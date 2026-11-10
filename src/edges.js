// Edge detection on lines of screen pixels. Imports nothing from gi://.
//
// A line is `{data, step, length}`: `length` pixels in `data`, each starting `step` bytes after
// the previous one, with red, green, and blue first. Positions between pixels are boundaries:
// boundary `b` sits between pixel `b - 1` and pixel `b`.

// Largest difference on any color channel between two pixels of the same surface.
export const EDGE_TOLERANCE = 12;
// Dragged edges snap to screen edges this close, in stage pixels.
export const SNAP_DISTANCE = 6;
// A guide also snaps to an edge this many stage pixels long, wherever it lies along the guide.
export const LONG_EDGE = 16;
// Stage coordinates times a fractional scale land a hair off whole device pixels.
const EPSILON = 1e-6;

function differs(line, a, b, tolerance) {
    const i = a * line.step;
    const j = b * line.step;
    return Math.abs(line.data[i] - line.data[j]) > tolerance ||
        Math.abs(line.data[i + 1] - line.data[j + 1]) > tolerance ||
        Math.abs(line.data[i + 2] - line.data[j + 2]) > tolerance;
}

/**
 * The run of pixels around `index` that keep its color: `start` is the boundary before the run,
 * `end` the boundary after it.
 */
export function regionAround(line, index, tolerance = EDGE_TOLERANCE) {
    let start = index;
    while (start > 0 && !differs(line, start - 1, index, tolerance))
        start--;
    let end = index + 1;
    while (end < line.length && !differs(line, end, index, tolerance))
        end++;
    return {start, end};
}

/**
 * The boundary between two different pixels nearest to `position` (a boundary coordinate, which
 * may be fractional), within `radius` and within the boundaries `from` to `to`; null when there
 * is none.
 */
export function nearestBoundary(line, position, radius, tolerance = EDGE_TOLERANCE,
    {from = 0, to = line.length, extra = []} = {}) {
    // Positions come from stage coordinates times a fractional scale: a hair of tolerance keeps a
    // boundary exactly `radius` away in.
    const first = Math.max(1, from, Math.ceil(position - radius - 1e-6));
    const last = Math.min(line.length - 1, to, Math.floor(position + radius + 1e-6));
    let best = null;
    const consider = b => {
        const distance = Math.abs(b - position);
        const bestDistance = best === null ? Infinity : Math.abs(best - position);
        if (distance < bestDistance || (distance === bestDistance && b < best))
            best = b;
    };
    for (let b = first; b <= last; b++) {
        if (differs(line, b - 1, b, tolerance))
            consider(b);
    }
    // Boundaries found elsewhere, such as long edges: the same limits apply.
    for (const b of extra) {
        if (b >= first && b <= last)
            consider(b);
    }
    return best;
}

/**
 * The boundaries in an area of pixels that are an edge on at least `minRun` consecutive pixels
 * along their length. The area is `{data, rowstride, channels, x, y, width, height}` as
 * Snapshot.area() returns it. With `vertical`, the boundaries lie between columns and runs go down
 * the rows; otherwise they lie between rows and runs go across the columns. Boundaries are in
 * the area's own coordinates plus its `x` or `y` (device pixels), ascending.
 */
export function longEdges(area, vertical, minRun, tolerance = EDGE_TOLERANCE) {
    const {data, rowstride, channels} = area;
    const across = vertical ? area.width : area.height;
    const along = vertical ? area.height : area.width;
    const origin = (vertical ? area.x : area.y) ?? 0;
    // Byte offsets of a step across the boundaries and of a step along them.
    const acrossStep = vertical ? channels : rowstride;
    const alongStep = vertical ? rowstride : channels;
    const edges = [];
    for (let b = 1; b < across; b++) {
        let run = 0;
        for (let k = 0; k < along; k++) {
            const j = k * alongStep + b * acrossStep;
            const i = j - acrossStep;
            if (Math.abs(data[i] - data[j]) > tolerance ||
                Math.abs(data[i + 1] - data[j + 1]) > tolerance ||
                Math.abs(data[i + 2] - data[j + 2]) > tolerance) {
                if (++run >= minRun) {
                    edges.push(origin + b);
                    break;
                }
            } else {
                run = 0;
            }
        }
    }
    return edges;
}

/**
 * The boundaries nearest to both ends of a stage span `{origin, length}` at `scale`, halves
 * rounding outward: the limits of the boundaries a dragged edge in that span can snap to.
 */
function spanBoundaries({origin, length}, scale) {
    return {from: Math.ceil(origin * scale - 0.5), to: Math.floor((origin + length) * scale + 0.5)};
}

/**
 * The stage coordinate a dragged edge at the stage coordinate `position` snaps to: the nearest
 * boundary of `line`, or of `extra` (device boundaries, such as long edges), within SNAP_DISTANCE
 * and within the stage span `bounds`, `{origin, length}`; `position` itself when there is none.
 */
export function snapPosition(line, scale, position, bounds, extra = []) {
    const boundary = nearestBoundary(line, position * scale, SNAP_DISTANCE * scale, undefined,
        {...spanBoundaries(bounds, scale), extra});
    return boundary === null ? position : boundary / scale;
}

/**
 * The area of the capture that holds the long edges a guide at the stage coordinate `position`
 * can snap to, `{x, y, width, height}` in device pixels, with the run `minRun` that makes an edge
 * long at `scale`; null when there is none to read. `along` is the stage span `{origin, length}`
 * of the zone's visible part on the guide's axis, `across` on the other; `vertical` for a vertical
 * guide. The area starts a pixel before the first boundary, so longEdges() sees both its sides.
 */
export function longEdgeBand(position, scale, along, across, vertical) {
    const span = spanBoundaries(along, scale);
    const first = Math.max(Math.ceil((position - SNAP_DISTANCE) * scale - EPSILON), span.from, 1);
    const last = Math.min(Math.floor((position + SNAP_DISTANCE) * scale + EPSILON), span.to);
    // Only the device pixels fully inside the zone's visible part, on both sides of each boundary.
    const start = Math.ceil(across.origin * scale - EPSILON);
    const end = Math.floor((across.origin + across.length) * scale + EPSILON);
    if (last < first || end <= start)
        return null;
    const minRun = Math.ceil(LONG_EDGE * scale - EPSILON);
    return vertical ?
        {x: first - 1, y: start, width: last - first + 2, height: end - start, minRun} :
        {x: start, y: first - 1, width: end - start, height: last - first + 2, minRun};
}

/**
 * The run of same-colored pixels of `line` around the stage coordinate `position`, at `scale`,
 * cut to the stage span `bounds`, `{origin, length}`: `{start, length}` in stage pixels, the
 * length 0 when the run and the span do not meet. The length is the device length over the scale,
 * so it reads the same wherever the run starts.
 */
export function measureRun(line, position, scale, bounds) {
    const {start, end} = regionAround(line, Math.floor(position * scale));
    const from = Math.max(start, Math.round(bounds.origin * scale));
    const to = Math.min(end, Math.round((bounds.origin + bounds.length) * scale));
    return {start: from / scale, length: Math.max(0, to - from) / scale};
}
