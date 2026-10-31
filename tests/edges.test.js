import assert from 'node:assert/strict';
import {test} from 'node:test';

import {nearestBoundary, regionAround} from '../src/edges.js';

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
});
