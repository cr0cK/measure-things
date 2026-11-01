import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {askConfirm, askName, closeDialogs, editSetSettings} from './dialogs.js';
import {formatAccelerator, formatEdited} from './format.js';
import {Manager} from './manager.js';
import {copyToClipboard, Overlay} from './overlay.js';
import {ColorPicker} from './picker.js';
import {uniqueName} from './sets.js';

const SHORTCUTS = ['edit-shortcut', 'pick-color-shortcut', 'grid-shortcut'];
// The grid shortcut acts on windows a view can show on.
const GRID_WINDOW_TYPES = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY];

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

        this._manager = new Manager(this._settings, {onChanged: () => this._syncMenu()});
        this._overlay = new Overlay(this._settings, this._manager, {
            onStateChanged: () => this._syncMenu(),
            onSettings: model => this._editSettings(model),
            onSaveAs: model => this._saveAs(model),
        });
        this._buildMenu();

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
            'grid-shortcut': () => this._picker || this._toggleFocusedGrid(),
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
        this._settingsSignals = SHORTCUTS.map(key =>
            this._settings.connect(`changed::${key}`, () => this._syncShortcuts()));
        this._syncShortcuts();
        this._syncMenu();
    }

    disable() {
        closeDialogs();
        for (const name of SHORTCUTS)
            Main.wm.removeKeybinding(name);
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._picker?.cancel();
        this._picker = null;
        this._overlay.destroy();
        this._overlay = null;
        this._manager.destroy();
        this._manager = null;
        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }

    /** Toggles the grid of the set on the focused window, creating a set when it shows none. */
    _toggleFocusedGrid() {
        const window = global.display.focus_window;
        if (!window || !GRID_WINDOW_TYPES.includes(window.get_window_type()))
            return;
        this._manager.toggleGrid(this._manager.modelForWindow(window));
    }

    _buildMenu() {
        const menu = this._indicator.menu;
        // A menu only starts closing after its action runs, which would capture it.
        const closingMenu = action => () => {
            this._closeMenu();
            action();
        };
        this._editItem = this._shortcutItem('Edit helpers', closingMenu(() => this._overlay.toggleEdit()));
        this._pickItem = this._shortcutItem('Pick color', closingMenu(() => this._pickColor()));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._onScreen = this._listSection('On screen');
        this._onScreenSeparator = new PopupMenu.PopupSeparatorMenuItem();
        menu.addMenuItem(this._onScreenSeparator);
        this._library = this._listSection('Sets');
        menu.addAction('Open sets folder', () => {
            Gio.AppInfo.launch_default_for_uri_async(this._manager.store.folder.get_uri(), null, null, null);
        });
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Settings', () => this.openPreferences());
        menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._syncMenu();
        });
    }

    _shortcutItem(label, action) {
        const item = new PopupMenu.PopupMenuItem(label);
        const keys = new St.Label({
            style_class: 'measure-things-menu-shortcut',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.add_child(keys);
        item.connect('activate', action);
        this._indicator.menu.addMenuItem(item);
        item.keys = keys;
        return item;
    }

    /** A titled list that scrolls past five rows. */
    _listSection(title) {
        const menu = this._indicator.menu;
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        header.label = new St.Label({text: title, style_class: 'measure-things-menu-header', x_expand: true});
        header.count = new St.Label({style_class: 'measure-things-menu-header'});
        header.add_child(header.label);
        header.add_child(header.count);
        menu.addMenuItem(header);
        const holder = new PopupMenu.PopupMenuSection();
        const scroll = new St.ScrollView({
            style_class: 'measure-things-menu-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
        });
        const section = new PopupMenu.PopupMenuSection();
        scroll.set_child(section.actor);
        holder.actor.add_child(scroll);
        menu.addMenuItem(holder);
        section._setParent(holder);
        return {header, holder, section};
    }

    _closeMenu() {
        this._indicator.menu.close(BoxPointer.PopupAnimation.NONE);
    }

    _syncShortcuts() {
        const keys = key => formatAccelerator(this._settings.get_strv(key)[0] ?? '');
        this._editItem.keys.text = keys('edit-shortcut');
        this._pickItem.keys.text = keys('pick-color-shortcut');
    }

    _syncMenu() {
        if (!this._manager || !this._indicator.menu.isOpen)
            return;
        this._syncOnScreen();
        this._syncLibrary();
    }

    _syncOnScreen() {
        const {section, header, holder} = this._onScreen;
        section.removeAll();
        const models = this._manager.onScreen;
        for (const visible of [header, holder, this._onScreenSeparator])
            visible.actor.visible = models.length > 0;
        for (const model of models) {
            const item = new PopupMenu.PopupBaseMenuItem({style_class: 'measure-things-set-row'});
            item.add_child(new St.Widget({
                style_class: 'measure-things-set-dot',
                style: `background-color: ${model.content.color};`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const title = model.view?.window.get_title() || 'Untitled window';
            item.add_child(this._titles(model.name,
                `main only · ${title}${model.hidden ? ' · hidden' : ''}`));
            const eye = this._rowButton(model.hidden ? 'view-conceal-symbolic' : 'view-reveal-symbolic',
                model.hidden ? 'Show' : 'Hide', () => this._manager.setHidden(model, !model.hidden));
            const remove = this._rowButton('window-close-symbolic', 'Remove from screen',
                () => this._manager.removeFromScreen(model));
            item.add_child(eye);
            item.add_child(remove);
            item.connect('activate', () => this._showSet(model));
            item.set = model;
            section.addMenuItem(item);
        }
    }

    _syncLibrary() {
        const {section, header} = this._library;
        section.removeAll();
        const entries = this._manager.store.entries();
        header.count.text = `${entries.length}`;
        const onScreen = new Set(this._manager.onScreen.map(model => model.id));
        const now = Date.now();
        if (entries.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('No sets yet. Draw on a window to start one.',
                {reactive: false, can_focus: false});
            empty.label.add_style_class_name('measure-things-menu-subtitle');
            section.addMenuItem(empty);
        }
        for (const entry of entries) {
            const item = new PopupMenu.PopupBaseMenuItem({style_class: 'measure-things-set-row'});
            const shown = onScreen.has(entry.id);
            item.add_child(this._titles(entry.name, entry.unavailable ? 'unavailable' : formatEdited(entry.edited, now)));
            item.entry = entry;
            section.addMenuItem(item);
            if (entry.unavailable) {
                item.setSensitive(false);
                continue;
            }
            if (shown) {
                item.add_child(new St.Label({
                    text: 'On screen',
                    style_class: 'measure-things-pill',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                continue;
            }
            const actions = new St.BoxLayout({style_class: 'measure-things-row-actions', opacity: 0});
            actions.add_child(this._rowButton('document-edit-symbolic', 'Rename', () => this._rename(entry)));
            actions.add_child(this._rowButton('user-trash-symbolic', 'Delete', () => this._delete(entry)));
            item.add_child(actions);
            item.connect('notify::active', () => {
                actions.opacity = item.active ? 255 : 0;
            });
            item.connect('activate', () => this._load(entry));
        }
    }

    _titles(title, subtitle) {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(new St.Label({text: title, style_class: 'measure-things-menu-title'}));
        box.add_child(new St.Label({text: subtitle, style_class: 'measure-things-menu-subtitle'}));
        return box;
    }

    _rowButton(iconName, accessibleName, action) {
        const button = new St.Button({
            style_class: 'measure-things-row-button',
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
            accessible_name: accessibleName,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', action);
        return button;
    }

    /** Activates a set's window, then edits it with its badge menu open. */
    _showSet(model) {
        this._closeMenu();
        const view = model.view;
        if (!view)
            return;
        if (model.hidden)
            this._manager.setHidden(model, false);
        Main.activateWindow(view.window);
        if (this._picker || !this._overlay.enterEdit())
            return;
        this._overlay.openBadgeMenu(view);
    }

    async _load(entry) {
        this._closeMenu();
        if (this._picker)
            return;
        const window = await this._overlay.pickWindow(entry.name);
        if (window && this._manager)
            this._manager.load(entry.id, window);
    }

    async _rename(entry) {
        this._closeMenu();
        const name = await askName({title: 'Rename set', name: entry.name, actionLabel: 'Rename'});
        if (name && this._manager)
            this._manager.rename(entry.id, name);
    }

    async _delete(entry) {
        this._closeMenu();
        const model = this._manager.modelOf(entry.id);
        const confirmed = await askConfirm({
            title: `Delete “${entry.name}”?`,
            description: model ? 'Its view will leave the screen. The file moves to the trash.'
                : 'The file moves to the trash.',
            actionLabel: 'Delete',
        });
        if (confirmed && this._manager)
            this._manager.delete(entry.id);
    }

    async _editSettings(model) {
        const draft = await editSetSettings(model, {onChooserOpen: () => this._overlay?.exitEdit()});
        if (!draft || !this._manager?.models.includes(model))
            return;
        const {content} = model;
        model.name = uniqueName(draft.name, this._manager.takenNames(model));
        content.color = draft.color;
        content.zoom = draft.zoom;
        Object.assign(content.grid, draft.grid);
        // A new image shows at once, and removing it turns the mockup off.
        if (draft.mockup.file !== content.mockup.file)
            content.mockup.visible = draft.mockup.file !== '';
        Object.assign(content.mockup, draft.mockup);
        this._manager.commit(model);
    }

    async _saveAs(model) {
        const name = await askName({
            title: 'Save as new set',
            name: uniqueName(model.name, this._manager.takenNames()),
            actionLabel: 'Save',
        });
        if (name && this._manager?.models.includes(model))
            await this._manager.saveAsNew(model, name);
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
