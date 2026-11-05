import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

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
    constructor(view, {manager, onSettings, onSaveAs, onAddCopy, onClosed}) {
        this._view = view;
        this.view = view;
        this._manager = manager;
        this._destroyId = 0;
        this._confirmRow = null;

        this.menu = new PopupMenu.PopupMenu(view.badgeActor, 0.5, St.Side.BOTTOM);
        this.menu.actor.add_style_class_name('measure-things-badge-menu');
        Main.uiGroup.add_child(this.menu.actor);
        this._menuManager = new PopupMenu.PopupMenuManager(view.badgeActor);
        this._menuManager.addMenu(this.menu);

        if (view.isMain)
            this._buildMain(view, {onSettings, onSaveAs, onAddCopy});
        else
            this._buildCopy(view, {onSaveAs});

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open || this._destroyId)
                return;
            onClosed();
            // An action closes the menu while its item still handles the click.
            this._destroyId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._destroyId = 0;
                this.destroy();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _header(title, subtitle) {
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const titles = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        titles.add_child(new St.Label({text: title, style_class: 'measure-things-menu-title'}));
        const label = new St.Label({text: subtitle, style_class: 'measure-things-menu-subtitle'});
        titles.add_child(label);
        header.add_child(titles);
        this.menu.addMenuItem(header);
        return label;
    }

    _buildMain(view, {onSettings, onSaveAs, onAddCopy}) {
        const model = view.model;
        const manager = this._manager;
        this._saved = this._header(model.name, savedText(model));

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
    _confirm(text, [[cancelLabel, onCancel], [actionLabel, onAction]]) {
        this._confirmRow?.destroy();
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

    close() {
        this.menu?.close(BoxPointer.PopupAnimation.NONE);
        this.destroy();
    }

    destroy() {
        if (this._destroyId)
            GLib.source_remove(this._destroyId);
        this._destroyId = 0;
        if (!this.menu)
            return;
        const menu = this.menu;
        this.menu = null;
        this._menuManager.removeMenu(menu);
        menu.destroy();
    }
}
