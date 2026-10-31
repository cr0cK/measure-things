import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {monitorAt} from './geometry.js';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_async');

const SETTINGS = ['mockup-file', 'mockup-visible', 'mockup-opacity', 'mockup-density', 'mockup-position'];

/**
 * A design image laid over the screen at its CSS size, half transparent, to compare a page with
 * it. Like the rest of the layer it never takes pointer input; edit mode moves it.
 */
export class Mockup {
    constructor(settings, ratios) {
        this._settings = settings;
        this._ratios = ratios;
        this._image = null;
        this._loading = null;
        this.actor = new St.Widget({name: 'measure-things-mockup', visible: false});
        this._signals = SETTINGS.map(key => settings.connect(`changed::${key}`, () => {
            if (key === 'mockup-file')
                this._load();
            else
                this.sync();
        }));
        this._load();
    }

    destroy() {
        for (const id of this._signals)
            this._settings.disconnect(id);
        this._signals = [];
        this._loading = null;
    }

    /** Whether the image is on screen. */
    get shown() {
        return this.actor.visible;
    }

    /** The top-left corner, in stage pixels. */
    get position() {
        return [this.actor.x, this.actor.y];
    }

    moveTo(x, y) {
        this.actor.set_position(x, y);
    }

    /** Stores the current position, which sync() then keeps. */
    save() {
        this._settings.set_value('mockup-position', new GLib.Variant('(ii)', this.position));
    }

    changeOpacity(delta) {
        const opacity = this._settings.get_int('mockup-opacity') + delta;
        this._settings.set_int('mockup-opacity', Math.min(100, Math.max(5, opacity)));
    }

    async _load() {
        const path = this._settings.get_string('mockup-file');
        const token = {};
        this._loading = token;
        this._image = null;
        this.sync();
        if (!path)
            return;

        try {
            const stream = await Gio.File.new_for_path(path).read_async(GLib.PRIORITY_DEFAULT, null);
            const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_async(stream, null);
            stream.close(null);
            if (this._loading !== token)
                return;
            const content = St.ImageContent.new_with_preferred_size(pixbuf.width, pixbuf.height);
            content.set_data(global.stage.context.get_backend().get_cogl_context(), pixbuf.get_pixels(),
                pixbuf.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                pixbuf.width, pixbuf.height, pixbuf.rowstride);
            this._image = {content, width: pixbuf.width, height: pixbuf.height};
            this.actor.set_content(content);
            this.sync();
        } catch (error) {
            if (this._loading === token)
                console.warn(`Measure Things: could not load the mockup ${path}: ${error.message}`);
        }
    }

    /** Applies the settings: shown when visible and loaded, sized from CSS pixels. */
    sync() {
        const image = this._image;
        this.actor.visible = Boolean(image) && this._settings.get_boolean('mockup-visible');
        if (!this.actor.visible)
            return;

        const [x, y] = this._settings.get_value('mockup-position').deepUnpack();
        const monitors = Main.layoutManager.monitors;
        const {css} = this._ratios(monitors[monitorAt(monitors, x, y)]);
        const density = this._settings.get_int('mockup-density');
        this.actor.set_position(x, y);
        const scale = 1 / density / css;
        this.actor.set_size(Math.round(image.width * scale), Math.round(image.height * scale));
        this.actor.opacity = Math.round(this._settings.get_int('mockup-opacity') * 255 / 100);
    }
}
