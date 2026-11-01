import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {COLOR_FORMATS} from './format.js';

const UNITS = ['css', 'device'];
const UNIT_LABELS = ['CSS pixels', 'Device pixels'];
const COLOR_FORMAT_LABELS = ['Hex', 'RGB', 'HSL'];
const SHORTCUTS = [
    ['edit-shortcut', 'Edit helpers'],
    ['pick-color-shortcut', 'Pick color'],
    ['grid-shortcut', 'Column grid', 'Toggles the grid of the set on the focused window.'],
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
            subtitle: 'CSS pixels follow the browser zoom of each set.',
            model: Gtk.StringList.new(UNIT_LABELS),
            selected: Math.max(0, UNITS.indexOf(settings.get_string('unit'))),
        });
        unitRow.connect('notify::selected', () => settings.set_string('unit', UNITS[unitRow.selected]));
        displayGroup.add(unitRow);
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

        const badgeGroup = new Adw.PreferencesGroup({title: 'Corner badges'});
        page.add(badgeGroup);
        const badgeRow = new Adw.SwitchRow({
            title: 'Show outside edit mode',
            subtitle: 'Badges never take clicks outside edit mode.',
        });
        settings.bind('show-badges', badgeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        badgeGroup.add(badgeRow);

        const shortcutGroup = new Adw.PreferencesGroup({title: 'Keyboard shortcuts'});
        page.add(shortcutGroup);
        for (const [key, title, subtitle = ''] of SHORTCUTS) {
            const label = new Gtk.ShortcutLabel({disabled_text: 'Disabled', valign: Gtk.Align.CENTER});
            const sync = () => {
                label.accelerator = settings.get_strv(key)[0] ?? '';
            };
            settings.connect(`changed::${key}`, sync);
            sync();
            const row = new Adw.ActionRow({title, subtitle, activatable: true});
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
}
