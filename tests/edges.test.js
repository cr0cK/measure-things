import assert from 'node:assert/strict';
import {test} from 'node:test';

import {longEdges, nearestBoundary, regionAround} from '../src/edges.js';

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
