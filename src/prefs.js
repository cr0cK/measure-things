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
