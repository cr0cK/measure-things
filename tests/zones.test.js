import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    MIN_ZONE,
    covers,
    dragEdge,
    edgeAt,
    intersect,
    pickHit,
    pixelRange,
    placeBadges,
    stackOrder,
    storedZone,
    targetZone,
    zoneEntry,
    zoneRects,
} from '../src/zones.js';

const frame = {width: 800, height: 600};
const rect = (x, y, width, height) => ({x, y, width, height});

test('intersects rectangles, and gives null when they only touch or miss', () => {
    assert.deepEqual(intersect(rect(0, 0, 10, 10), rect(5, 5, 10, 10)), rect(5, 5, 5, 5));
    assert.equal(intersect(rect(0, 0, 10, 10), rect(10, 0, 5, 5)), null);
    assert.equal(intersect(rect(0, 0, 10, 10), rect(20, 20, 5, 5)), null);
});

test('an automatic zone is the whole frame, and a fixed one keeps its place in it', () => {
    assert.deepEqual(zoneRects(frame, null, 1.25),
        {rect: rect(0, 0, 800, 600), visible: rect(0, 0, 800, 600)});
    const fixed = zoneRects(frame, {x: 200, y: 0, width: 600, height: 480}, 1);
    assert.deepEqual(fixed.visible, rect(200, 0, 600, 480));
    // The window shrank: the zone keeps its position and size, and shows its part in the frame.
    const shrunk = zoneRects({width: 500, height: 300}, {x: 200, y: 0, width: 600, height: 480}, 1);
    assert.deepEqual(shrunk.rect, rect(200, 0, 600, 480));
    assert.deepEqual(shrunk.visible, rect(200, 0, 300, 300));
    const gone = zoneRects({width: 150, height: 300}, {x: 200, y: 0, width: 600, height: 480}, 1);
    assert.equal(gone.visible, null);
});

test('a zone is stored in whole stage pixels, in the actor units', () => {
    assert.deepEqual(storedZone(rect(100.4, 20.6, 300.5, 200), 1.25),
        {x: 100 / 1.25, y: 21 / 1.25, width: 301 / 1.25, height: 160});
});

test('finds the zone edge under a point, along its whole length', () => {
    const zone = rect(100, 50, 300, 200);
    assert.equal(edgeAt(zone, 102, 150), 'left');
    assert.equal(edgeAt(zone, 404, 60), 'right');
    assert.equal(edgeAt(zone, 250, 46), 'top');
    assert.equal(edgeAt(zone, 350, 254), 'bottom');
    assert.equal(edgeAt(zone, 250, 150), null);
    assert.equal(edgeAt(zone, 90, 150), null);
    // Near the end of the edge, not past it.
    assert.equal(edgeAt(zone, 100, 253), 'left');
    assert.equal(edgeAt(zone, 100, 260), null);
    // The nearest edge wins at a corner.
    assert.equal(edgeAt(zone, 101, 52), 'left');
    assert.equal(edgeAt(zone, 103, 51), 'top');
});

test('dragging an edge moves only that edge', () => {
    const zone = rect(100, 50, 300, 200);
    assert.deepEqual(dragEdge(zone, 'left', 150, frame), rect(150, 50, 250, 200));
    assert.deepEqual(dragEdge(zone, 'right', 500, frame), rect(100, 50, 400, 200));
    assert.deepEqual(dragEdge(zone, 'top', 20, frame), rect(100, 20, 300, 230));
    assert.deepEqual(dragEdge(zone, 'bottom', 300, frame), rect(100, 50, 300, 250));
});

test('a dragged edge stays in the frame and keeps the 40 pixel minimum', () => {
    const zone = rect(100, 50, 300, 200);
    assert.equal(MIN_ZONE, 40);
    assert.deepEqual(dragEdge(zone, 'left', -30, frame), rect(0, 50, 400, 200));
    assert.deepEqual(dragEdge(zone, 'left', 390, frame), rect(360, 50, 40, 200));
    assert.deepEqual(dragEdge(zone, 'right', 90, frame), rect(100, 50, 40, 200));
    assert.deepEqual(dragEdge(zone, 'right', 9000, frame), rect(100, 50, 700, 200));
    assert.deepEqual(dragEdge(zone, 'top', 249, frame), rect(100, 210, 300, 40));
    assert.deepEqual(dragEdge(zone, 'bottom', 9000, frame), rect(100, 50, 300, 550));
});

test('a frame smaller than the minimum is the whole zone', () => {
    const small = {width: 30, height: 600};
    assert.deepEqual(dragEdge(rect(0, 0, 30, 600), 'left', 20, small), rect(0, 0, 30, 600));
    assert.deepEqual(dragEdge(rect(0, 100, 30, 300), 'bottom', 120, small), rect(0, 100, 30, 40));
});

test('a zone mostly outside the frame comes back inside when an edge is dragged', () => {
    assert.deepEqual(dragEdge(rect(780, 0, 600, 600), 'top', 10, frame), rect(760, 10, 40, 590));
    assert.deepEqual(dragEdge(rect(-500, 0, 520, 600), 'right', 300, frame), rect(0, 0, 300, 600));
});

test('targets the smallest zone under a point, the newest on equal sizes', () => {
    const entries = [
        zoneEntry('whole', rect(0, 0, 800, 600), 1),
        zoneEntry('right', rect(400, 0, 400, 600), 2),
        zoneEntry('rightNew', rect(400, 0, 400, 600), 3),
        zoneEntry('gone', null, 4),
    ];
    assert.equal(targetZone(entries, 100, 100), 'whole');
    assert.equal(targetZone(entries, 500, 100), 'rightNew');
    assert.equal(targetZone(entries.slice(0, 2), 500, 100), 'right');
    assert.equal(targetZone(entries, 800, 100), null);
    assert.equal(targetZone([entries[3]], 100, 100), null);
});

test('stacks the largest zone at the bottom and the newest on top of equal ones', () => {
    assert.deepEqual(stackOrder([
        {id: 'small', area: 10, seq: 1},
        {id: 'new', area: 100, seq: 4},
        {id: 'old', area: 100, seq: 2},
        {id: 'big', area: 500, seq: 3},
    ]), ['big', 'old', 'new', 'small']);
});

const flags = classes => Object.fromEntries(classes.map(name => [name, true]));
const hit = (id, area, seq, ...classes) => ({id, area, seq, ...flags(classes)});

test('a press goes to a badge first, then an edge, then a helper, then the zone', () => {
    const entries = [
        hit('a', 100, 1, 'zone', 'helper'),
        hit('b', 50, 2, 'edge'),
        hit('c', 400, 3, 'badge', 'helper'),
    ];
    assert.deepEqual(pickHit(entries), {id: 'c', kind: 'badge'});
    assert.deepEqual(pickHit(entries.slice(0, 2)), {id: 'b', kind: 'edge'});
    assert.deepEqual(pickHit([entries[0]]), {id: 'a', kind: 'helper'});
    assert.deepEqual(pickHit([hit('d', 1, 1, 'zone')]), {id: 'd', kind: 'zone'});
    assert.equal(pickHit([hit('e', 1, 1)]), null);
    assert.equal(pickHit([]), null);
});

test('the edge of a larger zone can be dragged from inside a smaller one', () => {
    const large = hit('large', 1000, 1, 'edge');
    const small = hit('small', 100, 2, 'zone');
    assert.deepEqual(pickHit([large, small]), {id: 'large', kind: 'edge'});
});

test('among equal hits the view targeted last wins, then the smaller zone, then the newer', () => {
    const entries = [hit('big', 1000, 1, 'edge'), hit('small', 100, 2, 'edge'), hit('newer', 100, 3, 'edge')];
    assert.equal(pickHit(entries, 'big').id, 'big');
    assert.equal(pickHit(entries, 'small').id, 'small');
    assert.equal(pickHit(entries).id, 'newer');
    assert.equal(pickHit(entries.slice(0, 2)).id, 'small');
    // A last-targeted view that is not in the class does not count.
    assert.equal(pickHit([hit('a', 5, 1, 'helper'), hit('b', 5, 2, 'helper')], 'z').id, 'b');
    // The zone is the one targeting picks, whatever was targeted last.
    assert.equal(pickHit([hit('a', 5, 1, 'zone')], 'b').id, 'a');
});

test('badges sit in the corner of their zone, and shift left when they overlap', () => {
    const badge = {width: 80, height: 20, right: 800, bottom: 600};
    assert.deepEqual(placeBadges([badge]), [{x: 712, y: 572}]);
    assert.deepEqual(placeBadges([badge, badge, badge]),
        [{x: 712, y: 572}, {x: 628, y: 572}, {x: 544, y: 572}]);
    // Badges in different zones do not touch.
    assert.deepEqual(placeBadges([badge, {...badge, right: 400}]),
        [{x: 712, y: 572}, {x: 312, y: 572}]);
});

test('a badge that would cross the left edge starts a row above', () => {
    const badge = {width: 80, height: 20, right: 200, bottom: 600};
    assert.deepEqual(placeBadges([badge, badge, badge]),
        [{x: 112, y: 572}, {x: 28, y: 572}, {x: 112, y: 548}]);
});

test('a badge wider than the frame stays on its row', () => {
    assert.deepEqual(placeBadges([{width: 300, height: 20, right: 100, bottom: 100}]), [{x: -208, y: 72}]);
});

test('a zone is covered when any rectangle above overlaps it, not when one only touches it', () => {
    const zone = rect(100, 100, 200, 100);
    assert.equal(covers([rect(0, 0, 50, 50), rect(250, 150, 100, 100)], zone), true);
    assert.equal(covers([rect(300, 100, 50, 100), rect(0, 0, 100, 100)], zone), false);
    assert.equal(covers([], zone), false);
});

test('intersects a one pixel overlap', () => {
    assert.deepEqual(intersect(rect(0, 0, 10, 10), rect(9, 0, 5, 5)), rect(9, 0, 1, 5));
    assert.deepEqual(intersect(rect(0, 0, 10, 10), rect(0, 9, 5, 5)), rect(0, 9, 5, 1));
    assert.equal(intersect(rect(0, 0, 10, 10), rect(0, 10, 5, 5)), null);
});

test('a fixed zone is scaled on every side', () => {
    const scaled = zoneRects(frame, {x: 10, y: 20, width: 30, height: 40}, 2);
    assert.deepEqual(scaled.rect, rect(20, 40, 60, 80));
    assert.deepEqual(scaled.visible, rect(20, 40, 60, 80));
    // The frame limits the visible part on both axes.
    const cut = zoneRects({width: 70, height: 100}, {x: 10, y: 20, width: 30, height: 40}, 2);
    assert.deepEqual(cut.visible, rect(20, 40, 50, 60));
});

test('a zone is stored rounded to the nearest whole stage pixel on every side', () => {
    assert.deepEqual(storedZone(rect(100.6, 20.4, 300.5, 200.4), 1.25),
        {x: 101 / 1.25, y: 20 / 1.25, width: 301 / 1.25, height: 200 / 1.25});
});

test('the device pixels of a zone are the whole ones inside it', () => {
    assert.deepEqual(pixelRange(rect(10, 20, 30, 40), 1, 100, 100),
        {left: 10, top: 20, width: 30, height: 40});
    // Positions off by less than the epsilon count as whole pixels.
    assert.deepEqual(pixelRange(rect(10.0004, 20.0004, 29.9992, 39.9992), 1, 100, 100),
        {left: 10, top: 20, width: 30, height: 40});
    // Past the epsilon the edge pixel is partly outside.
    assert.deepEqual(pixelRange(rect(10.005, 20.005, 29.99, 39.99), 1, 100, 100),
        {left: 11, top: 21, width: 28, height: 38});
    assert.deepEqual(pixelRange(rect(10, 20, 30, 40), 2, 200, 200),
        {left: 20, top: 40, width: 60, height: 80});
    // A custom epsilon is honoured.
    assert.equal(pixelRange(rect(10.005, 20, 30, 40), 1, 100, 100, 0.01).left, 10);
});

test('the device pixels of a zone must all lie in the image and be two or more across', () => {
    assert.deepEqual(pixelRange(rect(2, 3, 98, 47), 1, 100, 50), {left: 2, top: 3, width: 98, height: 47});
    assert.equal(pixelRange(rect(-1, 0, 50, 50), 1, 100, 100), null);
    assert.equal(pixelRange(rect(0, -1, 50, 50), 1, 100, 100), null);
    assert.equal(pixelRange(rect(1, 0, 100, 50), 1, 100, 100), null);
    assert.equal(pixelRange(rect(0, 1, 50, 100), 1, 100, 100), null);
    assert.deepEqual(pixelRange(rect(5, 5, 2, 2), 1, 100, 100), {left: 5, top: 5, width: 2, height: 2});
    assert.equal(pixelRange(rect(5, 5, 1, 20), 1, 100, 100), null);
    assert.equal(pixelRange(rect(5, 5, 20, 1), 1, 100, 100), null);
});

test('the edge under a point is found right at the ends of its length and of the tolerance', () => {
    const zone = rect(100, 50, 300, 200);
    // Each point is within 4 of two edges and closer to the one expected.
    assert.equal(edgeAt(zone, 98, 46), 'left');
    assert.equal(edgeAt(zone, 98, 254), 'left');
    assert.equal(edgeAt(zone, 402, 46), 'right');
    assert.equal(edgeAt(zone, 402, 254), 'right');
    assert.equal(edgeAt(zone, 96, 52), 'top');
    assert.equal(edgeAt(zone, 404, 52), 'top');
    assert.equal(edgeAt(zone, 96, 248), 'bottom');
    assert.equal(edgeAt(zone, 404, 248), 'bottom');
    // Just past the end of an edge's length, near it, is no edge.
    assert.equal(edgeAt(zone, 90, 52), null);
    assert.equal(edgeAt(zone, 410, 248), null);
    assert.equal(edgeAt(zone, 98, 40), null);
    assert.equal(edgeAt(zone, 98, 260), null);
    // The distance of exactly the tolerance counts; a default tolerance of 4.
    assert.equal(edgeAt(zone, 96, 150), 'left');
    assert.equal(edgeAt(zone, 95, 150), null);
});

test('a corner goes to the left or right edge, and a tie between them to the left', () => {
    const zone = rect(100, 50, 300, 200);
    assert.equal(edgeAt(zone, 100, 50), 'left');
    assert.equal(edgeAt(zone, 100, 250), 'left');
    assert.equal(edgeAt(zone, 400, 50), 'right');
    assert.equal(edgeAt(zone, 400, 250), 'right');
    assert.equal(edgeAt(rect(100, 50, 6, 200), 103, 150), 'left');
    assert.equal(edgeAt(rect(100, 50, 200, 6), 200, 53), 'top');
});

test('dragging an edge of a zone partly outside the frame first clips it to the frame', () => {
    assert.deepEqual(dragEdge(rect(100, -30, 300, 200), 'left', 150, frame), rect(150, 0, 250, 170));
    assert.deepEqual(dragEdge(rect(100, 500, 300, 200), 'left', 150, frame), rect(150, 500, 250, 100));
    assert.deepEqual(dragEdge(rect(-30, 100, 200, 300), 'top', 150, frame), rect(0, 150, 170, 250));
    assert.deepEqual(dragEdge(rect(700, 100, 200, 300), 'top', 150, frame), rect(700, 150, 100, 250));
});

test('a zone slightly under the minimum grows back to it', () => {
    assert.deepEqual(dragEdge(rect(100, 50, 300, 39.5), 'left', 100, frame), rect(100, 50, 300, 40));
    assert.deepEqual(dragEdge(rect(100, 50, 39.5, 300), 'top', 50, frame), rect(100, 50, 40, 300));
    // At the bottom of the frame it grows upward.
    assert.deepEqual(dragEdge(rect(100, 590, 300, 5), 'left', 100, frame), rect(100, 560, 300, 40));
    assert.deepEqual(dragEdge(rect(790, 100, 5, 300), 'top', 100, frame), rect(760, 100, 40, 300));
});

test('each axis of a frame smaller than the minimum is limited by its own size', () => {
    const narrow = {width: 30, height: 600};
    assert.deepEqual(dragEdge(rect(0, 0, 30, 300), 'top', 280, narrow), rect(0, 260, 30, 40));
    const short = {width: 600, height: 30};
    assert.deepEqual(dragEdge(rect(0, 0, 300, 30), 'top', 20, short), rect(0, 0, 300, 30));
    assert.deepEqual(dragEdge(rect(0, 0, 300, 30), 'bottom', 20, short), rect(0, 0, 300, 30));
});

test('stacking the views of a window leaves the entries as they were', () => {
    const entries = [{id: 'b', area: 100, seq: 2}, {id: 'a', area: 500, seq: 1}];
    assert.deepEqual(stackOrder(entries), ['a', 'b']);
    assert.deepEqual(entries.map(entry => entry.id), ['b', 'a']);
});

test('a zone entry has the area of its visible part, or none', () => {
    assert.deepEqual(zoneEntry('a', rect(0, 0, 10, 20), 7), {id: 'a', visible: rect(0, 0, 10, 20), area: 200, seq: 7});
    assert.deepEqual(zoneEntry('b', null, 8), {id: 'b', visible: null, area: 0, seq: 8});
});

test('a zone covers its left and top edges and not its right and bottom ones', () => {
    const entries = [zoneEntry('z', rect(400, 300, 400, 300), 1)];
    assert.equal(targetZone(entries, 400, 300), 'z');
    assert.equal(targetZone(entries, 799, 599), 'z');
    assert.equal(targetZone(entries, 399, 300), null);
    assert.equal(targetZone(entries, 400, 299), null);
    assert.equal(targetZone(entries, 800, 599), null);
    assert.equal(targetZone(entries, 799, 600), null);
});

test('the last targeted view wins among badges, but never among zones', () => {
    const badges = [hit('big', 1000, 1, 'badge'), hit('small', 100, 2, 'badge')];
    assert.equal(pickHit(badges, 'big').id, 'big');
    assert.equal(pickHit(badges).id, 'small');
    const zones = [hit('big', 1000, 1, 'zone'), hit('small', 100, 2, 'zone')];
    assert.equal(pickHit(zones, 'big').id, 'small');
});

test('a badge that ends exactly at the left edge stays on its row', () => {
    const badge = {width: 20, height: 20, right: 100, bottom: 600};
    assert.deepEqual(placeBadges([badge, badge, badge, badge]),
        [{x: 72, y: 572}, {x: 48, y: 572}, {x: 24, y: 572}, {x: 0, y: 572}]);
});

test('a crowd of badges in one corner ends: the one that finds no room stays on the first row', () => {
    const badge = {width: 80, height: 20, right: 200, bottom: 600};
    const placed = placeBadges(Array.from({length: 150}, () => badge));
    assert.equal(placed.length, 150);
    assert.deepEqual(placed.at(-1), {x: 112, y: 572});
});
