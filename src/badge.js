import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

/**
 * The menu of a main view's badge, anchored to the badge: the set's chips and actions. It takes
 * its own grab above edit mode's, and closes with Escape, a click outside, or an action.
 */
export class BadgeMenu {
    constructor(view, {manager, onSettings, onSaveAs, onClosed}) {
        this._view = view;
        this.view = view;
        this._manager = manager;
        this._destroyId = 0;
        const model = view.model;

        this.menu = new PopupMenu.PopupMenu(view.badgeActor, 0.5, St.Side.BOTTOM);
        this.menu.actor.add_style_class_name('measure-things-badge-menu');
        Main.uiGroup.add_child(this.menu.actor);
        this._menuManager = new PopupMenu.PopupMenuManager(view.badgeActor);
        this._menuManager.addMenu(this.menu);

        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const titles = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        titles.add_child(new St.Label({text: model.name, style_class: 'measure-things-menu-title'}));
        titles.add_child(new St.Label({text: 'Main view · saved', style_class: 'measure-things-menu-subtitle'}));
        header.add_child(titles);
        this.menu.addMenuItem(header);

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

        this.menu.addAction('Set settings…', () => onSettings(model));
        this.menu.addAction('Save as new set…', () => onSaveAs(model));
        const clear = this.menu.addAction('Clear helpers', () => {
            model.content.helpers = [];
            view.selectedId = null;
            manager.commit(model);
        });
        clear.setSensitive(content.helpers.length > 0);

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
