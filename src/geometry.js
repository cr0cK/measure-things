// Pure geometry for helpers, hit testing, grids, zones, and window targeting. Imports nothing from
// gi://, so node --test covers it. Interaction runs in zone pixels: stage pixels relative to the
// top-left corner of a zone.

export const HELPER_KINDS = ['horizontal', 'vertical', 'rectangle'];

// Distance, in stage pixels, within which a guide or a rectangle edge catches the pointer.
export const HIT_TOLERANCE = 4;

/** The rectangle spanned by two corner points, in either order. */
export function rectFromPoints(x1, y1, x2, y2) {
    return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
    };
}

/**
 * Finds the topmost helper under a point. Rectangles answer with the edges or corner under the
 * point (`top-left`, `right`, ...) or `inside`; guides answer with `move`.
 */
export function hitTest(helpers, x, y, tolerance = HIT_TOLERANCE) {
    for (let i = helpers.length - 1; i >= 0; i--) {
        const helper = helpers[i];
        if (helper.kind === 'horizontal' && Math.abs(y - helper.y) <= tolerance)
            return {id: helper.id, part: 'move'};
        if (helper.kind === 'vertical' && Math.abs(x - helper.x) <= tolerance)
            return {id: helper.id, part: 'move'};
        if (helper.kind !== 'rectangle')
            continue;

        const right = helper.x + helper.width;
        const bottom = helper.y + helper.height;
        if (x < helper.x - tolerance || x > right + tolerance ||
            y < helper.y - tolerance || y > bottom + tolerance)
            continue;

        const vertical = Math.abs(y - helper.y) <= tolerance ? 'top'
            : Math.abs(y - bottom) <= tolerance ? 'bottom' : '';
        const horizontal = Math.abs(x - helper.x) <= tolerance ? 'left'
            : Math.abs(x - right) <= tolerance ? 'right' : '';
        const part = [vertical, horizontal].filter(Boolean).join('-');
        return {id: helper.id, part: part || 'inside'};
    }
    return null;
}

const keep = value => value;

/**
 * The helper as it was at drag start, moved or resized by the pointer delta. `snapX(x)` and
 * `snapY(y)` pull the dragged guide or edges onto nearby screen edges, before a rectangle dragged
 * past its opposite edge flips; whole rectangle moves do not snap.
 */
export function dragHelper(origin, part, dx, dy, snapX = keep, snapY = keep) {
    if (origin.kind === 'horizontal')
        return {...origin, y: snapY(origin.y + dy)};
    if (origin.kind === 'vertical')
        return {...origin, x: snapX(origin.x + dx)};
    if (part === 'move' || part === 'inside')
        return {...origin, x: origin.x + dx, y: origin.y + dy};

    let left = origin.x;
    let top = origin.y;
    let right = origin.x + origin.width;
    let bottom = origin.y + origin.height;
    if (part.includes('left'))
        left = snapX(left + dx);
    if (part.includes('right'))
        right = snapX(right + dx);
    if (part.includes('top'))
        top = snapY(top + dy);
    if (part.includes('bottom'))
        bottom = snapY(bottom + dy);
    const rect = rectFromPoints(left, top, right, bottom);
    return {...origin, ...rect, width: Math.max(1, rect.width), height: Math.max(1, rect.height)};
}

/** The resize or move cursor, as a Meta.Cursor member name, for a helper part. */
export function cursorFor(kind, part) {
    if (kind === 'horizontal')
        return 'NS_RESIZE';
    if (kind === 'vertical')
        return 'EW_RESIZE';
    return {
        'top': 'N_RESIZE',
        'bottom': 'S_RESIZE',
        'left': 'W_RESIZE',
        'right': 'E_RESIZE',
        'top-left': 'NW_RESIZE',
        'top-right': 'NE_RESIZE',
        'bottom-left': 'SW_RESIZE',
        'bottom-right': 'SE_RESIZE',
    }[part] ?? 'MOVE';
}

/** Gaps between neighboring parallel guides: `axis` is the coordinate the guides sit on. */
export function guideGaps(helpers) {
    const gaps = [];
    for (const [kind, axis] of [['vertical', 'x'], ['horizontal', 'y']]) {
        const positions = [...new Set(helpers.filter(h => h.kind === kind).map(h => h[axis]))]
            .sort((a, b) => a - b);
        for (let i = 1; i < positions.length; i++)
            gaps.push({axis, from: positions[i - 1], to: positions[i]});
    }
    return gaps;
}

/**
 * Distances from a rectangle to the nearest helper on each side: guides, and rectangles that
 * overlap it across the gap. `axis` is the coordinate the gap runs along, `at` where the line
 * joining the two edges crosses the other axis. Touching or overlapping neighbors give no gap.
 */
export function rectangleGaps(helpers, id) {
    const rect = helpers.find(helper => helper.id === id);
    if (!rect || rect.kind !== 'rectangle')
        return [];

    const sides = {left: null, right: null, top: null, bottom: null};
    const keep = (side, gap) => {
        if (gap.to > gap.from && (!sides[side] || gap.to - gap.from < sides[side].to - sides[side].from))
            sides[side] = gap;
    };
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    const middleX = Math.round(rect.x + rect.width / 2);
    const middleY = Math.round(rect.y + rect.height / 2);
    for (const other of helpers) {
        if (other === rect)
            continue;
        if (other.kind === 'vertical') {
            keep('left', {axis: 'x', from: other.x, to: rect.x, at: middleY});
            keep('right', {axis: 'x', from: right, to: other.x, at: middleY});
        } else if (other.kind === 'horizontal') {
            keep('top', {axis: 'y', from: other.y, to: rect.y, at: middleX});
            keep('bottom', {axis: 'y', from: bottom, to: other.y, at: middleX});
        } else {
            const otherRight = other.x + other.width;
            const otherBottom = other.y + other.height;
            const overlapTop = Math.max(rect.y, other.y);
            const overlapBottom = Math.min(bottom, otherBottom);
            if (overlapTop < overlapBottom) {
                const at = Math.round((overlapTop + overlapBottom) / 2);
                keep('left', {axis: 'x', from: otherRight, to: rect.x, at});
                keep('right', {axis: 'x', from: right, to: other.x, at});
            }
            const overlapLeft = Math.max(rect.x, other.x);
            const overlapRight = Math.min(right, otherRight);
            if (overlapLeft < overlapRight) {
                const at = Math.round((overlapLeft + overlapRight) / 2);
                keep('top', {axis: 'y', from: otherBottom, to: rect.y, at});
                keep('bottom', {axis: 'y', from: bottom, to: other.y, at});
            }
        }
    }
    return Object.values(sides).filter(Boolean);
}

/**
 * Column bands of a layout grid, offsets relative to the bounds' left edge. The container is
 * `maxWidth` wide when set (0 means the full width), centered, with `margin` padding on both
 * sides; columns share what is left after the gutters.
 */
export function columnGrid({width, columns, gutter, margin, maxWidth}) {
    const container = maxWidth > 0 ? Math.min(width, maxWidth) : width;
    const inner = container - 2 * margin - (columns - 1) * gutter;
    if (columns < 1 || inner <= 0)
        return [];

    const columnWidth = inner / columns;
    const start = (width - container) / 2 + margin;
    return Array.from({length: columns}, (_, i) => ({
        x: start + i * (columnWidth + gutter),
        width: columnWidth,
    }));
}

/** Index of the monitor containing a point, or of the nearest one. */
export function monitorAt(monitors, x, y) {
    let best = -1;
    let bestDistance = Infinity;
    monitors.forEach((monitor, i) => {
        const dx = Math.max(monitor.x - x, 0, x - (monitor.x + monitor.width - 1));
        const dy = Math.max(monitor.y - y, 0, y - (monitor.y + monitor.height - 1));
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
            best = i;
            bestDistance = distance;
        }
    });
    return best;
}

/** Whether Mutter lays monitors out in logical pixels, from its experimental features. */
export function isLogicalLayout(experimentalFeatures) {
    return experimentalFeatures.includes('scale-monitor-framebuffer');
}

/** A helper with every coordinate multiplied by `factor`, then passed through `round`. */
export function scaleHelper(helper, factor, round = value => value) {
    const scaled = {...helper};
    for (const key of ['x', 'y', 'width', 'height']) {
        if (key in helper)
            scaled[key] = round(helper[key] * factor);
    }
    return scaled;
}

/**
 * Index of the monitor with the highest scale among those a rectangle touches, the first on ties,
 * as Mutter picks the scale a window is drawn at; -1 when it touches none.
 */
export function highestScaleMonitor(monitors, rect) {
    let best = -1;
    monitors.forEach((monitor, i) => {
        const touches = rect.x < monitor.x + monitor.width && monitor.x < rect.x + rect.width &&
            rect.y < monitor.y + monitor.height && monitor.y < rect.y + rect.height;
        if (touches && (best < 0 || monitor.geometry_scale > monitors[best].geometry_scale))
            best = i;
    });
    return best;
}

/**
 * How far Mutter moves a window's surfaces so that they start on a device pixel of the monitor
 * that sets their scale: `position` and `monitorOrigin` are stage coordinates on one axis. This
 * mirrors surface_container_apply_transform() in meta-window-actor-wayland.c, which helpers
 * drawn next to the surfaces do not inherit.
 */
export function surfaceOffset(position, monitorOrigin, scale) {
    return monitorOrigin + Math.round((position - monitorOrigin) * scale) / scale - position;
}

/**
 * The window a point targets, from windows listed top first as `{rect, role}`: a `window` can be
 * targeted, a `blocker` in front of it, such as a popup menu, hides it, and `ignore` lets the
 * point through. Returns the index of the target, or -1.
 */
export function targetAt(windows, x, y) {
    for (let i = 0; i < windows.length; i++) {
        const {rect, role} = windows[i];
        if (role === 'ignore' || x < rect.x || y < rect.y || x >= rect.x + rect.width ||
            y >= rect.y + rect.height)
            continue;
        return role === 'window' ? i : -1;
    }
    return -1;
}
