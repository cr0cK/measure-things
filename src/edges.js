// Edge detection on lines of screen pixels. Imports nothing from gi://.
//
// A line is `{data, step, length}`: `length` pixels in `data`, each starting `step` bytes after
// the previous one, with red, green, and blue first. Positions between pixels are boundaries:
// boundary `b` sits between pixel `b - 1` and pixel `b`.

// Largest difference on any color channel between two pixels of the same surface.
export const EDGE_TOLERANCE = 12;

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
