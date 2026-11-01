import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {formatLength, formatSize, withAlpha} from './format.js';
import {columnGrid, guideGaps, highestScaleMonitor, rectangleGaps, scaleHelper, surfaceOffset} from './geometry.js';
import {roundCss} from './sets.js';

const LABEL_MARGIN = 4;
const HANDLE_SIZE = 7;
const BADGE_MARGIN = 8;
const RECTANGLE_PARTS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * Where a window's frame is drawn, as the views inside it need it:
 * - `k`: the stage pixels per unit of the window actor's children. In physical layout mode Mutter
 *   scales them by the window's geometry scale; in logical mode it is 1. One unit is one CSS pixel
 *   at 100% zoom either way.
 * - `originX`, `originY`: the frame's top-left corner in stage pixels, moved as Mutter moves the
 *   window's surfaces onto the device pixels of the highest-scale monitor the frame touches.
 * - `layerX`, `layerY`: the same corner in the window actor's units.
 * - `width`, `height`: the frame's size in stage pixels.
 * - `devicePerStage`: device pixels per stage pixel where the window is drawn.
 */
export function windowGeometry(window, logical) {
    const actor = window.get_compositor_private();
    if (!actor)
        return null;
    const frame = window.get_frame_rect();
    const buffer = window.get_buffer_rect();
    const k = actor.get_child_transform().get_value(0, 0) || 1;
    const monitors = Main.layoutManager.monitors;
    const monitor = monitors[highestScaleMonitor(monitors, frame)] ?? monitors[window.get_monitor()] ??
        {x: 0, y: 0, geometry_scale: 1};
    const container = actor.get_children().find(child =>
        GObject.type_name(child.constructor.$gtype) === 'MetaSurfaceContainerActorWayland');
    let offsetX = 0;
    let offsetY = 0;
    if (container) {
        offsetX = container.x * k + surfaceOffset(actor.x + container.x, monitor.x, monitor.geometry_scale);
        offsetY = container.y * k + surfaceOffset(actor.y + container.y, monitor.y, monitor.geometry_scale);
    }
    const insetX = frame.x - buffer.x + offsetX;
    const insetY = frame.y - buffer.y + offsetY;
    return {
        k,
        originX: actor.x + insetX,
        originY: actor.y + insetY,
        layerX: insetX / k,
        layerY: insetY / k,
        width: frame.width,
        height: frame.height,
        devicePerStage: logical ? monitor.geometry_scale : 1,
    };
}

/**
 * A set shown on a window, inside its zone: the whole frame, as zones are automatic. Its actors
 * are children of the window actor, so they move, hide, and stack with the window, and they are
 * attached only while they show something. Nothing in it is reactive.
 *
 * Interaction runs in zone pixels: stage pixels from the zone's top-left corner. Helpers are
 * stored in CSS pixels at the set's zoom, and drawn in the window actor's units.
 */
export class View {
    constructor(model, window, {settings, images, isLogical, onClosed, onMoved}) {
        this.model = model;
        this.window = window;
        this.selectedId = null;
        this.editing = false;
        this.geometry = null;
        this._settings = settings;
        this._images = images;
        this._isLogical = isLogical;
        this._actor = window.get_compositor_private();
        this._helperViews = new Map();
        this._mockupPath = null;
        this._labelHeight = 0;
        this._attached = false;

        this.layer = new St.Widget({name: 'measure-things-view', clip_to_allocation: true});
        // In the window actor's units.
        this._content = new St.Widget();
        this._mockup = new St.Widget({visible: false});
        this._grid = new St.Widget();
        this._shapes = new St.Widget();
        this._gapLines = new St.Widget();
        for (const group of [this._mockup, this._grid, this._shapes, this._gapLines])
            this._content.add_child(group);
        // In zone pixels: the window actor's scale is undone, so text keeps its size.
        this._chrome = new St.Widget();
        this._handles = new St.Widget();
        this._gapLabels = new St.Widget();
        this._labels = new St.Widget();
        this._badge = new St.BoxLayout({style_class: 'measure-things-badge'});
        this._badgeDot = new St.Widget({style_class: 'measure-things-badge-dot', y_align: Clutter.ActorAlign.CENTER});
        this._badgeLabel = new St.Label({style_class: 'measure-things-badge-label', y_align: Clutter.ActorAlign.CENTER});
        this._badge.add_child(this._badgeDot);
        this._badge.add_child(this._badgeLabel);
        for (const group of [this._handles, this._gapLabels, this._labels, this._badge])
            this._chrome.add_child(group);
        this.layer.add_child(this._content);
        this.layer.add_child(this._chrome);

        const sync = () => this._onWindowChanged();
        this._windowSignals = [
            window.connect('position-changed', sync),
            window.connect('size-changed', sync),
            window.connect('highest-scale-monitor-changed', sync),
            window.connect('notify::minimized', () => onMoved(this)),
            window.connect('workspace-changed', () => onMoved(this)),
            window.connect('unmanaged', () => onClosed(this)),
        ];
        this._onMoved = onMoved;
        this._monitorsSignal = Main.layoutManager.connect('monitors-changed', sync);
        this._badgesSignal = settings.connect('changed::show-badges', () => this.sync());
        this._unitSignal = settings.connect('changed::unit', () => this.sync());
        this.sync();
    }

    destroy() {
        for (const id of this._windowSignals)
            this.window.disconnect(id);
        Main.layoutManager.disconnect(this._monitorsSignal);
        this._settings.disconnect(this._badgesSignal);
        this._settings.disconnect(this._unitSignal);
        this._setAttached(false);
        this.layer.destroy();
        this._helperViews.clear();
        this._mockupPath = null;
    }

    /** Detaches from a window that is going away, before its actor is destroyed. */
    detach() {
        this._setAttached(false);
    }

    _onWindowChanged() {
        this.sync();
        this._onMoved(this);
    }

    setEditing(editing) {
        this.editing = editing;
        if (!editing)
            this.selectedId = null;
        this.sync();
    }

    /** Hides the view for a capture of the screen, without detaching it. */
    setCaptureHidden(hidden) {
        this.layer.visible = !hidden;
    }

    select(id) {
        this.selectedId = id;
        this.syncHelpers();
    }

    get content() {
        return this.model.content;
    }

    /** Zone pixels per CSS pixel. */
    get zonePerCss() {
        return this.geometry.k * this.unitsPerCss;
    }

    /** Window actor units per CSS pixel: the set's browser zoom. */
    get unitsPerCss() {
        return this.content.zoom / 100;
    }

    /** Display units per zone pixel: CSS pixels at the set's zoom, or device pixels. */
    get displayRatio() {
        return this._settings.get_string('unit') === 'device'
            ? this.geometry.devicePerStage : 1 / this.zonePerCss;
    }

    /** The helpers in zone pixels, with their ids. */
    zoneHelpers() {
        return this.content.helpers.map(helper => scaleHelper(helper, this.zonePerCss));
    }

    /** Stores a helper given in zone pixels, rounded to CSS hundredths. */
    toCss(helper) {
        return scaleHelper(helper, 1 / this.zonePerCss, roundCss);
    }

    /** A stage point in whole zone pixels. */
    toZone(x, y) {
        return [Math.round(x - this.geometry.originX), Math.round(y - this.geometry.originY)];
    }

    /** Whether a zone point is in the zone. */
    contains(x, y) {
        return x >= 0 && y >= 0 && x < this.geometry.width && y < this.geometry.height;
    }

    /** Whether a zone point is on the badge, which only shows in edit mode for input. */
    badgeContains(x, y) {
        const badge = this._badge;
        return this._attached && badge.visible && x >= badge.x && y >= badge.y &&
            x < badge.x + badge.width && y < badge.y + badge.height;
    }

    get badgeActor() {
        return this._badge;
    }

    /** The text of a guide's position, shared by its label and Ctrl+C. */
    guideMeasure(helper) {
        return formatLength((helper.kind === 'vertical' ? helper.x : helper.y) * this.displayRatio);
    }

    /** The text of a rectangle's size, shared by its label and Ctrl+C. */
    sizeMeasure(helper) {
        const ratio = this.displayRatio;
        return formatSize(helper.width * ratio, helper.height * ratio);
    }

    _showsHelpers() {
        return this.editing || this.content.helpersVisible;
    }

    _showsBadge() {
        return this.editing || this._settings.get_boolean('show-badges');
    }

    _showsMockup() {
        return this.content.mockup.visible && this.content.mockup.file !== '';
    }

    /** Whether anything would show: a view is attached only then. */
    _wanted() {
        if (!this.editing && this.model.hidden)
            return false;
        return this._showsBadge() || this.content.grid.visible || this._showsMockup() ||
            (this._showsHelpers() && this.content.helpers.length > 0);
    }

    _setAttached(attached) {
        if (attached === this._attached || !this._actor)
            return;
        this._attached = attached;
        if (attached)
            this._actor.add_child(this.layer);
        else
            this._actor.remove_child(this.layer);
    }

    /** Lays the view out again from the window and the set. */
    sync() {
        this.geometry = windowGeometry(this.window, this._isLogical());
        this._setAttached(Boolean(this.geometry) && this._wanted());
        if (!this._attached)
            return;

        const {k, layerX, layerY, width, height} = this.geometry;
        this.layer.set_position(layerX, layerY);
        this.layer.set_size(width / k, height / k);
        this._content.set_size(width / k, height / k);
        this._chrome.set_scale(1 / k, 1 / k);
        this._chrome.set_size(width, height);
        this._content.visible = true;
        this._shapes.visible = this._showsHelpers();
        this._gapLines.visible = this._showsHelpers();
        this._handles.visible = this._showsHelpers();
        this._labels.visible = this._showsHelpers();
        this._gapLabels.visible = this._showsHelpers();
        this.syncHelpers();
        this._syncGrid();
        this._syncMockup();
        this._syncBadge();
    }

    _color() {
        return this.content.color;
    }

    /** One device pixel, in the window actor's units. */
    _line() {
        return 1 / (this.geometry.devicePerStage * this.geometry.k);
    }

    syncHelpers() {
        if (!this._attached)
            return;
        const helpers = this.zoneHelpers();
        const ids = new Set(helpers.map(helper => helper.id));
        for (const [id, views] of this._helperViews) {
            if (!ids.has(id)) {
                for (const actor of views.actors)
                    actor.destroy();
                this._helperViews.delete(id);
            }
        }
        for (const helper of helpers) {
            let views = this._helperViews.get(helper.id);
            if (!views || views.kind !== helper.kind) {
                for (const actor of views?.actors ?? [])
                    actor.destroy();
                views = this._createHelperViews(helper);
                this._helperViews.set(helper.id, views);
            }
            this._updateHelperViews(views, helper);
        }
        this._syncGaps(helpers);
    }

    /** Stacks helper actors in list order, as hit testing reads it. */
    restack() {
        for (const helper of this.content.helpers) {
            for (const actor of this._helperViews.get(helper.id)?.actors ?? [])
                actor.get_parent().set_child_above_sibling(actor, null);
        }
    }

    _createHelperViews(helper) {
        const shape = new St.Widget();
        const label = new St.Label({style_class: 'measure-things-label'});
        this._shapes.add_child(shape);
        this._labels.add_child(label);
        const views = {kind: helper.kind, shape, label, actors: [shape, label]};
        if (helper.kind === 'rectangle') {
            views.edges = [0, 1, 2, 3].map(() => new St.Widget());
            for (const edge of views.edges)
                shape.add_child(edge);
            views.position = new St.Label({style_class: 'measure-things-label'});
            views.handles = RECTANGLE_PARTS.map(() => new St.Widget({style_class: 'measure-things-handle'}));
            this._labels.add_child(views.position);
            for (const handle of views.handles)
                this._handles.add_child(handle);
            views.actors.push(views.position, ...views.handles);
        }
        return views;
    }

    _updateHelperViews(views, helper) {
        const color = this._color();
        const {k, width: zoneWidth, height: zoneHeight} = this.geometry;
        const line = this._line();
        const selected = helper.id === this.selectedId;
        const labelStyle = selected
            ? `background-color: white; color: ${color}; border: 1px solid ${color};`
            : `background-color: ${color}; color: white;`;
        views.label.style = labelStyle;

        if (helper.kind === 'vertical' || helper.kind === 'horizontal') {
            const vertical = helper.kind === 'vertical';
            views.shape.style = `background-color: ${color};`;
            if (vertical) {
                views.shape.set_position(helper.x / k, 0);
                views.shape.set_size(line, zoneHeight / k);
            } else {
                views.shape.set_position(0, helper.y / k);
                views.shape.set_size(zoneWidth / k, line);
            }
            views.label.text = `${vertical ? 'x' : 'y'} ${this.guideMeasure(helper)}`;
            if (vertical)
                views.label.set_position(Math.round(helper.x + LABEL_MARGIN), LABEL_MARGIN);
            else
                views.label.set_position(LABEL_MARGIN, Math.round(helper.y + LABEL_MARGIN));
            return;
        }

        const width = helper.width / k;
        const height = helper.height / k;
        views.shape.style = `background-color: ${withAlpha(color, 0.08)};`;
        views.shape.set_position(helper.x / k, helper.y / k);
        views.shape.set_size(width, height);
        const edges = [[0, 0, width, line], [0, height - line, width, line], [0, 0, line, height],
            [width - line, 0, line, height]];
        views.edges.forEach((edge, i) => {
            edge.style = `background-color: ${color};`;
            edge.set_position(edges[i][0], edges[i][1]);
            edge.set_size(Math.max(edges[i][2], 0), Math.max(edges[i][3], 0));
        });

        views.label.text = this.sizeMeasure(helper);
        const [, labelWidth] = views.label.get_preferred_width(-1);
        const [, labelHeight] = views.label.get_preferred_height(-1);
        // Below the rectangle, or above its bottom edge when its zone ends first.
        let labelY = helper.y + helper.height + LABEL_MARGIN;
        if (labelY + labelHeight > zoneHeight)
            labelY = helper.y + helper.height - labelHeight - LABEL_MARGIN;
        const centered = helper.x + (helper.width - labelWidth) / 2;
        const labelX = Math.min(Math.max(centered, 0), zoneWidth - labelWidth);
        views.label.set_position(Math.round(labelX), Math.round(labelY));

        const ratio = this.displayRatio;
        views.position.visible = selected;
        views.position.style = labelStyle;
        views.position.text = `${formatLength(helper.x * ratio)}, ${formatLength(helper.y * ratio)}`;
        const [, positionHeight] = views.position.get_preferred_height(-1);
        views.position.set_position(Math.round(helper.x),
            Math.round(Math.max(helper.y - positionHeight - LABEL_MARGIN, 0)));

        const half = Math.floor(HANDLE_SIZE / 2);
        RECTANGLE_PARTS.forEach((part, i) => {
            const handle = views.handles[i];
            handle.visible = selected;
            handle.style = `border-color: ${color};`;
            handle.set_position(
                Math.round((part.endsWith('left') ? helper.x : helper.x + helper.width - 1) - half),
                Math.round((part.startsWith('top') ? helper.y : helper.y + helper.height - 1) - half));
        });
    }

    _measureLabelHeight() {
        if (!this._labelHeight) {
            const probe = new St.Label({style_class: 'measure-things-label measure-things-gap', text: '0'});
            this._gapLabels.add_child(probe);
            [, this._labelHeight] = probe.get_preferred_height(-1);
            probe.destroy();
        }
        return this._labelHeight;
    }

    _syncGaps(helpers) {
        this._gapLines.destroy_all_children();
        this._gapLabels.destroy_all_children();
        const labelHeight = this._measureLabelHeight();
        for (const gap of guideGaps(helpers)) {
            // Below the guide labels at the top of the zone, or right of them on the left.
            const at = gap.axis === 'x'
                ? LABEL_MARGIN + labelHeight + 2 * LABEL_MARGIN + Math.round(labelHeight / 2)
                : 6 * LABEL_MARGIN;
            this._drawGap({...gap, at});
        }
        for (const gap of rectangleGaps(helpers, this.selectedId))
            this._drawGap(gap);
    }

    /**
     * A line joining two edges along `axis`, at `at` across it, and its length: centered on a
     * horizontal line, right of a vertical one.
     */
    _drawGap({axis, from, to, at}) {
        const {k} = this.geometry;
        const middle = (from + to) / 2;
        const line = new St.Widget({style: `background-color: ${withAlpha(this._color(), 0.6)};`});
        const label = new St.Label({
            style_class: 'measure-things-label measure-things-gap',
            text: formatLength((to - from) * this.displayRatio),
        });
        this._gapLines.add_child(line);
        this._gapLabels.add_child(label);
        const [, labelWidth] = label.get_preferred_width(-1);
        const [, labelHeight] = label.get_preferred_height(-1);
        if (axis === 'x') {
            line.set_position(from / k, at / k);
            line.set_size((to - from) / k, this._line());
            label.set_position(Math.round(middle - labelWidth / 2), Math.round(at - labelHeight / 2));
        } else {
            line.set_position(at / k, from / k);
            line.set_size(this._line(), (to - from) / k);
            label.set_position(Math.round(at + LABEL_MARGIN), Math.round(middle - labelHeight / 2));
        }
    }

    _syncGrid() {
        this._grid.destroy_all_children();
        const {grid} = this.content;
        const zoom = this.unitsPerCss;
        if (!grid.visible)
            return;
        const {k, width, height} = this.geometry;
        // Grid settings are CSS pixels at the set's zoom.
        const columns = columnGrid({
            width: width / this.zonePerCss,
            columns: grid.columns,
            gutter: grid.gutter,
            margin: grid.margin,
            maxWidth: grid.maxWidth,
        });
        const style = `background-color: ${withAlpha(this._color(), 0.12)};`;
        for (const column of columns) {
            this._grid.add_child(new St.Widget({
                style,
                x: column.x * zoom,
                y: 0,
                width: column.width * zoom,
                height: height / k,
            }));
        }
    }

    _syncMockup() {
        const {mockup} = this.content;
        const zoom = this.unitsPerCss;
        if (!this._showsMockup()) {
            this._mockup.hide();
            this._mockupPath = null;
            return;
        }
        if (this._mockupPath !== mockup.file) {
            this._mockupPath = mockup.file;
            this._mockup.hide();
            this._mockupImage = null;
            const path = mockup.file;
            this._images.load(path).then(image => {
                if (this._mockupPath !== path)
                    return;
                this._mockupImage = image;
                this._mockup.set_content(image.content);
                this._syncMockup();
            }).catch(error => {
                if (this._mockupPath === path)
                    console.warn(`Measure Things: could not load the mockup ${path}: ${error.message}`);
            });
            return;
        }
        const image = this._mockupImage;
        if (!image)
            return;
        // One image pixel per CSS pixel at density 1, at the set's zoom.
        this._mockup.set_position(mockup.x * zoom, mockup.y * zoom);
        this._mockup.set_size(image.width / mockup.density * zoom, image.height / mockup.density * zoom);
        this._mockup.opacity = Math.round(mockup.opacity * 255 / 100);
        this._mockup.show();
    }

    _syncBadge() {
        const badge = this._badge;
        badge.visible = this._showsBadge();
        if (!badge.visible)
            return;
        this._badgeDot.style = `background-color: ${this._color()};`;
        this._badgeLabel.text = this.model.name;
        const [, badgeWidth] = badge.get_preferred_width(-1);
        const [, badgeHeight] = badge.get_preferred_height(-1);
        const {width, height} = this.geometry;
        badge.set_position(Math.round(width - badgeWidth - BADGE_MARGIN),
            Math.round(height - badgeHeight - BADGE_MARGIN));
    }
}
