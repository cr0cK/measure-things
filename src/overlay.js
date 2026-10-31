import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {formatLength, formatSize, withAlpha} from './format.js';
import {
    columnGrid,
    cursorFor,
    dragHelper,
    guideGaps,
    hitTest,
    isLogicalLayout,
    labelAnchor,
    monitorAt,
    parseHelpers,
    pixelRatios,
    rectFromPoints,
    serializeHelpers,
} from './geometry.js';

// A press must travel this far, in stage pixels, before it draws a rectangle.
const DRAG_THRESHOLD = 3;
const LABEL_MARGIN = 4;
const HANDLE_SIZE = 7;
const HINT_TEXT = 'Drag  rectangle   ·   H / V  guide   ·   Arrows  nudge (Shift ×10, Alt resize)   ·   ' +
    'Tab  select   ·   Del  remove   ·   G  grid   ·   Ctrl+C  copy   ·   Esc  done';
const RECTANGLE_PARTS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * The layer above every window that holds the helpers and the column grid. Outside edit mode
 * nothing in it is reactive, so the pointer reaches the windows below. Edit mode takes a modal
 * grab and handles the pointer and the keyboard itself.
 */
export class Overlay {
    constructor(settings, {onStateChanged}) {
        this._settings = settings;
        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._onStateChanged = onStateChanged;
        this._helpers = parseHelpers(settings.get_string('helpers'));
        this._nextId = this._helpers.length + 1;
        this._selectedId = null;
        this._views = new Map();
        this._drag = null;
        this._grab = null;
        this._gridWindow = null;
        this._gridSignals = [];
        this._gridVisible = false;

        this.actor = new St.Widget({name: 'measure-things-overlay', reactive: false});
        this.actor.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        this._gridGroup = new St.Widget();
        this._helperGroup = new St.Widget();
        this._labelGroup = new St.Widget();
        this._gapGroup = new St.Widget();
        this._cursorGroup = new St.Widget({visible: false});
        for (const group of [this._gridGroup, this._helperGroup, this._gapGroup, this._labelGroup,
            this._cursorGroup])
            this.actor.add_child(group);

        this._crosshairX = new St.Widget();
        this._crosshairY = new St.Widget();
        this._readout = new St.Label({style_class: 'measure-things-label measure-things-readout'});
        this._hint = new St.Label({style_class: 'measure-things-hint', text: HINT_TEXT});
        for (const actor of [this._crosshairX, this._crosshairY, this._readout, this._hint])
            this._cursorGroup.add_child(actor);

        this.actor.connect('button-press-event', (_actor, event) => this._onPress(event));
        this.actor.connect('motion-event', (_actor, event) => this._onMotion(event));
        this.actor.connect('button-release-event', (_actor, event) => this._onRelease(event));
        this.actor.connect('key-press-event', (_actor, event) => this._onKeyPress(event));

        Main.layoutManager.addTopChrome(this.actor, {affectsInputRegion: false});
        this._signals = [
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._syncAll())],
            [global.workspace_manager,
                global.workspace_manager.connect('active-workspace-changed', () => this._syncGrid())],
            ...['color', 'unit', 'show-helpers'].map(key =>
                [settings, settings.connect(`changed::${key}`, () => this._syncAll())]),
            ...['grid-columns', 'grid-gutter', 'grid-margin', 'grid-max-width'].map(key =>
                [settings, settings.connect(`changed::${key}`, () => this._syncGrid())]),
        ];
        this._syncAll();
    }

    destroy() {
        this.exitEdit();
        this._hideGrid();
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        this.actor.destroy();
        this._views.clear();
    }

    get editing() {
        return this._grab !== null;
    }

    get gridVisible() {
        return this._gridVisible;
    }

    get hasHelpers() {
        return this._helpers.length > 0;
    }

    /** Takes the modal grab; returns false when another grab holds the keyboard. */
    enterEdit() {
        if (this._grab)
            return true;

        this.actor.reactive = true;
        const grab = Main.pushModal(this.actor, {actionMode: Shell.ActionMode.POPUP});
        if (!(grab.get_seat_state() & Clutter.GrabState.KEYBOARD)) {
            Main.popModal(grab);
            this.actor.reactive = false;
            return false;
        }

        this._grab = grab;
        global.display.set_cursor(Meta.Cursor.CROSSHAIR);
        const [x, y] = global.get_pointer();
        this._cursorGroup.show();
        this._placeHint();
        this._updateCursor(x, y);
        this._syncAll();
        this._onStateChanged();
        return true;
    }

    exitEdit() {
        if (!this._grab)
            return;

        this._cancelDrag();
        Main.popModal(this._grab);
        this._grab = null;
        this.actor.reactive = false;
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        this._cursorGroup.hide();
        this._selectedId = null;
        this._syncAll();
        this._onStateChanged();
    }

    toggleEdit() {
        if (this.editing)
            this.exitEdit();
        else
            this.enterEdit();
    }

    /** Adds a guide through the center of the primary monitor, then edits it. */
    addGuide(kind) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!this.enterEdit())
            return;
        this._addGuideAt(kind,
            Math.round(monitor.x + monitor.width / 2),
            Math.round(monitor.y + monitor.height / 2));
    }

    clear() {
        this._cancelDrag();
        this._helpers = [];
        this._selectedId = null;
        this._save();
        this._syncAll();
        this._onStateChanged();
    }

    /** Hides the layer while the color picker reads the screen. */
    setHidden(hidden) {
        this.actor.visible = !hidden;
    }

    /** Shows the column grid over the focused window, or the primary work area without one. */
    toggleGrid() {
        if (this._gridVisible) {
            this._hideGrid();
        } else {
            this._gridVisible = true;
            const window = global.display.focus_window;
            if (window) {
                this._gridWindow = window;
                this._gridSignals = [
                    window.connect('position-changed', () => this._syncGrid()),
                    window.connect('size-changed', () => this._syncGrid()),
                    window.connect('notify::minimized', () => this._syncGrid()),
                    window.connect('workspace-changed', () => this._syncGrid()),
                    window.connect('unmanaged', () => this._hideGrid()),
                ];
            }
            this._syncGrid();
        }
        this._onStateChanged();
    }

    _hideGrid() {
        if (this._gridWindow) {
            for (const id of this._gridSignals)
                this._gridWindow.disconnect(id);
        }
        this._gridWindow = null;
        this._gridSignals = [];
        if (!this._gridVisible)
            return;
        this._gridVisible = false;
        this._syncGrid();
        this._onStateChanged();
    }

    _color() {
        return this._settings.get_string('color');
    }

    /** Stage-pixel ratios on a monitor; see pixelRatios(). */
    _ratios(monitor) {
        const logical = isLogicalLayout(this._mutterSettings.get_strv('experimental-features'));
        return pixelRatios(monitor?.geometry_scale ?? 1, logical);
    }

    /** The monitor under a point, and how many display units one stage pixel is worth there. */
    _unitAt(x, y) {
        const monitors = Main.layoutManager.monitors;
        const monitor = monitors[monitorAt(monitors, x, y)] ??
            {x: 0, y: 0, width: global.stage.width, height: global.stage.height, geometry_scale: 1};
        const ratios = this._ratios(monitor);
        const ratio = this._settings.get_string('unit') === 'device' ? ratios.device : ratios.css;
        return {monitor, ratio};
    }

    /** A guide's label anchor, monitor, and position text in the display unit. */
    _guideMeasure(helper) {
        const vertical = helper.kind === 'vertical';
        const position = vertical ? helper.x : helper.y;
        const anchor = labelAnchor(Main.layoutManager.monitors, helper.kind, position);
        const {monitor, ratio} = vertical ? this._unitAt(helper.x, anchor.edge)
            : this._unitAt(anchor.edge, helper.y);
        const offset = vertical ? position - monitor.x : position - monitor.y;
        return {anchor, text: formatLength(offset * ratio)};
    }

    _syncAll() {
        const visible = this.editing || this._settings.get_boolean('show-helpers');
        for (const group of [this._helperGroup, this._labelGroup, this._gapGroup])
            group.visible = visible;
        const color = this._color();
        this._crosshairX.style = `background-color: ${withAlpha(color, 0.45)};`;
        this._crosshairY.style = this._crosshairX.style;
        this._syncHelpers();
        this._syncGrid();
    }

    _syncHelpers() {
        const ids = new Set(this._helpers.map(helper => helper.id));
        for (const [id, view] of this._views) {
            if (!ids.has(id)) {
                for (const actor of view.actors)
                    actor.destroy();
                this._views.delete(id);
            }
        }
        for (const helper of this._helpers) {
            let view = this._views.get(helper.id);
            if (!view) {
                view = this._createView(helper);
                this._views.set(helper.id, view);
            }
            this._updateView(view, helper);
        }
        this._syncGaps();
    }

    _createView(helper) {
        const shape = new St.Widget();
        const label = new St.Label({style_class: 'measure-things-label'});
        this._helperGroup.add_child(shape);
        this._labelGroup.add_child(label);
        const view = {shape, label, actors: [shape, label]};
        if (helper.kind === 'rectangle') {
            view.position = new St.Label({style_class: 'measure-things-label'});
            view.handles = RECTANGLE_PARTS.map(() => new St.Widget({style_class: 'measure-things-handle'}));
            this._labelGroup.add_child(view.position);
            for (const handle of view.handles)
                this._helperGroup.add_child(handle);
            view.actors.push(view.position, ...view.handles);
        }
        return view;
    }

    _updateView(view, helper) {
        const color = this._color();
        const selected = helper.id === this._selectedId;
        const labelStyle = selected
            ? `background-color: white; color: ${color}; border: 1px solid ${color};`
            : `background-color: ${color}; color: white;`;
        view.label.style = labelStyle;
        const {width: stageWidth, height: stageHeight} = global.stage;

        if (helper.kind === 'vertical' || helper.kind === 'horizontal') {
            const vertical = helper.kind === 'vertical';
            view.shape.style = `background-color: ${color};`;
            if (vertical) {
                view.shape.set_position(helper.x, 0);
                view.shape.set_size(1, stageHeight);
            } else {
                view.shape.set_position(0, helper.y);
                view.shape.set_size(stageWidth, 1);
            }

            const {anchor, text} = this._guideMeasure(helper);
            view.label.text = `${vertical ? 'x' : 'y'} ${text}`;
            if (vertical) {
                view.label.set_position(helper.x + LABEL_MARGIN,
                    anchor.edge + this._topInset(anchor.monitor));
            } else {
                view.label.set_position(anchor.edge + LABEL_MARGIN, helper.y + LABEL_MARGIN);
            }
            return;
        }

        view.shape.style = `border: 1px solid ${color}; background-color: ${withAlpha(color, 0.08)};`;
        view.shape.set_position(helper.x, helper.y);
        view.shape.set_size(helper.width, helper.height);

        const {monitor, ratio} = this._unitAt(helper.x + helper.width / 2, helper.y + helper.height / 2);
        view.label.text = formatSize(helper.width * ratio, helper.height * ratio);
        const [, labelWidth] = view.label.get_preferred_width(-1);
        const [, labelHeight] = view.label.get_preferred_height(-1);
        // Below the rectangle, or above its bottom edge when its monitor ends first.
        let labelY = helper.y + helper.height + LABEL_MARGIN;
        if (labelY + labelHeight > monitor.y + monitor.height)
            labelY = helper.y + helper.height - labelHeight - LABEL_MARGIN;
        const labelX = Math.max(helper.x + (helper.width - labelWidth) / 2, monitor.x);
        view.label.set_position(
            Math.round(Math.min(labelX, monitor.x + monitor.width - labelWidth)), labelY);

        view.position.visible = selected;
        view.position.style = labelStyle;
        view.position.text = `${formatLength((helper.x - monitor.x) * ratio)}, ` +
            `${formatLength((helper.y - monitor.y) * ratio)}`;
        const [, positionHeight] = view.position.get_preferred_height(-1);
        view.position.set_position(helper.x, Math.max(helper.y - positionHeight - LABEL_MARGIN, 0));

        const half = Math.floor(HANDLE_SIZE / 2);
        RECTANGLE_PARTS.forEach((part, i) => {
            const handle = view.handles[i];
            handle.visible = selected;
            handle.style = `border-color: ${color};`;
            handle.set_position(
                (part.endsWith('left') ? helper.x : helper.x + helper.width - 1) - half,
                (part.startsWith('top') ? helper.y : helper.y + helper.height - 1) - half);
        });
    }

    /** Room under the top bar for labels on the primary monitor. */
    _topInset(monitorIndex) {
        return (monitorIndex === Main.layoutManager.primaryIndex ? Main.panel.height : 0) + LABEL_MARGIN;
    }

    _syncGaps() {
        this._gapGroup.destroy_all_children();
        const monitors = Main.layoutManager.monitors;
        for (const gap of guideGaps(this._helpers)) {
            const middle = (gap.from + gap.to) / 2;
            const kind = gap.axis === 'x' ? 'vertical' : 'horizontal';
            const anchor = labelAnchor(monitors, kind, Math.round(middle));
            const line = new St.Widget({style: `background-color: ${withAlpha(this._color(), 0.6)};`});
            const {ratio} = gap.axis === 'x' ? this._unitAt(middle, anchor.edge)
                : this._unitAt(anchor.edge, middle);
            const label = new St.Label({
                style_class: 'measure-things-label measure-things-gap',
                text: formatLength((gap.to - gap.from) * ratio),
            });
            this._gapGroup.add_child(line);
            this._gapGroup.add_child(label);
            const [, labelWidth] = label.get_preferred_width(-1);
            const [, labelHeight] = label.get_preferred_height(-1);
            if (gap.axis === 'x') {
                const y = anchor.edge + this._topInset(anchor.monitor) + labelHeight + 2 * LABEL_MARGIN;
                line.set_position(gap.from, y + Math.round(labelHeight / 2));
                line.set_size(gap.to - gap.from, 1);
                label.set_position(Math.round(middle - labelWidth / 2), y);
            } else {
                const x = anchor.edge + 6 * LABEL_MARGIN;
                line.set_position(x, gap.from);
                line.set_size(1, gap.to - gap.from);
                label.set_position(x + LABEL_MARGIN, Math.round(middle - labelHeight / 2));
            }
        }
    }

    _syncGrid() {
        this._gridGroup.destroy_all_children();
        if (!this._gridVisible)
            return;

        const window = this._gridWindow;
        if (window && (window.minimized ||
            !window.located_on_workspace(global.workspace_manager.get_active_workspace())))
            return;
        const bounds = window ? window.get_frame_rect()
            : Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);

        // Grid settings are CSS pixels whatever the display unit.
        const monitors = Main.layoutManager.monitors;
        const center = [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2];
        const {css} = this._ratios(monitors[monitorAt(monitors, ...center)]);
        const columns = columnGrid({
            width: bounds.width * css,
            columns: this._settings.get_int('grid-columns'),
            gutter: this._settings.get_int('grid-gutter'),
            margin: this._settings.get_int('grid-margin'),
            maxWidth: this._settings.get_int('grid-max-width'),
        });
        const style = `background-color: ${withAlpha(this._color(), 0.12)};`;
        for (const column of columns) {
            const left = bounds.x + Math.round(column.x / css);
            const right = bounds.x + Math.round((column.x + column.width) / css);
            this._gridGroup.add_child(new St.Widget({
                style,
                x: left,
                y: bounds.y,
                width: right - left,
                height: bounds.height,
            }));
        }
    }

    _placeHint() {
        const monitor = Main.layoutManager.primaryMonitor;
        const [, width] = this._hint.get_preferred_width(-1);
        const [, height] = this._hint.get_preferred_height(-1);
        this._hint.set_position(
            Math.round(monitor.x + (monitor.width - width) / 2),
            monitor.y + monitor.height - height - 32);
    }

    _updateCursor(x, y) {
        this._crosshairX.set_position(0, y);
        this._crosshairX.set_size(global.stage.width, 1);
        this._crosshairY.set_position(x, 0);
        this._crosshairY.set_size(1, global.stage.height);
        const {monitor, ratio} = this._unitAt(x, y);
        this._readout.text = `${formatLength((x - monitor.x) * ratio)}, ${formatLength((y - monitor.y) * ratio)}`;
        this._readout.set_position(x + 14, y + 14);

        if (this._drag)
            return;
        const hit = hitTest(this._helpers, x, y);
        const helper = hit && this._find(hit.id);
        const cursor = !helper || (hit.part === 'inside' && hit.id !== this._selectedId)
            ? 'CROSSHAIR' : cursorFor(helper.kind, hit.part);
        global.display.set_cursor(Meta.Cursor[cursor]);
    }

    _find(id) {
        return this._helpers.find(helper => helper.id === id) ?? null;
    }

    _replace(helper) {
        this._helpers = this._helpers.map(current => (current.id === helper.id ? helper : current));
    }

    _select(id) {
        this._selectedId = id;
        this._syncHelpers();
    }

    _onPress(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;

        const [x, y] = event.get_coords().map(Math.round);
        const hit = hitTest(this._helpers, x, y);
        if (hit && (hit.part !== 'inside' || hit.id === this._selectedId)) {
            this._drag = {kind: 'move', id: hit.id, part: hit.part, x, y, origin: this._find(hit.id)};
            this._select(hit.id);
        } else {
            this._drag = {kind: 'create', id: null, x, y, insideId: hit?.id ?? null};
        }
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        const [x, y] = event.get_coords().map(Math.round);
        this._updateCursor(x, y);
        const drag = this._drag;
        if (!drag)
            return Clutter.EVENT_STOP;

        if (drag.kind === 'move') {
            this._replace(dragHelper(drag.origin, drag.part, x - drag.x, y - drag.y));
        } else {
            if (drag.id === null) {
                if (Math.max(Math.abs(x - drag.x), Math.abs(y - drag.y)) < DRAG_THRESHOLD)
                    return Clutter.EVENT_STOP;
                drag.id = this._nextId++;
                this._helpers.push({id: drag.id, kind: 'rectangle', x, y, width: 1, height: 1});
                this._selectedId = drag.id;
            }
            const rect = rectFromPoints(drag.x, drag.y, x, y);
            this._replace({id: drag.id, kind: 'rectangle', ...rect,
                width: Math.max(1, rect.width), height: Math.max(1, rect.height)});
        }
        this._syncHelpers();
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        const drag = this._drag;
        if (!drag || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;

        this._drag = null;
        if (drag.kind === 'create' && drag.id === null)
            this._select(drag.insideId);
        this._save();
        this._onStateChanged();
        return Clutter.EVENT_STOP;
    }

    _cancelDrag() {
        const drag = this._drag;
        if (!drag)
            return;
        this._drag = null;
        if (drag.kind === 'move')
            this._replace(drag.origin);
        else if (drag.id !== null)
            this._remove(drag.id);
        this._syncHelpers();
    }

    _remove(id) {
        this._helpers = this._helpers.filter(helper => helper.id !== id);
        if (this._selectedId === id)
            this._selectedId = null;
    }

    _addGuideAt(kind, x, y) {
        const helper = kind === 'vertical' ? {id: this._nextId++, kind, x} : {id: this._nextId++, kind, y};
        this._helpers.push(helper);
        this._select(helper.id);
        this._save();
        this._onStateChanged();
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const control = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const alt = (state & Clutter.ModifierType.MOD1_MASK) !== 0;
        const selected = this._find(this._selectedId);
        const [pointerX, pointerY] = global.get_pointer();

        switch (symbol) {
        case Clutter.KEY_Escape:
            if (this._drag)
                this._cancelDrag();
            else
                this.exitEdit();
            break;
        case Clutter.KEY_Delete:
        case Clutter.KEY_BackSpace:
            if (selected && !this._drag) {
                this._remove(selected.id);
                this._afterEdit();
            }
            break;
        case Clutter.KEY_Left:
        case Clutter.KEY_Right:
        case Clutter.KEY_Up:
        case Clutter.KEY_Down: {
            if (!selected || this._drag)
                break;
            const step = shift ? 10 : 1;
            const dx = symbol === Clutter.KEY_Left ? -step : symbol === Clutter.KEY_Right ? step : 0;
            const dy = symbol === Clutter.KEY_Up ? -step : symbol === Clutter.KEY_Down ? step : 0;
            const part = alt && selected.kind === 'rectangle' ? (dx ? 'right' : 'bottom') : 'move';
            this._replace(dragHelper(selected, part, dx, dy));
            this._afterEdit();
            break;
        }
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab: {
            if (this._helpers.length === 0 || this._drag)
                break;
            const index = this._helpers.findIndex(helper => helper.id === this._selectedId);
            const length = this._helpers.length;
            const next = index < 0 ? 0 : (index + (shift ? length - 1 : 1)) % length;
            this._select(this._helpers[next].id);
            break;
        }
        case Clutter.KEY_h:
        case Clutter.KEY_H:
            if (!this._drag)
                this._addGuideAt('horizontal', pointerX, pointerY);
            break;
        case Clutter.KEY_v:
        case Clutter.KEY_V:
            if (!this._drag)
                this._addGuideAt('vertical', pointerX, pointerY);
            break;
        case Clutter.KEY_g:
        case Clutter.KEY_G:
            this.toggleGrid();
            break;
        case Clutter.KEY_c:
        case Clutter.KEY_C:
            if (control && selected)
                this._copy(selected);
            break;
        }
        return Clutter.EVENT_STOP;
    }

    _afterEdit() {
        this._syncHelpers();
        this._save();
        this._onStateChanged();
    }

    _copy(helper) {
        let text;
        if (helper.kind === 'rectangle') {
            const {ratio} = this._unitAt(helper.x + helper.width / 2, helper.y + helper.height / 2);
            text = formatSize(helper.width * ratio, helper.height * ratio);
        } else {
            text = this._guideMeasure(helper).text;
        }
        copyToClipboard(text, 'edit-copy-symbolic');
    }

    _save() {
        this._settings.set_string('helpers', serializeHelpers(this._helpers));
    }
}

/** Copies text and confirms it with an on-screen display. */
export function copyToClipboard(text, iconName) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    Main.osdWindowManager.showAll(Gio.ThemedIcon.new(iconName), `Copied ${text}`, null, null);
}
