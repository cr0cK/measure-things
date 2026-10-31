import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    columnGrid,
    cursorFor,
    dragHelper,
    guideGaps,
    hitTest,
    isLogicalLayout,
    labelAnchor,
    monitorAt,
    parseHelpers,
    pixelRatios,
    rectangleGaps,
    rectFromPoints,
    serializeHelpers,
    snapHelper,
} from '../src/geometry.js';

const rect = (x, y, width, height, id = 1) => ({id, kind: 'rectangle', x, y, width, height});

test('parses stored helpers, drops invalid ones, and assigns ids', () => {
    const helpers = parseHelpers(JSON.stringify([
        {kind: 'vertical', x: 120.4},
        {kind: 'horizontal', y: 'top'},
        {kind: 'rectangle', x: 1, y: 2, width: 0, height: 5},
        {kind: 'rectangle', x: 1, y: 2, width: 30, height: 5},
        {kind: 'circle', x: 3},
        null,
    ]));
    assert.deepEqual(helpers, [
        {id: 1, kind: 'vertical', x: 120},
        {id: 2, kind: 'rectangle', x: 1, y: 2, width: 30, height: 5},
    ]);
});

test('reads malformed storage as an empty list', () => {
    assert.deepEqual(parseHelpers('not json'), []);
    assert.deepEqual(parseHelpers('{"kind":"vertical"}'), []);
});

test('serializes helpers without runtime ids', () => {
    const text = serializeHelpers([{id: 7, kind: 'horizontal', y: 40}]);
    assert.equal(text, '[{"kind":"horizontal","y":40}]');
    assert.deepEqual(parseHelpers(text), [{id: 1, kind: 'horizontal', y: 40}]);
});

test('builds a rectangle from corners in any order', () => {
    assert.deepEqual(rectFromPoints(50, 80, 10, 20), {x: 10, y: 20, width: 40, height: 60});
});

test('hits guides within the tolerance', () => {
    const helpers = [{id: 1, kind: 'vertical', x: 100}, {id: 2, kind: 'horizontal', y: 50}];
    assert.deepEqual(hitTest(helpers, 103, 400), {id: 1, part: 'move'});
    assert.deepEqual(hitTest(helpers, 300, 46), {id: 2, part: 'move'});
    assert.equal(hitTest(helpers, 105, 400), null);
});

test('names rectangle edges, corners, and inside', () => {
    const helpers = [rect(100, 100, 200, 100)];
    assert.deepEqual(hitTest(helpers, 101, 150), {id: 1, part: 'left'});
    assert.deepEqual(hitTest(helpers, 299, 202), {id: 1, part: 'bottom-right'});
    assert.deepEqual(hitTest(helpers, 200, 99), {id: 1, part: 'top'});
    assert.deepEqual(hitTest(helpers, 200, 150), {id: 1, part: 'inside'});
    assert.equal(hitTest(helpers, 200, 220), null);
});

test('prefers the topmost helper', () => {
    const helpers = [rect(0, 0, 100, 100, 1), rect(50, 50, 100, 100, 2)];
    assert.equal(hitTest(helpers, 75, 75).id, 2);
});

test('moves guides along their axis only', () => {
    assert.deepEqual(dragHelper({id: 1, kind: 'vertical', x: 10}, 'move', 5, 9),
        {id: 1, kind: 'vertical', x: 15});
    assert.deepEqual(dragHelper({id: 1, kind: 'horizontal', y: 10}, 'move', 5, 9),
        {id: 1, kind: 'horizontal', y: 19});
});

test('moves and resizes rectangles', () => {
    const origin = rect(100, 100, 200, 100);
    assert.deepEqual(dragHelper(origin, 'inside', -10, 5), rect(90, 105, 200, 100));
    assert.deepEqual(dragHelper(origin, 'top-left', 20, 30), rect(120, 130, 180, 70));
    assert.deepEqual(dragHelper(origin, 'right', -50, 999), rect(100, 100, 150, 100));
});

test('flips a rectangle dragged past its opposite edge and keeps it visible', () => {
    const origin = rect(100, 100, 200, 100);
    assert.deepEqual(dragHelper(origin, 'left', 250, 0), rect(300, 100, 50, 100));
    assert.deepEqual(dragHelper(origin, 'bottom', 0, -100), rect(100, 100, 200, 1));
});

test('maps parts to Meta cursor names', () => {
    assert.equal(cursorFor('vertical', 'move'), 'EW_RESIZE');
    assert.equal(cursorFor('rectangle', 'bottom-left'), 'SW_RESIZE');
    assert.equal(cursorFor('rectangle', 'inside'), 'MOVE');
});

test('measures gaps between neighboring parallel guides', () => {
    const gaps = guideGaps([
        {kind: 'vertical', x: 300},
        {kind: 'vertical', x: 100},
        {kind: 'vertical', x: 100},
        {kind: 'horizontal', y: 40},
        rect(0, 0, 10, 10),
    ]);
    assert.deepEqual(gaps, [{axis: 'x', from: 100, to: 300}]);
});

test('lays out a full-width grid', () => {
    const grid = columnGrid({width: 1000, columns: 4, gutter: 20, margin: 30, maxWidth: 0});
    assert.deepEqual(grid.map(c => c.x), [30, 270, 510, 750]);
    assert.ok(grid.every(c => c.width === 220));
});

test('centers a grid capped by its max width', () => {
    const grid = columnGrid({width: 1600, columns: 2, gutter: 0, margin: 0, maxWidth: 1200});
    assert.deepEqual(grid, [{x: 200, width: 600}, {x: 800, width: 600}]);
});

test('returns no columns when gutters and margins fill the width', () => {
    assert.deepEqual(columnGrid({width: 100, columns: 12, gutter: 10, margin: 0, maxWidth: 0}), []);
});

test('converts stage pixels in logical and physical layout modes', () => {
    assert.deepEqual(pixelRatios(1.25, true), {css: 1, device: 1.25});
    assert.deepEqual(pixelRatios(2, false), {css: 0.5, device: 1});
    assert.deepEqual(pixelRatios(1, false), {css: 1, device: 1});
});

test('divides CSS pixels by the browser zoom only', () => {
    assert.deepEqual(pixelRatios(1.25, true, 1.25), {css: 0.8, device: 1.25});
    assert.deepEqual(pixelRatios(2, false, 2), {css: 0.25, device: 1});
});

test('reads the layout mode from Mutter experimental features', () => {
    assert.equal(isLogicalLayout(['scale-monitor-framebuffer', 'xwayland-native-scaling']), true);
    assert.equal(isLogicalLayout(['xwayland-native-scaling']), false);
    assert.equal(isLogicalLayout([]), false);
});

test('finds the monitor under a point, or the nearest one', () => {
    const monitors = [{x: 0, y: 0, width: 1920, height: 1080}, {x: 1920, y: 0, width: 1280, height: 720}];
    assert.equal(monitorAt(monitors, 1919, 500), 0);
    assert.equal(monitorAt(monitors, 2000, 100), 1);
    assert.equal(monitorAt(monitors, 3100, 900), 1);
});

test('anchors guide labels on the edge of the outermost crossed monitor', () => {
    const monitors = [{x: 0, y: 300, width: 1920, height: 1080}, {x: 1920, y: 0, width: 1280, height: 720}];
    assert.deepEqual(labelAnchor(monitors, 'vertical', 2000), {monitor: 1, edge: 0});
    assert.deepEqual(labelAnchor(monitors, 'horizontal', 400), {monitor: 0, edge: 0});
    assert.deepEqual(labelAnchor(monitors, 'horizontal', 100), {monitor: 1, edge: 1920});
    assert.deepEqual(labelAnchor(monitors, 'vertical', 9000), {monitor: -1, edge: 0});
});

test('measures a rectangle to its nearest neighbor on each side', () => {
    const helpers = [
        rect(100, 100, 100, 50, 1),
        rect(260, 120, 40, 100, 2),
        rect(230, 0, 10, 140, 3),
        {id: 4, kind: 'vertical', x: 40},
        {id: 5, kind: 'horizontal', y: 400},
        {id: 6, kind: 'horizontal', y: 300},
        rect(0, 300, 50, 50, 7),
    ];
    assert.deepEqual(rectangleGaps(helpers, 1), [
        {axis: 'x', from: 40, to: 100, at: 125},
        {axis: 'x', from: 200, to: 230, at: 120},
        {axis: 'y', from: 150, to: 300, at: 150},
    ]);
});

test('gives no gap to touching or overlapping neighbors, or without a selected rectangle', () => {
    const helpers = [rect(0, 0, 100, 100, 1), rect(100, 0, 50, 50, 2), rect(50, 50, 100, 100, 3)];
    assert.deepEqual(rectangleGaps(helpers, 1), []);
    assert.deepEqual(rectangleGaps([{id: 1, kind: 'vertical', x: 3}], 1), []);
    assert.deepEqual(rectangleGaps(helpers, 9), []);
});

test('snaps the moving edges of a dragged helper', () => {
    const snap = value => (Math.abs(value - 200) <= 5 ? 200 : value);
    assert.deepEqual(snapHelper({id: 1, kind: 'vertical', x: 197}, 'move', snap, snap),
        {id: 1, kind: 'vertical', x: 200});
    assert.deepEqual(snapHelper(rect(100, 100, 98, 103), 'bottom-right', snap, snap), rect(100, 100, 100, 100));
    assert.deepEqual(snapHelper(rect(198, 198, 50, 50), 'left', snap, snap), rect(200, 198, 48, 50));
    assert.deepEqual(snapHelper(rect(198, 198, 50, 50), 'inside', snap, snap), rect(198, 198, 50, 50));
});
