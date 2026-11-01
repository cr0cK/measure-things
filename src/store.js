import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {MAX_FILE_BYTES, parseSet, serializeSet} from './sets.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.File.prototype, 'trash_async');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The size in bytes of a set's file text. */
export function fileBytes(text) {
    return encoder.encode(text).length;
}

/**
 * The sets folder: one JSON file per set, named after its ID. It reads every file at start,
 * watches the folder for files that appear or go, and writes each set atomically, one write at a
 * time per set, the latest one winning.
 */
export class SetStore {
    constructor({onChanged}) {
        this._onChanged = onChanged;
        this.folder = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_data_dir(), 'measure-things', 'sets']));
        this._cancellable = new Gio.Cancellable();
        // File name → {name, set} for a valid file, or {name, title, error} for an unavailable one.
        this._entries = new Map();
        // IDs deleted this session: a late write never brings them back.
        this._tombstones = new Set();
        this._writes = new Map();
        this._monitor = null;
    }

    async load() {
        try {
            this.folder.make_directory_with_parents(null);
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw error;
        }
        this._monitor = this.folder.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, this._cancellable);
        this._monitor.connect('changed', (_monitor, file, other, event) => this._onEvent(file, other, event));

        const enumerator = await this.folder.enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this._cancellable);
        const names = [];
        for (;;) {
            const infos = await enumerator.next_files_async(100, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (infos.length === 0)
                break;
            names.push(...infos.map(info => info.get_name()));
        }
        await Promise.all(names.filter(isSetFile).map(name => this._read(name)));
        this._onChanged();
    }

    destroy() {
        this._cancellable.cancel();
        this._monitor?.cancel();
        this._monitor = null;
        this._entries.clear();
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
        return set ? JSON.parse(JSON.stringify(set)) : null;
    }

    /** The names of every valid set. */
    names() {
        return [...this._entries.values()].filter(entry => entry.set).map(entry => entry.set.name);
    }

    /**
     * Writes a set and records it as the file's content. Resolves with whether the file was
     * written; a deleted set is never written.
     */
    write(set) {
        if (this._tombstones.has(set.id))
            return Promise.resolve(false);
        const text = serializeSet(set);
        const name = `${set.id}.json`;
        this._entries.set(name, {name, set: JSON.parse(JSON.stringify(set))});

        let job = this._writes.get(set.id);
        if (job) {
            job.text = text;
            return job.done;
        }
        job = {text};
        this._writes.set(set.id, job);
        job.done = (async () => {
            let written = false;
            while (job.text !== null) {
                const bytes = new GLib.Bytes(encoder.encode(job.text));
                job.text = null;
                try {
                    await this.folder.get_child(name).replace_contents_bytes_async(bytes, null, false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                    written = true;
                } catch (error) {
                    written = false;
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`Measure Things: could not save ${name}: ${error.message}`);
                }
            }
            this._writes.delete(set.id);
            return written;
        })();
        return job.done;
    }

    /** Moves a set's file to the trash, and remembers its ID for the session. */
    async trash(id) {
        this._tombstones.add(id);
        const name = `${id}.json`;
        this._entries.delete(name);
        this._onChanged();
        await this._writes.get(id)?.done;
        try {
            await this.folder.get_child(name).trash_async(GLib.PRIORITY_DEFAULT, null);
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`Measure Things: could not move ${name} to the trash: ${error.message}`);
        }
    }

    async _read(name) {
        let entry;
        try {
            const [bytes] = await this.folder.get_child(name).load_contents_async(this._cancellable);
            const result = bytes.length > MAX_FILE_BYTES ? {error: 'too-large'}
                : parseSet(decoder.decode(bytes), bytes.length);
            // A file is identified by its name: any other name is left to imports.
            if (result.set && name === `${result.set.id}.json` && !this._tombstones.has(result.set.id))
                entry = {name, set: result.set};
            else
                entry = {name, title: titleOf(bytes, name), error: result.error ?? 'misnamed'};
        } catch (error) {
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ||
                error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return;
            entry = {name, title: name.replace(/\.json$/, ''), error: 'unreadable'};
        }
        // A file this session already holds is not replaced by what other programs write there.
        if (!this._entries.has(name))
            this._entries.set(name, entry);
    }

    async _onEvent(file, other, event) {
        const {CREATED, MOVED_IN, DELETED, MOVED_OUT, RENAMED} = Gio.FileMonitorEvent;
        const added = event === CREATED || event === MOVED_IN ? file
            : event === RENAMED ? other : null;
        const removed = event === DELETED || event === MOVED_OUT || event === RENAMED ? file : null;
        let changed = false;
        if (removed && this._entries.delete(removed.get_basename()))
            changed = true;
        const name = added?.get_basename();
        if (name && isSetFile(name) && !this._entries.has(name)) {
            await this._read(name);
            changed = this._entries.has(name);
        }
        if (changed)
            this._onChanged();
    }
}

function isSetFile(name) {
    return name.endsWith('.json') && !name.startsWith('.');
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
    return name.replace(/\.json$/, '');
}
