import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_stage_to_content');
Gio._promisify(Shell.Screenshot, 'composite_to_stream');

// Lines kept per axis: enough for a drag that wanders across a few rows and columns.
const CACHED_LINES = 8;

/**
 * A still image of the stage, kept on the GPU, from which small areas and lines of pixels are
 * read on demand: reading a whole 4K screen into memory takes over a second, a line a few
 * milliseconds. Pixel coordinates are device pixels, stage coordinates times `scale`.
 */
export class Snapshot {
    /** Paints the stage as it is now; hide what must not be captured first. */
    static async capture() {
        const [content, scale] = await new Shell.Screenshot().screenshot_stage_to_content();
        return new Snapshot(content.get_texture(), scale);
    }

    constructor(texture, scale) {
        this._texture = texture;
        this.scale = scale;
        this.width = texture.get_width();
        this.height = texture.get_height();
        this._lines = {row: new Map(), column: new Map()};
    }

    /**
     * The pixels of an area clipped to the image, as `{data, rowstride, channels, x, y, width,
     * height}`; null when the area is outside the image.
     */
    async area(x, y, width, height) {
        const left = Math.max(0, x);
        const top = Math.max(0, y);
        const right = Math.min(this.width, x + width);
        const bottom = Math.min(this.height, y + height);
        if (left >= right || top >= bottom)
            return null;

        const pixbuf = await Shell.Screenshot.composite_to_stream(this._texture,
            left, top, right - left, bottom - top, this.scale, null, 0, 0, 1,
            Gio.MemoryOutputStream.new_resizable());
        return {
            data: pixbuf.read_pixel_bytes().toArray(),
            rowstride: pixbuf.rowstride,
            channels: pixbuf.n_channels,
            x: left,
            y: top,
            width: pixbuf.width,
            height: pixbuf.height,
        };
    }

    /** The device pixel holding a stage coordinate. */
    pixel(stageCoordinate) {
        return Math.floor(stageCoordinate * this.scale);
    }

    /**
     * The full row or column of device pixels through a stage coordinate, as a line for
     * edges.js, if it has been read already; otherwise null, and `onRead` runs once it has.
     */
    line(axis, stageCoordinate, onRead) {
        const index = this.pixel(stageCoordinate);
        const cache = this._lines[axis];
        const entry = cache.get(index);
        if (entry?.line)
            return entry.line;
        if (entry) {
            entry.callbacks.add(onRead);
            return null;
        }

        const pending = {line: null, callbacks: new Set([onRead])};
        cache.set(index, pending);
        if (cache.size > CACHED_LINES)
            cache.delete(cache.keys().next().value);
        const row = axis === 'row';
        this.area(row ? 0 : index, row ? index : 0, row ? this.width : 1, row ? 1 : this.height)
            .then(area => {
                if (!area)
                    return;
                pending.line = {
                    data: area.data,
                    step: row ? area.channels : area.rowstride,
                    length: row ? area.width : area.height,
                };
                for (const callback of pending.callbacks)
                    callback();
            })
            .catch(error => {
                cache.delete(index);
                console.warn(`Measure Things: could not read the screen: ${error.message}`);
            });
        return null;
    }
}
