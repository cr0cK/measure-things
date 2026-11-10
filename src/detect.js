// Find helpers: guides on long edges and rectangles around uniform regions, found in the pixels of
// a zone. Imports nothing from gi://, so node --test covers it.
//
// Rows of pixels are fed to a `Detector` in any number of pieces, so a caller can read the zone in
// bands and yield to the main loop between them; the result does not depend on how the rows were
// split. Positions are boundaries between pixels, relative to the zone's top-left corner:
// boundary `b` sits between pixel `b - 1` and pixel `b`.
//
// Two neighboring pixels are on the same surface unless some color channel differs by more than
// the level's tolerance, which is what edges.js does for snapping. Guides come from projection
// profiles of that edge map: the length of long runs of edge pixels along each column and row.
// Rectangles come from the connected regions of pixels with no edge between them, found in one
// pass over the rows with a union-find over labels that are freed once a region cannot grow. A
// region fills its box when, row by row, it spans the box: what is inside it, such as the text of
// a card or the elements on a panel, does not make it less of a rectangle.

export const LEVELS = ['low', 'medium', 'high'];

// Each level's numbers, tuned on the test images of tests/fixtures/images.js:
// - `edge`: largest difference on any color channel between two pixels of the same surface;
// - `run`: the shortest run of edge pixels that counts toward an edge's coverage, as a fraction
//   of the zone's size along the edge, with a floor in pixels;
// - `coverage`: the fraction of the zone's size along the edge that its runs must reach;
// - `minWidth`, `minHeight`: the smallest rectangle, as a fraction of the zone's size with a floor;
// - `spans`, `area`: a rectangle must reach `spans` of the zone's width or height, or `area` of its
//   area, so that the lowest level keeps the bands, columns, and quarters of the layout, not the
//   cards in them;
// - `fill`: the share of its box that a region must span, row by row, to be a rectangle.
export const PARAMETERS = {
    low: {
        edge: 20,
        run: {fraction: 0.08, floor: 16},
        coverage: 0.4,
        minWidth: {fraction: 0.08, floor: 64},
        minHeight: {fraction: 0.05, floor: 32},
        spans: 0.8,
        area: 0.10,
        fill: 0.85,
    },
    medium: {
        edge: 12,
        run: {fraction: 0.04, floor: 12},
        coverage: 0.12,
        minWidth: {fraction: 0.05, floor: 40},
        minHeight: {fraction: 0.04, floor: 24},
        spans: 0,
        area: 0,
        fill: 0.85,
    },
    high: {
        edge: 8,
        run: {fraction: 0, floor: 26},
        coverage: 0.05,
        minWidth: {fraction: 0, floor: 16},
        minHeight: {fraction: 0, floor: 12},
        spans: 0,
        area: 0,
        fill: 0.85,
    },
};

// At most this many guides and rectangles each; a kind that finds fewer leaves its slots to the other.
export const MAX_PER_KIND = 30;
// A guide within this many pixels of a rectangle's edge is dropped, and two guides this close
// are one, as the two boundaries of a one-pixel line: the one with the longer coverage is kept.
const NEAR = 1;
// A region at least this share of the zone in both directions is the background.
const BACKGROUND = 0.95;
// The percentage of a side's positions that a thin line must cover for the region to take it in.
const LINE_PERCENT = 85;
// Flags of the edge map kept for every pixel: an edge with the pixel to its left, and with the one above.
const LEFT = 1;
const ABOVE = 2;

const size = ({fraction, floor}, length) => Math.max(floor, Math.round(fraction * length));

/** A growable set of regions, found while the rows go by. */
class Regions {
    constructor(width) {
        this._Extent = width <= 0x10000 ? Uint16Array : Uint32Array;
        this._capacity = 256;
        this.parent = new Int32Array(this._capacity);
        this.minX = new Int32Array(this._capacity);
        this.maxX = new Int32Array(this._capacity);
        this.minY = new Int32Array(this._capacity);
        this.maxY = new Int32Array(this._capacity);
        // Per region, the first and last pixel on each of its rows so far, flat: min, max, min, max...
        // from row `minY`, `used` of them, in 16 bits unless the zone is wider than that. A region
        // alive is on every row since it began, so the list has no gap; a merge takes the hull of
        // both lists row by row, into the list of the region that began first.
        this.extent = [];
        this.used = new Int32Array(this._capacity);
        this.rowMin = new Int32Array(this._capacity);
        this.rowMax = new Int32Array(this._capacity);
        this.seen = new Int32Array(this._capacity);
        this._next = 0;
        this.free = [];
    }

    _grow() {
        this._capacity *= 2;
        for (const name of ['parent', 'minX', 'maxX', 'minY', 'maxY', 'used', 'rowMin', 'rowMax', 'seen']) {
            const bigger = new Int32Array(this._capacity);
            bigger.set(this[name]);
            this[name] = bigger;
        }
    }

    /** A new region, first seen on row `y`. */
    alloc(y) {
        let id;
        if (this.free.length > 0) {
            id = this.free.pop();
        } else {
            if (this._next === this._capacity)
                this._grow();
            id = this._next++;
        }
        this.parent[id] = id;
        this.minX[id] = 0x7fffffff;
        this.maxX[id] = -1;
        this.minY[id] = y;
        this.maxY[id] = y;
        // A freed id keeps its list, and the next region of that id reuses it.
        this.used[id] = 0;
        this.seen[id] = 0;
        return id;
    }

    /** Adds the first and last pixel of the region's next row. */
    push(id, first, last) {
        let list = this.extent[id];
        const used = this.used[id];
        if (!list) {
            list = this.extent[id] = new this._Extent(8);
        } else if (used === list.length) {
            const bigger = new this._Extent(used * 2);
            bigger.set(list);
            list = this.extent[id] = bigger;
        }
        list[used] = first;
        list[used + 1] = last;
        this.used[id] = used + 2;
    }

    find(id) {
        const {parent} = this;
        let root = id;
        while (parent[root] !== root)
            root = parent[root];
        while (parent[id] !== root) {
            const next = parent[id];
            parent[id] = root;
            id = next;
        }
        return root;
    }

    /** Merges two roots into the one that began first, which is returned. */
    union(a, b) {
        if (a === b)
            return a;
        if (this.minY[b] < this.minY[a] || (this.minY[b] === this.minY[a] && b < a))
            [a, b] = [b, a];
        const from = this.extent[b];
        const length = this.used[b];
        if (length > 0) {
            // `a` began first, so its list covers every row of `b`'s.
            const into = this.extent[a];
            const offset = (this.minY[b] - this.minY[a]) * 2;
            for (let k = 0; k < length; k += 2) {
                if (from[k] < into[offset + k])
                    into[offset + k] = from[k];
                if (from[k + 1] > into[offset + k + 1])
                    into[offset + k + 1] = from[k + 1];
            }
        }
        this.parent[b] = a;
        this.minX[a] = Math.min(this.minX[a], this.minX[b]);
        this.maxX[a] = Math.max(this.maxX[a], this.maxX[b]);
        this.minY[a] = Math.min(this.minY[a], this.minY[b]);
        this.maxY[a] = Math.max(this.maxY[a], this.maxY[b]);
        return a;
    }
}

export class Detector {
    /**
     * `level` is `low`, `medium`, or `high`; the zone is `width` × `height` pixels, read at `scale`
     * device pixels per CSS pixel: a rectangle takes in a line up to `ceil(scale)` pixels thick.
     */
    constructor(width, height, level, scale = 1) {
        const parameters = PARAMETERS[level];
        if (!parameters)
            throw new Error(`Unknown tolerance: ${level}`);
        this.width = width;
        this.height = height;
        this.rows = 0;
        this._reach = Math.max(1, Math.ceil(scale));
        this._edge = parameters.edge;
        // Runs along a column count against the zone's height, and along a row against its width.
        this._runY = size(parameters.run, height);
        this._runX = size(parameters.run, width);
        this._needY = parameters.coverage * height;
        this._needX = parameters.coverage * width;
        this._minWidth = size(parameters.minWidth, width);
        this._minHeight = size(parameters.minHeight, height);
        this._spans = parameters.spans;
        this._area = parameters.area;
        this._fill = parameters.fill;

        this._previous = new Uint8Array(width * 3);
        // Edge pixels in a row, per boundary: the current run down the column, and its sum.
        this._columnRun = new Int32Array(width);
        this._columnCover = new Int32Array(width);
        this._rowCover = new Int32Array(height);
        this._labels = new Int32Array(width);
        this._above = new Int32Array(width);
        this._regions = new Regions(width);
        this._alive = [];
        // The regions that ended, judged in `finish()`: a line beside one may be in rows not fed yet.
        this._ended = [];
        // The edge map, kept to find the thin lines beside the regions.
        this._edges = new Uint8Array(width * height);
    }

    /**
     * Feeds `count` rows of pixels, the first at byte `offset` of `data`, `stride` bytes apart,
     * `channels` bytes per pixel with red, green, and blue first. Rows beyond the zone are ignored.
     */
    addRows(data, offset, stride, channels, count) {
        const rows = Math.min(count, this.height - this.rows);
        for (let r = 0; r < rows; r++)
            this._row(data, offset + r * stride, channels);
    }

    _row(data, offset, channels) {
        const {width, _edge: edge, _previous: previous, _columnRun: columnRun, _regions: regions} = this;
        const y = this.rows;
        const labels = this._labels;
        const above = this._above;
        let rowRun = 0;
        let red = 0;
        let green = 0;
        let blue = 0;
        for (let x = 0, i = offset, p = 0; x < width; x++, i += channels, p += 3) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const vertical = x > 0 && (Math.abs(r - red) > edge || Math.abs(g - green) > edge ||
                Math.abs(b - blue) > edge);
            const horizontal = y > 0 && (Math.abs(r - previous[p]) > edge ||
                Math.abs(g - previous[p + 1]) > edge || Math.abs(b - previous[p + 2]) > edge);
            this._edges[y * width + x] = (vertical ? LEFT : 0) | (horizontal ? ABOVE : 0);
            red = r;
            green = g;
            blue = b;
            previous[p] = r;
            previous[p + 1] = g;
            previous[p + 2] = b;

            if (vertical) {
                columnRun[x]++;
            } else if (columnRun[x] > 0) {
                if (columnRun[x] >= this._runY)
                    this._columnCover[x] += columnRun[x];
                columnRun[x] = 0;
            }
            if (horizontal) {
                rowRun++;
            } else if (rowRun > 0) {
                if (rowRun >= this._runX)
                    this._rowCover[y] += rowRun;
                rowRun = 0;
            }

            let label = horizontal || y === 0 ? -1 : above[x];
            if (!vertical && x > 0) {
                let left = labels[x - 1];
                if (regions.parent[left] !== left)
                    left = regions.find(left);
                label = label < 0 ? left : regions.union(regions.find(label), left);
            }
            labels[x] = label < 0 ? this._alloc(y) : label;
        }
        if (rowRun >= this._runX)
            this._rowCover[y] += rowRun;

        this._account(y);
        // The labels of this row are the ones above the next.
        this._labels = above;
        this._above = labels;
        this.rows++;
    }

    _alloc(y) {
        const id = this._regions.alloc(y);
        this._alive.push(id);
        return id;
    }

    /** Settles the labels of row `y` on their roots, counts its pixels, and frees what ended. */
    _account(y) {
        const {width, _labels: labels, _regions: regions, _alive: alive} = this;
        const {minX, maxX, maxY, rowMin, rowMax, seen} = regions;
        let x = 0;
        while (x < width) {
            const root = regions.find(labels[x]);
            let end = x;
            labels[x] = root;
            while (end + 1 < width && (labels[end + 1] === root || regions.find(labels[end + 1]) === root)) {
                end++;
                labels[end] = root;
            }
            if (x < minX[root])
                minX[root] = x;
            if (end > maxX[root])
                maxX[root] = end;
            maxY[root] = y;
            if (seen[root] !== y + 1) {
                rowMin[root] = x;
                seen[root] = y + 1;
            }
            rowMax[root] = end;
            x = end + 1;
        }

        let kept = 0;
        for (let k = 0; k < alive.length; k++) {
            const id = alive[k];
            if (regions.parent[id] !== id) {
                regions.free.push(id);
            } else if (seen[id] !== y + 1) {
                this._finish(id);
                regions.free.push(id);
            } else {
                regions.push(id, rowMin[id], rowMax[id]);
                alive[kept++] = id;
            }
        }
        alive.length = kept;
    }

    /** A region that cannot grow any more: kept for judging when it can still be big and full enough. */
    _finish(id) {
        const {minX, maxX, minY, maxY, extent, used} = this._regions;
        const width = maxX[id] + 1 - minX[id];
        const height = maxY[id] + 1 - minY[id];
        // The box grows by a line on each side at most.
        const reach = 2 * this._reach;
        if (width + reach < this._minWidth || height + reach < this._minHeight)
            return;
        // The share of its box that the region spans, row by row.
        let span = 0;
        const rows = extent[id];
        for (let k = 0; k < used[id]; k += 2)
            span += rows[k + 1] - rows[k] + 1;
        // A box only grows, so a region below the fill share of its own box is below it afterwards.
        if (span < this._fill * width * height)
            return;
        // The row extents are copied: a freed region's list is reused by the next of that id.
        this._ended.push({x: minX[id], y: minY[id], width, height, span, rows: rows.slice(0, used[id])});
    }

    /**
     * How thick a line along one side of a box is, from 1 to `_reach` pixels, or 0 when the side
     * takes none in. The `count` positions along the side are in the edge map from `start`, `step`
     * apart; there, `flag` is set when the first pixel beyond the box differs from the box's own.
     * Going out from it, `outward` entries apart, the first entry with `flag` set after `t` steps
     * is the far boundary of a line `t` thick, unless the next entry has `flag` set too: the pixel
     * beyond the boundary would then be a line of one pixel itself, the second half of a line
     * drawn across two device pixels (a border at a fractional scale), and the line is thicker.
     * `room` is how many steps the zone leaves for it.
     * Only the positions where `covers(i)` holds vote: the region's own pixel is at the box's side,
     * as its row extents tell, and not a notch of it.
     */
    _line(start, step, count, outward, room, flag, covers) {
        const edges = this._edges;
        const reach = Math.min(this._reach, room);
        if (reach < 1)
            return 0;
        const counts = new Int32Array(reach + 1);
        for (let i = 0, at = start; i < count; i++, at += step) {
            // The edge between the region's pixel and the first one beyond the box.
            if (!(edges[at] & flag) || !covers(i))
                continue;
            for (let t = 1; t <= reach; t++) {
                if ((edges[at + t * outward] & flag) &&
                    (t === reach || !(edges[at + (t + 1) * outward] & flag))) {
                    counts[t]++;
                    break;
                }
            }
        }
        for (let t = 1; t <= reach; t++) {
            if (counts[t] * 100 >= LINE_PERCENT * count)
                return t;
        }
        return 0;
    }

    /** The box of an ended region with the thin lines along its sides taken in. */
    _grown({x, y, width, height, rows}) {
        const w = this.width;
        const x1 = x + width - 1;
        const y1 = y + height - 1;
        const last = (height - 1) * 2;
        // Each side is judged against the region's own box. `room` is how many boundaries the zone
        // has beyond the near one, so that the far boundary lies inside it.
        const left = this._line(y * w + x, w, height, -1, x - 1, LEFT, i => rows[i * 2] === x);
        const right = this._line(y * w + x1 + 1, w, height, 1, w - x1 - 2, LEFT, i => rows[i * 2 + 1] === x1);
        const top = this._line(y * w + x, 1, width, -w, y - 1, ABOVE,
            i => rows[0] <= x + i && x + i <= rows[1]);
        const bottom = this._line((y1 + 1) * w + x, 1, width, w, this.height - y1 - 2, ABOVE,
            i => rows[last] <= x + i && x + i <= rows[last + 1]);
        return {
            x: x - left,
            y: y - top,
            width: width + left + right,
            height: height + top + bottom,
        };
    }

    /** A region's box, with its lines, when it is big and full enough to be a rectangle. */
    _rectangle(region) {
        const box = this._grown(region);
        const {x, y, width, height} = box;
        if (width < this._minWidth || height < this._minHeight)
            return null;
        if (width < this._spans * this.width && height < this._spans * this.height &&
            width * height < this._area * this.width * this.height)
            return null;
        if (region.span < this._fill * width * height)
            return null;
        if (width >= BACKGROUND * this.width && height >= BACKGROUND * this.height)
            return null;
        return {x, y, width, height};
    }

    /**
     * The helpers found, as `{guides, rectangles}` in boundaries of the zone: guides are
     * `{kind: 'vertical', x}` or `{kind: 'horizontal', y}`, rectangles `{kind: 'rectangle', x, y,
     * width, height}`. At most 60 in all, truncated as the spec says.
     */
    finish() {
        if (this.rows === 0)
            return {guides: [], rectangles: []};
        for (let x = 0; x < this.width; x++) {
            if (this._columnRun[x] >= this._runY)
                this._columnCover[x] += this._columnRun[x];
            this._columnRun[x] = 0;
        }
        for (const id of this._alive)
            this._finish(id);
        this._alive.length = 0;
        const found = [];
        for (const region of this._ended) {
            const box = this._rectangle(region);
            if (box)
                found.push(box);
        }
        this._ended.length = 0;

        const candidates = [];
        for (let x = 1; x < this.width; x++) {
            if (this._columnCover[x] >= this._needY)
                candidates.push({kind: 'vertical', x, cover: this._columnCover[x]});
        }
        for (let y = 1; y < this.height; y++) {
            if (this._rowCover[y] >= this._needX)
                candidates.push({kind: 'horizontal', y, cover: this._rowCover[y]});
        }
        return selectHelpers(found.map(rect => ({kind: 'rectangle', ...rect})), candidates);
    }
}

const where = guide => (guide.kind === 'vertical' ? [0, guide.x] : [guide.y, 0]);

function byPosition(a, b) {
    const [ay, ax] = a.kind === 'rectangle' ? [a.y, a.x] : where(a);
    const [by, bx] = b.kind === 'rectangle' ? [b.y, b.x] : where(b);
    return ay - by || ax - bx;
}

const along = guide => (guide.kind === 'vertical' ? guide.x : guide.y);

/** Whether a guide lies within a pixel of an edge of a rectangle; guides span the whole zone. */
function onEdge(guide, rect) {
    if (guide.kind === 'vertical')
        return Math.abs(guide.x - rect.x) <= NEAR || Math.abs(guide.x - rect.x - rect.width) <= NEAR;
    return Math.abs(guide.y - rect.y) <= NEAR || Math.abs(guide.y - rect.y - rect.height) <= NEAR;
}

/** Whether two rectangles have every edge within a pixel of the other's: one thing drawn twice. */
const same = (a, b) => Math.abs(a.x - b.x) <= NEAR && Math.abs(a.y - b.y) <= NEAR &&
    Math.abs(a.x + a.width - b.x - b.width) <= NEAR && Math.abs(a.y + a.height - b.y - b.height) <= NEAR;

/**
 * Applies the rules on what is kept: rectangles that repeat a larger one are dropped; so are guides
 * within a pixel of a longer one and those on a rectangle's edge; at most 30 of each kind, the
 * rectangles largest first and the guides longest first, the slots one kind leaves unused going to
 * the other. Ties go by position, top to bottom then left to right.
 */
export function selectHelpers(rectangles, candidates) {
    rectangles.sort((a, b) => b.width * b.height - a.width * a.height || byPosition(a, b));
    // A region and the border around it are one rectangle: the larger is kept. No more than the
    // 60 that fit are needed.
    const total = 2 * MAX_PER_KIND;
    const unique = [];
    for (const rect of rectangles) {
        if (unique.length === total)
            break;
        if (!unique.some(kept => same(kept, rect)))
            unique.push(rect);
    }
    rectangles = unique;
    candidates.sort((a, b) => b.cover - a.cover || byPosition(a, b));
    const merged = [];
    for (const guide of candidates) {
        if (!merged.some(kept => kept.kind === guide.kind && Math.abs(along(kept) - along(guide)) <= NEAR))
            merged.push(guide);
    }

    // The rectangles are the first `kept`; the guides are those not on their edges. Rectangles past
    // the first 30 take only the slots the guides leave vacant, and each one kept drops the guides
    // on its own edges, which vacates more, so this goes on until no slot is vacant.
    const guidesWithout = count => merged.filter(guide =>
        !rectangles.slice(0, count).some(rect => onEdge(guide, rect)));
    let kept = Math.min(rectangles.length, MAX_PER_KIND);
    let guides = guidesWithout(kept);
    while (kept < rectangles.length) {
        const more = Math.min(rectangles.length, kept + Math.max(0, total - kept - guides.length));
        if (more === kept)
            break;
        kept = more;
        guides = guidesWithout(kept);
    }
    guides = guides.slice(0, total - kept);
    const rects = rectangles.slice(0, kept);
    return {
        guides: guides.map(({cover: _cover, ...guide}) => guide),
        rectangles: rects,
    };
}

/**
 * The helpers in an image `{data, width, height, stride, channels}` at a tolerance level; `stride`
 * and `channels` default to a tightly packed RGBA image. `bandRows` feeds the rows in pieces of
 * that height, as a caller reading the zone in bands does; `scale` is the image's device scale.
 */
export function detect(image, level, {bandRows = image.height, scale = 1} = {}) {
    const {data, width, height, channels = 4, stride = width * channels} = image;
    const detector = new Detector(width, height, level, scale);
    for (let y = 0; y < height; y += bandRows)
        detector.addRows(data, y * stride, stride, channels, Math.min(bandRows, height - y));
    return detector.finish();
}
