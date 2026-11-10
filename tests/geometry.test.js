import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    columnGrid,
    cursorFor,
    dragHelper,
    ARROW_LENGTH,
    ARROW_MIN_GAP,
    ARROW_WIDTH,
    gapArrowheads,
    guideGaps,
    hitTest,
    highestScaleMonitor,
    isInZone,
    isLogicalLayout,
    monitorAt,
    rectangleGaps,
    rectFromPoints,
    scaleHelper,
    surfaceOffset,
    targetAt,
    windowRole,
} from '../src/geometry.js';

const rect = (x, y, width, height, id = 1) => ({id, kind: 'rectangle', x, y, width, height});

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

test('snaps the dragged guide or edges of a helper', () => {
    const snap = value => (Math.abs(value - 200) <= 5 ? 200 : value);
    assert.deepEqual(dragHelper({id: 1, kind: 'vertical', x: 190}, 'move', 7, 0, snap, snap),
        {id: 1, kind: 'vertical', x: 200});
    assert.deepEqual(dragHelper(rect(100, 100, 90, 90), 'bottom-right', 8, 13, snap, snap),
        rect(100, 100, 100, 100));
    assert.deepEqual(dragHelper(rect(190, 190, 50, 50), 'left', 8, 0, snap, snap), rect(200, 190, 40, 50));
    assert.deepEqual(dragHelper(rect(190, 190, 50, 50), 'inside', 8, 8, snap, snap), rect(198, 198, 50, 50));
});

test('snaps the dragged edge, not the fixed one, when a resize flips the rectangle', () => {
    const snap = value => (Math.abs(value - 252) <= 5 ? 252 : Math.abs(value - 198) <= 5 ? 198 : value);
    assert.deepEqual(dragHelper(rect(100, 100, 100, 50), 'left', 150, 0, snap, snap), rect(200, 100, 52, 50));
});

test('scales every coordinate of a helper', () => {
    assert.deepEqual(scaleHelper(rect(10, 20, 30, 41), 1.25), {id: 1, kind: 'rectangle', x: 12.5, y: 25, width: 37.5, height: 51.25});
    assert.deepEqual(scaleHelper({id: 2, kind: 'vertical', x: 10}, 1 / 3, Math.round), {id: 2, kind: 'vertical', x: 3});
});

test('picks the highest-scale monitor a window touches, the first on ties', () => {
    const monitors = [
        {x: 0, y: 0, width: 1600, height: 1000, geometry_scale: 1},
        {x: 1600, y: 0, width: 1280, height: 800, geometry_scale: 1.25},
        {x: 2880, y: 0, width: 1280, height: 800, geometry_scale: 1.25},
    ];
    assert.equal(highestScaleMonitor(monitors, {x: 100, y: 100, width: 600, height: 400}), 0);
    assert.equal(highestScaleMonitor(monitors, {x: 1500, y: 100, width: 600, height: 400}), 1);
    assert.equal(highestScaleMonitor(monitors, {x: 1700, y: 100, width: 1600, height: 400}), 1);
    assert.equal(highestScaleMonitor(monitors, {x: 5000, y: 0, width: 10, height: 10}), -1);
});

test('moves surfaces onto the device pixels of their monitor', () => {
    // At 125%, 187 stage pixels from the monitor are 233.75 device pixels: rounded to 234.
    assert.ok(Math.abs(surfaceOffset(187, 0, 1.25) - 0.2) < 1e-9);
    assert.ok(Math.abs(surfaceOffset(1789, 1600, 1.25) + 0.2) < 1e-9);
    assert.equal(surfaceOffset(188, 0, 1.25), 0);
    assert.equal(surfaceOffset(301, 0, 1), 0);
});

test('targets the topmost window under a point, unless something blocks it', () => {
    const windows = [
        {rect: {x: 0, y: 0, width: 1600, height: 32}, role: 'ignore'},
        {rect: {x: 120, y: 180, width: 200, height: 200}, role: 'blocker'},
        {rect: {x: 100, y: 100, width: 600, height: 400}, role: 'window'},
        {rect: {x: 0, y: 0, width: 1600, height: 1000}, role: 'window'},
    ];
    assert.equal(targetAt(windows, 400, 300), 2);
    assert.equal(targetAt(windows, 150, 200), -1);
    assert.equal(targetAt(windows, 10, 10), 3);
    assert.equal(targetAt(windows, 700, 300), 3);
    assert.equal(targetAt(windows, 1600, 300), -1);
});

test('classifies every window type as a target, a blocker, or transparent', () => {
    // Every Meta.WindowType member.
    const expected = {
        NORMAL: 'window',
        DIALOG: 'window',
        MODAL_DIALOG: 'window',
        UTILITY: 'window',
        MENU: 'blocker',
        DROPDOWN_MENU: 'blocker',
        POPUP_MENU: 'blocker',
        TOOLTIP: 'blocker',
        COMBO: 'blocker',
        OVERRIDE_OTHER: 'blocker',
        DESKTOP: 'ignore',
        DOCK: 'ignore',
        TOOLBAR: 'ignore',
        SPLASHSCREEN: 'ignore',
        NOTIFICATION: 'ignore',
        DND: 'ignore',
    };
    assert.equal(Object.keys(expected).length, 16);
    for (const [type, role] of Object.entries(expected))
        assert.equal(windowRole(type), role, type);
});

test('lets an override-redirect window block whatever its type', () => {
    assert.equal(windowRole('NORMAL', true), 'blocker');
    assert.equal(windowRole('DOCK', true), 'blocker');
});

test('hides the helpers outside a zone, and keeps those that intersect it', () => {
    const inside = helper => isInZone(helper, {x: 0, y: 0, width: 300, height: 200});
    assert.deepEqual([0, 299, 300, -1].map(x => inside({kind: 'vertical', x})), [true, true, false, false]);
    assert.deepEqual([0, 199, 200, -1].map(y => inside({kind: 'horizontal', y})), [true, true, false, false]);
    assert.equal(inside(rect(-50, 10, 60, 5)), true);
    assert.equal(inside(rect(-50, 10, 50, 5)), false);
    assert.equal(inside(rect(10, 200, 5, 5)), false);
    assert.equal(inside(rect(299, 199, 50, 50)), true);
});

test('hides the helpers outside the visible part of a zone that starts before the frame', () => {
    const visible = {x: 100, y: 50, width: 200, height: 100};
    const inside = helper => isInZone(helper, visible);
    assert.deepEqual([99, 100, 299, 300].map(x => inside({kind: 'vertical', x})), [false, true, true, false]);
    assert.deepEqual([49, 50, 149, 150].map(y => inside({kind: 'horizontal', y})), [false, true, true, false]);
    assert.equal(inside(rect(0, 60, 100, 10)), false);
    assert.equal(inside(rect(0, 60, 101, 10)), true);
});

test('ends a horizontal-running distance line in an arrowhead at each end, tips on the edges', () => {
    const heads = gapArrowheads({axis: 'x', from: 100, to: 300}, 40.5);
    assert.deepEqual(heads, [
        [[100, 40.5], [105, 38], [105, 43]],
        [[300, 40.5], [295, 38], [295, 43]],
    ]);
});

test('ends a vertical-running distance line in an arrowhead at each end, tips on the edges', () => {
    const heads = gapArrowheads({axis: 'y', from: 50, to: 250}, 20);
    assert.deepEqual(heads, [
        [[20, 50], [17.5, 55], [22.5, 55]],
        [[20, 250], [17.5, 245], [22.5, 245]],
    ]);
});

test('sizes arrowheads 5 long and 5 wide, whatever the axis or the line length', () => {
    for (const axis of ['x', 'y']) {
        for (const length of [12, 12.5, 40, 4000]) {
            const heads = gapArrowheads({axis, from: 10, to: 10 + length}, 7);
            assert.equal(heads.length, 2);
            const [along, across] = axis === 'x' ? [0, 1] : [1, 0];
            for (const [tip, a, b] of heads) {
                assert.equal(Math.abs(a[along] - tip[along]), ARROW_LENGTH);
                assert.equal(a[along], b[along]);
                assert.equal(Math.abs(a[across] - b[across]), ARROW_WIDTH);
                assert.equal(tip[across], 7);
                assert.equal((a[across] + b[across]) / 2, 7);
            }
            assert.equal(heads[0][0][along], 10);
            assert.equal(heads[1][0][along], 10 + length);
        }
    }
});

test('gives a distance line no arrowheads below 12 stage pixels, and some from 12', () => {
    assert.equal(ARROW_MIN_GAP, 12);
    assert.deepEqual(gapArrowheads({axis: 'x', from: 0, to: 11.99}, 0), []);
    assert.deepEqual(gapArrowheads({axis: 'y', from: 5, to: 16.99}, 0), []);
    assert.deepEqual(gapArrowheads({axis: 'x', from: 0, to: 0}, 0), []);
    assert.equal(gapArrowheads({axis: 'x', from: 0, to: 12}, 0).length, 2);
    assert.equal(gapArrowheads({axis: 'y', from: 5, to: 17}, 0).length, 2);
});

test('keeps arrowheads in stage pixels at fractional scales and zoom, tips on the stage edges', () => {
    // At 125% and 150%, a guide sits at a fractional stage position; a zoom stretches the gap but
    // not the arrowheads. The line is one device pixel thick, so its center is half of it past `at`.
    for (const scale of [1.25, 1.5]) {
        for (const zoom of [0.5, 1, 2.5]) {
            const from = 100.4 * zoom;
            const to = 300.8 * zoom;
            const center = 33 + 0.5 / scale;
            const [first, second] = gapArrowheads({axis: 'x', from, to}, center);
            assert.deepEqual(first[0], [from, center]);
            assert.deepEqual(second[0], [to, center]);
            assert.equal(first[1][0] - from, ARROW_LENGTH);
            assert.equal(to - second[1][0], ARROW_LENGTH);
        }
    }
    // A 12 stage pixel gap is 12 / zoom CSS pixels: the threshold is on the stage, not on CSS.
    assert.equal(gapArrowheads({axis: 'x', from: 0, to: 6 * 2}, 0).length, 2);
    assert.equal(gapArrowheads({axis: 'x', from: 0, to: 8 * 1.25}, 0).length, 0);
    assert.equal(gapArrowheads({axis: 'x', from: 0, to: 8 * 1.5}, 0).length, 2);
});
