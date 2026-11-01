import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {BadgeMenu} from './badge.js';
import {nearestBoundary, regionAround} from './edges.js';
import {formatLength, formatSize, withAlpha} from './format.js';
import {cursorFor, dragHelper, hitTest, monitorAt, rectFromPoints, targetAt} from './geometry.js';
import {roundCss} from './sets.js';
import {Snapshot} from './snapshot.js';
import {windowGeometry} from './view.js';

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
        'G  grid   ·   Esc  done',
].join('\n');
const {WindowType} = Meta;
const TARGET_TYPES = [WindowType.NORMAL, WindowType.DIALOG, WindowType.MODAL_DIALOG, WindowType.UTILITY,
    WindowType.TOOLBAR, WindowType.SPLASHSCREEN];
const IGNORED_TYPES = [WindowType.DESKTOP, WindowType.DOCK];

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
        this._measuring = false;
        this._region = null;
        this._badgeMenu = null;
        this._loadDone = null;
        // Shared by every line request, so a pending line calls it back once.
        this._onLineRead = () => this._refreshPointer();
        manager.onViewMoved = view => this._onViewMoved(view);
        manager.onViewRemoved = view => this._onViewRemoved(view);

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
        Main.layoutManager.addTopChrome(this.actor, {affectsInputRegion: false});
        // Below the modal dialogs that edit mode opens, which its reactive layer would cover.
        Main.uiGroup.set_child_below_sibling(this.actor, Main.layoutManager.modalDialogGroup);
    }

    destroy() {
        this.exitEdit();
        this._endLoad(null);
        if (this._recaptureId)
            GLib.source_remove(this._recaptureId);
        this._recaptureId = 0;
        this._manager.onViewMoved = () => {};
        this._manager.onViewRemoved = () => {};
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
        const grab = Main.pushModal(this.actor, {actionMode: Shell.ActionMode.POPUP});
        if (!(grab.get_seat_state() & Clutter.GrabState.KEYBOARD)) {
            Main.popModal(grab);
            this.actor.reactive = false;
            return false;
        }
        this._grab = grab;
        return true;
    }

    _popModal() {
        Main.popModal(this._grab);
        this._grab = null;
        this.actor.reactive = false;
        global.display.set_cursor(Meta.Cursor.DEFAULT);
    }

    /** Takes the modal grab; returns false when another grab holds the keyboard. */
    enterEdit() {
        if (this._mode === 'edit')
            return true;
        if (this._mode || !this._pushModal())
            return false;

        this._mode = 'edit';
        this._manager.setEditing(true);
        this._captureSnapshot();
        global.display.set_cursor(Meta.Cursor.CROSSHAIR);
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
        // A drag released while its snapping lines were read is done; any other is cancelled.
        if (this._drag?.released)
            this._finishDrag(this._drag);
        else
            this._cancelDrag();
        this._popModal();
        this._mode = null;
        this._dropSnapshot();
        this._measuring = false;
        this._region = null;
        this._target = null;
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

    /** A target view moved, resized, changed scale or monitor, or left the workspace. */
    _onViewMoved(view) {
        if (!this.editing)
            return;
        if (this._drag?.view === view || this._drag?.window === view.window)
            this._cancelDrag();
        if (this._target?.window !== view.window)
            return;
        // Windows send several changes in a row: capture once they settle.
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
        if (this._drag?.view === view)
            this._drag = null;
        if (this._target?.view === view)
            this._target = null;
        if (this._badgeMenu?.view === view)
            this._badgeMenu.close();
    }

    /** The topmost visible window under a stage point, with its view; null over no window. */
    _targetAt(x, y) {
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
            if (!actor.visible || !window || window.minimized)
                continue;
            const type = window.get_window_type();
            const role = TARGET_TYPES.includes(type) ? 'window' : IGNORED_TYPES.includes(type) ? 'ignore' : 'blocker';
            windows.push({window, rect: window.get_frame_rect(), role});
        }
        const index = targetAt(windows, x, y);
        if (index < 0)
            return null;
        const {window} = windows[index];
        return {window, view: this._manager.viewOn(window)};
    }

    _setTarget(target) {
        const view = this._target?.view;
        if (view && view !== target?.view && view.selectedId !== null)
            view.select(null);
        this._target = target;
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
        if (!this._drag)
            this._setTarget(this._targetAt(x, y));
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

        this._readout.visible = Boolean(target);
        if (target) {
            const zone = this._zoneOf(target);
            const ratio = this._ratioOf(target);
            this._readout.text = this._region
                ? formatSize(this._region.width * ratio, this._region.height * ratio)
                : `${formatLength((x - zone.originX) * ratio)}, ${formatLength((y - zone.originY) * ratio)}`;
            this._readout.set_position(x + 14, y + 14);
        }

        if (this._drag)
            return;
        const view = target?.view;
        let cursor = 'CROSSHAIR';
        if (view) {
            const [zoneX, zoneY] = view.toZone(x, y);
            const hit = view.contains(zoneX, zoneY) && hitTest(view.zoneHelpers(), zoneX, zoneY);
            const helper = hit && view.content.helpers.find(h => h.id === hit.id);
            if (view.badgeContains(zoneX, zoneY))
                cursor = 'POINTER';
            else if (helper && (hit.part !== 'inside' || hit.id === view.selectedId))
                cursor = cursorFor(helper.kind, hit.part);
        }
        global.display.set_cursor(Meta.Cursor[cursor]);
    }

    /**
     * In area measuring, finds the run of same-colored pixels around the pointer on its row and
     * column, within the target zone, and draws their extent in stage pixels.
     */
    _updateArea(x, y, target, color) {
        this._region = null;
        const snapshot = this._snapshot;
        const row = this._measuring && target && snapshot?.line('row', y, this._onLineRead);
        const column = this._measuring && target && snapshot?.line('column', x, this._onLineRead);
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
        const across = clamp(regionAround(row, snapshot.pixel(x)), zone.originX, zone.width);
        const down = clamp(regionAround(column, snapshot.pixel(y)), zone.originY, zone.height);
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
     * The nearest screen edge to a vertical edge at zone `x`, on the row through zone `y`,
     * within the zone. Marks the drag as waiting while that row is being read.
     */
    _snapX(zone, x, y) {
        const snapshot = this._snapshot;
        const stageY = zone.originY + y;
        const row = snapshot?.line('row', stageY, this._onLineRead);
        if (!row) {
            this._drag.waiting ||= Boolean(snapshot?.reading('row', stageY));
            return x;
        }
        const snapped = this._nearest(row, snapshot.scale, zone.originX + x, zone.originX, zone.width);
        return snapped - zone.originX;
    }

    /** Like _snapX(), for a horizontal edge at zone `y` on the column through zone `x`. */
    _snapY(zone, x, y) {
        const snapshot = this._snapshot;
        const stageX = zone.originX + x;
        const column = snapshot?.line('column', stageX, this._onLineRead);
        if (!column) {
            this._drag.waiting ||= Boolean(snapshot?.reading('column', stageX));
            return y;
        }
        const snapped = this._nearest(column, snapshot.scale, zone.originY + y, zone.originY, zone.height);
        return snapped - zone.originY;
    }

    /** The stage coordinate of the nearest screen edge within the zone, or `position` itself. */
    _nearest(line, scale, position, origin, length) {
        const boundary = nearestBoundary(line, position * scale, SNAP_DISTANCE * scale);
        const outside = boundary !== null &&
            (boundary < origin * scale - 0.5 || boundary > (origin + length) * scale + 0.5);
        if (boundary === null || outside)
            return position;
        return boundary / scale;
    }

    _onPress(event) {
        const [x, y] = event.get_coords();
        if (this._mode === 'load') {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                this._endLoad(null);
            return Clutter.EVENT_STOP;
        }
        if (this._drag)
            return Clutter.EVENT_STOP;
        const target = this._targetAt(x, y);
        this._setTarget(target);
        const view = target?.view;
        const [zoneX, zoneY] = view ? view.toZone(x, y) : [0, 0];
        if (event.get_button() === Clutter.BUTTON_SECONDARY && view?.content.mockup.visible) {
            const {mockup} = view.content;
            this._drag = {kind: 'mockup', target, view, window: target.window, x, y, origin: [mockup.x, mockup.y]};
            return Clutter.EVENT_STOP;
        }
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || !target)
            return Clutter.EVENT_STOP;
        if (view?.badgeContains(zoneX, zoneY)) {
            this.openBadgeMenu(view);
            return Clutter.EVENT_STOP;
        }

        const hit = view?.contains(zoneX, zoneY) ? hitTest(view.zoneHelpers(), zoneX, zoneY) : null;
        if (hit && (hit.part !== 'inside' || hit.id === view.selectedId)) {
            const helper = view.content.helpers.find(h => h.id === hit.id);
            this._drag = {
                kind: 'move', target, view, window: target.window, id: hit.id, part: hit.part, x, y,
                origin: view.zoneHelpers().find(h => h.id === hit.id),
                originCss: {...helper},
            };
            view.select(hit.id);
        } else {
            this._drag = {kind: 'create', target, view, window: target.window, id: null, x, y, insideId: hit?.id ?? null};
        }
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        const [x, y] = event.get_coords();
        if (this._mode === 'load') {
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
            drag.view.sync();
            return;
        }

        drag.waiting = false;
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
        view.syncHelpers();
    }

    _onRelease(event) {
        if (this._mode === 'load') {
            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                const [x, y] = event.get_coords();
                this._endLoad(this._targetAt(x, y)?.window ?? null);
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
        if (drag.kind === 'create' && drag.id === null) {
            drag.view?.select(drag.insideId);
            return;
        }
        this._manager.commit(drag.view.model);
        this._onStateChanged();
    }

    _cancelDrag() {
        const drag = this._drag;
        if (!drag)
            return;
        this._drag = null;
        const view = drag.view;
        if (!view || !this._manager.views.includes(view))
            return;
        const model = view.model;
        if (drag.kind === 'mockup') {
            [model.content.mockup.x, model.content.mockup.y] = drag.origin;
        } else if (drag.kind === 'move') {
            this._replaceHelper(model, drag.originCss);
        } else if (drag.id !== null) {
            model.content.helpers = model.content.helpers.filter(helper => helper.id !== drag.id);
            if (view.selectedId === drag.id)
                view.selectedId = null;
        }
        if (model.provisional)
            this._manager.discard(model);
        else
            view.sync();
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
        if (this._mode === 'load') {
            if (symbol === Clutter.KEY_Escape)
                this._endLoad(null);
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
            const helpers = model?.content.helpers ?? [];
            if (helpers.length === 0)
                break;
            const index = helpers.findIndex(helper => helper.id === view.selectedId);
            const next = index < 0 ? 0 : (index + (shift ? helpers.length - 1 : 1)) % helpers.length;
            view.select(helpers[next].id);
            break;
        }
        case Clutter.KEY_h:
        case Clutter.KEY_H:
            this._addHelper({kind: 'horizontal', y: zoneY});
            break;
        case Clutter.KEY_v:
        case Clutter.KEY_V:
            this._addHelper({kind: 'vertical', x: zoneX});
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
            this._measuring = !this._measuring;
            this._updateCursor(pointerX, pointerY);
            break;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            if (this._region && this._target) {
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

    /**
     * Shows a crosshair and a hint until a window is clicked; resolves with that window, or null
     * on Escape or a click outside any window.
     */
    pickWindow(setName) {
        if (this._mode || !this._pushModal())
            return Promise.resolve(null);
        this._mode = 'load';
        global.display.set_cursor(Meta.Cursor.CROSSHAIR);
        this._loadHint.text = `Click a window to show “${setName}” · Esc cancels`;
        this._loadGroup.show();
        this._placeHint(this._loadHint);
        this._highlightAt(...global.get_pointer());
        return new Promise(resolve => {
            this._loadDone = resolve;
        });
    }

    _highlightAt(x, y) {
        const target = this._targetAt(x, y);
        this._highlight.visible = Boolean(target);
        if (!target)
            return;
        const rect = target.window.get_frame_rect();
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
