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
 * may be fractional), within `radius`; null when there is none.
 */
export function nearestBoundary(line, position, radius, tolerance = EDGE_TOLERANCE) {
    const first = Math.max(1, Math.ceil(position - radius));
    const last = Math.min(line.length - 1, Math.floor(position + radius));
    let best = null;
    for (let b = first; b <= last; b++) {
        if (differs(line, b - 1, b, tolerance) &&
            (best === null || Math.abs(b - position) < Math.abs(best - position)))
            best = b;
    }
    return best;
}
