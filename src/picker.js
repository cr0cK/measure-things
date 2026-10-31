import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {colorToHex, colorToRgb} from './format.js';

Gio._promisify(Shell.Screenshot.prototype, 'pick_color');

// The swatch sits this far from the pointer, so it never covers the pixel being read.
const SWATCH_OFFSET = 18;

/**
 * A modal color picker: the swatch follows the pointer with the color under it, a primary
 * click resolves with that color, and Escape or a secondary click resolves with null.
 */
export class ColorPicker {
    constructor() {
        this._screenshot = new Shell.Screenshot();
        this._picking = false;
        this._reads = 0;
        this._pending = null;
        this._color = null;
        this._done = null;

        this._actor = new St.Widget({name: 'measure-things-picker', reactive: true});
        this._actor.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        this._swatch = new St.BoxLayout({style_class: 'measure-things-swatch', visible: false});
        this._chip = new St.Widget({style_class: 'measure-things-chip', y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._swatch.add_child(this._chip);
        this._swatch.add_child(this._label);
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
            if (event.get_key_symbol() === Clutter.KEY_Escape)
                this._resolve(null);
            return Clutter.EVENT_STOP;
        });
    }

    /** Resolves with `{hex, rgb}`, or null when cancelled or when the keyboard is taken. */
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
        this._queuePick(...global.get_pointer());
        return result;
    }

    cancel() {
        this._resolve(null);
    }

    async _finish([x, y]) {
        this._pending = null;
        const color = await this._read(Math.round(x), Math.round(y));
        this._resolve(color ? {hex: colorToHex(color), rgb: colorToRgb(color)} : null);
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

    /** Reads the pixel with the swatch hidden, so the pointer can never sample the swatch. */
    async _read(x, y) {
        // Reads can overlap (a motion read and the click read); show the swatch after the last.
        this._reads++;
        this._swatch.opacity = 0;
        try {
            const [color] = await this._screenshot.pick_color(x, y);
            return color;
        } catch (error) {
            console.warn(`Measure Things: could not read the color at ${x}, ${y}: ${error.message}`);
            return null;
        } finally {
            if (--this._reads === 0)
                this._swatch.opacity = 255;
        }
    }

    /** Reads at most one pixel at a time and always ends on the latest pointer position. */
    async _queuePick(x, y) {
        this._pending = [Math.round(x), Math.round(y)];
        if (this._picking)
            return;

        this._picking = true;
        while (this._pending && this._done) {
            const [px, py] = this._pending;
            this._pending = null;
            const color = await this._read(px, py);
            if (color && this._done)
                this._show(px, py, color);
        }
        this._picking = false;
    }

    _show(x, y, color) {
        const hex = colorToHex(color);
        this._chip.style = `background-color: ${hex};`;
        this._label.text = hex;
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
