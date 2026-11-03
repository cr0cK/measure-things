import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_async');

/**
 * Mockup images, decoded once per path, modification time, and size, and shared by every view
 * that shows them: a file replaced at the same path is decoded again. Each image resolves with
 * `{content, width, height}` in image pixels; a path that cannot be read rejects.
 */
export class ImageCache {
    constructor() {
        this._images = new Map();
    }

    async load(path) {
        const info = await Gio.File.new_for_path(path).query_info_async(
            'standard::size,time::modified,time::modified-usec', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, null);
        const key = [info.get_size(), info.get_attribute_uint64('time::modified'),
            info.get_attribute_uint32('time::modified-usec')].join();
        const cached = this._images.get(path);
        if (cached?.key === key)
            return cached.image;
        const entry = {key, image: loadImage(path)};
        this._images.set(path, entry);
        // A failed decode is tried again next time.
        entry.image.catch(() => {
            if (this._images.get(path) === entry)
                this._images.delete(path);
        });
        return entry.image;
    }

    clear() {
        this._images.clear();
    }
}

async function loadImage(path) {
    const stream = await Gio.File.new_for_path(path).read_async(GLib.PRIORITY_DEFAULT, null);
    const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_async(stream, null);
    stream.close(null);
    const content = St.ImageContent.new_with_preferred_size(pixbuf.width, pixbuf.height);
    content.set_data(global.stage.context.get_backend().get_cogl_context(), pixbuf.get_pixels(),
        pixbuf.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
        pixbuf.width, pixbuf.height, pixbuf.rowstride);
    return {content, width: pixbuf.width, height: pixbuf.height};
}
