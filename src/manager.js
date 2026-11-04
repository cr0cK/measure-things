import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {isLogicalLayout} from './geometry.js';
import {History} from './history.js';
import {noticeFor} from './library.js';
import {ImageCache} from './mockup.js';
import {
    MAX_FILE_BYTES,
    MAX_HELPERS,
    defaultContent,
    migrateSettings,
    nextColor,
    nextUntitledName,
    serializeSet,
    uniqueName,
} from './sets.js';
import {SetStore, fileBytes} from './store.js';
import {View} from './view.js';
import {placeBadges, stackOrder} from './zones.js';

/** Tells the user about something that did not happen as asked. */
export function notify(text) {
    Main.notify('Measure Things', text);
}

const stateOf = model => JSON.stringify({name: model.name, content: model.content});

// Mockup images already reported as unreadable, by set and path: one notice each for the session,
// kept across a disable and re-enable.
const mockupNotices = new Set();

/**
 * The sets on screen and their views, over the sets folder. A model is one set in memory:
 * its file fields, its content with runtime helper ids, its undo history, whether it is hidden,
 * its main view, and its copies. A window can show several views.
 *
 * An unlinked copy edits a local model of its own: its content, its undo history, and the count
 * of its local changes; `local` is true on it, and `set` is the model it was taken from.
 */
export class Manager {
    constructor(settings, {onChanged, onSetClosing = () => {}}) {
        this._settings = settings;
        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._onChanged = onChanged;
        this._images = new ImageCache();
        this.models = [];
        this.editing = false;
        this._seq = 0;
        // The set `A` adds a copy of: the last one edited, else the last one loaded or created.
        // Once any set has been edited, loading or creating one does not take its place.
        this.lastEdited = null;
        this._anyEdit = false;
        // Called with the ID of a set whose dialogs and menus must close without applying.
        this._onSetClosing = onSetClosing;
        // The IDs of sets whose last write failed: one notice covers a run of failures.
        this._failing = new Set();
        // Set by the overlay: a view left the screen, became a set's main view, a set was
        // replaced by its file, or a set's saved state changed.
        this.onViewRemoved = () => {};
        this.onViewPromoted = () => {};
        this.onSetReplaced = () => {};
        this.onSavedChanged = () => {};
        this.store = new SetStore({
            onChanged: () => this._changed(),
            onReplaced: (set, info) => this._onFileReplaced(set, info),
            onGone: (id, reason, info) => this._onFileGone(id, reason, info),
            onWriteResult: (id, ok) => this._onWriteResult(id, ok),
            isClaimed: id => this.models.some(model => model.id === id),
            takenNames: except => this.takenNames(except),
        });
        this._mutterSignal = this._mutterSettings.connect('changed::experimental-features',
            () => this._syncViews());
        this.ready = this.store.load()
            .then(() => this._migrate())
            .catch(error => console.warn(`Measure Things: could not read the sets: ${error.message}`));
    }

    destroy() {
        // A set that was not saved is tried once more; its writes finish after the disable.
        for (const model of this.models)
            this._retryUnsaved(model);
        for (const view of this.views)
            view.destroy();
        this.models = [];
        this._mutterSettings.disconnect(this._mutterSignal);
        this.store.destroy();
        this._images.clear();
    }

    isLogical() {
        return isLogicalLayout(this._mutterSettings.get_strv('experimental-features'));
    }

    _changed() {
        this._onChanged();
    }

    _syncViews() {
        for (const view of this.views)
            view.sync();
    }

    /** Every view on screen: main views and copies. */
    get views() {
        return this.models.flatMap(model => [model.view, ...model.copies]).filter(Boolean);
    }

    /** The views of one window, the oldest first. */
    viewsOn(window) {
        return this.views.filter(view => view.window === window).sort((a, b) => a.seq - b.seq);
    }

    /** The set a model belongs to: itself, or the set an unlinked copy was taken from. */
    setOf(model) {
        return model.set ?? model;
    }

    /** The local changes of the set's unlinked copies. */
    localChanges(set) {
        return set.copies.reduce((total, view) => total + (view.local?.localChanges ?? 0), 0);
    }

    /** The sets the menu lists as on screen: not the one a gesture is still creating. */
    get onScreen() {
        return this.models.filter(model => !model.provisional);
    }

    modelOf(id) {
        return this.models.find(model => model.id === id) ?? null;
    }

    /** Names taken by sets other than `except`, a model or a set. */
    takenNames(except = null) {
        const names = new Set();
        for (const entry of this.store.entries()) {
            if (!entry.unavailable && entry.id !== except?.id)
                names.add(entry.name);
        }
        for (const model of this.models) {
            if (model.id !== except?.id)
                names.add(model.name);
        }
        for (const name of this.store.reservedNames(except?.id))
            names.add(name);
        return [...names];
    }

    _model(set, provisional = false) {
        const content = set.content;
        content.helpers = content.helpers.map((helper, i) => ({...helper, id: i + 1}));
        const nextId = content.helpers.length + 1;
        const model = {
            ...set, content, nextId, hidden: false, view: null, copies: [], provisional, saved: true,
            found: false,
        };
        model.history = new History(stateOf(model));
        return model;
    }

    _makeView(set, window) {
        return new View(set, window, {
            settings: this._settings,
            images: this._images,
            isLogical: () => this.isLogical(),
            seq: ++this._seq,
            onClosed: view => this._onWindowClosed(view),
            onBadgeChanged: view => this._layoutBadges(view.window),
            onMockupError: (view, path) => this._mockupFailed(view, path),
        });
    }

    /** A mockup image that cannot be read or decoded: one notice per set and path, for the session. */
    _mockupFailed(view, path) {
        const set = this.setOf(view.model);
        const key = `${set.id}\n${path}`;
        if (mockupNotices.has(key))
            return;
        mockupNotices.add(key);
        notify(`The mockup image of “${set.name}” cannot be read: ${GLib.path_get_basename(path)}. ` +
            'Its path is kept, and it shows again when the file comes back.');
    }

    /** Shows a model on a window as its main view, with an automatic zone. */
    _show(model, window) {
        model.view = this._makeView(model, window);
        if (this.editing)
            model.view.setEditing(true);
        this.models.push(model);
        if (!model.provisional)
            this._fallbackEdited(model);
        this._layoutBadges(window);
        this._changed();
        return model.view;
    }

    /** A set loaded or created becomes the one `A` copies, until a set is edited. */
    _fallbackEdited(model) {
        if (!this._anyEdit)
            this.lastEdited = model;
    }

    /** A set whose content just changed becomes the one `A` copies. */
    _edited(set) {
        this._anyEdit = true;
        this.lastEdited = set;
    }

    /** Adds a linked copy of a set on a window, with an automatic zone. */
    addCopy(model, window) {
        const view = this._makeView(model, window);
        model.copies.push(view);
        if (this.editing)
            view.setEditing(true);
        this._layoutBadges(window);
        this._changed();
        return view;
    }

    /**
     * Places the badges of a window's views together, shifting overlapping ones left and wrapping
     * them to a row above, then stacks its views: the largest zone at the bottom, then badges.
     */
    _layoutBadges(window) {
        const views = this.viewsOn(window).filter(view => view.geometry);
        const shown = views.filter(view => view.hasBadge);
        const items = shown.map(view => ({...view.badgeSize, ...view.badgeCorner()}));
        placeBadges(items).forEach(({x, y}, i) => shown[i].placeBadge(x, y));

        const actor = window.get_compositor_private();
        if (!actor)
            return;
        const layers = stackOrder(views.filter(view => view.attached.layer).map(view => ({
            id: view, area: view.zoneArea, seq: view.seq,
        })));
        const wanted = [...layers.map(view => view.layer), ...shown.map(view => view.attached.badge)];
        const present = actor.get_children().filter(child => wanted.includes(child));
        if (present.every((child, i) => child === wanted[i]))
            return;
        for (const child of wanted)
            actor.set_child_above_sibling(child, null);
    }

    /** A window closed: a copy goes; a main view hands over to the oldest linked copy. */
    _onWindowClosed(view) {
        view.detach();
        const model = view.set;
        if (!view.isMain) {
            this.removeCopy(view);
            return;
        }
        const next = model.copies.find(copy => copy.linked);
        if (!next) {
            this.removeFromScreen(model);
            return;
        }
        model.copies.splice(model.copies.indexOf(next), 1);
        model.view = next;
        this._dropView(view);
        // A menu open on the copy shows what it was, not what it is now.
        this.onViewPromoted(next);
        next.sync();
        this._changed();
    }

    _dropView(view) {
        this.onViewRemoved(view);
        view.destroy();
        this._layoutBadges(view.window);
    }

    /** Removes one copy from the screen. */
    removeCopy(view) {
        const set = view.set;
        const index = set.copies.indexOf(view);
        if (index < 0)
            return;
        set.copies.splice(index, 1);
        this._dropView(view);
        this._changed();
    }

    /** Takes a linked copy off the set: it holds a copy of the content, and edits it alone. */
    unlink(view) {
        const set = view.set;
        if (view.isMain || !view.linked || !this.models.includes(set))
            return;
        const local = {
            local: true,
            set,
            view,
            name: set.name,
            content: JSON.parse(JSON.stringify(set.content)),
            nextId: set.nextId,
            hidden: false,
            provisional: false,
            localChanges: 0,
        };
        local.history = new History(stateOf(local));
        view.local = local;
        view.sync();
        this._changed();
    }

    /** Makes an unlinked copy show the set again, dropping its local changes. */
    relink(view) {
        if (view.linked)
            return;
        view.local = null;
        view.selectedId = null;
        view.sync();
        this._changed();
    }

    /**
     * A set for a window no zone covers, shown as its main view. It is provisional, with no badge
     * and out of the menu, until its first commit writes it; until then discard() drops it.
     */
    createSet(window) {
        const used = this.onScreen.map(model => model.content.color);
        const set = {
            id: GLib.uuid_string_random(),
            name: nextUntitledName(this.takenNames()),
            revision: 0,
            edited: Date.now(),
            migrated: false,
            content: defaultContent(nextColor(used)),
        };
        return this._show(this._model(set, true), window);
    }

    /** Drops a set created by a gesture that ended without a change. */
    discard(model) {
        if (model.provisional)
            this.removeFromScreen(model);
    }

    canAddHelpers(model, count = 1) {
        if (model.content.helpers.length + count <= MAX_HELPERS)
            return true;
        notify(`“${model.name}” already has ${MAX_HELPERS} helpers.`);
        return false;
    }

    /** Adds a helper given in CSS pixels, with a new runtime id, and returns it. */
    addHelper(model, helper) {
        const added = {id: model.nextId++, ...helper};
        model.content.helpers.push(added);
        return added;
    }

    /**
     * Saves a set's current content as one undo step, and writes its file. A change that would
     * make the file too large is refused and undone. A commit clears the set's `found` mark, which
     * only the Find helpers commit sets: that one, made while the mark is set, takes the place of
     * the previous run's step instead of adding one.
     */
    commit(model, {found = false} = {}) {
        const set = this.setOf(model);
        if (!this.models.includes(set))
            return false;
        const state = stateOf(model);
        if (state === model.history.current) {
            if (set.provisional)
                this.discard(set);
            else
                this.syncModel(model);
            return false;
        }
        if (model.local) {
            if (this._tooLarge(model)) {
                this._apply(model, model.history.current);
                return false;
            }
            model.history.record(state);
            model.localChanges++;
            this._edited(set);
            this.syncModel(model);
            this._changed();
            return true;
        }
        if (!this._write(model)) {
            this._apply(model, model.history.current);
            return false;
        }
        if (found && model.found)
            model.history.replace(state);
        else
            model.history.record(state);
        model.found = found;
        this._edited(set);
        return true;
    }

    /**
     * Replaces a set's helpers with the ones Find helpers found, in CSS pixels, and saves the
     * tolerance they were found at: one undo step. Marks the set as just found.
     */
    applyFound(model, helpers, tolerance) {
        if (!this.models.includes(model))
            return false;
        model.content.helpers = helpers.map(helper => ({id: model.nextId++, ...helper}));
        model.content.tolerance = tolerance;
        for (const view of [model.view, ...model.copies]) {
            if (view)
                view.selectedId = null;
        }
        return this.commit(model, {found: true});
    }

    /** Whether a model's file would pass the size limit; a notice says so when it does not. */
    _tooLarge(model) {
        const set = this.setOf(model);
        const bytes = fileBytes(serializeSet({
            id: set.id, name: set.name, revision: set.revision + 1, edited: Date.now(),
            migrated: set.migrated, content: model.content,
        }));
        if (bytes <= MAX_FILE_BYTES)
            return false;
        notify(`“${set.name}” would be larger than 1 MiB: the change was undone.`);
        return true;
    }

    _write(model) {
        if (this._tooLarge(model))
            return false;
        const set = {
            id: model.id,
            name: model.name,
            revision: model.revision + 1,
            edited: Date.now(),
            migrated: model.migrated,
            content: model.content,
        };
        model.revision = set.revision;
        model.edited = set.edited;
        model.provisional = false;
        this.store.write(set);
        this.syncModel(model);
        this._changed();
        return true;
    }

    /** The result of a write the store tried: a set is `not saved` from a failure until a success. */
    _onWriteResult(id, ok) {
        const model = this.modelOf(id);
        const first = !this._failing.has(id);
        if (ok)
            this._failing.delete(id);
        else
            this._failing.add(id);
        if (model) {
            model.saved = ok;
            this.onSavedChanged(model);
        }
        if (!ok && first) {
            const name = model?.name ?? this.store.get(id)?.name ?? 'A set';
            notify(model
                ? `“${name}” could not be saved. The changes stay in memory, and the next change tries again.`
                : `“${name}” could not be saved.`);
        }
    }

    /**
     * A set that is not saved, or whose write is still in flight, leaves the screen: its latest
     * state is written once more when that write failed, and a notice says when this fails too.
     */
    _retryUnsaved(model) {
        if (model.provisional)
            return;
        const pending = this.store.pending(model.id);
        if (model.saved && !pending)
            return;
        const {id, name, revision, edited, migrated, content} = model;
        const set = {id, name, revision, edited, migrated, content: JSON.parse(JSON.stringify(content))};
        const epoch = this.store.epoch(id);
        // Tracked: a run that starts right after a disable waits for it. A file that superseded
        // the set meanwhile, such as after a conflict, is not written over.
        this.store.track(Promise.resolve(pending).then(() => {
            // A set back on screen, or superseded by its file, owns a newer state than this one.
            if (!this.store.hasFailed(id) || this.store.epoch(id) !== epoch || this.modelOf(id))
                return null;
            return this.store.write(set).then(written => {
                if (!written)
                    notify(`“${name}” could not be saved, and its unsaved changes are lost.`);
            });
        }));
    }

    /**
     * Another program edited a set's file, or a conflict reloaded it: the set in memory and its
     * linked copies take the file's content, a gesture on it is cancelled, its dialogs and menus
     * close, and its undo history starts over. Unlinked copies keep their own state.
     */
    _onFileReplaced(set, {dropped}) {
        const model = this.modelOf(set.id);
        // A dialog may be open for a set of the library that is not on screen.
        this._onSetClosing(set.id);
        if (model) {
            this.onSetReplaced(model);
            const {content} = set;
            content.helpers = content.helpers.map((helper, i) => ({...helper, id: i + 1}));
            Object.assign(model, {
                name: set.name,
                revision: set.revision,
                edited: set.edited,
                migrated: set.migrated,
                content,
                nextId: content.helpers.length + 1,
            });
            model.history = new History(stateOf(model));
            model.found = false;
            // The memory now holds what the file holds.
            model.saved = true;
            this._failing.delete(model.id);
            this.onSavedChanged(model);
            for (const view of [model.view, ...model.copies]) {
                if (!view?.linked)
                    continue;
                if (!content.helpers.some(helper => helper.id === view.selectedId))
                    view.selectedId = null;
                view.sync();
                view.restack();
            }
            this._changed();
        }
        // An edit the shell saw alone is told; a conflict is told once, with its dropped commits.
        if (model || dropped > 0)
            notify(noticeFor('edited', {name: set.name, dropped}));
    }

    /**
     * A set's file was removed, turned unavailable, or now holds another set: the set leaves the
     * screen, unlinked copies included, with a notice that counts the local changes lost.
     */
    _onFileGone(id, reason, {name, dropped}) {
        const model = this.modelOf(id);
        this._failing.delete(id);
        this._onSetClosing(id);
        if (!model && dropped === 0)
            return;
        const lost = model ? this.localChanges(model) : 0;
        if (model)
            this.removeFromScreen(model, {retry: false});
        notify(noticeFor(reason, {name, dropped, lost}));
    }

    /** Lays out again every view that shows a model: the main view and linked copies, or one copy. */
    syncModel(model) {
        if (model.local) {
            model.view.sync();
            return;
        }
        for (const view of [model.view, ...model.copies]) {
            if (view?.linked)
                view.sync();
        }
    }

    /** Lays out again the helpers of every view of a model, during a drag. */
    syncHelpers(model) {
        if (model.local) {
            model.view.syncHelpers();
            return;
        }
        for (const view of [model.view, ...model.copies]) {
            if (view?.linked)
                view.syncHelpers();
        }
    }

    undo(model) {
        this._step(model, model.history.undo(), -1);
    }

    redo(model) {
        this._step(model, model.history.redo(), 1);
    }

    _step(model, state, change) {
        if (state === null)
            return;
        this._apply(model, state);
        model.found = false;
        this._edited(this.setOf(model));
        if (model.local) {
            model.localChanges += change;
            this._changed();
        } else {
            this._write(model);
        }
    }

    /** Puts back a recorded state. A name taken since then gets a numeric suffix. */
    _apply(model, state) {
        const {name, content} = JSON.parse(state);
        if (!model.local)
            model.name = uniqueName(name, this.takenNames(model));
        model.content = content;
        model.nextId = Math.max(model.nextId, ...content.helpers.map(helper => helper.id + 1));
        for (const view of model.local ? [model.view] : [model.view, ...model.copies]) {
            if (!view || view.model !== model)
                continue;
            if (!content.helpers.some(helper => helper.id === view.selectedId))
                view.selectedId = null;
            view.sync();
            view.restack();
        }
    }

    setHidden(model, hidden) {
        model.hidden = hidden;
        for (const view of [model.view, ...model.copies])
            view?.sync();
        this._changed();
    }

    setEditing(editing) {
        this.editing = editing;
        for (const view of this.views)
            view.setEditing(editing);
    }

    /** Hides every view for a capture of the screen, or shows them again. */
    setCaptureHidden(hidden) {
        for (const view of this.views)
            view.setCaptureHidden(hidden);
    }

    /**
     * Removes a set with its main view and every copy. A set that is not saved is written once
     * more first, unless `retry` is false, as when its file is gone.
     */
    removeFromScreen(model, {retry = true} = {}) {
        const index = this.models.indexOf(model);
        if (index < 0)
            return;
        if (retry)
            this._retryUnsaved(model);
        this.models.splice(index, 1);
        if (this.lastEdited === model) {
            // `A` does nothing until another set is edited: loading one does not bring it back.
            this.lastEdited = null;
            this._anyEdit = true;
        }
        const views = [model.view, ...model.copies].filter(Boolean);
        model.view = null;
        model.copies = [];
        for (const view of views)
            this._dropView(view);
        this._changed();
    }

    /**
     * Loads a set from the library onto a window: as its main view, or as a linked copy when it
     * is on screen already.
     */
    load(id, window) {
        const shown = this.modelOf(id);
        const set = shown ?? this.store.get(id);
        if (!set)
            return null;
        const model = shown ?? this._model(set);
        const view = shown ? this.addCopy(model, window) : this._show(model, window);
        this._fallbackEdited(model);
        // A load counts as an edit for the library's order.
        this._write(model);
        return view;
    }

    /** Renames a set from the library. It is not an undo step: the history keeps the new name. */
    rename(id, name) {
        const model = this.modelOf(id);
        const current = model ?? this.store.get(id);
        if (!current)
            return;
        name = uniqueName(name.trim(), this.takenNames(current));
        if (name === current.name)
            return;
        if (model) {
            model.name = name;
            model.history.rewrite(state => JSON.stringify({...JSON.parse(state), name}));
            this._write(model);
        } else {
            this.store.write({...current, name, revision: current.revision + 1, edited: Date.now()});
            this._changed();
        }
    }

    /**
     * Moves a set's file to the trash. The set stays, on screen too, until the file is there; when
     * it cannot go, nothing changes and a notice says so.
     */
    async delete(id) {
        const name = this.modelOf(id)?.name ?? this.store.get(id)?.name ?? id;
        const trashed = await this.store.trash(id);
        if (trashed === null)
            return;
        if (!trashed) {
            notify(`Could not delete “${name}”: its file cannot go to the trash.`);
            return;
        }
        const model = this.modelOf(id);
        if (model) {
            this._onSetClosing(id);
            this.removeFromScreen(model, {retry: false});
        }
        this._failing.delete(id);
    }

    /**
     * Saves the current content of a main view's set under a new name, and switches the view to
     * the new set with its undo history, at once, so later commits write the new set. The old
     * set keeps what its file last held.
     */
    saveAsNew(model, name) {
        name = uniqueName(name.trim(), this.takenNames());
        const set = {
            id: GLib.uuid_string_random(),
            name,
            revision: 0,
            edited: Date.now(),
            migrated: false,
            content: JSON.parse(JSON.stringify(model.content)),
        };
        this._failing.delete(model.id);
        Object.assign(model, {
            id: set.id, name, revision: 0, edited: set.edited, migrated: false, saved: true,
        });
        model.history.rewrite(state => JSON.stringify({...JSON.parse(state), name}));
        this.store.write(set);
        // A new set, not a change of content: it counts as created.
        this._fallbackEdited(model);
        this.syncModel(model);
        this._changed();
    }

    /**
     * Saves an unlinked copy as a new set: the copy becomes its main view, with its content and
     * its undo history. The set it came from and its other views do not change.
     */
    saveCopyAsNew(view, name) {
        const local = view.local;
        const from = view.set;
        if (!local || !this.models.includes(from))
            return;
        name = uniqueName(name.trim(), this.takenNames());
        const set = {
            id: GLib.uuid_string_random(),
            name,
            revision: 0,
            edited: Date.now(),
            migrated: false,
            content: JSON.parse(JSON.stringify(local.content)),
        };
        const model = {
            ...set, content: local.content, nextId: local.nextId, hidden: false, view, copies: [],
            provisional: false, history: local.history, saved: true, found: false,
        };
        model.history.rewrite(state => JSON.stringify({...JSON.parse(state), name}));
        from.copies.splice(from.copies.indexOf(view), 1);
        view.local = null;
        view.set = model;
        this.models.push(model);
        this.store.write(set);
        // A new set, not a change of content: it counts as created.
        this._fallbackEdited(model);
        view.sync();
        this._changed();
    }

    /** The model shown by the newest view of a window, or a new set when it shows none. */
    modelForWindow(window) {
        return (this.viewsOn(window).at(-1) ?? this.createSet(window)).model;
    }

    toggleGrid(model) {
        model.content.grid.visible = !model.content.grid.visible;
        this.commit(model);
    }

    /**
     * Turns the v0.2 settings into a set once. The marker is written only after the file, and a
     * set file from an earlier, interrupted run stops a second one.
     */
    async _migrate() {
        const settings = this._settings;
        if (settings.get_boolean('migrated'))
            return;
        const migrated = this.store.entries().some(entry => entry.id && this.store.get(entry.id).migrated);
        const primary = Main.layoutManager.primaryMonitor ?? {x: 0, y: 0, geometry_scale: 1};
        const scale = this.isLogical() ? 1 : primary.geometry_scale;
        const zoom = settings.get_int('zoom') / 100;
        const result = migrated ? null : migrateSettings({
            helpers: settings.get_string('helpers'),
            showHelpers: settings.get_boolean('show-helpers'),
            color: settings.get_string('color'),
            zoom: settings.get_int('zoom'),
            gridColumns: settings.get_int('grid-columns'),
            gridGutter: settings.get_int('grid-gutter'),
            gridMargin: settings.get_int('grid-margin'),
            gridMaxWidth: settings.get_int('grid-max-width'),
            mockupFile: settings.get_string('mockup-file'),
            mockupVisible: settings.get_boolean('mockup-visible'),
            mockupOpacity: settings.get_int('mockup-opacity'),
            mockupDensity: settings.get_int('mockup-density'),
            mockupPosition: settings.get_value('mockup-position').deepUnpack(),
        }, {origin: [primary.x, primary.y], toCss: value => value / scale / zoom});
        if (result) {
            const {content, leftOut} = result;
            const written = await this.store.write({
                id: GLib.uuid_string_random(),
                name: uniqueName('Untitled 1', this.takenNames()),
                revision: 0,
                edited: Date.now(),
                migrated: true,
                content,
            });
            if (!written)
                return;
            if (leftOut > 0)
                notify(`${leftOut} v0.2 helpers were left out: a set holds at most ${MAX_HELPERS}.`);
            this._changed();
        }
        settings.set_boolean('migrated', true);
    }
}
