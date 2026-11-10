import GLib from 'gi://GLib';

import {Detector} from './detect.js';
import {notify} from './manager.js';
import {Snapshot} from './snapshot.js';
import {covers, pixelRange} from './zones.js';

// The zone is read this many rows at a time: each band's readback is synchronous on the GPU, so
// the band size is what keeps every stall of the shell short. The detector gets it in smaller
// pieces, with the main loop running in between.
const BAND_ROWS = 256;
const CHUNK_ROWS = 64;

const MESSAGES = {
    covered: 'Find helpers: another window covers the zone, so nothing changed. Move it away and try again.',
    capture: 'Find helpers: the zone could not be captured, so nothing changed.',
    stale: 'Find helpers: the window or the set changed while it ran, so nothing changed.',
    none: 'No helpers found',
};

/** Lets the main loop paint and run its timers before going on. */
function yieldToLoop() {
    return new Promise(resolve => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/**
 * Find helpers: reads the pixels of a main view's zone and replaces the set's helpers with the
 * guides and rectangles that `detect.js` finds there. A run takes a capture of its own with
 * every actor of the extension hidden (`hold` and `release` hide and show them), reads the zone
 * in bands, and commits only if nothing changed meanwhile. A new run cancels the one in progress.
 */
export class Finder {
    constructor(manager, {hold, release, isShown, isBusy}) {
        this._manager = manager;
        this._hold = hold;
        this._release = release;
        this._isShown = isShown;
        this._isBusy = isBusy;
        this._token = null;
    }

    destroy() {
        this._token = null;
    }

    /** The visible part of a view's zone in stage pixels, or null when it is empty. */
    _zoneOf(view) {
        const geometry = view.geometry;
        if (!geometry?.visible)
            return null;
        const {visible} = geometry;
        return {
            x: geometry.originX + visible.x,
            y: geometry.originY + visible.y,
            width: visible.width,
            height: visible.height,
        };
    }

    /** What a run must find unchanged to commit: the set, the zone, and the window. */
    _stamp(view) {
        const geometry = view.geometry;
        if (!geometry || !this._manager.models.includes(view.model) || view.model.view !== view)
            return null;
        const {originX, originY, width, height, k, visible} = geometry;
        const epoch = this._manager.store.epoch(view.model.id);
        return JSON.stringify([view.model.id, view.model.revision, epoch, originX, originY, width, height,
            k, visible, view.content.zoom]);
    }

    /** Whether a window above the target's in the stack overlaps the zone. */
    _covered(window, zone) {
        const actors = global.get_window_actors();
        const index = actors.findIndex(actor => actor.meta_window === window);
        const above = actors.slice(index + 1)
            .filter(actor => actor.visible && this._isShown(actor.meta_window))
            .map(actor => actor.meta_window.get_frame_rect());
        return covers(above, zone);
    }

    /**
     * Watches what a run cannot see by looking at its ends: the window minimized, moved to another
     * workspace, or closed, and a window raised over the zone, even if each is undone before the
     * run ends. `state.status` is the first thing that happened, as the status the run ends with.
     */
    _watch(window, zone) {
        const state = {status: null};
        const note = status => {
            state.status ??= status;
        };
        const watched = [
            [window, window.connect('notify::minimized', () => note('stale'))],
            [window, window.connect('workspace-changed', () => note('stale'))],
            [window, window.connect('unmanaged', () => note('stale'))],
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed',
                () => note('stale'))],
            [global.display, global.display.connect('restacked', () => {
                if (this._covered(window, zone))
                    note('covered');
            })],
        ];
        return {state, stop: () => watched.forEach(([object, id]) => object.disconnect(id))};
    }

    /**
     * What stops a run from going on, as a status, or null: the window left the screen, another
     * covers the zone, or a gesture is changing the set. Checked around the capture and before the
     * commit, since windows come and go while a run reads.
     */
    _blocked(view, zone, state) {
        if (state.status)
            return state.status;
        if (!this._isShown(view.window))
            return 'capture';
        if (this._covered(view.window, zone))
            return 'covered';
        return this._isBusy(view) ? 'stale' : null;
    }

    /**
     * Runs Find helpers on the main view of a set at a tolerance level, and commits what it finds;
     * with `replace`, the commit takes the place of the previous run's undo step.
     * Resolves to `found`, `none`, `covered`, `capture`, `stale`, `cancelled`, or `refused` (the
     * manager could not save it, and said so); all but `found` changed nothing, and all but
     * `cancelled` and `refused` have told the user.
     */
    async run(view, level, {replace = false} = {}) {
        const token = {};
        this._token = token;
        const status = await this._run(view, level, token, replace);
        if (status in MESSAGES && this._token === token)
            notify(MESSAGES[status]);
        return status;
    }

    async _run(view, level, token, replace) {
        const stamp = this._stamp(view);
        const zone = this._zoneOf(view);
        if (!stamp || !zone)
            return 'capture';
        const watch = this._watch(view.window, zone);
        try {
            return await this._read(view, level, token, replace, {stamp, zone, state: watch.state});
        } finally {
            watch.stop();
        }
    }

    async _read(view, level, token, replace, {stamp, zone, state}) {
        const blocked = this._blocked(view, zone, state);
        if (blocked && blocked !== 'stale')
            return blocked;
        if (zone.x < 0 || zone.y < 0 || zone.x + zone.width > global.stage.width ||
            zone.y + zone.height > global.stage.height)
            return 'capture';

        let snapshot = null;
        this._hold();
        try {
            snapshot = await Snapshot.capture();
        } catch (error) {
            console.warn(`Measure Things: could not capture the screen: ${error.message}`);
        } finally {
            this._release();
        }
        if (this._token !== token)
            return 'cancelled';
        if (!snapshot)
            return 'capture';
        const {scale} = snapshot;
        const pixels = pixelRange(zone, scale, snapshot.width, snapshot.height);
        if (!pixels)
            return 'capture';
        const {left, top, width, height} = pixels;
        if (this._stamp(view) !== stamp)
            return 'stale';
        const afterCapture = this._blocked(view, zone, state);
        if (afterCapture)
            return afterCapture;

        const detector = new Detector(width, height, level, scale);
        for (let y = 0; y < height; y += BAND_ROWS) {
            const rows = Math.min(BAND_ROWS, height - y);
            let area = null;
            try {
                area = await snapshot.area(left, top + y, width, rows);
            } catch (error) {
                console.warn(`Measure Things: could not read the screen: ${error.message}`);
            }
            if (this._token !== token)
                return 'cancelled';
            if (!area || area.x !== left || area.width !== width || area.height !== rows)
                return 'capture';
            for (let row = 0; row < rows; row += CHUNK_ROWS) {
                detector.addRows(area.data, row * area.rowstride, area.rowstride, area.channels,
                    Math.min(CHUNK_ROWS, rows - row));
                await yieldToLoop();
                if (this._token !== token)
                    return 'cancelled';
                if (this._stamp(view) !== stamp)
                    return 'stale';
                if (state.status || this._isBusy(view))
                    return state.status ?? 'stale';
            }
        }

        const found = detector.finish();
        if (this._stamp(view) !== stamp)
            return 'stale';
        const beforeCommit = this._blocked(view, zone, state);
        if (beforeCommit)
            return beforeCommit;
        const helpers = this._helpers(view, found, {left, top, scale});
        if (helpers.length === 0)
            return 'none';
        return this._manager.applyFound(view.model, helpers, level, {replace}) ? 'found' : 'refused';
    }

    /**
     * The helpers as a set stores them: a boundary of the capture goes to the stage pixel snapping
     * would put it at, then to the zone's pixels, then to CSS pixels like any helper.
     */
    _helpers(view, {rectangles, guides}, {left, top, scale}) {
        const {originX, originY} = view.geometry;
        const toX = boundary => (left + boundary) / scale - originX;
        const toY = boundary => (top + boundary) / scale - originY;
        return [
            ...rectangles.map(rect => view.toCss({
                kind: 'rectangle',
                x: toX(rect.x),
                y: toY(rect.y),
                width: rect.width / scale,
                height: rect.height / scale,
            })),
            ...guides.map(guide => view.toCss(guide.kind === 'vertical'
                ? {kind: 'vertical', x: toX(guide.x)}
                : {kind: 'horizontal', y: toY(guide.y)})),
        ];
    }
}
