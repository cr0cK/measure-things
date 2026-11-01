import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_async');

/**
 * Mockup images, loaded once per path and shared by every view that shows them. Each image
 * resolves with `{content, width, height}` in image pixels; a failed load is retried next time.
 */
export class ImageCache {
    constructor() {
        this._images = new Map();
    }

    load(path) {
        let image = this._images.get(path);
        if (!image) {
            image = loadImage(path);
            this._images.set(path, image);
            image.catch(() => this._images.delete(path));
        }
        return image;
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
