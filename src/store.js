import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    SETTLE_MS,
    eventAction,
    idOfName,
    importedSet,
    isOwn,
    isSetFileName,
    judge,
    planScan,
    renamedSet,
} from './library.js';
import {MAX_FILE_BYTES, parseSet, serializeSet, uniqueName} from './sets.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.File.prototype, 'trash_async');

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EVENT_NAMES = Object.fromEntries(
    Object.entries(Gio.FileMonitorEvent).map(([name, value]) => [value, name]));

// Kept across a disable and re-enable, as the shell session outlives the extension: a write of
// the previous run still in flight keeps its place in the queue of its file, an ID deleted this
// session stays deleted, and the etag and text of each file's last successful read or write stay
// what the next run judges the folder's events against.
//
// File name → the write queue of that file: one write at a time, the commits not started yet merged.
const writes = new Map();
// File name → {etag, text} of the last successful read or write.
const known = new Map();
// File name → a number that moves when the shell starts or ends a write, a deletion, or a removal
// of that file, to tell a read that overlapped one: it is read again.
const generations = new Map();
const tombstones = new Set();
// The IDs of sets whose last write failed, and the operations under way besides the queues (an
// import, a retry): the next run waits for all of them, and for the deletions in progress.
const failures = new Set();
const inflight = new Set();
// Sets being deleted: their commits wait in memory until the file is in the trash, or is not.
const holds = new Map();

const clone = value => JSON.parse(JSON.stringify(value));
const bump = name => generations.set(name, (generations.get(name) ?? 0) + 1);

/** The size in bytes of a set's file text. */
export function fileBytes(text) {
    return encoder.encode(text).length;
}

const NO_CALLBACKS = {
    onChanged: () => {},
    onReplaced: () => {},
    onGone: () => {},
    onWriteResult: () => {},
    isClaimed: () => false,
    takenNames: () => [],
};

/**
 * The sets folder: one JSON file per set, named after its ID. It reads every file at start,
 * watches the folder, and writes each set atomically, one write at a time per file, the commits
 * not started yet merged into the latest one. What it decides about a change in the folder is
 * library.js's; this class reads, writes, waits for the right moment, and tells the manager.
 *
 * Callbacks: `onChanged()` when the library changed; `onReplaced(set, {dropped})` when another
 * program edited the file of a set, or a conflict reloaded it; `onGone(id, reason, {name,
 * dropped})` when its file was removed, turned unavailable, or now holds another set (`reason`
 * is `removed`, `unavailable`, or `replaced`); `onWriteResult(id, ok)` after each write that was
 * tried; `isClaimed(id)` and `takenNames(set)` for the sets the manager holds in memory.
 */
export class SetStore {
    constructor(callbacks) {
        this._cb = {...NO_CALLBACKS, ...callbacks};
        this.folder = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_data_dir(), 'measure-things', 'sets']));
        this._cancellable = new Gio.Cancellable();
        // File name → {name, set} for a valid file, or {name, title, error} for an unavailable one.
        this._entries = new Map();
        this._monitor = null;
        this._destroyed = false;
        // File name → the timeout of a name that is settling, and the chain of what runs on it.
        this._timers = new Map();
        this._chains = new Map();
        // The names of the copies being imported, which no other import may take.
        this._reserved = new Set();
        this._ready = new Promise(resolve => {
            this._markReady = resolve;
        });
    }

    async load() {
        try {
            // What the previous run left in flight must end before the files are read: an import
            // would be done twice, a deletion undone, a retry missed.
            while (writes.size > 0 || inflight.size > 0 || holds.size > 0) {
                await Promise.all([
                    ...[...writes.values()].map(job => job.done),
                    ...inflight,
                    ...[...holds.values()].map(hold => hold.released),
                ]);
            }
            try {
                this.folder.make_directory_with_parents(null);
            } catch (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    throw error;
            }
            this._watch();

            const enumerator = await this.folder.enumerate_children_async('standard::name',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this._cancellable);
            const names = [];
            for (;;) {
                const infos = await enumerator.next_files_async(100, GLib.PRIORITY_DEFAULT,
                    this._cancellable);
                if (infos.length === 0)
                    break;
                names.push(...infos.map(info => info.get_name()));
            }
            const disks = (await Promise.all(names.filter(isSetFileName).map(name => this._readDisk(name))))
                .filter(Boolean);
            await this._scan(disks);
            this._cb.onChanged();
        } finally {
            this._markReady();
        }
    }

    destroy() {
        this._destroyed = true;
        this._cb = NO_CALLBACKS;
        this._cancellable.cancel();
        this._monitor?.cancel();
        this._monitor = null;
        for (const id of this._timers.values())
            GLib.source_remove(id);
        this._timers.clear();
        this._entries.clear();
        this._markReady();
    }

    /** Every file, as `{key, id, name, edited, unavailable}`, most recently edited first. */
    entries() {
        const entries = [...this._entries.values()].map(({name: key, set, title}) => (set
            ? {key, id: set.id, name: set.name, edited: set.edited, unavailable: false}
            : {key, id: null, name: title, edited: 0, unavailable: true}));
        return entries.sort((a, b) => b.edited - a.edited || a.name.localeCompare(b.name));
    }

    /** A copy of the set a valid file holds, or null. */
    get(id) {
        const set = this._entries.get(`${id}.json`)?.set;
        return set ? clone(set) : null;
    }

    /** The names of every valid set. */
    names() {
        return [...this._entries.values()].filter(entry => entry.set).map(entry => entry.set.name);
    }

    /**
     * Writes a set. It joins the library, and becomes the file's content, once the write
     * succeeded. Resolves with whether the file was written: false for a failure, a conflict, a
     * file that went, a deleted set, and a file that is unavailable, which is never written to; a
     * set being deleted only keeps its latest commit in memory.
     */
    write(set, {afterReload = false} = {}) {
        const hold = holds.get(set.id);
        if (tombstones.has(set.id) && !hold)
            return Promise.resolve(false);
        const name = `${set.id}.json`;
        if (this._entries.get(name)?.error)
            return Promise.resolve(false);
        const copy = clone(set);
        if (hold) {
            hold.pending = copy;
            return Promise.resolve(false);
        }

        const text = serializeSet(set);
        let job = writes.get(name);
        if (job?.reloading && !afterReload) {
            // Made from a state the file has left: dropped with the commits of the conflict.
            job.reloading.dropped++;
            return job.done;
        }
        if (job) {
            job.text = text;
            job.set = copy;
            job.commits++;
            return job.done;
        }
        job = {text, set: copy, commits: 1, reload: null, reloading: null};
        writes.set(name, job);
        job.done = this._run(name, job);
        return job.done;
    }

    /** Registers an operation that the next run, after a disable, must wait for. */
    track(promise) {
        const done = promise.finally(() => inflight.delete(done));
        inflight.add(done);
        return done;
    }

    /** The names that imports under way are about to take. */
    reservedNames() {
        return [...this._reserved];
    }

    /** The queue of a set's file, as a promise of its last write, or null when it is idle. */
    pending(id) {
        return writes.get(`${id}.json`)?.done ?? null;
    }

    /** Whether the last write of a set failed. */
    hasFailed(id) {
        return failures.has(id);
    }

    /**
     * The queue of one file: each write starts once the previous one ended. A write that finds
     * the file changed or gone drops every commit that was waiting, then reloads the file.
     */
    async _run(name, job) {
        let written = false;
        for (;;) {
            if (job.text !== null) {
                const {text, set, commits} = job;
                job.text = null;
                job.commits = 0;
                bump(name);
                let outcome;
                try {
                    outcome = await this._attempt(name, text);
                } catch (error) {
                    console.warn(`Measure Things: could not save ${name}: ${error.message}`);
                    outcome = {status: 'failed'};
                }
                bump(name);
                if (outcome.status === 'written') {
                    written = true;
                    failures.delete(set.id);
                    known.set(name, {etag: outcome.etag, text});
                    this._entries.set(name, {name, set: clone(set)});
                    this._cb.onWriteResult(set.id, true);
                    this._cb.onChanged();
                } else if (outcome.status === 'failed') {
                    written = false;
                    failures.add(set.id);
                    this._cb.onWriteResult(set.id, false);
                } else {
                    // Everything queued came from a state the file has left.
                    written = false;
                    job.reload = {dropped: commits + job.commits, missing: outcome.status === 'missing'};
                    job.text = null;
                    job.commits = 0;
                }
                continue;
            }
            if (job.reload) {
                // Commits made while the file is read again are dropped too: write() counts them.
                const reload = job.reload;
                job.reload = null;
                job.reloading = reload;
                try {
                    await this._reload(name, reload);
                } catch (error) {
                    console.warn(`Measure Things: could not reload ${name}: ${error.message}`);
                }
                job.reloading = null;
                continue;
            }
            break;
        }
        writes.delete(name);
        return written;
    }

    /**
     * One write: `{status: 'written', etag}`, `conflict` when the file is not the one last read
     * or written, or `missing` when it went. GIO's replace recreates a missing file even with an
     * etag, so a file already read or written is first checked to still exist. A first write
     * creates the file, and the folder when it is missing.
     */
    async _attempt(name, text) {
        const last = known.get(name) ?? null;
        if (last) {
            try {
                await this.folder.get_child(name).query_info_async('standard::name',
                    Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
            } catch (error) {
                if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    return {status: 'missing'};
                throw error;
            }
        }
        try {
            return {status: 'written', etag: await this._replace(name, new GLib.Bytes(encoder.encode(text)),
                last?.etag ?? null)};
        } catch (error) {
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.WRONG_ETAG))
                return {status: 'conflict'};
            throw error;
        }
    }

    /** Replaces a file's content and resolves with its new etag, creating the folder when missing. */
    async _replace(name, bytes, etag) {
        const file = this.folder.get_child(name);
        const replace = () => file.replace_contents_bytes_async(bytes, etag, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        try {
            return (await replace())[0];
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw error;
            this.folder.make_directory_with_parents(null);
            // A folder that was removed took its watch with it.
            if (!this._destroyed)
                this._watch();
            return (await replace())[0];
        }
    }

    /**
     * Moves a set's file to the trash, once its writes are done, and remembers its ID for the
     * session. Commits made meanwhile wait in memory. Resolves with whether the file is in the
     * trash; when it could not go there, nothing changed: the ID is forgotten, the set stays, and
     * the commits held go out as one write. Resolves with null when a deletion is already running.
     */
    async trash(id) {
        if (holds.has(id))
            return null;
        const name = `${id}.json`;
        const hold = {pending: null};
        hold.released = new Promise(resolve => {
            hold.release = resolve;
        });
        holds.set(id, hold);
        await writes.get(name)?.done;
        tombstones.add(id);
        bump(name);
        let trashed;
        try {
            await this.folder.get_child(name).trash_async(GLib.PRIORITY_DEFAULT, null);
            trashed = true;
        } catch (error) {
            // A file already gone needs no trash.
            trashed = error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
            if (!trashed)
                console.warn(`Measure Things: could not move ${name} to the trash: ${error.message}`);
        }
        holds.delete(id);
        hold.release();
        if (trashed) {
            this._entries.delete(name);
            known.delete(name);
        } else {
            tombstones.delete(id);
        }
        bump(name);
        if (trashed) {
            this._cb.onChanged();
            return true;
        }
        if (hold.pending)
            this.write(hold.pending);
        return false;
    }

    _watch() {
        this._monitor?.cancel();
        this._monitor = this.folder.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, this._cancellable);
        this._monitor.connect('changed', (_monitor, file, other, event) => this._onEvent(file, other, event));
    }

    /** A file as it is on disk: null when gone, undefined when the store was destroyed meanwhile. */
    async _readDisk(name, cancellable = this._cancellable) {
        let bytes;
        let etag;
        try {
            [bytes, etag] = await this.folder.get_child(name).load_contents_async(cancellable);
        } catch (error) {
            if (!(error instanceof GLib.Error))
                throw error;
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return undefined;
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return null;
            return {name, etag: null, text: null, title: idOfName(name), parsed: {error: 'unreadable'}};
        }
        if (bytes.length > MAX_FILE_BYTES)
            return {name, etag, text: null, title: titleOf(bytes, name), parsed: {error: 'too-large'}};
        const text = decoder.decode(bytes);
        return {name, etag, text, title: titleOf(bytes, name), parsed: parseSet(text, bytes.length)};
    }

    /** The startup scan: the files that join the library, the imports, and the unavailable ones. */
    async _scan(disks) {
        const plan = planScan(disks, {
            isTaken: id => tombstones.has(id) || this._cb.isClaimed(id),
            newId: () => GLib.uuid_string_random(),
            now: Date.now(),
        });
        for (const {name, disk} of plan.unavailable) {
            this._remember(name, disk);
            this._entries.set(name, {name, title: disk.title, error: disk.parsed.error});
        }
        for (const {name, disk, set, renamed} of plan.library) {
            this._remember(name, disk);
            this._entries.set(name, {name, set});
            if (renamed)
                this.write(set);
        }
        // Not through the chain of the name: a settle of it waits for the scan to end.
        await Promise.all(plan.imports.map(({name, disk, copy}) => this._import(name, disk, copy)));
    }

    /** Remembers the etag and text of a file read, which later events are judged against. */
    _remember(name, disk) {
        if (disk && disk.text !== null)
            known.set(name, {etag: disk.etag, text: disk.text});
        else
            known.delete(name);
    }

    _isTaken(id) {
        return tombstones.has(id) || this._cb.isClaimed(id) ||
            [...this._entries.values()].some(entry => entry.set?.id === id);
    }

    _onEvent(file, other, event) {
        const action = eventAction(EVENT_NAMES[event]);
        if (action === 'ignore')
            return;
        if (file.equal(this.folder)) {
            // The folder itself went: every file in it did too.
            for (const name of new Set([...this._entries.keys(), ...known.keys()]))
                this._touch(name, false);
            return;
        }
        for (const touched of [file, other]) {
            if (touched?.get_parent()?.equal(this.folder))
                this._touch(touched.get_basename(), action === 'now');
        }
    }

    /** A file changed: the shell acts on its name once the events settle. */
    _touch(name, now) {
        if (!isSetFileName(name) || this._destroyed)
            return;
        const pending = this._timers.get(name);
        if (pending)
            GLib.source_remove(pending);
        this._timers.delete(name);
        if (now) {
            this._settle(name);
            return;
        }
        this._timers.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            this._timers.delete(name);
            this._settle(name);
            return GLib.SOURCE_REMOVE;
        }));
    }

    /** Runs tasks on one name one after the other: a file is never judged twice at once. */
    _serial(name, task) {
        const next = (this._chains.get(name) ?? Promise.resolve()).then(task)
            .catch(error => console.warn(`Measure Things: could not read ${name}: ${error.message}`));
        this._chains.set(name, next);
        next.then(() => {
            if (this._chains.get(name) === next)
                this._chains.delete(name);
        });
        return next;
    }

    _settle(name) {
        return this._serial(name, () => this._settleNow(name));
    }

    /**
     * Judges a name against the file as it is once its write queue is idle. A read that overlapped
     * a write is dropped and done again.
     */
    async _settleNow(name) {
        await this._ready;
        for (;;) {
            if (this._destroyed)
                return;
            const job = writes.get(name);
            if (job) {
                await job.done;
                continue;
            }
            const hold = holds.get(idOfName(name));
            if (hold) {
                await hold.released;
                continue;
            }
            const generation = generations.get(name) ?? 0;
            const disk = await this._readDisk(name);
            if (this._destroyed || disk === undefined)
                return;
            if (writes.has(name) || (generations.get(name) ?? 0) !== generation)
                continue;
            await this._apply(name, disk);
            return;
        }
    }

    /** A write found the file changed or gone: the file on disk wins, and the commits are dropped. */
    async _reload(name, reload) {
        if (this._destroyed)
            return;
        const disk = reload.missing ? null : await this._readDisk(name);
        if (disk === undefined)
            return;
        await this._apply(name, disk, {force: true, dropped: reload.dropped});
    }

    /** Acts on what library.js decides about a file. */
    async _apply(name, disk, {force = false, dropped = 0} = {}) {
        const entry = this._entries.get(name) ?? null;
        const held = entry?.set ?? null;
        const verdict = judge({
            name,
            entry: entry ? (entry.set ? 'set' : 'unavailable') : null,
            disk,
            known: known.get(name) ?? null,
            force,
            isTaken: id => this._isTaken(id),
        });
        this._remember(name, disk);
        // What the shell tried to write is superseded by the file: it is never tried again.
        if (held && verdict.action !== 'none')
            failures.delete(held.id);
        switch (verdict.action) {
        case 'none':
            break;
        case 'remove':
            this._entries.delete(name);
            if (held) {
                tombstones.add(held.id);
                this._cb.onGone(held.id, 'removed', {name: held.name, dropped});
            }
            this._cb.onChanged();
            break;
        case 'unavailable':
            this._entries.set(name, {name, title: verdict.title, error: verdict.error});
            if (held)
                this._cb.onGone(held.id, 'unavailable', {name: held.name, dropped});
            this._cb.onChanged();
            break;
        case 'add':
            this._entries.set(name, {name, set: verdict.set});
            this._giveFreeName(name, verdict.set);
            this._cb.onChanged();
            break;
        case 'replace': {
            const set = this._giveFreeName(name, verdict.set);
            this._entries.set(name, {name, set});
            this._cb.onReplaced(clone(set), {dropped});
            this._cb.onChanged();
            break;
        }
        case 'reimport':
            this._entries.delete(name);
            tombstones.add(held.id);
            this._cb.onGone(held.id, 'replaced', {name: held.name, dropped});
            await this._import(name, disk, this._importedCopy(verdict.set));
            break;
        case 'import':
            await this._import(name, disk, this._importedCopy(verdict.set));
            break;
        default:
            throw new Error(`Unknown verdict ${verdict.action}`);
        }
    }

    /** A set found in the folder under a name that is taken gets a suffix, written to its file once. */
    _giveFreeName(name, set) {
        const free = uniqueName(set.name, this._cb.takenNames(set));
        if (free === set.name)
            return set;
        const renamed = renamedSet(set, free);
        this._entries.set(name, {name, set: renamed});
        // Kept even while the file is read again after a conflict: it is the file's own naming.
        this.write(renamed, {afterReload: true});
        return renamed;
    }

    _importedCopy(set) {
        return importedSet(set, {
            id: GLib.uuid_string_random(),
            now: Date.now(),
            taken: this._cb.takenNames(null),
        });
    }

    /**
     * Imports a file: `<new id>.json` is written first, then the original is removed. When the
     * original cannot be removed, the copy goes again, so that a later scan never imports it
     * twice, and the original shows as unavailable. An original that changed meanwhile stays: its
     * own events judge it again.
     */
    _import(name, disk, copy) {
        this._reserved.add(copy.name);
        const done = this.track(this._importNow(name, disk, copy).finally(() => {
            this._reserved.delete(copy.name);
        }));
        return done;
    }

    async _importNow(name, disk, copy) {
        const written = await this.write(copy);
        if (!written) {
            this._entries.set(name, {name, title: copy.name, error: 'unreadable'});
            this._cb.onChanged();
            return;
        }
        // Not cancelled by a disable: the source is removed only once it is known to be unchanged.
        const current = await this._readDisk(name, null);
        if (current && !isOwn({etag: disk.etag, text: disk.text}, current)) {
            // Another program replaced it while the copy was written: nothing of it is lost.
            this._entries.delete(name);
            known.delete(name);
            this._cb.onChanged();
            return;
        }
        try {
            await this._removeFile(this.folder.get_child(name));
            this._entries.delete(name);
            known.delete(name);
        } catch (error) {
            if (error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                this._entries.delete(name);
                known.delete(name);
            } else {
                console.warn(`Measure Things: could not remove ${name} after importing it: ${error.message}`);
                // The copy stays in the library, as the shell's own write, until it is gone: its
                // events would otherwise be judged as a new file.
                const copyName = `${copy.id}.json`;
                bump(copyName);
                try {
                    await this._removeFile(this.folder.get_child(copyName));
                } catch (removal) {
                    console.warn(`Measure Things: could not remove ${copyName}: ${removal.message}`);
                }
                tombstones.add(copy.id);
                this._entries.delete(copyName);
                known.delete(copyName);
                bump(copyName);
                // A copy loaded meanwhile leaves the screen with it.
                this._cb.onGone(copy.id, 'removed', {name: copy.name, dropped: 0});
                this._remember(name, disk);
                this._entries.set(name, {name, title: copy.name, error: 'unremovable'});
            }
        }
        this._cb.onChanged();
    }

    _removeFile(file) {
        return file.delete_async(GLib.PRIORITY_DEFAULT, null);
    }
}

/** What an unavailable file shows as: its set's name when readable, or its file name. */
function titleOf(bytes, name) {
    try {
        const title = JSON.parse(decoder.decode(bytes)).name;
        if (typeof title === 'string' && title.trim())
            return title.trim();
    } catch {
        // Not JSON.
    }
    return idOfName(name);
}
