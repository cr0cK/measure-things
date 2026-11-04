// Pure zone geometry and view targeting among the views of a window. Imports nothing from gi://,
// so node --test covers it. Rectangles are `{x, y, width, height}` in stage pixels; a zone's own
// coordinates are relative to the window frame's top-left corner.

import {HIT_TOLERANCE} from './geometry.js';

// A zone is never smaller than this on either side, or than the whole frame when that is smaller.
export const MIN_ZONE = 40;

/** The overlap of two rectangles, or null when it is empty. */
export function intersect(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    return right > x && bottom > y ? {x, y, width: right - x, height: bottom - y} : null;
}

/** Whether any of the rectangles overlaps the zone's visible part. */
export function covers(rects, zone) {
    return rects.some(rect => intersect(rect, zone) !== null);
}

/**
 * A zone in the frame's coordinates: `rect` is the zone itself, `visible` its part inside the
 * frame, or null when it lies outside. `zone` is the stored fixed zone, in the window actor's
 * units, or null for the automatic one, the whole frame; `k` is stage pixels per unit.
 */
export function zoneRects(frame, zone, k) {
    const rect = zone
        ? {x: zone.x * k, y: zone.y * k, width: zone.width * k, height: zone.height * k}
        : {x: 0, y: 0, width: frame.width, height: frame.height};
    return {rect, visible: intersect(rect, {x: 0, y: 0, width: frame.width, height: frame.height})};
}

/** A zone as it is stored: whole stage pixels, in the window actor's units. */
export function storedZone(rect, k) {
    return {
        x: Math.round(rect.x) / k,
        y: Math.round(rect.y) / k,
        width: Math.round(rect.width) / k,
        height: Math.round(rect.height) / k,
    };
}

/**
 * The edge of a rectangle within `tolerance` of a point along its whole length: `left`, `right`,
 * `top`, or `bottom`. The nearest wins; a corner goes to the left or right edge on a tie.
 */
export function edgeAt(rect, x, y, tolerance = HIT_TOLERANCE) {
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    const alongX = x >= rect.x - tolerance && x <= right + tolerance;
    const alongY = y >= rect.y - tolerance && y <= bottom + tolerance;
    const candidates = [
        ['left', Math.abs(x - rect.x), alongY],
        ['right', Math.abs(x - right), alongY],
        ['top', Math.abs(y - rect.y), alongX],
        ['bottom', Math.abs(y - bottom), alongX],
    ].filter(([, distance, along]) => along && distance <= tolerance);
    let best = null;
    for (const candidate of candidates) {
        if (!best || candidate[1] < best[1])
            best = candidate;
    }
    return best?.[0] ?? null;
}

/**
 * The zone `rect` with one edge moved to `position`: a coordinate in the frame's. The zone stays
 * within the frame, and keeps `min` pixels on each side, or the whole frame when it is smaller.
 * The other edges stay where they are, unless they lie outside the frame.
 */
export function dragEdge(rect, edge, position, frame, min = MIN_ZONE) {
    const minWidth = Math.min(min, frame.width);
    const minHeight = Math.min(min, frame.height);
    let left = Math.max(0, rect.x);
    let top = Math.max(0, rect.y);
    let right = Math.min(frame.width, rect.x + rect.width);
    let bottom = Math.min(frame.height, rect.y + rect.height);
    // A zone mostly outside the frame first grows back to the minimum.
    if (right - left < minWidth) {
        right = Math.min(frame.width, left + minWidth);
        left = right - minWidth;
    }
    if (bottom - top < minHeight) {
        bottom = Math.min(frame.height, top + minHeight);
        top = bottom - minHeight;
    }
    const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
    if (edge === 'left')
        left = clamp(position, 0, right - minWidth);
    else if (edge === 'right')
        right = clamp(position, left + minWidth, frame.width);
    else if (edge === 'top')
        top = clamp(position, 0, bottom - minHeight);
    else if (edge === 'bottom')
        bottom = clamp(position, top + minHeight, frame.height);
    return {x: left, y: top, width: right - left, height: bottom - top};
}

const area = rect => rect.width * rect.height;

/** Whether a view stacks above another: the smaller zone, then the newer one. */
function stacksAbove(a, b) {
    return a.area !== b.area ? a.area < b.area : a.seq > b.seq;
}

function topmost(entries) {
    return entries.reduce((best, entry) => (!best || stacksAbove(entry, best) ? entry : best), null);
}

/**
 * Views of one window from the bottom up: the largest zone first, the newest on top among equal
 * sizes. `entries` are `{id, area, seq}`.
 */
export function stackOrder(entries) {
    return [...entries]
        .sort((a, b) => (stacksAbove(a, b) ? 1 : stacksAbove(b, a) ? -1 : 0))
        .map(entry => entry.id);
}

/** A view's zone for targeting: the visible part, with its stacking rank. */
export function zoneEntry(id, visible, seq) {
    return {id, visible, area: visible ? area(visible) : 0, seq};
}

/**
 * The view a point targets by zone alone: the smallest visible zone under it, the newest on equal
 * sizes. `entries` are `{id, visible, area, seq}`; null when no zone covers the point.
 */
export function targetZone(entries, x, y) {
    const under = entries.filter(({visible}) => visible && x >= visible.x && y >= visible.y &&
        x < visible.x + visible.width && y < visible.y + visible.height);
    return topmost(under)?.id ?? null;
}

const HIT_CLASSES = ['badge', 'edge', 'helper', 'zone'];

/**
 * What a press acts on, over every view of a window. `entries` are `{id, area, seq}` with a
 * boolean for each class the point is in: `badge`, `edge`, `helper`, and `zone`, which only the
 * view that zone targeting picks has. A badge comes first, then a zone edge, then helpers, then
 * the zone. Among equal hits the view targeted last, `lastId`, wins, then the one stacked higher.
 * Returns `{id, kind}`, or null.
 */
export function pickHit(entries, lastId = null) {
    for (const kind of HIT_CLASSES) {
        const hits = entries.filter(entry => entry[kind]);
        if (hits.length === 0)
            continue;
        const last = kind !== 'zone' && hits.find(entry => entry.id === lastId);
        return {id: (last || topmost(hits)).id, kind};
    }
    return null;
}

/**
 * Where badges of one window go. `items` are `{width, height, right, bottom}`: a badge's size and
 * the bottom-right corner of the zone it belongs to, in the frame's coordinates, oldest view
 * first. A badge sits `margin` inside that corner; one that would overlap another moves left by
 * `gap` past it, so the newest ends outermost; one that would cross the frame's left edge starts
 * a new row above. A badge wider than the frame stays on the first row, clipped.
 */
export function placeBadges(items, margin = 8, gap = 4) {
    const placed = [];
    for (const {width, height, right: cornerX, bottom: cornerY} of items) {
        const startRight = cornerX - margin;
        let right = startRight;
        let row = 0;
        let spot = null;
        for (let attempt = 0; attempt < 200 && !spot; attempt++) {
            const rect = {
                x: right - width,
                y: cornerY - margin - height - row * (height + gap),
                width,
                height,
            };
            const blocker = placed.find(other => intersect(rect, other));
            if (blocker) {
                right = blocker.x - gap;
            } else if (rect.x < 0 && right !== startRight) {
                row++;
                right = startRight;
            } else {
                spot = rect;
            }
        }
        spot ??= {x: startRight - width, y: cornerY - margin - height, width, height};
        placed.push(spot);
    }
    return placed.map(({x, y}) => ({x, y}));
}
