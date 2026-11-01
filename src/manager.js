import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {isLogicalLayout} from './geometry.js';
import {History} from './history.js';
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

/** Tells the user about something that did not happen as asked. */
export function notify(text) {
    Main.notify('Measure Things', text);
}

const stateOf = model => JSON.stringify({name: model.name, content: model.content});

/**
 * The sets on screen and their views, over the sets folder. A model is one set in memory:
 * its file fields, its content with runtime helper ids, its undo history, whether it is hidden,
 * and its main view. Each window shows at most one view.
 */
export class Manager {
    constructor(settings, {onChanged}) {
        this._settings = settings;
        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._onChanged = onChanged;
        this._images = new ImageCache();
        this.models = [];
        this.editing = false;
        // Set by the overlay: a view moved, resized, or left the workspace, or left the screen.
        this.onViewMoved = () => {};
        this.onViewRemoved = () => {};
        this.store = new SetStore({onChanged: () => this._changed()});
        this._mutterSignal = this._mutterSettings.connect('changed::experimental-features',
            () => this._syncViews());
        this.ready = this.store.load()
            .then(() => this._migrate())
            .catch(error => console.warn(`Measure Things: could not read the sets: ${error.message}`));
    }

    destroy() {
        for (const model of this.models)
            model.view?.destroy();
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
        for (const model of this.models)
            model.view?.sync();
    }

    get views() {
        return this.models.map(model => model.view).filter(Boolean);
    }

    /** The sets the menu lists as on screen: not the one a gesture is still creating. */
    get onScreen() {
        return this.models.filter(model => !model.provisional);
    }

    viewOn(window) {
        return this.views.find(view => view.window === window) ?? null;
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
        return [...names];
    }

    _model(set, provisional = false) {
        const content = set.content;
        content.helpers = content.helpers.map((helper, i) => ({...helper, id: i + 1}));
        const nextId = content.helpers.length + 1;
        const model = {...set, content, nextId, hidden: false, view: null, provisional};
        model.history = new History(stateOf(model));
        return model;
    }

    /** Shows a model on a window as its main view, replacing the view already there. */
    _show(model, window) {
        const existing = this.viewOn(window);
        if (existing)
            this.removeFromScreen(existing.model);
        model.view = new View(model, window, {
            settings: this._settings,
            images: this._images,
            isLogical: () => this.isLogical(),
            onClosed: view => this._onWindowClosed(view),
            onMoved: view => this.onViewMoved(view),
        });
        if (this.editing)
            model.view.setEditing(true);
        this.models.push(model);
        this._changed();
        return model.view;
    }

    _onWindowClosed(view) {
        view.detach();
        this.removeFromScreen(view.model);
    }

    /**
     * A set for a window no zone covers, shown as its main view. It is written by its first
     * commit; until then discard() drops it.
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
     * make the file too large is refused and undone.
     */
    commit(model) {
        if (!this.models.includes(model))
            return false;
        const state = stateOf(model);
        if (state === model.history.current) {
            if (model.provisional)
                this.discard(model);
            else
                model.view?.sync();
            return false;
        }
        if (!this._write(model)) {
            this._apply(model, model.history.current);
            return false;
        }
        model.history.record(state);
        return true;
    }

    _write(model) {
        const set = {
            id: model.id,
            name: model.name,
            revision: model.revision + 1,
            edited: Date.now(),
            migrated: model.migrated,
            content: model.content,
        };
        if (fileBytes(serializeSet(set)) > MAX_FILE_BYTES) {
            notify(`“${model.name}” would be larger than 1 MiB: the change was undone.`);
            return false;
        }
        model.revision = set.revision;
        model.edited = set.edited;
        model.provisional = false;
        this.store.write(set);
        model.view?.sync();
        this._changed();
        return true;
    }

    undo(model) {
        this._step(model, model.history.undo());
    }

    redo(model) {
        this._step(model, model.history.redo());
    }

    _step(model, state) {
        if (state === null)
            return;
        this._apply(model, state);
        this._write(model);
    }

    /** Puts back a recorded state. A name taken since then gets a numeric suffix. */
    _apply(model, state) {
        const {name, content} = JSON.parse(state);
        model.name = uniqueName(name, this.takenNames(model));
        model.content = content;
        model.nextId = Math.max(model.nextId, ...content.helpers.map(helper => helper.id + 1));
        const view = model.view;
        if (view) {
            if (!content.helpers.some(helper => helper.id === view.selectedId))
                view.selectedId = null;
            view.sync();
            view.restack();
        }
    }

    setHidden(model, hidden) {
        model.hidden = hidden;
        model.view?.sync();
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

    removeFromScreen(model) {
        const index = this.models.indexOf(model);
        if (index < 0)
            return;
        this.models.splice(index, 1);
        const view = model.view;
        model.view = null;
        if (view) {
            this.onViewRemoved(view);
            view.destroy();
        }
        this._changed();
    }

    /** Loads a set from the library onto a window, as its main view. */
    load(id, window) {
        if (this.modelOf(id))
            return null;
        const set = this.store.get(id);
        if (!set)
            return null;
        const model = this._model(set);
        const view = this._show(model, window);
        // A load counts as an edit for the library's order.
        this._write(model);
        return view;
    }

    /** Renames a set from the library. It is not an undo step: the history keeps the new name. */
    rename(id, name) {
        name = uniqueName(name.trim(), this.takenNames(this.modelOf(id) ?? this.store.get(id)));
        const model = this.modelOf(id);
        if (model) {
            model.name = name;
            model.history.rewrite(state => JSON.stringify({...JSON.parse(state), name}));
            this._write(model);
        } else {
            const set = this.store.get(id);
            if (set)
                this.store.write({...set, name, revision: set.revision + 1, edited: Date.now()});
            this._changed();
        }
    }

    delete(id) {
        const model = this.modelOf(id);
        if (model)
            this.removeFromScreen(model);
        this.store.trash(id);
    }

    /**
     * Saves the current content of a main view's set under a new name, and switches the view to
     * the new set with its undo history. The old set keeps what its file last held.
     */
    async saveAsNew(model, name) {
        name = uniqueName(name.trim(), this.takenNames());
        const set = {
            id: GLib.uuid_string_random(),
            name,
            revision: 0,
            edited: Date.now(),
            migrated: false,
            content: JSON.parse(JSON.stringify(model.content)),
        };
        if (!await this.store.write(set)) {
            notify(`Could not save “${name}”.`);
            return;
        }
        if (!this.models.includes(model))
            return;
        Object.assign(model, {id: set.id, name, revision: 0, edited: set.edited, migrated: false});
        model.history.rewrite(state => JSON.stringify({...JSON.parse(state), name}));
        model.view?.sync();
        this._changed();
    }

    /** The set shown on a window, or a new one when it shows none. */
    modelForWindow(window) {
        return (this.viewOn(window) ?? this.createSet(window)).model;
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
        const content = migrated ? null : migrateSettings({
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
        if (content) {
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
            this._changed();
        }
        settings.set_boolean('migrated', true);
    }
}
