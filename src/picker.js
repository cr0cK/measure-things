import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {COLOR_FORMATS, formatColor} from './format.js';
import {Snapshot} from './snapshot.js';

// The swatch sits this far from the pointer, so it never covers the pixel being read.
const SWATCH_OFFSET = 18;
// The loupe shows this many device pixels across, each this many stage pixels wide.
const LOUPE_PIXELS = 11;
const LOUPE_ZOOM = 10;
const LOUPE_SIZE = LOUPE_PIXELS * LOUPE_ZOOM;

/**
 * A modal color picker on a still capture of the screen: the swatch follows the pointer with a
 * magnified view of the pixels around it and the color under it, a primary click resolves with
 * that color as text in the chosen format, and Escape or a secondary click resolves with null.
 * The capture is taken before the swatch shows, so the swatch can never be sampled.
 */
export class ColorPicker {
    constructor(settings) {
        this._settings = settings;
        this._snapshot = null;
        this._picking = false;
        this._pending = null;
        this._color = null;
        this._done = null;

        this._actor = new St.Widget({name: 'measure-things-picker', reactive: true});
        this._actor.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        this._swatch = new St.BoxLayout({
            style_class: 'measure-things-swatch',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
        });
        this._loupe = new St.Widget({
            style_class: 'measure-things-loupe',
            width: LOUPE_SIZE,
            height: LOUPE_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
        });
        this._loupeImage = new St.Widget();
        const {NEAREST} = Clutter.ScalingFilter;
        this._loupeImage.set_content_scaling_filters(NEAREST, NEAREST);
        this._loupeContent = St.ImageContent.new_with_preferred_size(LOUPE_PIXELS, LOUPE_PIXELS);
        this._loupeImage.set_content(this._loupeContent);
        const center = (LOUPE_SIZE - LOUPE_ZOOM) / 2;
        // A white frame in a black one, visible on any color, with the pixel showing through.
        const marker = new St.Widget({
            style_class: 'measure-things-loupe-pixel',
            x: center - 2,
            y: center - 2,
            width: LOUPE_ZOOM + 4,
            height: LOUPE_ZOOM + 4,
        });
        marker.add_child(new St.Widget({
            style_class: 'measure-things-loupe-pixel-inner',
            x: 1,
            y: 1,
            width: LOUPE_ZOOM + 2,
            height: LOUPE_ZOOM + 2,
        }));
        this._loupe.add_child(this._loupeImage);
        this._loupe.add_child(marker);
        const value = new St.BoxLayout({style_class: 'measure-things-swatch-value'});
        this._chip = new St.Widget({style_class: 'measure-things-chip', y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        value.add_child(this._chip);
        value.add_child(this._label);
        this._swatch.add_child(this._loupe);
        this._swatch.add_child(value);
        this._actor.add_child(this._swatch);

        this._actor.connect('motion-event', (_actor, event) => {
            this._queuePick(...event.get_coords());
            return Clutter.EVENT_STOP;
        });
        this._actor.connect('button-press-event', () => Clutter.EVENT_STOP);
        this._actor.connect('button-release-event', (_actor, event) => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY)
                this._finish(event.get_coords());
            else
                this._resolve(null);
            return Clutter.EVENT_STOP;
        });
        this._actor.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape)
                this._resolve(null);
            else if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab)
                this._cycleFormat();
            return Clutter.EVENT_STOP;
        });
    }

    /**
     * Resolves with the color text, or null when cancelled or when the keyboard is taken. Hide
     * what must not be sampled before calling it.
     */
    pick() {
        Main.layoutManager.addTopChrome(this._actor, {affectsInputRegion: false});
        const grab = Main.pushModal(this._actor, {actionMode: Shell.ActionMode.POPUP});
        if (!(grab.get_seat_state() & Clutter.GrabState.KEYBOARD)) {
            Main.popModal(grab);
            this._actor.destroy();
            return Promise.resolve(null);
        }

        this._grab = grab;
        global.display.set_cursor(Meta.Cursor.CROSSHAIR);
        const result = new Promise(resolve => {
            this._done = resolve;
        });
        // After _done is set: reads stop once the picker resolves.
        this._snapshot = Snapshot.capture();
        this._queuePick(...global.get_pointer());
        return result;
    }

    cancel() {
        this._resolve(null);
    }

    _format() {
        return this._settings.get_string('color-format');
    }

    _cycleFormat() {
        const index = COLOR_FORMATS.indexOf(this._format());
        this._settings.set_string('color-format', COLOR_FORMATS[(index + 1) % COLOR_FORMATS.length]);
        if (this._color)
            this._label.text = formatColor(this._color, this._format());
    }

    async _finish([x, y]) {
        this._pending = null;
        const reading = await this._read(x, y);
        this._resolve(reading ? formatColor(reading.color, this._format()) : null);
    }

    _resolve(result) {
        if (!this._done)
            return;
        const done = this._done;
        this._done = null;
        Main.popModal(this._grab);
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        this._actor.destroy();
        done(result);
    }

    /** The pixels around a stage point and the color of the one under it, from the capture. */
    async _read(x, y) {
        try {
            const snapshot = await this._snapshot;
            const pixelX = Math.min(snapshot.pixel(x), snapshot.width - 1);
            const pixelY = Math.min(snapshot.pixel(y), snapshot.height - 1);
            const half = (LOUPE_PIXELS - 1) / 2;
            const area = await snapshot.area(pixelX - half, pixelY - half, LOUPE_PIXELS, LOUPE_PIXELS);
            const i = (pixelY - area.y) * area.rowstride + (pixelX - area.x) * area.channels;
            const color = {red: area.data[i], green: area.data[i + 1], blue: area.data[i + 2]};
            return {color, area, column: pixelX - area.x, row: pixelY - area.y};
        } catch (error) {
            console.warn(`Measure Things: could not read the color at ${x}, ${y}: ${error.message}`);
            return null;
        }
    }

    /** Reads at most one area at a time and always ends on the latest pointer position. */
    async _queuePick(x, y) {
        this._pending = [x, y];
        if (this._picking)
            return;

        this._picking = true;
        while (this._pending && this._done) {
            const [px, py] = this._pending;
            this._pending = null;
            const reading = await this._read(px, py);
            if (reading && this._done)
                this._show(Math.round(px), Math.round(py), reading);
        }
        this._picking = false;
    }

    _show(x, y, {color, area, column, row}) {
        this._color = color;
        this._chip.style = `background-color: ${formatColor(color, 'hex')};`;
        this._label.text = formatColor(color, this._format());
        this._loupeContent.set_data(global.stage.context.get_backend().get_cogl_context(), area.data,
            area.channels === 4 ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
            area.width, area.height, area.rowstride);
        // The pixel under the pointer goes under the marker, even where the area is clipped.
        const center = (LOUPE_SIZE - LOUPE_ZOOM) / 2;
        this._loupeImage.set_position(center - column * LOUPE_ZOOM, center - row * LOUPE_ZOOM);
        this._loupeImage.set_size(area.width * LOUPE_ZOOM, area.height * LOUPE_ZOOM);

        this._swatch.show();
        const [, width] = this._swatch.get_preferred_width(-1);
        const [, height] = this._swatch.get_preferred_height(-1);
        const flipX = x + SWATCH_OFFSET + width > global.stage.width;
        const flipY = y + SWATCH_OFFSET + height > global.stage.height;
        this._swatch.set_position(
            flipX ? x - SWATCH_OFFSET - width : x + SWATCH_OFFSET,
            flipY ? y - SWATCH_OFFSET - height : y + SWATCH_OFFSET);
    }
}
