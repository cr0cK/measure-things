// Pure geometry for helpers, hit testing, grids, and pixel units. Imports nothing from gi://,
// so node --test covers it. Coordinates are stage pixels unless a name says otherwise.

export const HELPER_KINDS = ['horizontal', 'vertical', 'rectangle'];

// Distance, in stage pixels, within which a guide or a rectangle edge catches the pointer.
export const HIT_TOLERANCE = 4;

/** Reads the stored JSON list, dropping invalid entries, and gives each helper a runtime id. */
export function parseHelpers(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    } catch {
        return [];
    }
    if (!Array.isArray(raw))
        return [];

    const helpers = [];
    for (const entry of raw) {
        const helper = normalizeHelper(entry);
        if (helper)
            helpers.push({id: helpers.length + 1, ...helper});
    }
    return helpers;
}

function normalizeHelper(entry) {
    if (!entry || !HELPER_KINDS.includes(entry.kind))
        return null;
    const numbers = entry.kind === 'horizontal' ? ['y']
        : entry.kind === 'vertical' ? ['x'] : ['x', 'y', 'width', 'height'];
    if (!numbers.every(key => Number.isFinite(entry[key])))
        return null;

    const helper = {kind: entry.kind};
    for (const key of numbers)
        helper[key] = Math.round(entry[key]);
    if (entry.kind === 'rectangle' && (helper.width < 1 || helper.height < 1))
        return null;
    return helper;
}

/** Serializes helpers without their runtime ids. */
export function serializeHelpers(helpers) {
    return JSON.stringify(helpers.map(({id: _id, ...helper}) => helper));
}

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

/** The helper as it was at drag start, moved or resized by the pointer delta. */
export function dragHelper(origin, part, dx, dy) {
    if (origin.kind === 'horizontal')
        return {...origin, y: origin.y + dy};
    if (origin.kind === 'vertical')
        return {...origin, x: origin.x + dx};
    if (part === 'move' || part === 'inside')
        return {...origin, x: origin.x + dx, y: origin.y + dy};

    let left = origin.x;
    let top = origin.y;
    let right = origin.x + origin.width;
    let bottom = origin.y + origin.height;
    if (part.includes('left'))
        left += dx;
    if (part.includes('right'))
        right += dx;
    if (part.includes('top'))
        top += dy;
    if (part.includes('bottom'))
        bottom += dy;
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

/**
 * Converts stage pixels to CSS pixels (at 100% browser zoom) and to device pixels. In logical
 * layout mode, the one fractional scaling uses, the stage is in logical pixels; in physical
 * mode it is in device pixels.
 */
export function pixelRatios(monitorScale, logical) {
    return {
        css: logical ? 1 : 1 / monitorScale,
        device: logical ? monitorScale : 1,
    };
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

/**
 * Where a guide label goes: for a vertical guide, the top edge of the highest monitor it
 * crosses; for a horizontal guide, the left edge of the leftmost one. Falls back to the stage
 * origin when the guide crosses no monitor.
 */
export function labelAnchor(monitors, kind, position) {
    const crossed = kind === 'vertical'
        ? monitors.filter(m => position >= m.x && position < m.x + m.width)
        : monitors.filter(m => position >= m.y && position < m.y + m.height);
    if (crossed.length === 0)
        return {monitor: -1, edge: 0};

    const key = kind === 'vertical' ? 'y' : 'x';
    const monitor = crossed.reduce((a, b) => (b[key] < a[key] ? b : a));
    return {monitor: monitors.indexOf(monitor), edge: monitor[key]};
}
