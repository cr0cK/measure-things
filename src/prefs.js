import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {colorToHex} from './format.js';

const UNITS = ['css', 'device'];
const UNIT_LABELS = ['CSS pixels', 'Device pixels'];
const SHORTCUTS = [
    ['edit-shortcut', 'Edit helpers'],
    ['pick-color-shortcut', 'Pick color'],
    ['grid-shortcut', 'Column grid'],
];
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

        const shortcutGroup = new Adw.PreferencesGroup({
            title: 'Keyboard shortcuts',
            description: 'For example <Super><Shift>m. Leave empty to disable.',
        });
        page.add(shortcutGroup);
        for (const [key, title] of SHORTCUTS) {
            const row = new Adw.EntryRow({
                title,
                text: settings.get_strv(key)[0] ?? '',
                show_apply_button: true,
            });
            row.connect('changed', () => row.remove_css_class('error'));
            row.connect('apply', () => {
                const text = row.get_text().trim();
                const [valid, keyval, modifiers] = Gtk.accelerator_parse(text);
                if (text && (!valid || keyval === 0)) {
                    row.add_css_class('error');
                    return;
                }
                settings.set_strv(key, text ? [Gtk.accelerator_name(keyval, modifiers)] : []);
            });
            shortcutGroup.add(row);
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
}
