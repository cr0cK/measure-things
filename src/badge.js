import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {MAX_NAME_LENGTH, TOLERANCES} from './sets.js';

const TOLERANCE_LABELS = {low: 'Low', medium: 'Medium', high: 'High'};

/** `1 local change`, `3 local changes`. */
function localChanges(count) {
    return `${count} local change${count === 1 ? '' : 's'}`;
}

/** The state under a main view's name: its last write worked or failed. */
function savedText(model) {
    return `Main view · ${model.saved ? 'saved' : 'not saved'}`;
}

/**
 * The menu of a view's badge, anchored to the badge: the set's chips and actions on the main
 * view, linking and removal on a copy. It takes its own grab above edit mode's, and closes with
 * Escape, a click outside, or an action.
 */
export class BadgeMenu {
    constructor(view, {manager, onSettings, onSaveAs, onAddCopy, onFind, onTolerance, onClosed}) {
        this._view = view;
        this.view = view;
        this._manager = manager;
        this._destroyId = 0;
        this._confirmRow = null;
        // The entry that edits the main view's name, while it does.
        this._nameEntry = null;
        this._titleButton = null;

        this.menu = new PopupMenu.PopupMenu(view.badgeActor, 0.5, St.Side.BOTTOM);
        this.menu.actor.add_style_class_name('measure-things-badge-menu');
        Main.uiGroup.add_child(this.menu.actor);
        // Escape on the name entry leaves it, and on a confirmation that asks for it cancels the
        // confirmation, not the menu. The menu manager closes the menu on Escape from the same
        // signal, so this is connected first. A press anywhere in the menu but the entry ends the
        // edit, before the item under it handles the click.
        this.menu.actor.connect('captured-event', (_actor, event) => {
            const type = event.type();
            if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
                const target = global.stage.get_event_actor(event);
                if (this._nameEntry && !(target && this._nameEntry.contains(target)))
                    this._endNameEdit(true);
                return Clutter.EVENT_PROPAGATE;
            }
            if (type !== Clutter.EventType.KEY_PRESS || event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            if (this._nameEntry) {
                this._endNameEdit(false);
                return Clutter.EVENT_STOP;
            }
            if (!this._confirmRow || !this._escapeCancels)
                return Clutter.EVENT_PROPAGATE;
            this._confirmRow.destroy();
            return Clutter.EVENT_STOP;
        });
        this._menuManager = new PopupMenu.PopupMenuManager(view.badgeActor);
        this._menuManager.addMenu(this.menu);
        if (view.isMain)
            this._buildMain(view, {onSettings, onSaveAs, onAddCopy, onFind, onTolerance});
        else
            this._buildCopy(view, {onSaveAs});

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open || this._destroyId)
                return;
            this._endNameEdit(true);
            onClosed();
            // An action closes the menu while its item still handles the click.
            this._destroyId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._destroyId = 0;
                this.destroy();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    /** The header: a title, which a click turns into a text entry when `onTitle` is given, and a subtitle. */
    _header(title, subtitle, onTitle = null) {
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const titles = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this._titles = titles;
        this._title = new St.Label({text: title, style_class: 'measure-things-menu-title'});
        if (onTitle) {
            this._titleButton = new St.Button({
                child: this._title,
                can_focus: true,
                x_align: Clutter.ActorAlign.START,
                style_class: 'measure-things-menu-title-button',
            });
            this._titleButton.connect('clicked', onTitle);
            titles.add_child(this._titleButton);
        } else {
            titles.add_child(this._title);
        }
        const label = new St.Label({text: subtitle, style_class: 'measure-things-menu-subtitle'});
        titles.add_child(label);
        header.add_child(titles);
        this.menu.addMenuItem(header);
        return label;
    }

    /** Turns the main view's name into a text entry holding it, selected. */
    _startNameEdit() {
        if (this._nameEntry || !this.menu)
            return;
        // A confirmation in the menu goes: the edit is what the user does now.
        this._confirmRow?.destroy();
        const entry = new St.Entry({
            text: this._view.model.name,
            can_focus: true,
            x_expand: true,
            style_class: 'measure-things-entry measure-things-title-entry',
        });
        entry.clutter_text.max_length = MAX_NAME_LENGTH;
        entry.clutter_text.connect('activate', () => this._endNameEdit(true, {keepFocus: true}));
        this._nameEntry = entry;
        this._titleButton.hide();
        this._titles.insert_child_at_index(entry, 0);
        entry.grab_key_focus();
        entry.clutter_text.set_selection(0, -1);
    }

    /**
     * Leaves the name entry. With `apply`, the set takes the name it holds as Set settings would:
     * one commit, one undo step. Without it, the name is dropped. The menu manager's grab needs the
     * key focus back in the menu once the entry is gone.
     */
    _endNameEdit(apply, {keepFocus = true} = {}) {
        const entry = this._nameEntry;
        if (!entry)
            return;
        this._nameEntry = null;
        const text = entry.text;
        entry.destroy();
        this._titleButton?.show();
        const model = this._view.model;
        if (apply && this._manager.models.includes(model)) {
            this._manager.setName(model, text);
            this._manager.commit(model);
        }
        if (this._title)
            this._title.text = model.name;
        if (keepFocus && this.menu?.isOpen)
            this.menu.actor.grab_key_focus();
    }

    _buildMain(view, {onSettings, onSaveAs, onAddCopy, onFind, onTolerance}) {
        const model = view.model;
        const manager = this._manager;
        this._saved = this._header(model.name, savedText(model), () => this._startNameEdit());

        const chips = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({style_class: 'measure-things-chips'});
        const {content} = model;
        this.chips = {
            helpers: this._chip(box, 'Helpers', content.helpersVisible, true,
                () => (content.helpersVisible = !content.helpersVisible)),
            grid: this._chip(box, 'Grid', content.grid.visible, true,
                () => (content.grid.visible = !content.grid.visible)),
            mockup: this._chip(box, 'Mockup', content.mockup.visible, content.mockup.file !== '',
                () => (content.mockup.visible = !content.mockup.visible)),
        };
        chips.add_child(box);
        this.menu.addMenuItem(chips);

        this._buildFind(view, {onFind, onTolerance});
        this.menu.addAction('Add a copy…', () => onAddCopy(model));
        this.menu.addAction('Set settings…', () => onSettings(model));
        this.menu.addAction('Save as new set…', () => onSaveAs(view));
        this._resetItem(view);
        const clear = this.menu.addAction('Clear helpers', () => {
            model.content.helpers = [];
            view.selectedId = null;
            manager.commit(model);
        });
        clear.setSensitive(content.helpers.length > 0);
    }

    /**
     * Find helpers and its Tolerance list. Find helpers is not an action item, which would close
     * the menu: with helpers on the set it asks first, in the menu, and a run closes it.
     */
    _buildFind(view, {onFind, onTolerance}) {
        const model = view.model;
        this.findItem = new PopupMenu.PopupMenuItem('Find helpers');
        this.findItem.activate = () => {
            const count = model.content.helpers.length;
            if (count === 0) {
                onFind(view);
                return;
            }
            this._confirm(`Replace the ${count} helper${count === 1 ? '' : 's'} with the ones found?`,
                [['Cancel', () => {}], ['Replace', () => onFind(view)]], {escapeCancels: true});
        };
        this.menu.addMenuItem(this.findItem);

        const row = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({style_class: 'measure-things-chips', x_expand: true});
        box.add_child(new St.Label({
            text: 'Tolerance',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'measure-things-menu-subtitle',
        }));
        this.tolerances = {};
        for (const level of TOLERANCES) {
            const button = new St.Button({
                label: TOLERANCE_LABELS[level],
                style_class: 'measure-things-chip-button',
                toggle_mode: true,
                checked: model.content.tolerance === level,
                can_focus: true,
            });
            button.connect('clicked', () => {
                onTolerance(view, level);
                this._syncTolerance();
            });
            this.tolerances[level] = button;
            box.add_child(button);
        }
        row.add_child(box);
        this.menu.addMenuItem(row);
    }

    /** Checks the tolerance the set has: a click that ran Find helpers may have kept the old one. */
    _syncTolerance() {
        if (!this.menu)
            return;
        for (const [level, button] of Object.entries(this.tolerances))
            button.checked = this._view.model.content.tolerance === level;
    }

    /** Brings the header up to date after a write ended. */
    refreshSaved() {
        if (this._saved && this.menu)
            this._saved.text = savedText(this._view.model);
    }

    _resetItem(view) {
        const reset = this.menu.addAction('Reset zone', () => view.setZone(null));
        reset.setSensitive(view.fixed);
    }

    _buildCopy(view, {onSaveAs}) {
        const manager = this._manager;
        this._subtitle = this._header(`Copy of ${view.set.name}`, this._status());
        this._link = new PopupMenu.PopupSwitchMenuItem('Linked', view.linked);
        // setToggleState() emits `toggled` too: act only on a state the view does not have yet.
        this._link.connect('toggled', (_item, state) => {
            if (state === view.linked)
                return;
            if (!state) {
                manager.unlink(view);
            } else if (view.local.localChanges === 0) {
                manager.relink(view);
            } else {
                this._link.setToggleState(false);
                this._confirm(`Discard ${localChanges(view.local.localChanges)} and follow the main view?`,
                    [['Keep', () => {}], ['Discard', () => manager.relink(view), true]]);
                return;
            }
            this._refresh();
        });
        // A click toggles the switch and keeps the menu open, for the confirmation of a relink.
        this._link.activate = () => this._link.toggle();
        this.menu.addMenuItem(this._link);
        this._resetItem(view);
        this._saveItem = this.menu.addAction('Save as new set…', () => onSaveAs(view));
        // Not an action item: an action closes the menu, and a copy with changes asks first.
        const remove = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this.removeButton = new St.Button({
            label: 'Remove copy',
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            style_class: 'measure-things-danger',
        });
        this.removeButton.connect('clicked', () => this._removeCopy(view));
        remove.add_child(this.removeButton);
        this.menu.addMenuItem(remove);
        this._refresh();
    }

    _status() {
        const view = this._view;
        if (view.linked)
            return 'Follows the main view';
        const count = view.local.localChanges;
        return count === 0 ? 'Unlinked' : `Unlinked · ${localChanges(count)}`;
    }

    /** Brings the header and the unlinked-only item up to date after linking changes. */
    _refresh() {
        this._subtitle.text = this._status();
        this._saveItem.actor.visible = !this._view.linked;
    }

    /** Removes a copy; one with local changes asks first, in the menu. */
    _removeCopy(view) {
        if (view.linked || view.local.localChanges === 0) {
            this._manager.removeCopy(view);
            this.menu?.close(BoxPointer.PopupAnimation.NONE);
            return;
        }
        this._confirm(`Remove this copy? Its ${localChanges(view.local.localChanges)} will be lost.`,
            [['Cancel', () => {}], ['Remove', () => this._manager.removeCopy(view), true]]);
    }

    /**
     * A light confirmation in place, under the header: a question and two buttons, the second
     * being the action. Either one closes the menu; the first leaves everything as it was.
     */
    _confirm(text, [[cancelLabel, onCancel], [actionLabel, onAction]], {escapeCancels = false} = {}) {
        this._confirmRow?.destroy();
        this._escapeCancels = escapeCancels;
        const row = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        row.add_style_class_name('measure-things-confirm');
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const label = new St.Label({text, style_class: 'measure-things-confirm-text'});
        label.clutter_text.line_wrap = true;
        box.add_child(label);
        const buttons = new St.BoxLayout({x_align: Clutter.ActorAlign.END, style_class: 'measure-things-confirm-buttons'});
        const entries = [[cancelLabel, onCancel, false], [actionLabel, onAction, true]];
        for (const [buttonLabel, action, danger] of entries) {
            const button = new St.Button({
                label: buttonLabel,
                can_focus: true,
                style_class: `measure-things-confirm-button${danger ? ' measure-things-confirm-action' : ''}`,
            });
            button.connect('clicked', () => {
                action();
                this.menu?.close(BoxPointer.PopupAnimation.NONE);
            });
            buttons.add_child(button);
        }
        box.add_child(buttons);
        row.add_child(box);
        this._confirmRow = row;
        row.connect('destroy', () => {
            if (this._confirmRow === row)
                this._confirmRow = null;
        });
        this.menu.addMenuItem(row, 2);
    }

    _chip(box, label, checked, sensitive, toggle) {
        const chip = new St.Button({
            label,
            style_class: 'measure-things-chip-button',
            toggle_mode: true,
            checked,
            can_focus: sensitive,
            reactive: sensitive,
        });
        chip.connect('clicked', () => {
            toggle();
            this._manager.commit(this._view.model);
        });
        box.add_child(chip);
        return chip;
    }

    open() {
        this.menu.open(BoxPointer.PopupAnimation.NONE);
    }

    /**
     * Closes the menu. A name being edited is dropped, as the set may be gone or replaced; with
     * `apply`, the set takes it, as when the user closes the menu.
     */
    close({apply = false} = {}) {
        this._endNameEdit(apply, {keepFocus: false});
        this.menu?.close(BoxPointer.PopupAnimation.NONE);
        this.destroy();
    }

    /** Closes the menu from inside one of its items: it is destroyed once the click is handled. */
    dismiss() {
        this.menu?.close(BoxPointer.PopupAnimation.NONE);
    }

    destroy() {
        if (this._destroyId)
            GLib.source_remove(this._destroyId);
        this._destroyId = 0;
        this._nameEntry = null;
        if (!this.menu)
            return;
        const menu = this.menu;
        this.menu = null;
        this._menuManager.removeMenu(menu);
        menu.destroy();
    }
}
