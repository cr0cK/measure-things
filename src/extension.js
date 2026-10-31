import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {copyToClipboard, Overlay} from './overlay.js';
import {ColorPicker} from './picker.js';

const SHORTCUTS = ['edit-shortcut', 'pick-color-shortcut', 'grid-shortcut'];

export default class MeasureThingsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._picker = null;

        this._indicator = new PanelMenu.Button(0.5, this.metadata.name, false);
        const icon = new St.Icon({
            gicon: Gio.FileIcon.new(this.dir.get_child('measure-things-symbolic.svg')),
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(icon);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._buildMenu();

        this._overlay = new Overlay(this._settings, {onStateChanged: () => this._syncMenu()});
        // Edit mode and the picker capture the screen at once, so an open menu must go first.
        const handlers = {
            'edit-shortcut': () => {
                this._closeMenu();
                return this._picker || this._overlay.toggleEdit();
            },
            'pick-color-shortcut': () => {
                this._closeMenu();
                this._pickColor();
            },
            'grid-shortcut': () => this._picker || this._overlay.toggleGrid(),
        };
        for (const name of SHORTCUTS) {
            Main.wm.addKeybinding(
                name,
                this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
                handlers[name]
            );
        }
        this._settingsSignals = ['show-helpers', 'mockup-file', 'mockup-visible'].map(key =>
            this._settings.connect(`changed::${key}`, () => this._syncMenu()));
        this._syncMenu();
    }

    disable() {
        for (const name of SHORTCUTS)
            Main.wm.removeKeybinding(name);
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._picker?.cancel();
        this._picker = null;
        this._overlay.destroy();
        this._overlay = null;
        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }

    _buildMenu() {
        const menu = this._indicator.menu;
        // A menu only starts closing after its action runs, which would capture it.
        const closingMenu = action => () => {
            this._closeMenu();
            action();
        };
        this._editItem = menu.addAction('Edit helpers', closingMenu(() => this._overlay.toggleEdit()));
        menu.addAction('Add vertical guide', closingMenu(() => this._overlay.addGuide('vertical')));
        menu.addAction('Add horizontal guide', closingMenu(() => this._overlay.addGuide('horizontal')));
        menu.addAction('Pick color', closingMenu(() => this._pickColor()));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._gridItem = new PopupMenu.PopupSwitchMenuItem('Column grid', false);
        // setToggleState() emits toggled too, so act only on a real change.
        this._gridItem.connect('toggled', (_item, state) => {
            if (state !== this._overlay.gridVisible)
                this._overlay.toggleGrid();
        });
        menu.addMenuItem(this._gridItem);
        this._showItem = new PopupMenu.PopupSwitchMenuItem('Show helpers', true);
        this._showItem.connect('toggled', (_item, state) => {
            if (state !== this._settings.get_boolean('show-helpers'))
                this._settings.set_boolean('show-helpers', state);
        });
        menu.addMenuItem(this._showItem);
        this._mockupItem = new PopupMenu.PopupSwitchMenuItem('Mockup', false);
        this._mockupItem.connect('toggled', (_item, state) => {
            if (state !== this._settings.get_boolean('mockup-visible'))
                this._settings.set_boolean('mockup-visible', state);
        });
        menu.addMenuItem(this._mockupItem);
        this._clearItem = menu.addAction('Clear helpers', () => this._overlay.clear());

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Preferences', () => this.openPreferences());
    }

    _closeMenu() {
        this._indicator.menu.close(BoxPointer.PopupAnimation.NONE);
    }

    _syncMenu() {
        if (!this._overlay)
            return;
        this._editItem.label.text = this._overlay.editing ? 'Stop editing' : 'Edit helpers';
        this._gridItem.setToggleState(this._overlay.gridVisible);
        this._showItem.setToggleState(this._settings.get_boolean('show-helpers'));
        this._mockupItem.setToggleState(this._settings.get_boolean('mockup-visible'));
        // Without an image the switch would do nothing; the preferences choose one.
        this._mockupItem.setSensitive(this._settings.get_string('mockup-file') !== '');
        this._clearItem.setSensitive(this._overlay.hasHelpers);
    }

    async _pickColor() {
        if (this._picker)
            return;

        const overlay = this._overlay;
        const editing = overlay.editing;
        overlay.exitEdit();
        overlay.setHidden(true);
        const picker = new ColorPicker(this._settings);
        this._picker = picker;
        const color = await picker.pick();
        // disable() cancels the picker, and a quick enable() may already have replaced both.
        if (this._picker !== picker || this._overlay !== overlay)
            return;

        this._picker = null;
        overlay.setHidden(false);
        // Before the confirmation shows, so edit mode does not capture it.
        if (editing)
            overlay.enterEdit();
        if (color)
            copyToClipboard(color, 'color-select-symbolic');
    }
}
