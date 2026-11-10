import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    LONG_EDGE,
    SNAP_DISTANCE,
    longEdgeBand,
    longEdges,
    measureRun,
    nearestBoundary,
    regionAround,
    snapPosition,
} from '../src/edges.js';

// A line of RGBA pixels from gray levels.
const line = levels => ({
    data: Uint8Array.from(levels.flatMap(level => [level, level, level, 255])),
    step: 4,
    length: levels.length,
});

test('finds the run of pixels sharing the color under a point', () => {
    const pixels = line([0, 0, 200, 200, 205, 200, 0]);
    assert.deepEqual(regionAround(pixels, 3), {start: 2, end: 6});
    assert.deepEqual(regionAround(pixels, 0), {start: 0, end: 2});
    assert.deepEqual(regionAround(pixels, 6), {start: 6, end: 7});
});

test('reads columns through their row stride', () => {
    const column = {data: Uint8Array.from([9, 9, 9, 0, 9, 9, 9, 0, 90, 90, 90, 0]), step: 4, length: 3};
    assert.deepEqual(regionAround(column, 0), {start: 0, end: 2});
});

test('finds the nearest boundary within a radius', () => {
    const pixels = line([0, 0, 0, 255, 255, 255, 255, 0, 0, 0]);
    assert.equal(nearestBoundary(pixels, 4, 2), 3);
    assert.equal(nearestBoundary(pixels, 5.6, 3), 7);
    assert.equal(nearestBoundary(pixels, 5, 1), null);
    assert.equal(nearestBoundary(pixels, 0, 1), null);
    // Boundaries past the limits are not candidates, even when they are the nearest.
    assert.equal(nearestBoundary(pixels, 4, 2, undefined, {from: 4}), null);
    assert.equal(nearestBoundary(pixels, 6, 3, undefined, {from: 4, to: 7}), 7);
    // A farther boundary inside the limits wins over a nearer one outside them.
    assert.equal(nearestBoundary(pixels, 6, 3, undefined, {to: 6}), 3);
});

// An area of RGBA pixels, `width` x `height`, from a function of (x, y) returning a gray level.
const area = (width, height, level, origin = {x: 0, y: 0}) => {
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            data.fill(level(x, y), i, i + 3);
            data[i + 3] = 255;
        }
    }
    return {data, rowstride: width * 4, channels: 4, width, height, ...origin};
};

// A vertical edge between columns 4 and 5 over rows `from` to `to` (excluded), the rest flat.
const wall = (from, to, height = 60) => area(10, height, (x, y) => (x >= 5 && y >= from && y < to ? 255 : 0));

test('a long edge needs a run of exactly the minimum length', () => {
    assert.deepEqual(longEdges(wall(10, 26), true, 16), [5]);
    assert.deepEqual(longEdges(wall(10, 25), true, 16), []);
    assert.deepEqual(longEdges(wall(0, 16), true, 16), [5]);
    assert.deepEqual(longEdges(wall(44, 60), true, 16), [5]);
    assert.deepEqual(longEdges(wall(45, 60), true, 16), []);
});

test('the minimum run scales: 20 device pixels at 125%, 24 at 150%', () => {
    for (const [scale, run] of [[1.25, 20], [1.5, 24]]) {
        const minRun = Math.ceil(16 * scale);
        assert.equal(minRun, run);
        assert.deepEqual(longEdges(wall(5, 5 + run), true, minRun), [5], `${scale}: ${run} long`);
        assert.deepEqual(longEdges(wall(5, 5 + run - 1), true, minRun), [], `${scale}: ${run - 1} long`);
    }
});

test('an edge counts wherever its run lies, above or below the pointer', () => {
    assert.deepEqual(longEdges(wall(0, 20), true, 16), [5]);
    assert.deepEqual(longEdges(wall(40, 60), true, 16), [5]);
});

test('short edges, such as text, are not long edges', () => {
    // Glyph-like strokes: many separate 6 pixel runs, each cut by a gap, on the same boundary.
    const text = area(10, 60, (x, y) => (x >= 5 && y % 8 < 6 ? 255 : 0));
    assert.deepEqual(longEdges(text, true, 16), []);
});

test('a run broken by one matching pixel is not a run', () => {
    const broken = area(10, 60, (x, y) => (x >= 5 && y !== 20 && y >= 5 && y < 36 ? 255 : 0));
    assert.deepEqual(longEdges(broken, true, 16), []);
    assert.deepEqual(longEdges(broken, true, 15), [5]);
});

test('a difference within the tolerance is not an edge', () => {
    const faint = area(10, 40, x => (x >= 5 ? 12 : 0));
    assert.deepEqual(longEdges(faint, true, 16), []);
    const clear = area(10, 40, x => (x >= 5 ? 13 : 0));
    assert.deepEqual(longEdges(clear, true, 16), [5]);
});

test('a long edge between colors that differ on one channel only is found, whichever channel', () => {
    // The fixtures above are gray: every channel differs at once. Here only one does.
    for (const channel of [0, 1, 2]) {
        const tinted = area(10, 40, () => 0);
        for (let y = 0; y < 40; y++) {
            for (let x = 5; x < 10; x++)
                tinted.data[(y * 10 + x) * 4 + channel] = 13;
        }
        assert.deepEqual(longEdges(tinted, true, 16), [5], `channel ${channel}`);
        assert.deepEqual(longEdges(tinted, false, 16), [], `channel ${channel}, across`);
    }
});

test('boundaries are reported ascending, in the coordinates of the page', () => {
    const two = area(12, 40, x => (x >= 3 ? (x >= 9 ? 0 : 255) : 0), {x: 100, y: 7});
    assert.deepEqual(longEdges(two, true, 16), [103, 109]);
});

test('horizontal long edges run across the columns of a band', () => {
    const band = area(60, 10, (x, y) => (y >= 4 && x >= 20 && x < 45 ? 255 : 0), {x: 3, y: 200});
    assert.deepEqual(longEdges(band, false, 16), [204]);
    assert.deepEqual(longEdges(band, false, 26), []);
});

test('rows are read through the row stride, not the width', () => {
    const padded = area(10, 40, x => (x >= 5 ? 255 : 0));
    const stride = 10 * 4 + 8;
    const data = new Uint8Array(stride * 40).fill(77);
    for (let y = 0; y < 40; y++)
        data.set(padded.data.subarray(y * 40, (y + 1) * 40), y * stride);
    assert.deepEqual(longEdges({...padded, data, rowstride: stride}, true, 16), [5]);
});

test('a long edge competes with the pointer row edge by distance', () => {
    const pixels = line([0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // The row edges are at 5 and 10; a long edge at 14 is farther than 10 from a pointer at 8.
    assert.equal(nearestBoundary(pixels, 8, 6, undefined, {extra: [14]}), 10);
    // Nearer than the row edges: it wins.
    assert.equal(nearestBoundary(pixels, 13, 6, undefined, {extra: [14]}), 14);
    // The row edge wins when it is nearer.
    assert.equal(nearestBoundary(pixels, 11, 6, undefined, {extra: [14]}), 10);
    // Without a row edge in range, a long edge alone snaps.
    assert.equal(nearestBoundary(line([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 4, 6, undefined, {extra: [7]}), 7);
});

test('at equal distance the lower boundary wins, from the row or from the long edges', () => {
    const flat = line(new Array(30).fill(0));
    assert.equal(nearestBoundary(flat, 10, 6, undefined, {extra: [12, 8]}), 8);
    assert.equal(nearestBoundary(flat, 10, 6, undefined, {extra: [8, 12]}), 8);
    const edge = line([...new Array(12).fill(0), ...new Array(18).fill(255)]);
    assert.equal(nearestBoundary(edge, 10, 6, undefined, {extra: [8]}), 8);
    assert.equal(nearestBoundary(edge, 10, 6, undefined, {extra: [9]}), 9);
    const low = line([...new Array(8).fill(0), ...new Array(22).fill(255)]);
    assert.equal(nearestBoundary(low, 10, 6, undefined, {extra: [12]}), 8);
});

test('long edges obey the radius and the bounds of the row edges', () => {
    const flat = line(new Array(40).fill(0));
    assert.equal(nearestBoundary(flat, 20, 6, undefined, {extra: [27]}), null);
    assert.equal(nearestBoundary(flat, 20, 6, undefined, {extra: [26]}), 26);
    assert.equal(nearestBoundary(flat, 20, 6, undefined, {extra: [14, 26]}), 14);
    assert.equal(nearestBoundary(flat, 20, 6, undefined, {extra: [18], from: 19}), null);
    assert.equal(nearestBoundary(flat, 20, 6, undefined, {extra: [22], to: 21}), null);
    assert.equal(nearestBoundary(flat, 20, 6, undefined, {extra: [18, 24], from: 19, to: 23}), null);
    assert.equal(nearestBoundary(flat, 20, 6, undefined, {extra: [0, 40]}), null);
});

test('at a fractional scale the radius is in device pixels', () => {
    const flat = line(new Array(60).fill(0));
    // 6 stage pixels at 1.25 are 7.5 device pixels: 7 reaches, 8 does not.
    assert.equal(nearestBoundary(flat, 30, 6 * 1.25, undefined, {extra: [37]}), 37);
    assert.equal(nearestBoundary(flat, 30, 6 * 1.25, undefined, {extra: [38]}), null);
    assert.equal(nearestBoundary(flat, 30, 6 * 1.5, undefined, {extra: [39]}), 39);
    assert.equal(nearestBoundary(flat, 30, 6 * 1.5, undefined, {extra: [40]}), null);
});

test('a boundary exactly the radius away counts despite the rounding of fractional scales', () => {
    const flat = line(new Array(60).fill(0));
    // A zone at 0.8 and a guide at 19.6 at 125%: device position 25.5 plus a hair, radius 7.5.
    const at125 = (0.8 + 19.6) * 1.25;
    assert.ok(at125 - 6 * 1.25 > 18, 'the float really lands above 18');
    assert.equal(nearestBoundary(flat, at125, 6 * 1.25, undefined, {extra: [18]}), 18);
    const at150 = (2 / 3 + 30) * 1.5;
    assert.equal(nearestBoundary(flat, at150, 6 * 1.5, undefined, {extra: [Math.round(at150 - 9)]}),
        Math.round(at150 - 9));
    // One device pixel farther is still out.
    assert.equal(nearestBoundary(flat, at125, 6 * 1.25, undefined, {extra: [17]}), null);
});

// A line of RGBA pixels from [red, green, blue] triples.
const rgbLine = colors => ({
    data: Uint8Array.from(colors.flatMap(color => [...color, 255])),
    step: 4,
    length: colors.length,
});

test('a boundary between colors that differ on one channel only is found, whichever channel', () => {
    // The gray fixtures above differ on every channel at once.
    for (const channel of [0, 1, 2]) {
        const tint = Array.from({length: 3}, (_, i) => (i === channel ? 13 : 0));
        const pixels = rgbLine([[0, 0, 0], [0, 0, 0], tint, tint]);
        assert.equal(nearestBoundary(pixels, 2, 1), 2, `channel ${channel}`);
        assert.deepEqual(regionAround(pixels, 0), {start: 0, end: 2}, `channel ${channel}`);
    }
});

test('a difference of exactly the tolerance is the same surface, one more is an edge', () => {
    for (const channel of [0, 1, 2]) {
        const color = level => Array.from({length: 3}, (_, i) => (i === channel ? level : 100));
        const same = rgbLine([color(100), color(100), color(112), color(112)]);
        assert.equal(nearestBoundary(same, 2, 1), null, `channel ${channel}`);
        assert.deepEqual(regionAround(same, 0), {start: 0, end: 4}, `channel ${channel}`);
        const edge = rgbLine([color(100), color(100), color(113), color(113)]);
        assert.equal(nearestBoundary(edge, 2, 1), 2, `channel ${channel}`);
        assert.deepEqual(regionAround(edge, 0), {start: 0, end: 2}, `channel ${channel}`);
    }
});

test('a region is judged against the pixel under the point, so a gradient does not run on forever', () => {
    // Each step is within the tolerance of its neighbor, but not of the pixel under the point.
    const ramp = line([0, 10, 20, 30, 40, 50, 60]);
    assert.deepEqual(regionAround(ramp, 3), {start: 2, end: 5});
    assert.deepEqual(regionAround(ramp, 0), {start: 0, end: 2});
});

test('a region reaches both ends of the line', () => {
    const flat = line([7, 7, 7, 7]);
    for (const index of [0, 1, 3])
        assert.deepEqual(regionAround(flat, index), {start: 0, end: 4}, `from ${index}`);
});

// An area of the capture with a vertical edge at the device boundary `edge`, down its whole height.
const captured = ({x, y, width, height}, edge) =>
    area(width, height, column => (x + column >= edge ? 255 : 0), {x, y});

test('a guide reads the band of long edges within the snapping distance, a pixel before the first', () => {
    const along = {origin: 0, length: 1000};
    const across = {origin: 10, length: 500};
    assert.deepEqual(longEdgeBand(100, 1, along, across, true),
        {x: 93, y: 10, width: 14, height: 500, minRun: 16});
    assert.deepEqual(longEdgeBand(100, 1, along, across, false),
        {x: 10, y: 93, width: 500, height: 14, minRun: 16});
    assert.equal(SNAP_DISTANCE, 6);
    assert.equal(LONG_EDGE, 16);
});

test('a long edge exactly the snapping distance away, on either side, is in the band and found', () => {
    for (const scale of [1, 1.25, 1.5, 2]) {
        // 106 ± 6 lands on whole device pixels at each of these scales.
        const band = longEdgeBand(106, scale, {origin: 0, length: 1000}, {origin: 0, length: 200},
            true);
        for (const stage of [106 - SNAP_DISTANCE, 106 + SNAP_DISTANCE]) {
            const edge = stage * scale;
            const found = longEdges(captured(band, edge), true, band.minRun);
            assert.deepEqual(found, [edge], `${stage} at ${scale}`);
            const bounds = {origin: 0, length: 1000};
            assert.equal(snapPosition({data: [], step: 0, length: 4000}, scale, 106, bounds,
                [edge]), stage, `snaps to ${stage} at ${scale}`);
        }
    }
});

test('the run that makes an edge long scales with the screen: 20 device pixels at 125%, 24 at 150%', () => {
    const run = scale =>
        longEdgeBand(100, scale, {origin: 0, length: 1000}, {origin: 0, length: 500}, true).minRun;
    assert.deepEqual([1, 1.25, 1.5, 1.75, 2].map(run), [16, 20, 24, 28, 32]);
    // 16 × 1.1 is 17.6 device pixels: a run of 17 is shorter than 16 stage pixels.
    assert.equal(run(1.1), 18);
});

test('the band covers only whole device pixels across the zone, despite float noise', () => {
    // 50 × 1.1 is 55.00000000000001: the zone still starts on device pixel 55, not 56.
    const band = longEdgeBand(100, 1.1, {origin: 0, length: 1000}, {origin: 50, length: 100}, true);
    assert.equal(band.y, 55);
    assert.equal(band.height, 110);
    // 100 × 1.15 is 114.99999999999999: the zone still ends on boundary 115.
    const noisy = longEdgeBand(100, 1.15, {origin: 0, length: 1000}, {origin: 0, length: 100}, true);
    assert.equal(noisy.height, 115);
    // A zone that starts partway through a device pixel starts on the next one across, even
    // when it covers less than half of it.
    const across = origin =>
        longEdgeBand(100, 1.25, {origin: 0, length: 1000}, {origin, length: 100}, true).y;
    assert.equal(across(10.2), 13);
    assert.equal(across(9.9), 13);
});

test('along the guide, the band stops at the zone, halves rounding outward', () => {
    // The zone starts at stage 90, device 112.5: boundary 112 still counts, as for row edges.
    const band = longEdgeBand(95, 1.25, {origin: 90, length: 20}, {origin: 0, length: 100}, true);
    assert.equal(band.x, 111);
    // It ends at stage 110, device 137.5: boundary 138 counts.
    const end = longEdgeBand(105, 1.25, {origin: 90, length: 20}, {origin: 0, length: 100}, true);
    assert.equal(end.x + end.width - 1, 138);
    // The snapping distance itself, despite float noise: 50 × 1.1 is 55.00000000000001, and
    // 100 × 1.15 is 114.99999999999999; boundaries 55 and 115 are exactly 6 stage pixels away.
    assert.equal(longEdgeBand(56, 1.1, {origin: 0, length: 1000}, {origin: 0, length: 100}, true).x, 54);
    const far = longEdgeBand(94, 1.15, {origin: 0, length: 1000}, {origin: 0, length: 100}, true);
    assert.equal(far.x + far.width - 1, 115);
    // A guide farther than the snapping distance from the zone reads nothing.
    assert.equal(longEdgeBand(200, 1, {origin: 0, length: 100}, {origin: 0, length: 100}, true), null);
    assert.equal(longEdgeBand(50, 1, {origin: 0, length: 100}, {origin: 0, length: 0}, true), null);
});

test('a snapped position is the boundary in stage pixels, not rounded to a whole stage pixel', () => {
    const edge = line([...Array(112).fill(0), ...Array(100).fill(255)]);
    assert.equal(snapPosition(edge, 1.25, 92, {origin: 0, length: 1000}), 89.6);
    assert.equal(snapPosition(edge, 1, 115, {origin: 0, length: 1000}), 112);
    // Nothing within the snapping distance: the position stays.
    assert.equal(snapPosition(edge, 1, 119, {origin: 0, length: 1000}), 119);
});

test('a snapped position stays in the zone, halves of a device pixel rounding outward', () => {
    // At 125% the zone starts at stage 90, device 112.5: boundary 112 is in, 111 out.
    const at = boundary => line([...Array(boundary).fill(0), ...Array(300 - boundary).fill(255)]);
    assert.equal(snapPosition(at(112), 1.25, 91, {origin: 90, length: 20}), 89.6);
    assert.equal(snapPosition(at(111), 1.25, 91, {origin: 90, length: 20}), 91);
    // It ends at stage 110, device 137.5: boundary 138 is in, 139 out.
    assert.equal(snapPosition(at(138), 1.25, 109, {origin: 90, length: 20}), 110.4);
    assert.equal(snapPosition(at(139), 1.25, 109, {origin: 90, length: 20}), 109);
});

test('an area runs over the same color around the pointer pixel, up to the pointer\'s last pixel', () => {
    // A block from device pixel 10 to 19, between two others.
    const block = line([...Array(10).fill(0), ...Array(10).fill(200), ...Array(10).fill(0)]);
    const whole = {origin: 0, length: 30};
    assert.deepEqual(measureRun(block, 15, 1, whole), {start: 10, end: 20});
    // The pointer on the block's last pixel, at 100% and at 125%: still the block.
    assert.deepEqual(measureRun(block, 19.9, 1, whole), {start: 10, end: 20});
    assert.deepEqual(measureRun(block, 15.9, 1.25, whole), {start: 8, end: 16});
    // The pointer on the next pixel measures the next block.
    assert.deepEqual(measureRun(block, 20, 1, whole), {start: 20, end: 30});
});

test('an area stops at the zone, rounded to the nearest device pixel', () => {
    const flat = line(Array(60).fill(90));
    assert.deepEqual(measureRun(flat, 20, 1, {origin: 12, length: 5}), {start: 12, end: 17});
    // At 125% a zone from stage 10.2 to 30.2 is device 12.75 to 37.75: pixels 13 to 38.
    assert.deepEqual(measureRun(flat, 20, 1.25, {origin: 10.2, length: 20}), {start: 10.4, end: 30.4});
    // A zone from stage 10.32 starts at device 12.9: pixel 13 too, not 12.
    assert.deepEqual(measureRun(flat, 20, 1.25, {origin: 10.32, length: 20}).start, 10.4);
    // One ending at stage 29.8, device 37.25, ends on boundary 37, not 38.
    assert.equal(measureRun(flat, 20, 1.25, {origin: 10.2, length: 19.6}).end, 29.6);
});

test('an area outside the zone is empty, where the pointer is', () => {
    const block = line([...Array(10).fill(0), ...Array(10).fill(200)]);
    assert.deepEqual(measureRun(block, 15, 1, {origin: 0, length: 8}), {start: 10, end: 10});
});
