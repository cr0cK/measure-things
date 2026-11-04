import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {BadgeMenu} from './badge.js';
import {setCursor} from './cursor.js';
import {nearestBoundary, regionAround} from './edges.js';
import {formatLength, formatSize, withAlpha} from './format.js';
import {cursorFor, dragHelper, monitorAt, rectFromPoints, targetAt, windowRole} from './geometry.js';
import {notify} from './manager.js';
import {roundCss} from './sets.js';
import {Snapshot} from './snapshot.js';
import {windowGeometry} from './view.js';
import {dragEdge, pickHit, targetZone, zoneEntry} from './zones.js';

// A press must travel this far, in stage pixels, before it draws a rectangle.
const DRAG_THRESHOLD = 3;
// Dragged edges snap to screen edges this close, in stage pixels.
const SNAP_DISTANCE = 6;
const LABEL_MARGIN = 4;
const NEUTRAL_COLOR = '#ff2d95';
const HINT_TEXT = [
    'Drag  rectangle   ·   H / V  guide   ·   D  measure area   ·   Arrows  nudge (Shift ×10, Alt resize)   ·   ' +
        'Tab  select   ·   Del  remove',
    'Ctrl+Z  undo   ·   Ctrl+C  copy   ·   Ctrl+drag  no snapping   ·   Right-drag  move mockup   ·   ' +
        'G  grid   ·   A  add a copy   ·   Drag a dashed edge  frame a zone   ·   Esc  done',
].join('\n');
const TYPE_NAMES = new Map(Object.entries(Meta.WindowType).map(([name, type]) => [type, name]));
// What a target window does that edit mode must react to.
const WINDOW_CHANGES = ['position-changed', 'size-changed', 'highest-scale-monitor-changed',
    'notify::minimized', 'workspace-changed'];

/** How a window counts for targeting: `window`, `blocker`, or `ignore`. */
export function roleOf(window) {
    return windowRole(TYPE_NAMES.get(window.get_window_type()), window.is_override_redirect());
}

/** Whether a window is on screen: not minimized, and on the active workspace. */
export function isShown(window) {
    return !window.minimized &&
        window.located_on_workspace(global.workspace_manager.get_active_workspace());
}

/**
 * The stage-wide layer for input: edit mode takes a modal grab on it and handles every pointer and
 * key event, targeting the window and the view under the pointer, and it draws the crosshair, the
 * readout, the measured area, and the hint bar. It also picks the window a set is loaded onto.
 * Outside those modes nothing in it is reactive or visible.
 */
export class Overlay {
    constructor(settings, manager, {onStateChanged, onSettings, onSaveAs}) {
        this._settings = settings;
        this._manager = manager;
        this._onStateChanged = onStateChanged;
        this._onSettings = onSettings;
        this._onSaveAs = onSaveAs;
        this._mode = null;
        this._grab = null;
        this._target = null;
        this._drag = null;
        this._snapshot = null;
        this._snapshotToken = null;
        this._recaptureId = 0;
        this._watched = null;
        this._watchIds = [];
        this._globalIds = [];
        this._measuring = false;
        this._region = null;
        this._badgeMenu = null;
        this._loadDone = null;
        // The view a press on a helper, a badge, or a zone edge keeps as the target, and a pending
        // Add a copy… pick.
        this._latched = null;
        this._copyPick = null;
        // Shared by every line request, so a pending line calls it back once.
        this._onLineRead = () => this._refreshPointer();
        manager.onViewRemoved = view => this._onViewRemoved(view);
        manager.onViewPromoted = view => {
            if (this._badgeMenu?.view === view)
                this._badgeMenu.close();
        };
        manager.onSetReplaced = model => this._onSetReplaced(model);
        manager.onSavedChanged = () => this._badgeMenu?.refreshSaved();

        this.actor = new St.Widget({name: 'measure-things-overlay', reactive: false});
        this.actor.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        this._cursorGroup = new St.Widget({visible: false});
        this._crosshairX = new St.Widget();
        this._crosshairY = new St.Widget();
        this._areaGroup = new St.Widget({visible: false});
        this._areaX = new St.Widget();
        this._areaY = new St.Widget();
        this._areaWidth = new St.Label({style_class: 'measure-things-label'});
        this._areaHeight = new St.Label({style_class: 'measure-things-label'});
        for (const actor of [this._areaX, this._areaY, this._areaWidth, this._areaHeight])
            this._areaGroup.add_child(actor);
        this._readout = new St.Label({style_class: 'measure-things-label measure-things-readout'});
        this._hint = new St.Label({style_class: 'measure-things-hint', text: HINT_TEXT});
        this._hint.clutter_text.line_alignment = Pango.Alignment.CENTER;
        for (const actor of [this._crosshairX, this._crosshairY, this._areaGroup, this._readout, this._hint])
            this._cursorGroup.add_child(actor);
        this._loadGroup = new St.Widget({visible: false});
        this._highlight = new St.Widget({style_class: 'measure-things-highlight', visible: false});
        this._loadHint = new St.Label({style_class: 'measure-things-hint'});
        this._loadGroup.add_child(this._highlight);
        this._loadGroup.add_child(this._loadHint);
        this.actor.add_child(this._cursorGroup);
        this.actor.add_child(this._loadGroup);

        this.actor.connect('button-press-event', (_actor, event) => this._onPress(event));
        this.actor.connect('motion-event', (_actor, event) => this._onMotion(event));
        this.actor.connect('button-release-event', (_actor, event) => this._onRelease(event));
        this.actor.connect('key-press-event', (_actor, event) => this._onKeyPress(event));
        Main.layoutManager.addTopChrome(this.actor);
        // Below the modal dialogs that edit mode opens, which its reactive layer would cover.
        Main.uiGroup.set_child_below_sibling(this.actor, Main.layoutManager.modalDialogGroup);
    }

    destroy() {
        this.exitEdit();
        this._endLoad(null);
        if (this._recaptureId)
            GLib.source_remove(this._recaptureId);
        this._recaptureId = 0;
        this._manager.onViewRemoved = () => {};
        this._manager.onViewPromoted = () => {};
        this._manager.onSetReplaced = () => {};
        this._manager.onSavedChanged = () => {};
        this.actor.destroy();
    }

    get editing() {
        return this._mode === 'edit';
    }

    /** Whether a gesture is in progress, which nothing else may commit under. */
    get dragging() {
        return this._drag !== null;
    }

    _pushModal() {
        this.actor.reactive = true;
        this._grab = Main.pushModal(this.actor, {actionMode: Shell.ActionMode.POPUP});
    }

    _popModal() {
        Main.popModal(this._grab);
        this._grab = null;
        this.actor.reactive = false;
        setCursor(this.actor, 'DEFAULT');
    }

    /** Takes the modal grab; returns false when another mode is active. */
    enterEdit() {
        if (this._mode === 'edit')
            return true;
        if (this._mode)
            return false;

        this._pushModal();
        this._mode = 'edit';
        this._globalIds = [
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed',
                () => this._onWorkspaceSwitched())],
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed',
                () => this._onMonitorsChanged())],
        ];
        this._manager.setEditing(true);
        this._captureSnapshot();
        setCursor(this.actor, 'CROSSHAIR');
        this._cursorGroup.show();
        this._placeHint(this._hint);
        this._refreshPointer();
        this._onStateChanged();
        return true;
    }

    exitEdit() {
        if (this._mode !== 'edit')
            return;

        this._badgeMenu?.close();
        this._endCopyPick(null);
        // A drag released while its snapping lines were read is done; any other is cancelled.
        if (this._drag?.released)
            this._finishDrag(this._drag);
        else
            this._cancelDrag();
        this._popModal();
        this._mode = null;
        for (const [object, id] of this._globalIds)
            object.disconnect(id);
        this._globalIds = [];
        this._dropSnapshot();
        this._measuring = false;
        this._region = null;
        this._latched = null;
        this._setTarget(null);
        this._cursorGroup.hide();
        this._manager.setEditing(false);
        this._onStateChanged();
    }

    toggleEdit() {
        if (this.editing)
            this.exitEdit();
        else
            this.enterEdit();
    }

    /** Hides the layer and every view while the color picker reads the screen. */
    setHidden(hidden) {
        this.actor.visible = !hidden;
        this._manager.setCaptureHidden(hidden);
    }

    /** Opens the badge menu of a view, in edit mode. */
    openBadgeMenu(view) {
        if (!this.editing || !view)
            return;
        this._badgeMenu?.close();
        this._badgeMenu = new BadgeMenu(view, {
            manager: this._manager,
            onSettings: model => this._onSettings(model),
            onSaveAs: model => this._onSaveAs(model),
            onAddCopy: model => this._pickCopyWindow(model),
            onClosed: () => {
                this._badgeMenu = null;
            },
        });
        this._badgeMenu.open();
    }

    get badgeMenu() {
        return this._badgeMenu;
    }

    /**
     * Captures the screen without the layer and the views, for edge detection. The capture paints
     * the stage at once, so they are hidden for that paint only.
     */
    _captureSnapshot() {
        const token = {};
        this._snapshotToken = token;
        this._snapshot = null;
        this.actor.opacity = 0;
        this._manager.setCaptureHidden(true);
        Snapshot.capture()
            .then(snapshot => {
                if (this._snapshotToken !== token)
                    return;
                this._snapshot = snapshot;
                this._refreshPointer();
            })
            .catch(error => console.warn(`Measure Things: could not capture the screen: ${error.message}`))
            .finally(() => {
                if (this._snapshotToken === token)
                    this._showAfterCapture();
            });
    }

    _showAfterCapture() {
        this.actor.opacity = 255;
        this._manager.setCaptureHidden(false);
    }

    _dropSnapshot() {
        if (this._snapshotToken && !this._snapshot)
            this._showAfterCapture();
        this._snapshotToken = null;
        this._snapshot = null;
    }

    /** Watches the target window: edit mode reacts to it moving, hiding, or closing. */
    _watch(window) {
        if (this._watched === window)
            return;
        this._unwatch();
        if (!window)
            return;
        this._watched = window;
        this._watchIds = [
            ...WINDOW_CHANGES.map(name => window.connect(name, () => this._onWindowChanged(window))),
            window.connect('unmanaged', () => this._onWindowChanged(window, true)),
        ];
    }

    _unwatch() {
        for (const id of this._watchIds)
            this._watched.disconnect(id);
        this._watched = null;
        this._watchIds = [];
    }

    /**
     * The target window moved, resized, changed scale or monitor, was minimized, left the
     * workspace, or closed: a gesture on it is cancelled, and a window no longer shown loses its
     * target and selection. Otherwise the screen is captured again.
     */
    _onWindowChanged(window, closed = false) {
        if (!this.editing)
            return;
        if (this._drag?.window === window)
            this._cancelDrag();
        if (closed || !isShown(window)) {
            this._setTarget(null);
            this._refreshPointer();
            return;
        }
        this._scheduleRecapture();
    }

    _onWorkspaceSwitched() {
        const window = this._drag?.window ?? this._target?.window;
        if (window)
            this._onWindowChanged(window);
        else
            this._scheduleRecapture();
    }

    _onMonitorsChanged() {
        this._cancelDrag();
        this._scheduleRecapture();
    }

    /** Windows send several changes in a row: the screen is captured again once they settle. */
    _scheduleRecapture() {
        if (this._recaptureId)
            GLib.source_remove(this._recaptureId);
        this._recaptureId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._recaptureId = 0;
            if (this.editing)
                this._captureSnapshot();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onViewRemoved(view) {
        const drag = this._drag;
        if (drag?.view === view) {
            // What the gesture changed in a set that stays is put back.
            this._drag = null;
            this._revert(drag);
        }
        if (this._latched === view)
            this._latched = null;
        if (this._target?.view === view) {
            this._target = null;
            this._unwatch();
        }
        if (this._badgeMenu?.view === view)
            this._badgeMenu.close();
    }

    /**
     * Another program edited the file of a set: a gesture on the set is cancelled, and the badge
     * menus of its views close. An unlinked copy is not affected.
     */
    _onSetReplaced(set) {
        const shared = view => view.linked && this._manager.setOf(view.model) === set;
        if (this._drag?.view && shared(this._drag.view))
            this._cancelDrag();
        if (this._badgeMenu && shared(this._badgeMenu.view))
            this._badgeMenu.close();
    }

    /** The topmost visible window under a stage point; null over no window. */
    _windowAt(x, y) {
        if (Main.overview.visible)
            return null;
        const panel = Main.layoutManager.panelBox;
        if (panel.visible) {
            const [panelX, panelY] = panel.get_transformed_position();
            if (x >= panelX && y >= panelY && x < panelX + panel.width && y < panelY + panel.height)
                return null;
        }
        const windows = [];
        for (const actor of global.get_window_actors().reverse()) {
            const window = actor.meta_window;
            if (!actor.visible || !window || !isShown(window))
                continue;
            windows.push({window, rect: window.get_frame_rect(), role: roleOf(window)});
        }
        const index = targetAt(windows, x, y);
        return index < 0 ? null : windows[index].window;
    }

    /** The view whose zone targeting picks at a point of a window: the smallest, the newest. */
    _zoneViewAt(window, x, y) {
        const views = this._manager.viewsOn(window).filter(view => view.geometry);
        if (views.length === 0)
            return null;
        const {originX, originY} = views[0].geometry.frame;
        return targetZone(views.map(view => zoneEntry(view, view.geometry.visibleInFrame, view.seq)),
            x - originX, y - originY);
    }

    /**
     * The window under a point and its view: the latched view while the pointer stays in the
     * window, else the view whose zone is smallest there; the view is null where no zone covers.
     */
    _targetAt(x, y) {
        const window = this._windowAt(x, y);
        if (!window)
            return null;
        const latched = this._latched;
        const view = latched?.window === window ? latched : this._zoneViewAt(window, x, y);
        return {window, view};
    }

    /**
     * What a press at a point of a window acts on, over every view of it: `{view, kind, hit}`, with
     * `kind` the badge, the zone edge, the helper, or the zone, in that order; null where no view
     * has anything. Among equal hits the view targeted last wins, then the one stacked higher.
     * `edges` false looks past zone edges.
     */
    _pickAt(window, x, y, edges = true) {
        const zoneView = this._zoneViewAt(window, x, y);
        const entries = this._manager.viewsOn(window).filter(view => view.geometry).map(view => {
            const hit = view.hitAt(x, y);
            return {
                id: view,
                hit,
                area: view.zoneArea,
                seq: view.seq,
                badge: hit.badge,
                edge: edges && hit.edge !== null,
                helper: hit.helper !== null,
                zone: view === zoneView,
            };
        });
        const pick = pickHit(entries, this._latched ?? this._target?.view ?? null);
        return pick && {view: pick.id, kind: pick.kind, hit: entries.find(entry => entry.id === pick.id).hit};
    }

    _setTarget(target) {
        const view = this._target?.view;
        if (view && view !== target?.view && view.selectedId !== null)
            view.select(null);
        this._target = target;
        this._watch(this.editing ? target?.window ?? null : null);
    }

    /** The zone of a target: its view's, or the window's frame when it has no view. */
    _zoneOf(target) {
        return target.view?.geometry ?? windowGeometry(target.window, this._manager.isLogical());
    }

    /** Display units per zone pixel on a target. */
    _ratioOf(target) {
        if (target.view)
            return target.view.displayRatio;
        const zone = this._zoneOf(target);
        return this._settings.get_string('unit') === 'device' ? zone.devicePerStage : 1 / zone.k;
    }

    _placeHint(hint) {
        const monitor = Main.layoutManager.primaryMonitor;
        const [, width] = hint.get_preferred_width(-1);
        const [, height] = hint.get_preferred_height(-1);
        hint.set_position(
            Math.round(monitor.x + (monitor.width - width) / 2),
            monitor.y + monitor.height - height - 32);
    }

    _updateCursor(x, y) {
        if (!this._drag) {
            // A latched view stays the target until the pointer leaves its window.
            if (this._latched && this._latched.window !== this._windowAt(x, y))
                this._latched = null;
            this._setTarget(this._targetAt(x, y));
        }
        const target = this._drag?.target ?? this._target;
        const color = target?.view?.content.color ?? NEUTRAL_COLOR;
        this._crosshairX.style = `background-color: ${withAlpha(color, 0.45)};`;
        this._crosshairY.style = this._crosshairX.style;
        const monitors = Main.layoutManager.monitors;
        const monitor = monitors[monitorAt(monitors, x, y)] ??
            {x: 0, y: 0, width: global.stage.width, height: global.stage.height};
        this._crosshairX.set_position(monitor.x, y);
        this._crosshairX.set_size(monitor.width, 1);
        this._crosshairY.set_position(x, monitor.y);
        this._crosshairY.set_size(1, monitor.height);
        this._updateArea(x, y, target, color);

        // Outside the latched view's zone, the readout shows nothing.
        const inZone = this._inZone(target, x, y);
        this._readout.visible = Boolean(target) && inZone;
        if (target && inZone) {
            const zone = this._zoneOf(target);
            const ratio = this._ratioOf(target);
            this._readout.text = this._region
                ? formatSize(this._region.width * ratio, this._region.height * ratio)
                : `${formatLength((x - zone.originX) * ratio)}, ${formatLength((y - zone.originY) * ratio)}`;
            this._readout.set_position(x + 14, y + 14);
        }

        if (this._drag)
            return;
        let cursor = 'CROSSHAIR';
        const pick = target && this._pickAt(target.window, x, y);
        if (pick?.kind === 'badge') {
            cursor = 'POINTER';
        } else if (pick?.kind === 'edge') {
            cursor = pick.hit.edge === 'left' || pick.hit.edge === 'right' ? 'EW_RESIZE' : 'NS_RESIZE';
        } else if (pick?.kind === 'helper') {
            const helper = pick.view.content.helpers.find(h => h.id === pick.hit.helper.id);
            cursor = cursorFor(helper.kind, pick.hit.helper.part);
        }
        setCursor(this.actor, cursor);
    }

    /** Whether a stage point is in the target's visible zone; a window without a view is all zone. */
    _inZone(target, x, y) {
        const view = target?.view;
        return !view || view.contains(...view.toZone(x, y));
    }

    /**
     * In area measuring, finds the run of same-colored pixels around the pointer on its row and
     * column, within the target zone, and draws their extent in stage pixels.
     */
    _updateArea(x, y, target, color) {
        this._region = null;
        const snapshot = this._snapshot;
        const measuring = this._measuring && target && this._inZone(target, x, y);
        const row = measuring && snapshot?.line('row', y, this._onLineRead);
        const column = measuring && snapshot?.line('column', x, this._onLineRead);
        const shown = Boolean(row && column);
        this._areaGroup.visible = shown;
        this._crosshairX.visible = !shown;
        this._crosshairY.visible = !shown;
        if (!shown)
            return;

        const {scale} = snapshot;
        const zone = this._zoneOf(target);
        const clamp = ({start, end}, origin, length) => ({
            start: Math.max(start, Math.round(origin * scale)),
            end: Math.min(end, Math.round((origin + length) * scale)),
        });
        const {visible} = zone;
        const across = clamp(regionAround(row, snapshot.pixel(x)), zone.originX + visible.x, visible.width);
        const down = clamp(regionAround(column, snapshot.pixel(y)), zone.originY + visible.y, visible.height);
        const region = {
            x: across.start / scale,
            y: down.start / scale,
            width: Math.max(0, across.end - across.start) / scale,
            height: Math.max(0, down.end - down.start) / scale,
        };
        this._region = region;
        const ratio = this._ratioOf(target);
        for (const actor of [this._areaX, this._areaY, this._areaWidth, this._areaHeight])
            actor.style = `background-color: ${color};`;
        this._areaX.set_position(region.x, y);
        this._areaX.set_size(region.width, 1);
        this._areaY.set_position(x, region.y);
        this._areaY.set_size(1, region.height);
        this._areaWidth.text = formatLength(region.width * ratio);
        this._areaHeight.text = formatLength(region.height * ratio);
        const [, width] = this._areaWidth.get_preferred_width(-1);
        const [, height] = this._areaWidth.get_preferred_height(-1);
        this._areaWidth.set_position(Math.round(region.x + (region.width - width) / 2),
            y - height - LABEL_MARGIN);
        const [, heightLabelHeight] = this._areaHeight.get_preferred_height(-1);
        this._areaHeight.set_position(x + LABEL_MARGIN,
            Math.round(region.y + (region.height - heightLabelHeight) / 2));
    }

    /** Redraws what depends on the screen capture once a line of it has been read. */
    _refreshPointer() {
        if (!this.editing)
            return;
        const drag = this._drag;
        if (drag?.pointer) {
            this._applyDrag();
            if (drag.released && !drag.waiting)
                this._finishDrag(drag);
        }
        const [x, y] = global.get_pointer();
        this._updateCursor(x, y);
    }

    /**
     * The nearest screen edge to a vertical edge at `x`, on the row through `y`, both in pixels
     * from the corner of `zone`, within `bounds` in the same pixels: the zone's visible part for
     * helpers, the window frame for a zone edge. Marks the drag as waiting while that row is
     * being read.
     */
    _snapX(zone, x, y, bounds = zone.visible) {
        const snapshot = this._snapshot;
        const stageY = zone.originY + y;
        const row = snapshot?.line('row', stageY, this._onLineRead);
        if (!row) {
            this._drag.waiting ||= Boolean(snapshot?.reading('row', stageY));
            return x;
        }
        const snapped = this._nearest(row, snapshot.scale, zone.originX + x, zone.originX + bounds.x,
            bounds.width);
        return snapped - zone.originX;
    }

    /** Like _snapX(), for a horizontal edge at `y` on the column through `x`. */
    _snapY(zone, x, y, bounds = zone.visible) {
        const snapshot = this._snapshot;
        const stageX = zone.originX + x;
        const column = snapshot?.line('column', stageX, this._onLineRead);
        if (!column) {
            this._drag.waiting ||= Boolean(snapshot?.reading('column', stageX));
            return y;
        }
        const snapped = this._nearest(column, snapshot.scale, zone.originY + y, zone.originY + bounds.y,
            bounds.height);
        return snapped - zone.originY;
    }

    /** The stage coordinate of the nearest screen edge within the zone, or `position` itself. */
    _nearest(line, scale, position, origin, length) {
        // Only boundaries within the zone count: the nearest one may lie outside it.
        const boundary = nearestBoundary(line, position * scale, SNAP_DISTANCE * scale, undefined, {
            from: Math.ceil(origin * scale - 0.5),
            to: Math.floor((origin + length) * scale + 0.5),
        });
        return boundary === null ? position : boundary / scale;
    }

    _onPress(event) {
        const [x, y] = event.get_coords();
        if (this._picking()) {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                this._endPick(null);
            return Clutter.EVENT_STOP;
        }
        if (this._drag)
            return Clutter.EVENT_STOP;
        const window = this._windowAt(x, y);
        if (event.get_button() === Clutter.BUTTON_SECONDARY) {
            const target = this._targetAt(x, y);
            this._setTarget(target);
            const view = target?.view;
            if (view?.content.mockup.visible) {
                const {mockup} = view.content;
                this._drag = {kind: 'mockup', target, view, window: target.window, x, y, origin: [mockup.x, mockup.y]};
            }
            return Clutter.EVENT_STOP;
        }
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || !window)
            return Clutter.EVENT_STOP;

        const pick = this._pickAt(window, x, y);
        // A badge, a helper, or a zone edge keeps its view as the target; any other press lets
        // the zone under the pointer pick it.
        const latching = pick && pick.kind !== 'zone';
        this._latched = latching ? pick.view : null;
        const view = pick ? pick.view : null;
        const target = {window, view};
        this._setTarget(target);
        if (pick?.kind === 'badge') {
            this.openBadgeMenu(view);
        } else if (pick?.kind === 'edge') {
            this._drag = {
                kind: 'zone', target, view, window, edge: pick.hit.edge, x, y, active: false,
                origin: {...view.geometry.visibleInFrame}, originZone: view.zone,
            };
        } else if (pick?.kind === 'helper') {
            const {helper: hit} = pick.hit;
            const stored = view.content.helpers.find(h => h.id === hit.id);
            this._drag = {
                kind: 'move', target, view, window, id: hit.id, part: hit.part, x, y,
                origin: view.zoneHelpers().find(h => h.id === hit.id),
                originCss: {...stored},
            };
            view.select(hit.id);
        } else {
            this._drag = {
                kind: 'create', target, view, window, id: null, x, y,
                insideId: pick?.hit.under?.id ?? null,
            };
        }
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        const [x, y] = event.get_coords();
        if (this._picking()) {
            this._highlightAt(x, y);
            return Clutter.EVENT_STOP;
        }
        if (this._drag && !this._drag.released) {
            const snap = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) === 0;
            this._drag.pointer = {x, y, snap};
            this._applyDrag();
        }
        this._updateCursor(x, y);
        return Clutter.EVENT_STOP;
    }

    _replaceHelper(model, helper) {
        model.content.helpers = model.content.helpers.map(current =>
            (current.id === helper.id ? helper : current));
    }

    /** Applies the drag to the pointer position, snapping dragged edges to screen edges. */
    _applyDrag() {
        const drag = this._drag;
        const {x, y, snap} = drag.pointer;
        if (drag.kind === 'mockup') {
            const {mockup} = drag.view.content;
            mockup.x = roundCss(drag.origin[0] + (x - drag.x) / drag.view.zonePerCss);
            mockup.y = roundCss(drag.origin[1] + (y - drag.y) / drag.view.zonePerCss);
            this._manager.syncModel(drag.view.model);
            return;
        }

        drag.waiting = false;
        if (drag.kind === 'zone') {
            this._dragZoneEdge(drag, x, y, snap);
            return;
        }
        if (drag.kind === 'create' && drag.id === null) {
            if (Math.max(Math.abs(x - drag.x), Math.abs(y - drag.y)) < DRAG_THRESHOLD || drag.refused)
                return;
            if (!drag.view) {
                // The window can close before the press turns into a drag.
                if (!isManaged(drag.window)) {
                    this._drag = null;
                    return;
                }
                drag.view = this._manager.createSet(drag.window);
                drag.target = {window: drag.window, view: drag.view};
                this._target = drag.target;
            }
            if (!this._manager.canAddHelpers(drag.view.model)) {
                drag.refused = true;
                return;
            }
            drag.id = this._manager.addHelper(drag.view.model, {kind: 'rectangle', x: 0, y: 0, width: 1, height: 1}).id;
            drag.view.selectedId = drag.id;
            // A view with nothing to show is not attached to its window yet.
            this._manager.syncModel(drag.view.model);
        }

        const view = drag.view;
        const zone = view.geometry;
        const [zoneX, zoneY] = view.toZone(x, y);
        const [startX, startY] = view.toZone(drag.x, drag.y);
        const snapX = (value, rowY = zoneY) => (snap ? this._snapX(zone, value, rowY) : value);
        const snapY = (value, columnX = zoneX) => (snap ? this._snapY(zone, columnX, value) : value);
        let helper;
        if (drag.kind === 'move') {
            helper = dragHelper(drag.origin, drag.part, zoneX - startX, zoneY - startY, snapX, snapY);
        } else {
            const rect = rectFromPoints(snapX(startX, startY), snapY(startY, startX),
                snapX(zoneX), snapY(zoneY));
            helper = {id: drag.id, kind: 'rectangle', ...rect, width: Math.max(1, rect.width), height: Math.max(1, rect.height)};
        }
        this._replaceHelper(view.model, view.toCss(helper));
        this._manager.syncHelpers(view.model);
    }

    /**
     * Moves a zone's edge with the pointer once it has traveled 3 pixels, snapped to screen edges
     * anywhere in the window frame, within the frame and the 40 pixel minimum. The zone becomes
     * fixed.
     */
    _dragZoneEdge(drag, x, y, snap) {
        if (!drag.active) {
            if (Math.max(Math.abs(x - drag.x), Math.abs(y - drag.y)) < DRAG_THRESHOLD)
                return;
            drag.active = true;
        }
        const {frame} = drag.view.geometry;
        const bounds = {x: 0, y: 0, width: frame.width, height: frame.height};
        const {edge, origin} = drag;
        const horizontal = edge === 'left' || edge === 'right';
        const [frameX, frameY] = [x - frame.originX, y - frame.originY];
        const start = {left: origin.x, right: origin.x + origin.width, top: origin.y,
            bottom: origin.y + origin.height}[edge];
        let position = start + (horizontal ? x - drag.x : y - drag.y);
        if (snap && horizontal)
            position = this._snapX(frame, position, frameY, bounds);
        else if (snap)
            position = this._snapY(frame, frameX, position, bounds);
        drag.view.setZone(dragEdge(origin, edge, position, frame));
    }

    _onRelease(event) {
        if (this._picking()) {
            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                const [x, y] = event.get_coords();
                this._endPick(this._windowAt(x, y));
            }
            return Clutter.EVENT_STOP;
        }
        const drag = this._drag;
        const button = drag?.kind === 'mockup' ? Clutter.BUTTON_SECONDARY : Clutter.BUTTON_PRIMARY;
        if (!drag || drag.released || event.get_button() !== button)
            return Clutter.EVENT_STOP;

        // A line needed for snapping is still being read: finish once it is.
        if (drag.waiting)
            drag.released = true;
        else
            this._finishDrag(drag);
        return Clutter.EVENT_STOP;
    }

    _finishDrag(drag) {
        this._drag = null;
        if (drag.kind === 'zone') {
            // A press on an edge released before it traveled acts as a press under the edge.
            if (!drag.active)
                this._pressBelowEdge(drag);
            this._onStateChanged();
            return;
        }
        if (drag.kind === 'create' && drag.id === null) {
            drag.view?.select(drag.insideId);
            return;
        }
        this._manager.commit(drag.view.model);
        this._onStateChanged();
    }

    /**
     * A short press on a zone edge: it selects the helper under it, and latches that view, or
     * else clears the selection of the view that zone targeting picks, and latches it.
     */
    _pressBelowEdge(drag) {
        const {window, x, y} = drag;
        const pick = this._pickAt(window, x, y, false);
        this._latched = pick?.view ?? null;
        this._setTarget({window, view: pick?.view ?? null});
        if (pick?.kind === 'helper')
            pick.view.select(pick.hit.helper.id);
        else
            pick?.view.select(pick.hit.under?.id ?? null);
    }

    _cancelDrag() {
        const drag = this._drag;
        if (!drag)
            return;
        this._drag = null;
        this._revert(drag);
    }

    /** Puts back what a gesture changed, in a view and set that are still on screen. */
    _revert(drag) {
        const view = drag.view;
        if (!view)
            return;
        if (drag.kind === 'zone') {
            if (this._manager.views.includes(view)) {
                view.zone = drag.originZone;
                view.sync();
            }
            return;
        }
        const model = view.model;
        const set = this._manager.setOf(model);
        if (!this._manager.models.includes(set))
            return;
        if (drag.kind === 'mockup') {
            [model.content.mockup.x, model.content.mockup.y] = drag.origin;
        } else if (drag.kind === 'move') {
            this._replaceHelper(model, drag.originCss);
        } else if (drag.id !== null) {
            model.content.helpers = model.content.helpers.filter(helper => helper.id !== drag.id);
            if (view.selectedId === drag.id)
                view.selectedId = null;
        }
        if (set.provisional)
            this._manager.discard(set);
        else
            this._manager.syncModel(model);
    }

    /** The model of the target, creating a set on a window without a view. */
    _targetModel() {
        const target = this._target;
        if (!target || !isManaged(target.window))
            return null;
        if (!target.view) {
            target.view = this._manager.createSet(target.window);
            this._target = target;
        }
        return target.view.model;
    }

    /** Adds a helper given in zone pixels to the target, selects it, and commits. */
    _addHelper(zoneHelper) {
        const model = this._targetModel();
        if (!model)
            return;
        if (!this._manager.canAddHelpers(model)) {
            this._manager.discard(model);
            return;
        }
        const view = this._target.view;
        const helper = this._manager.addHelper(model, view.toCss(zoneHelper));
        view.selectedId = helper.id;
        this._manager.commit(model);
        this._onStateChanged();
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        if (this._picking()) {
            if (symbol === Clutter.KEY_Escape)
                this._endPick(null);
            return Clutter.EVENT_STOP;
        }
        const state = event.get_state();
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const control = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const alt = (state & Clutter.ModifierType.MOD1_MASK) !== 0;
        const [pointerX, pointerY] = global.get_pointer();
        const view = this._target?.view ?? null;
        const model = view?.model ?? null;
        const selected = view && view.zoneHelpers().find(helper => helper.id === view.selectedId);
        const [zoneX, zoneY] = this._target ? [pointerX - this._zoneOf(this._target).originX,
            pointerY - this._zoneOf(this._target).originY] : [0, 0];
        // H, V, D, and Enter do nothing while the pointer is outside the latched view's zone.
        const inZone = this._inZone(this._target, pointerX, pointerY);

        if (symbol === Clutter.KEY_Escape) {
            // A released drag waiting for a read is done, and exitEdit() finishes it.
            if (this._drag && !this._drag.released)
                this._cancelDrag();
            else
                this.exitEdit();
            return Clutter.EVENT_STOP;
        }
        if (this._drag)
            return Clutter.EVENT_STOP;

        switch (symbol) {
        case Clutter.KEY_Delete:
        case Clutter.KEY_BackSpace:
            if (selected) {
                model.content.helpers = model.content.helpers.filter(helper => helper.id !== selected.id);
                view.selectedId = null;
                this._manager.commit(model);
            }
            break;
        case Clutter.KEY_Left:
        case Clutter.KEY_Right:
        case Clutter.KEY_Up:
        case Clutter.KEY_Down: {
            const step = shift ? 10 : 1;
            const dx = symbol === Clutter.KEY_Left ? -step : symbol === Clutter.KEY_Right ? step : 0;
            const dy = symbol === Clutter.KEY_Up ? -step : symbol === Clutter.KEY_Down ? step : 0;
            if (control) {
                if (view?.content.mockup.visible) {
                    const {mockup} = view.content;
                    mockup.x = roundCss(mockup.x + dx / view.zonePerCss);
                    mockup.y = roundCss(mockup.y + dy / view.zonePerCss);
                    this._manager.commit(model);
                }
                break;
            }
            if (!selected)
                break;
            const part = alt && selected.kind === 'rectangle' ? (dx ? 'right' : 'bottom') : 'move';
            this._replaceHelper(model, view.toCss(dragHelper(selected, part, dx, dy)));
            this._manager.commit(model);
            break;
        }
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab: {
            // Helpers outside the zone are hidden, and cannot be selected.
            const helpers = view?.zoneHelpers() ?? [];
            if (helpers.length === 0)
                break;
            const index = helpers.findIndex(helper => helper.id === view.selectedId);
            const next = index < 0 ? 0 : (index + (shift ? helpers.length - 1 : 1)) % helpers.length;
            view.select(helpers[next].id);
            break;
        }
        case Clutter.KEY_h:
        case Clutter.KEY_H:
            if (inZone)
                this._addHelper({kind: 'horizontal', y: zoneY});
            break;
        case Clutter.KEY_v:
        case Clutter.KEY_V:
            if (inZone)
                this._addHelper({kind: 'vertical', x: zoneX});
            break;
        case Clutter.KEY_a:
        case Clutter.KEY_A:
            if (!control)
                this._addCopyHere();
            break;
        case Clutter.KEY_g:
        case Clutter.KEY_G: {
            const targetModel = this._targetModel();
            if (targetModel)
                this._manager.toggleGrid(targetModel);
            break;
        }
        case Clutter.KEY_c:
        case Clutter.KEY_C:
            if (control && selected) {
                copyToClipboard(selected.kind === 'rectangle' ? view.sizeMeasure(selected)
                    : view.guideMeasure(selected), 'edit-copy-symbolic');
            }
            break;
        case Clutter.KEY_d:
        case Clutter.KEY_D:
            if (inZone) {
                this._measuring = !this._measuring;
                this._updateCursor(pointerX, pointerY);
            }
            break;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            if (inZone && this._region && this._target) {
                const zone = this._zoneOf(this._target);
                const region = this._region;
                this._addHelper({
                    kind: 'rectangle',
                    x: region.x - zone.originX,
                    y: region.y - zone.originY,
                    width: Math.max(1, region.width),
                    height: Math.max(1, region.height),
                });
            }
            break;
        case Clutter.KEY_z:
        case Clutter.KEY_Z:
            if (control && model)
                this._step(model, shift ? 'redo' : 'undo');
            break;
        case Clutter.KEY_y:
        case Clutter.KEY_Y:
            if (control && model)
                this._step(model, 'redo');
            break;
        case Clutter.KEY_bracketleft:
        case Clutter.KEY_bracketright:
            if (view?.content.mockup.visible) {
                const {mockup} = view.content;
                const delta = symbol === Clutter.KEY_bracketleft ? -10 : 10;
                mockup.opacity = Math.min(100, Math.max(5, mockup.opacity + delta));
                this._manager.commit(model);
            }
            break;
        }
        return Clutter.EVENT_STOP;
    }

    _step(model, direction) {
        this._manager[direction](model);
        this._onStateChanged();
    }

    /** `A`: a linked copy of the set edited last, on the window under the pointer. */
    _addCopyHere() {
        const window = this._target?.window;
        if (!window || !isManaged(window))
            return;
        const model = this._manager.lastEdited;
        if (!model || !this._manager.models.includes(model)) {
            notify('No set to copy. Edit or load a set first.');
            return;
        }
        this._manager.addCopy(model, window);
        // The window has a view now: what the pointer targets changes without it moving.
        this._refreshPointer();
        this._onStateChanged();
    }

    _picking() {
        return this._mode === 'load' || this._copyPick !== null;
    }

    _endPick(window) {
        if (this._copyPick)
            this._endCopyPick(window);
        else
            this._endLoad(window);
    }

    /**
     * Add a copy…: a crosshair and a hint until a window is clicked, without leaving edit mode;
     * resolves with that window, or null on Escape or a click outside any window.
     */
    _pickCopyWindow(model) {
        if (!this.editing || this._copyPick || this._drag)
            return Promise.resolve(null);
        this._copyPick = {done: null};
        this._cursorGroup.hide();
        this._loadHint.text = `Click a window to add a copy of “${model.name}” · Esc cancels`;
        this._loadGroup.show();
        this._placeHint(this._loadHint);
        this._highlightAt(...global.get_pointer());
        return new Promise(resolve => {
            this._copyPick.done = resolve;
        }).then(window => {
            if (window && this.editing && this._manager.models.includes(model)) {
                this._manager.addCopy(model, window);
                this._refreshPointer();
            }
            this._onStateChanged();
        });
    }

    _endCopyPick(window) {
        const pick = this._copyPick;
        if (!pick)
            return;
        this._copyPick = null;
        this._loadGroup.hide();
        if (this.editing) {
            this._cursorGroup.show();
            this._refreshPointer();
        }
        pick.done(window);
    }

    /**
     * Shows a crosshair and a hint until a window is clicked; resolves with that window, or null
     * on Escape or a click outside any window.
     */
    pickWindow(setName) {
        if (this._mode)
            return Promise.resolve(null);
        this._pushModal();
        this._mode = 'load';
        setCursor(this.actor, 'CROSSHAIR');
        this._loadHint.text = `Click a window to show “${setName}” · Esc cancels`;
        this._loadGroup.show();
        this._placeHint(this._loadHint);
        this._highlightAt(...global.get_pointer());
        return new Promise(resolve => {
            this._loadDone = resolve;
        });
    }

    _highlightAt(x, y) {
        const window = this._windowAt(x, y);
        this._highlight.visible = Boolean(window);
        if (!window)
            return;
        const rect = window.get_frame_rect();
        this._highlight.set_position(rect.x, rect.y);
        this._highlight.set_size(rect.width, rect.height);
    }

    _endLoad(window) {
        if (this._mode !== 'load')
            return;
        this._popModal();
        this._mode = null;
        this._loadGroup.hide();
        const done = this._loadDone;
        this._loadDone = null;
        done(window);
    }
}

function isManaged(window) {
    return global.get_window_actors().some(actor => actor.meta_window === window);
}

/** Copies text and confirms it with an on-screen display. */
export function copyToClipboard(text, iconName) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    Main.osdWindowManager.showAll(Gio.ThemedIcon.new(iconName), `Copied ${text}`, null, null);
}
