import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {formatLength, formatSize, withAlpha} from './format.js';
import {
    columnGrid,
    guideGaps,
    hitTest,
    highestScaleMonitor,
    isInZone,
    rectangleGaps,
    scaleHelper,
    surfaceOffset,
} from './geometry.js';
import {badgeName, roundCss} from './sets.js';
import {edgeAt, storedZone, zoneRects} from './zones.js';

const LABEL_MARGIN = 4;
const HANDLE_SIZE = 7;
const BADGE_NAME_LENGTH = 24;
// What a mockup file does that its view must read the image again for.
const {CHANGES_DONE_HINT, CREATED, DELETED, MOVED_IN, MOVED_OUT, RENAMED} = Gio.FileMonitorEvent;
const MOCKUP_FILE_EVENTS = [CHANGES_DONE_HINT, CREATED, DELETED, MOVED_IN, MOVED_OUT, RENAMED];
const RECTANGLE_PARTS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * Where a window's frame, or a zone of it, is drawn, as the views inside it need it:
 * - `k`: the stage pixels per unit of the window actor's children. In physical layout mode Mutter
 *   scales them by the window's geometry scale; in logical mode it is 1. One unit is one CSS pixel
 *   at 100% zoom either way.
 * - `originX`, `originY`: the zone's top-left corner in stage pixels; for the frame, moved as
 *   Mutter moves the window's surfaces onto the device pixels of the highest-scale monitor the
 *   frame touches.
 * - `layerX`, `layerY`: the same corner in the window actor's units.
 * - `width`, `height`: the zone's size in stage pixels.
 * - `visible`: the part of the zone inside the frame, in zone pixels, or null when it is empty.
 * - `zone`, `visibleInFrame`: the zone and its visible part in frame pixels.
 * - `frame`: the geometry of the whole frame, which has `visible` and `zone` of the whole frame.
 * - `devicePerStage`: device pixels per stage pixel where the window is drawn.
 *
 * `zone` is a view's fixed zone, in the window actor's units from the frame's corner, or null.
 */
export function windowGeometry(window, logical, zone = null) {
    const frame = frameGeometry(window, logical);
    if (!frame)
        return null;
    const {rect, visible} = zoneRects(frame, zone, frame.k);
    return {
        ...frame,
        frame,
        originX: frame.originX + rect.x,
        originY: frame.originY + rect.y,
        layerX: frame.layerX + rect.x / frame.k,
        layerY: frame.layerY + rect.y / frame.k,
        width: rect.width,
        height: rect.height,
        zone: rect,
        visibleInFrame: visible,
        visible: visible && {...visible, x: visible.x - rect.x, y: visible.y - rect.y},
    };
}

function frameGeometry(window, logical) {
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
 * A set shown on a window, inside a zone of it: the whole frame, or a fixed zone. Its actors are
 * children of the window actor, so they move, hide, and stack with the window, and they are
 * attached only while they show something. Nothing in it is reactive.
 *
 * A view is the main view of its set, or a copy. A linked view shows the set's content; an
 * unlinked copy holds `local`, a model of its own that never reaches the set.
 *
 * Interaction runs in zone pixels: stage pixels from the zone's top-left corner. Helpers are
 * stored in CSS pixels at the set's zoom, and drawn in the window actor's units.
 */
export class View {
    constructor(set, window, {settings, images, isLogical, onClosed, onBadgeChanged, onMockupError, seq}) {
        this.set = set;
        this.local = null;
        this.zone = null;
        this.seq = seq;
        this.window = window;
        this.selectedId = null;
        this.editing = false;
        this.geometry = null;
        // The badge's place in the frame, which the manager sets for all views of a window.
        this.badgeRect = null;
        this.badgeSize = {width: 0, height: 0};
        this._onBadgeChanged = onBadgeChanged;
        this._onMockupError = onMockupError;
        this._settings = settings;
        this._images = images;
        this._isLogical = isLogical;
        this._actor = window.get_compositor_private();
        this._helperViews = new Map();
        this._mockupPath = null;
        this._mockupImage = null;
        this._mockupMonitor = null;
        this._mockupWatched = null;
        this._mockupLoad = null;
        this._labelHeight = 0;
        this._attached = false;
        this._badgeAttached = false;
        this._badgeShown = false;
        this._captureHidden = false;

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
        // The dashed frame of the zone and its edge handles, in edit mode.
        this._frame = new St.DrawingArea();
        this._frame.connect('repaint', area => this._paintFrame(area));
        this._zoneHandles = [0, 1, 2, 3].map(() => new St.Widget({style_class: 'measure-things-handle'}));
        // Children of the window actor of their own, above every view's layer: the box clips the
        // badge to the window frame.
        this._badgeBox = new St.Widget({name: 'measure-things-badge-box', clip_to_allocation: true});
        this._badge = new St.BoxLayout({style_class: 'measure-things-badge'});
        this._badgeBox.add_child(this._badge);
        this._badgeDot = new St.Widget({style_class: 'measure-things-badge-dot', y_align: Clutter.ActorAlign.CENTER});
        this._badgeLabel = new St.Label({style_class: 'measure-things-badge-label', y_align: Clutter.ActorAlign.CENTER});
        this._badgeLink = new St.Icon({icon_name: 'insert-link-symbolic', icon_size: 12, y_align: Clutter.ActorAlign.CENTER});
        this._badge.add_child(this._badgeDot);
        this._badge.add_child(this._badgeLabel);
        this._badge.add_child(this._badgeLink);
        for (const group of [this._frame, ...this._zoneHandles, this._handles, this._gapLabels, this._labels])
            this._chrome.add_child(group);
        this.layer.add_child(this._content);
        this.layer.add_child(this._chrome);

        const sync = () => this.sync();
        this._windowSignals = [
            window.connect('position-changed', sync),
            window.connect('size-changed', sync),
            window.connect('highest-scale-monitor-changed', sync),
            window.connect('unmanaged', () => onClosed(this)),
        ];
        // The window reports a move before its actor follows it, and the geometry reads the actor.
        this._actorSignals = this._actor
            ? ['notify::x', 'notify::y'].map(name => this._actor.connect(name, sync)) : [];
        this._monitorsSignal = Main.layoutManager.connect('monitors-changed', sync);
        this._badgesSignal = settings.connect('changed::show-badges', () => this.sync());
        this._unitSignal = settings.connect('changed::unit', () => this.sync());
        this.sync();
    }

    destroy() {
        for (const id of this._windowSignals)
            this.window.disconnect(id);
        this._disconnectActor();
        Main.layoutManager.disconnect(this._monitorsSignal);
        this._settings.disconnect(this._badgesSignal);
        this._settings.disconnect(this._unitSignal);
        this._setAttached(false);
        this._setBadgeAttached(false);
        this._watchMockup(null);
        this.layer.destroy();
        this._badgeBox.destroy();
        this._helperViews.clear();
        this._mockupPath = null;
        this._mockupLoad = null;
    }

    /** Detaches from a window that is going away, before its actor is destroyed. */
    detach() {
        this._disconnectActor();
        this._setAttached(false);
        this._setBadgeAttached(false);
    }

    _disconnectActor() {
        for (const id of this._actorSignals)
            this._actor.disconnect(id);
        this._actorSignals = [];
    }

    setEditing(editing) {
        this.editing = editing;
        if (!editing)
            this.selectedId = null;
        this.sync();
    }

    /** Hides the view for a capture of the screen, without detaching it. */
    setCaptureHidden(hidden) {
        this._captureHidden = hidden;
        this.layer.visible = !hidden;
        this._badgeBox.visible = !hidden && this._badgeShown;
    }

    /** The model its edits go to: the set's, or an unlinked copy's own. */
    get model() {
        return this.local ?? this.set;
    }

    get isMain() {
        return this.set.view === this;
    }

    get linked() {
        return this.local === null;
    }

    /** Whether the zone is fixed rather than the whole window. */
    get fixed() {
        return this.zone !== null;
    }

    /** Sets the zone from a rectangle in frame pixels, rounded to whole stage pixels; null resets. */
    setZone(rect) {
        this.zone = rect && storedZone(rect, this.geometry.k);
        this.sync();
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

    /** The helpers in zone pixels, with their ids; those outside the zone are hidden, and left out. */
    zoneHelpers() {
        const {visible} = this.geometry;
        if (!visible)
            return [];
        return this.content.helpers.map(helper => scaleHelper(helper, this.zonePerCss))
            .filter(helper => isInZone(helper, visible));
    }

    /** Stores a helper given in zone pixels, rounded to CSS hundredths. */
    toCss(helper) {
        return scaleHelper(helper, 1 / this.zonePerCss, roundCss);
    }

    /** A stage point in whole zone pixels. */
    toZone(x, y) {
        return [Math.round(x - this.geometry.originX), Math.round(y - this.geometry.originY)];
    }

    /** Whether a zone point is in the visible part of the zone. */
    contains(x, y) {
        const {visible} = this.geometry;
        return Boolean(visible) && x >= visible.x && y >= visible.y &&
            x < visible.x + visible.width && y < visible.y + visible.height;
    }

    /**
     * What lies under a stage point, as a press sees it: `badge`, `edge` (a zone edge, in edit
     * mode, with its name), `helper` (what hit testing finds, which an unselected rectangle's
     * inside does not count as), and `inside` the visible zone.
     */
    hitAt(x, y) {
        const [zoneX, zoneY] = this.toZone(x, y);
        const {zone, visible} = this.geometry;
        const badge = this.badgeRect;
        const onBadge = this._badgeShown && Boolean(badge) && zoneX + zone.x >= badge.x &&
            zoneY + zone.y >= badge.y && zoneX + zone.x < badge.x + badge.width &&
            zoneY + zone.y < badge.y + badge.height;
        const inside = this.contains(zoneX, zoneY);
        const hit = inside ? hitTest(this.zoneHelpers(), zoneX, zoneY) : null;
        const helper = hit && (hit.part !== 'inside' || hit.id === this.selectedId) ? hit : null;
        return {
            badge: onBadge,
            edge: this.editing && visible ? edgeAt(visible, zoneX, zoneY) : null,
            helper,
            inside,
            under: hit,
        };
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

    /** A set a gesture is still creating has no badge until its first commit; a hidden one has none. */
    _showsBadge() {
        return !this.set.provisional && (this.editing || !this.set.hidden) &&
            (this.editing || this._settings.get_boolean('show-badges'));
    }

    _showsMockup() {
        return this.content.mockup.visible && this.content.mockup.file !== '';
    }

    /** Whether the layer would show anything: it is attached only then. */
    _wanted() {
        if (!this.geometry.visible || (!this.editing && this.set.hidden))
            return false;
        return this.editing || this.content.grid.visible || this._showsMockup() ||
            (this._showsHelpers() && this.zoneHelpers().length > 0);
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

    _setBadgeAttached(attached) {
        if (attached === this._badgeAttached || !this._actor)
            return;
        this._badgeAttached = attached;
        if (attached)
            this._actor.add_child(this._badgeBox);
        else
            this._actor.remove_child(this._badgeBox);
    }

    /** Whether its badge shows. */
    get hasBadge() {
        return this._badgeShown;
    }

    /** The visible zone's area in stage pixels, which stacks views. */
    get zoneArea() {
        const visible = this.geometry?.visibleInFrame;
        return visible ? visible.width * visible.height : 0;
    }

    /** The layer and the badge, each when attached to the window actor. */
    get attached() {
        return {
            layer: this._attached ? this.layer : null,
            badge: this._badgeAttached ? this._badgeBox : null,
        };
    }

    /** Lays the view out again from the window and the set. */
    sync() {
        this.geometry = windowGeometry(this.window, this._isLogical(), this.zone);
        this._setAttached(Boolean(this.geometry) && this._wanted());
        if (this._attached) {
            const {k, layerX, layerY, width, height, visible} = this.geometry;
            // The layer clips to the visible part; its content is laid out from the zone's corner.
            this.layer.set_position(layerX + visible.x / k, layerY + visible.y / k);
            this.layer.set_size(visible.width / k, visible.height / k);
            this._content.set_position(-visible.x / k, -visible.y / k);
            this._content.set_size(width / k, height / k);
            this._chrome.set_position(-visible.x / k, -visible.y / k);
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
            this._syncZoneFrame();
        }
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
        if (!ids.has(this.selectedId))
            this.selectedId = null;
        for (const [id, views] of this._helperViews) {
            if (!ids.has(id)) {
                for (const actor of views.actors)
                    actor.destroy();
                this._helperViews.delete(id);
            }
        }
        let created = false;
        for (const helper of helpers) {
            let views = this._helperViews.get(helper.id);
            if (!views || views.kind !== helper.kind) {
                for (const actor of views?.actors ?? [])
                    actor.destroy();
                views = this._createHelperViews(helper);
                this._helperViews.set(helper.id, views);
                created = true;
            }
            this._updateHelperViews(views, helper);
        }
        // New actors go on top; a helper that comes back into the zone keeps its place in the list.
        if (created)
            this.restack();
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
        const {k, width: zoneWidth, height: zoneHeight, visible} = this.geometry;
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
            // At the top or left of the visible part of the zone.
            if (vertical)
                views.label.set_position(Math.round(helper.x + LABEL_MARGIN), visible.y + LABEL_MARGIN);
            else
                views.label.set_position(visible.x + LABEL_MARGIN, Math.round(helper.y + LABEL_MARGIN));
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
        if (labelY + labelHeight > visible.y + visible.height)
            labelY = helper.y + helper.height - labelHeight - LABEL_MARGIN;
        const centered = helper.x + (helper.width - labelWidth) / 2;
        const labelX = Math.min(Math.max(centered, visible.x), visible.x + visible.width - labelWidth);
        views.label.set_position(Math.round(labelX), Math.round(labelY));

        const ratio = this.displayRatio;
        views.position.visible = selected;
        views.position.style = labelStyle;
        views.position.text = `${formatLength(helper.x * ratio)}, ${formatLength(helper.y * ratio)}`;
        const [, positionHeight] = views.position.get_preferred_height(-1);
        views.position.set_position(Math.round(helper.x),
            Math.round(Math.max(helper.y - positionHeight - LABEL_MARGIN, visible.y)));

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
            this._mockupImage = null;
            this._mockupLoad = null;
            this._watchMockup(null);
            return;
        }
        if (this._mockupPath !== mockup.file) {
            this._mockupPath = mockup.file;
            this._mockup.hide();
            this._mockupImage = null;
            const path = mockup.file;
            // Only the last load counts: an older one may end after it.
            const load = {};
            this._mockupLoad = load;
            this._watchMockup(path);
            this._images.load(path).then(image => {
                if (this._mockupLoad !== load)
                    return;
                this._mockupImage = image;
                this._mockup.set_content(image.content);
                this._syncMockup();
            }).catch(error => {
                if (this._mockupLoad !== load)
                    return;
                console.warn(`Measure Things: could not load the mockup ${path}: ${error.message}`);
                this._onMockupError(this, path);
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

    /** Reads the image again when its file appears, changes, or goes. */
    _watchMockup(path) {
        if (path === this._mockupWatched)
            return;
        this._mockupMonitor?.cancel();
        this._mockupMonitor = null;
        this._mockupWatched = path;
        if (path === null)
            return;
        this._mockupMonitor = Gio.File.new_for_path(path).monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._mockupMonitor.connect('changed', (_monitor, _file, _other, event) => {
            if (!MOCKUP_FILE_EVENTS.includes(event))
                return;
            this._mockupPath = null;
            this._syncMockup();
        });
    }

    /** The dashed frame of the zone's visible part, and a handle in the middle of each edge. */
    _syncZoneFrame() {
        const shown = this.editing;
        this._frame.visible = shown;
        for (const handle of this._zoneHandles)
            handle.visible = shown;
        if (!shown)
            return;
        const {x, y, width, height} = this.geometry.visible;
        this._frame.set_position(x, y);
        this._frame.set_size(width, height);
        this._frame.queue_repaint();
        const half = Math.floor(HANDLE_SIZE / 2);
        const middles = [[x, y + height / 2 - half], [x + width - HANDLE_SIZE, y + height / 2 - half],
            [x + width / 2 - half, y], [x + width / 2 - half, y + height - HANDLE_SIZE]];
        this._zoneHandles.forEach((handle, i) => {
            handle.style = `border-color: ${this._color()};`;
            handle.set_position(Math.round(middles[i][0]), Math.round(middles[i][1]));
        });
    }

    _paintFrame(area) {
        const [width, height] = area.get_surface_size();
        const cr = area.get_context();
        const rgb = parseInt(this._color().slice(1), 16);
        cr.setSourceRGBA((rgb >> 16) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255, 0.9);
        cr.setLineWidth(1);
        cr.setDash([6, 4], 0);
        cr.rectangle(0.5, 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
        cr.stroke();
        cr.$dispose();
    }

    /** Lays the badge's contents out, and tells the manager its size: it places badges together. */
    _syncBadge() {
        const badge = this._badge;
        this._badgeShown = Boolean(this.geometry) && this._showsBadge();
        this._setBadgeAttached(this._badgeShown);
        this._badgeBox.visible = this._badgeShown && !this._captureHidden;
        this._badge.visible = this._badgeShown;
        if (!this._badgeShown) {
            this.badgeRect = null;
            this._onBadgeChanged(this);
            return;
        }
        const main = this.isMain;
        const color = this._color();
        this._badgeDot.style = main ? `background-color: ${color};`
            : `background-color: transparent; border: 1px solid ${color}; width: 6px; height: 6px;`;
        this._badgeLink.visible = !main && this.linked;
        // The name is cut past 24 characters, or past half the frame's width.
        const {width} = this.geometry.frame;
        let length = BADGE_NAME_LENGTH;
        const text = () => (main ? badgeName(this.set.name, length) : 'Copy');
        this._badgeLabel.text = text();
        let [, badgeWidth] = badge.get_preferred_width(-1);
        while (main && badgeWidth > width / 2 && length > 1) {
            length--;
            this._badgeLabel.text = text();
            [, badgeWidth] = badge.get_preferred_width(-1);
        }
        const [, badgeHeight] = badge.get_preferred_height(-1);
        this.badgeSize = {width: Math.ceil(badgeWidth), height: Math.ceil(badgeHeight)};
        badge.set_scale(1 / this.geometry.k, 1 / this.geometry.k);
        this._onBadgeChanged(this);
    }

    /** The corner a badge belongs to: the bottom right of the zone's visible part, or of the frame. */
    badgeCorner() {
        const {visibleInFrame, frame} = this.geometry;
        const area = visibleInFrame ?? {x: 0, y: 0, width: frame.width, height: frame.height};
        return {right: area.x + area.width, bottom: area.y + area.height};
    }

    /** Puts the badge at a place in the frame, in stage pixels. */
    placeBadge(x, y) {
        const {frame} = this.geometry;
        this.badgeRect = {x, y, width: this.badgeSize.width, height: this.badgeSize.height};
        this._badgeBox.set_position(frame.layerX, frame.layerY);
        this._badgeBox.set_size(frame.width / frame.k, frame.height / frame.k);
        this._badge.set_position(x / frame.k, y / frame.k);
    }
}
