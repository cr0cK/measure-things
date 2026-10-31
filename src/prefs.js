import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {COLOR_FORMATS, colorToHex} from './format.js';

const UNITS = ['css', 'device'];
const UNIT_LABELS = ['CSS pixels', 'Device pixels'];
const COLOR_FORMAT_LABELS = ['Hex', 'RGB', 'HSL'];
const DENSITY_LABELS = ['1x', '2x', '3x', '4x'];
const SHORTCUTS = [
    ['edit-shortcut', 'Edit helpers'],
    ['pick-color-shortcut', 'Pick color'],
    ['grid-shortcut', 'Column grid'],
];
// The keys the overlay handles in edit mode, as Gtk.ShortcutLabel accelerators, with the
// modifier held for arrows apart, so four arrows fit one row.
const ARROWS = 'Left Right Up Down';
const EDIT_KEYS = [
    {title: 'Add a horizontal or vertical guide at the pointer', keys: 'h v'},
    {title: 'Measure the area under the pointer', keys: 'd'},
    {title: 'Add the measured area as a rectangle', keys: 'Return'},
    {title: 'Nudge the selection', keys: ARROWS, subtitle: 'With Shift: 10 pixels.'},
    {title: 'Resize the selected rectangle', hold: '<Alt>', keys: ARROWS, subtitle: 'With Shift: 10 pixels.'},
    {title: 'Select the next or previous helper', keys: 'Tab <Shift>Tab'},
    {title: 'Remove the selection', keys: 'Delete BackSpace'},
    {title: 'Copy the selected size or position', keys: '<Control>c'},
    {title: 'Undo', keys: '<Control>z'},
    {title: 'Redo', keys: '<Control><Shift>z <Control>y'},
    {title: 'Turn off snapping', keys: '<Control>', subtitle: 'Hold while dragging.'},
    {
        title: 'Move the mockup',
        hold: '<Control>',
        keys: ARROWS,
        subtitle: 'With Shift: 10 pixels. A right-drag moves it too.',
    },
    {title: 'Lower or raise the mockup opacity', keys: 'bracketleft bracketright'},
    {title: 'Toggle the column grid', keys: 'g'},
    {title: 'Cancel the current drag, or leave edit mode', keys: 'Escape'},
];
// A global shortcut needs one of these, so it cannot take a key away from typing.
const SHORTCUT_MODIFIERS = Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK |
    Gdk.ModifierType.SUPER_MASK;
const GRID_SETTINGS = [
    ['grid-columns', 'Columns', 1, 24],
    ['grid-gutter', 'Gutter', 0, 400],
    ['grid-margin', 'Side margin', 0, 800],
    ['grid-max-width', 'Maximum width (0 for full width)', 0, 10000],
];

export default class MeasureThingsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);
        // Ctrl+F finds a row among the shortcuts and keys.
        window.search_enabled = true;

        const displayGroup = new Adw.PreferencesGroup({title: 'Display'});
        page.add(displayGroup);
        const unitRow = new Adw.ComboRow({
            title: 'Unit',
            subtitle: 'CSS pixels match a page at 100% browser zoom.',
            model: Gtk.StringList.new(UNIT_LABELS),
            selected: Math.max(0, UNITS.indexOf(settings.get_string('unit'))),
        });
        unitRow.connect('notify::selected', () => settings.set_string('unit', UNITS[unitRow.selected]));
        displayGroup.add(unitRow);
        const zoomRow = Adw.SpinRow.new_with_range(25, 500, 5);
        zoomRow.title = 'Browser zoom (%)';
        zoomRow.subtitle = 'CSS pixel values, the grid, and the mockup follow this zoom level.';
        settings.bind('zoom', zoomRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(zoomRow);

        const rgba = new Gdk.RGBA();
        rgba.parse(settings.get_string('color'));
        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            rgba,
            valign: Gtk.Align.CENTER,
        });
        colorButton.connect('notify::rgba', () => {
            const {red, green, blue} = colorButton.rgba;
            settings.set_string('color', colorToHex({red: red * 255, green: green * 255, blue: blue * 255}));
        });
        const colorRow = new Adw.ActionRow({title: 'Helper color'});
        colorRow.add_suffix(colorButton);
        colorRow.set_activatable_widget(colorButton);
        displayGroup.add(colorRow);

        const formatRow = new Adw.ComboRow({
            title: 'Color format',
            subtitle: 'What the color picker shows and copies; Tab switches it while picking.',
            model: Gtk.StringList.new(COLOR_FORMAT_LABELS),
            selected: Math.max(0, COLOR_FORMATS.indexOf(settings.get_string('color-format'))),
        });
        formatRow.connect('notify::selected', () =>
            settings.set_string('color-format', COLOR_FORMATS[formatRow.selected]));
        settings.connect('changed::color-format', () => {
            formatRow.selected = Math.max(0, COLOR_FORMATS.indexOf(settings.get_string('color-format')));
        });
        displayGroup.add(formatRow);

        page.add(this._mockupGroup(window, settings));

        const gridGroup = new Adw.PreferencesGroup({
            title: 'Column grid',
            description: 'Laid over the focused window, in CSS pixels.',
        });
        page.add(gridGroup);
        for (const [key, title, lower, upper] of GRID_SETTINGS) {
            const row = Adw.SpinRow.new_with_range(lower, upper, 1);
            row.title = title;
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            gridGroup.add(row);
        }

        const shortcutGroup = new Adw.PreferencesGroup({title: 'Keyboard shortcuts'});
        page.add(shortcutGroup);
        for (const [key, title] of SHORTCUTS) {
            const label = new Gtk.ShortcutLabel({disabled_text: 'Disabled', valign: Gtk.Align.CENTER});
            const sync = () => {
                label.accelerator = settings.get_strv(key)[0] ?? '';
            };
            settings.connect(`changed::${key}`, sync);
            sync();
            const row = new Adw.ActionRow({title, activatable: true});
            row.add_suffix(label);
            row.connect('activated', () => this._captureShortcut(row, settings, key, title));
            shortcutGroup.add(row);
        }

        const editKeysGroup = new Adw.PreferencesGroup({title: 'In edit mode'});
        page.add(editKeysGroup);
        for (const {title, subtitle = '', hold, keys} of EDIT_KEYS) {
            const row = new Adw.ActionRow({title, subtitle});
            if (hold) {
                row.add_suffix(new Gtk.ShortcutLabel({accelerator: hold, valign: Gtk.Align.CENTER}));
                row.add_suffix(new Gtk.Label({label: '+', css_classes: ['dim-label']}));
            }
            row.add_suffix(new Gtk.ShortcutLabel({accelerator: keys, valign: Gtk.Align.CENTER}));
            editKeysGroup.add(row);
        }

        const aboutGroup = new Adw.PreferencesGroup({title: 'About'});
        page.add(aboutGroup);
        const versionRow = new Adw.ActionRow({
            title: 'Version',
            subtitle: this.metadata['version-name'] ?? 'Unknown',
            subtitle_selectable: true,
        });
        versionRow.add_css_class('property');
        aboutGroup.add(versionRow);
        const sourceRow = new Adw.ActionRow({
            title: 'Source code',
            subtitle: this.metadata.url,
            activatable: true,
        });
        sourceRow.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        sourceRow.connect('activated', () => {
            new Gtk.UriLauncher({uri: this.metadata.url}).launch(window, null, (launcher, result) => {
                try {
                    launcher.launch_finish(result);
                } catch {
                    console.error('Measure Things: could not open ' + this.metadata.url);
                }
            });
        });
        aboutGroup.add(sourceRow);
    }

    /**
     * Asks for a new global shortcut and stores the first valid combination pressed: Escape
     * cancels, Backspace disables the shortcut.
     */
    _captureShortcut(parent, settings, key, title) {
        const prompt = 'Press the new shortcut, with Ctrl, Alt, or Super. Backspace disables it.';
        const dialog = new Adw.AlertDialog({heading: title, body: prompt});
        dialog.add_response('cancel', 'Cancel');
        const controller = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            const modifiers = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gdk.KEY_Escape && !modifiers) {
                dialog.close();
            } else if (keyval === Gdk.KEY_BackSpace && !modifiers) {
                settings.set_strv(key, []);
                dialog.close();
            } else if (Gtk.accelerator_valid(keyval, modifiers)) {
                if (modifiers & SHORTCUT_MODIFIERS) {
                    settings.set_strv(key, [Gtk.accelerator_name(Gdk.keyval_to_lower(keyval), modifiers)]);
                    dialog.close();
                } else {
                    dialog.body = `${prompt}\n\nA shortcut without Ctrl, Alt, or Super would take the key from typing.`;
                }
            }
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present(parent);
    }

    _mockupGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Mockup',
            description: 'An image laid over the screen at its CSS size. In edit mode, right-drag or ' +
                'Ctrl+arrows move it, and [ and ] change its opacity.',
        });

        const fileRow = new Adw.ActionRow({title: 'Image'});
        const syncFile = () => {
            const path = settings.get_string('mockup-file');
            fileRow.subtitle = path ? GLib.markup_escape_text(path, -1) : 'None';
            clearButton.sensitive = path !== '';
        };
        const chooseButton = new Gtk.Button({label: 'Choose…', valign: Gtk.Align.CENTER});
        const clearButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: 'Remove the image',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        chooseButton.connect('clicked', () => {
            const filter = new Gtk.FileFilter({name: 'Images'});
            filter.add_pixbuf_formats();
            const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
            filters.append(filter);
            const dialog = new Gtk.FileDialog({title: 'Choose a mockup image', filters, default_filter: filter});
            dialog.open(window, null, (_dialog, result) => {
                try {
                    const path = dialog.open_finish(result)?.get_path();
                    if (path) {
                        settings.set_string('mockup-file', path);
                        settings.set_boolean('mockup-visible', true);
                    }
                } catch {
                    // Dismissed.
                }
            });
        });
        clearButton.connect('clicked', () => {
            settings.set_boolean('mockup-visible', false);
            settings.set_string('mockup-file', '');
        });
        fileRow.add_suffix(chooseButton);
        fileRow.add_suffix(clearButton);
        settings.connect('changed::mockup-file', syncFile);
        syncFile();
        group.add(fileRow);

        const showRow = new Adw.SwitchRow({title: 'Show the mockup'});
        settings.bind('mockup-visible', showRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(showRow);

        const opacityRow = Adw.SpinRow.new_with_range(5, 100, 5);
        opacityRow.title = 'Opacity (%)';
        settings.bind('mockup-opacity', opacityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(opacityRow);

        const densityRow = new Adw.ComboRow({
            title: 'Pixel density',
            subtitle: 'Image pixels per CSS pixel: 2x for an image exported at double size.',
            model: Gtk.StringList.new(DENSITY_LABELS),
            selected: settings.get_int('mockup-density') - 1,
        });
        densityRow.connect('notify::selected', () => settings.set_int('mockup-density', densityRow.selected + 1));
        group.add(densityRow);
        return group;
    }
}
