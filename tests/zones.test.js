import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    MIN_ZONE,
    covers,
    dragEdge,
    edgeAt,
    intersect,
    pickHit,
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
