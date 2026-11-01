import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {notify} from './manager.js';
import {chooseImage} from './portal.js';
import {DENSITY_RANGE, GRID_RANGES, MAX_NAME_LENGTH, OPACITY_RANGE, PALETTE, ZOOM_RANGE} from './sets.js';

// Open dialogs, which disabling the extension closes without saving.
const openDialogs = new Set();

export function closeDialogs() {
    for (const dialog of [...openDialogs])
        dialog.close();
}

const MeasureDialog = GObject.registerClass(
    class MeasureThingsDialog extends ModalDialog.ModalDialog {
        _init() {
            super._init({styleClass: 'measure-things-dialog'});
            openDialogs.add(this);
            this.connect('destroy', () => openDialogs.delete(this));
        }
    });

/** Opens a dialog and resolves with what `build(dialog, finish)` finishes it with. */
function runDialog(build, cancelled) {
    return new Promise(resolve => {
        const dialog = new MeasureDialog();
        let done = false;
        const finish = value => {
            if (done)
                return;
            done = true;
            dialog.close();
            resolve(value);
        };
        dialog.connect('destroy', () => finish(cancelled));
        build(dialog, finish);
        if (!dialog.open()) {
            dialog.destroy();
            finish(cancelled);
        }
    });
}

function addEntry(parent, text, params = {}) {
    const entry = new St.Entry({style_class: 'measure-things-entry', text, can_focus: true, x_expand: true, ...params});
    parent.add_child(entry);
    return entry;
}

function addField(parent, title, child) {
    const field = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'measure-things-field'});
    field.add_child(new St.Label({text: title, style_class: 'measure-things-field-title'}));
    field.add_child(child);
    parent.add_child(field);
    return field;
}

/** Asks for a set name; resolves with the trimmed name, or null when cancelled. */
export function askName({title, name, actionLabel}) {
    return runDialog((dialog, finish) => {
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({title}));
        const entry = addEntry(dialog.contentLayout, name);
        entry.clutter_text.max_length = MAX_NAME_LENGTH;
        const accept = () => {
            if (entry.text.trim())
                finish(entry.text.trim());
        };
        entry.clutter_text.connect('activate', accept);
        dialog.setButtons([
            {label: 'Cancel', action: () => finish(null), key: Clutter.KEY_Escape},
            {label: actionLabel, action: accept},
        ]);
        dialog.setInitialKeyFocus(entry);
        entry.clutter_text.set_selection(0, -1);
    }, null);
}

/** Asks to confirm an action; resolves with whether it was confirmed. */
export function askConfirm({title, description, actionLabel}) {
    return runDialog((dialog, finish) => {
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({title, description}));
        dialog.setButtons([
            {label: 'Cancel', action: () => finish(false), key: Clutter.KEY_Escape},
            {label: actionLabel, action: () => finish(true), default: true},
        ]);
        dialog.buttonLayout.get_last_child().add_style_class_name('measure-things-destructive');
    }, false);
}

/** An integer from an entry, clamped to a range, or `fallback` when it is not a number. */
function readInteger(entry, [min, max], fallback) {
    const value = Number.parseInt(entry.text, 10);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * The Set settings dialog. Resolves with the edited name, color, zoom, grid, and mockup, or null
 * when cancelled. While the file chooser is open, the dialog hides and releases its grab, and
 * `onChooserOpen` runs first.
 */
export function editSetSettings(model, {onChooserOpen}) {
    const {content} = model;
    const draft = {color: content.color, file: content.mockup.file, density: content.mockup.density};
    const cancellable = new Gio.Cancellable();
    return runDialog((dialog, finish) => {
        dialog.connect('destroy', () => cancellable.cancel());
        const layout = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'measure-things-settings',
        });
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({title: 'Set settings'}));
        dialog.contentLayout.add_child(layout);

        const nameEntry = addEntry(new St.BoxLayout(), model.name);
        nameEntry.clutter_text.max_length = MAX_NAME_LENGTH;
        addField(layout, 'Name', nameEntry.get_parent());

        layout.add_child(new St.Label({text: 'Display', style_class: 'measure-things-section'}));
        const display = new St.BoxLayout({style_class: 'measure-things-row'});
        layout.add_child(display);
        const colors = new St.BoxLayout({style_class: 'measure-things-swatches'});
        const hexEntry = addEntry(new St.BoxLayout(), content.color, {visible: false});
        const swatches = PALETTE.map(color => {
            const swatch = new St.Button({
                style_class: 'measure-things-swatch-button',
                style: `background-color: ${color};`,
                can_focus: true,
                accessible_name: color,
                y_align: Clutter.ActorAlign.CENTER,
            });
            swatch.connect('clicked', () => {
                draft.color = color;
                hexEntry.text = color;
                syncColors();
            });
            colors.add_child(swatch);
            return swatch;
        });
        const custom = new St.Button({
            label: 'Custom…',
            style_class: 'measure-things-button',
            can_focus: true,
        });
        custom.connect('clicked', () => {
            hexEntry.visible = true;
            hexEntry.grab_key_focus();
        });
        colors.add_child(custom);
        colors.add_child(hexEntry.get_parent());
        hexEntry.clutter_text.connect('text-changed', () => {
            if (/^#[0-9a-f]{6}$/i.test(hexEntry.text.trim())) {
                draft.color = hexEntry.text.trim().toLowerCase();
                syncColors();
            }
        });
        const syncColors = () => swatches.forEach((swatch, i) => {
            if (PALETTE[i] === draft.color)
                swatch.add_style_pseudo_class('checked');
            else
                swatch.remove_style_pseudo_class('checked');
        });
        syncColors();
        hexEntry.visible = !PALETTE.includes(draft.color);
        addField(display, 'Helper color', colors);
        const zoomEntry = addEntry(new St.BoxLayout(), `${content.zoom}`, {style_class: 'measure-things-entry measure-things-number'});
        addField(display, 'Browser zoom (%)', zoomEntry.get_parent());

        layout.add_child(new St.Label({text: 'Column grid', style_class: 'measure-things-section'}));
        const gridRow = new St.BoxLayout({style_class: 'measure-things-row'});
        layout.add_child(gridRow);
        const gridEntries = {};
        for (const [key, title] of [['columns', 'Columns'], ['gutter', 'Gutter'], ['margin', 'Margin'],
            ['maxWidth', 'Max width']]) {
            gridEntries[key] = addEntry(new St.BoxLayout(), `${content.grid[key]}`,
                {style_class: 'measure-things-entry measure-things-number'});
            addField(gridRow, title, gridEntries[key].get_parent());
        }

        layout.add_child(new St.Label({text: 'Mockup', style_class: 'measure-things-section'}));
        const fileRow = new St.BoxLayout({style_class: 'measure-things-row'});
        const fileLabel = new St.Label({style_class: 'measure-things-file', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const choose = new St.Button({label: 'Choose…', style_class: 'measure-things-button', can_focus: true});
        const remove = new St.Button({label: 'Remove', style_class: 'measure-things-button', can_focus: true});
        for (const child of [fileLabel, choose, remove])
            fileRow.add_child(child);
        layout.add_child(fileRow);
        const syncFile = () => {
            fileLabel.text = draft.file ? GLib.path_get_basename(draft.file) : 'No image';
            remove.reactive = draft.file !== '';
        };
        syncFile();
        remove.connect('clicked', () => {
            draft.file = '';
            syncFile();
        });
        choose.connect('clicked', async () => {
            dialog.popModal();
            dialog.hide();
            onChooserOpen();
            try {
                const path = await chooseImage('Choose a mockup image', cancellable);
                if (path)
                    draft.file = path;
            } catch (error) {
                notify(`Could not open the file chooser: ${error.message}`);
            }
            if (cancellable.is_cancelled())
                return;
            dialog.show();
            dialog.pushModal();
            syncFile();
        });

        const mockupRow = new St.BoxLayout({style_class: 'measure-things-row'});
        layout.add_child(mockupRow);
        const opacityEntry = addEntry(new St.BoxLayout(), `${content.mockup.opacity}`,
            {style_class: 'measure-things-entry measure-things-number'});
        addField(mockupRow, 'Opacity (%)', opacityEntry.get_parent());
        const densities = new St.BoxLayout({style_class: 'measure-things-segments'});
        const densityButtons = [1, 2, 3, 4].map(density => {
            const button = new St.Button({label: `${density}x`, style_class: 'measure-things-segment', can_focus: true});
            button.connect('clicked', () => {
                draft.density = density;
                syncDensity();
            });
            densities.add_child(button);
            return button;
        });
        const syncDensity = () => densityButtons.forEach((button, i) => {
            if (i + 1 === draft.density)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        });
        syncDensity();
        addField(mockupRow, 'Pixel density', densities);

        const save = () => finish({
            name: nameEntry.text.trim() || model.name,
            color: draft.color,
            zoom: readInteger(zoomEntry, ZOOM_RANGE, content.zoom),
            grid: Object.fromEntries(Object.entries(gridEntries).map(([key, entry]) =>
                [key, readInteger(entry, GRID_RANGES[key], content.grid[key])])),
            mockup: {
                file: draft.file,
                opacity: readInteger(opacityEntry, OPACITY_RANGE, content.mockup.opacity),
                density: Math.min(DENSITY_RANGE[1], Math.max(DENSITY_RANGE[0], draft.density)),
            },
        });
        dialog.setButtons([
            {label: 'Cancel', action: () => finish(null), key: Clutter.KEY_Escape},
            {label: 'Save', action: save, default: true},
        ]);
        dialog.setInitialKeyFocus(nameEntry);
    }, null);
}
