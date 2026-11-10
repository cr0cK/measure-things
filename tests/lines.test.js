// Rectangles take in a thin line along their sides (SET, Find helpers): two regions split by a
// 1-pixel border both reach across it. Every case is a synthetic zone with known pixels.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {LEVELS, detect} from '../src/detect.js';

const WHITE = [255, 255, 255];
const BLUE = [79, 124, 255];
const SAND = [255, 243, 224];
const INK = [31, 42, 68];
const BANDS = [1, 2, 3, 7, 64, 300];

/** An RGBA image of one color with `[x, y, width, height, color]` boxes painted in order. */
function scene(fills, width = 400, height = 300, background = WHITE) {
    const data = new Uint8Array(width * height * 4);
    const paint = (x, y, w, h, color) => {
        for (let row = y; row < y + h; row++) {
            for (let column = x; column < x + w; column++)
                data.set([...color, 255], (row * width + column) * 4);
        }
    };
    paint(0, 0, width, height, background);
    for (const fill of fills)
        paint(...fill);
    return {data, width, height};
}

/** The rectangles found, as `[x, y, width, height]`, left to right then top to bottom. */
function found(image, level = 'medium', options = {}) {
    return detect(image, level, options).rectangles
        .map(({x, y, width, height}) => [x, y, width, height])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** Same result for every way of cutting the rows into bands. */
function foundWhole(image, level, options = {}) {
    const whole = found(image, level, options);
    for (const bandRows of BANDS)
        assert.deepEqual(found(image, level, {...options, bandRows}), whole, `${level} bands of ${bandRows}`);
    return whole;
}

/** A at x 20..199 and B at x 200+ (or 201+...), both y 20..279, `gap` pixels of ink between. */
const split = (gap, {right = 380} = {}) => scene([
    [20, 20, 180, 260, BLUE],
    [200 + gap, 20, right - 200 - gap, 260, SAND],
    ...(gap > 0 ? [[200, 20, gap, 260, INK]] : []),
]);

test('two regions split by a 1-pixel border both reach across it, at every level', () => {
    for (const level of LEVELS)
        assert.deepEqual(foundWhole(split(1), level), [[20, 20, 181, 260], [200, 20, 180, 260]], level);
    // Without the border they only touch.
    for (const level of LEVELS)
        assert.deepEqual(foundWhole(split(0), level), [[20, 20, 180, 260], [200, 20, 180, 260]], level);
});

test('the border is one line on screen: the edges of both regions are on it', () => {
    const [a, b] = foundWhole(split(1), 'medium');
    assert.equal(a[0] + a[2] - 1, 200, 'A ends on the border pixel');
    assert.equal(b[0], 200, 'B begins on the border pixel');
});

test('a 2-pixel border is taken in at scale 1.25 and 1.5, not at scale 1', () => {
    for (const level of LEVELS) {
        assert.deepEqual(foundWhole(split(2), level), [[20, 20, 180, 260], [202, 20, 178, 260]], `${level} at 1`);
        for (const scale of [1.25, 1.5, 2]) {
            assert.deepEqual(foundWhole(split(2), level, {scale}),
                [[20, 20, 182, 260], [200, 20, 180, 260]], `${level} at ${scale}`);
        }
    }
    // A 3-pixel border needs a scale above 2.
    assert.deepEqual(foundWhole(split(3), 'medium', {scale: 2}), [[20, 20, 180, 260], [203, 20, 177, 260]]);
    assert.deepEqual(foundWhole(split(3), 'medium', {scale: 2.5}), [[20, 20, 183, 260], [200, 20, 180, 260]]);
});

test('the smallest thickness that holds wins, so a 1-pixel border at a high scale is still one pixel', () => {
    assert.deepEqual(foundWhole(split(1), 'medium', {scale: 3}), [[20, 20, 181, 260], [200, 20, 180, 260]]);
});

test('a side takes a line in when it covers 85% of its positions, not 84%', () => {
    // A is 260 rows high: 221 rows is 85%, 220 is 84.6%. Elsewhere B touches A.
    const beyond = rows => scene([
        [20, 20, 180, 260, BLUE], [201, 20, 179, 260, SAND], [200, 20, 1, rows, INK],
        // Where there is no line, B reaches A.
        [200, 20 + rows, 1, 260 - rows, SAND]]);
    for (const level of LEVELS) {
        assert.deepEqual(foundWhole(beyond(221), level)[0], [20, 20, 181, 260], `${level} 221 rows`);
        assert.deepEqual(foundWhole(beyond(220), level)[0], [20, 20, 180, 260], `${level} 220 rows`);
    }
});

test('a line that is not the same thickness along the side has no single far boundary', () => {
    // 1 pixel thick on the upper half of the side, 2 on the lower: 50% for either thickness.
    const image = scene([
        [20, 20, 180, 260, BLUE],
        [200, 20, 180, 260, SAND],
        [200, 20, 1, 130, INK], [200, 150, 2, 130, INK],
    ]);
    for (const scale of [1, 1.5, 2]) {
        const [a] = foundWhole(image, 'medium', {scale});
        assert.equal(a[2], 180, `A is not widened at ${scale}`);
    }
});

test('a line against the zone\'s edge is not taken in', () => {
    // A 1-pixel line at x = 0: the far boundary would be outside the zone.
    const left = scene([[0, 0, 1, 300, INK], [1, 20, 200, 260, BLUE]]);
    assert.deepEqual(foundWhole(left, 'medium', {scale: 2})[0], [1, 20, 200, 260]);
    // One pixel in, the background is beyond the line and it is taken in.
    const inside = scene([[1, 0, 1, 300, INK], [2, 20, 200, 260, BLUE]]);
    assert.deepEqual(foundWhole(inside, 'medium')[0], [1, 20, 201, 260]);
    // The same on the other three sides.
    const top = scene([[0, 0, 400, 1, INK], [20, 1, 360, 150, BLUE]]);
    assert.deepEqual(foundWhole(top, 'medium', {scale: 2})[0], [20, 1, 360, 150]);
    const bottom = scene([[0, 299, 400, 1, INK], [20, 100, 360, 199, BLUE]]);
    assert.deepEqual(foundWhole(bottom, 'medium', {scale: 2})[0], [20, 100, 360, 199]);
    const right = scene([[399, 0, 1, 300, INK], [100, 20, 299, 260, BLUE]]);
    assert.deepEqual(foundWhole(right, 'medium', {scale: 2})[0], [100, 20, 299, 260]);
    const farBottom = scene([[0, 298, 400, 1, INK], [20, 100, 360, 198, BLUE]]);
    assert.deepEqual(foundWhole(farBottom, 'medium')[0], [20, 100, 360, 199]);
});

test('a line against the tolerance is not an edge, so it is not taken in', () => {
    const grey = value => [value, value, value];
    // A 100, line 115, B 130: steps of 15 are edges at Medium (12) and High (8), not at Low (20).
    const image = scene([[20, 20, 180, 260, grey(100)], [200, 20, 1, 260, grey(115)],
        [201, 20, 179, 260, grey(130)]]);
    for (const level of ['medium', 'high'])
        assert.deepEqual(foundWhole(image, level), [[20, 20, 181, 260], [200, 20, 180, 260]], level);
    // At Low nothing is an edge: the three are one region, and no line is beside it.
    assert.deepEqual(foundWhole(image, 'low'), [[20, 20, 360, 260]]);
    // A line only 10 away from A: no edge at Medium, so A is not widened there.
    const faint = scene([[20, 20, 180, 260, grey(100)], [200, 20, 1, 260, grey(110)],
        [201, 20, 179, 260, grey(150)]]);
    assert.deepEqual(foundWhole(faint, 'medium')[0], [20, 20, 181, 260]);
    assert.deepEqual(foundWhole(faint, 'high')[0], [20, 20, 181, 260]);
});

test('a card with a 1-pixel outline is one rectangle: the outline and the interior merge', () => {
    const card = scene([[50, 50, 200, 120, INK], [51, 51, 198, 118, SAND]]);
    for (const level of ['medium', 'high']) {
        assert.deepEqual(foundWhole(card, level), [[50, 50, 200, 120]], level);
        assert.deepEqual(foundWhole(card, level, {scale: 1.5}), [[50, 50, 200, 120]], `${level} at 1.5`);
    }
    // Content in the card does not change it.
    const content = scene([[50, 50, 200, 120, INK], [51, 51, 198, 118, SAND], [70, 70, 60, 30, BLUE]]);
    assert.deepEqual(foundWhole(content, 'medium'), [[50, 50, 200, 120], [70, 70, 60, 30]]);
});

test('lines on two sides and at a corner are judged on each side alone', () => {
    // R has a line on its right and one below; B is right of the line, C below the other.
    const image = scene([
        [20, 20, 180, 120, BLUE], [200, 20, 1, 121, INK], [20, 140, 181, 1, INK],
        [201, 20, 179, 120, SAND], [20, 141, 180, 140, [200, 230, 200]],
    ]);
    const rectangles = foundWhole(image, 'medium');
    assert.ok(rectangles.some(r => r.join() === [20, 20, 181, 121].join()), 'R takes both lines in');
    assert.ok(rectangles.some(r => r.join() === [200, 20, 180, 120].join()), 'B takes the line on its left');
    assert.ok(rectangles.some(r => r.join() === [20, 140, 180, 141].join()), 'C takes the line above');
});

test('a side is judged against the region\'s own box, before any other side moves', () => {
    // R's right line is 1 pixel wide and its bottom line is 1 pixel wide: moving the right side
    // first must not change what the bottom side sees. R is 100 wide by 100 high at (20, 20).
    const image = scene([
        [20, 20, 100, 100, BLUE], [120, 20, 1, 100, INK], [20, 120, 100, 1, INK],
        [121, 20, 100, 100, SAND], [20, 121, 100, 100, SAND],
    ]);
    const r = foundWhole(image, 'high').find(rect => rect[0] === 20 && rect[1] === 20);
    assert.deepEqual(r, [20, 20, 101, 101]);
});

test('every level and every cut of the rows gives the same boxes', () => {
    const images = [split(1), split(2), scene([[50, 50, 200, 120, INK], [51, 51, 198, 118, SAND]])];
    for (const image of images) {
        for (const level of LEVELS) {
            for (const scale of [1, 1.25, 1.5, 2])
                foundWhole(image, level, {scale});
        }
    }
});

test('the guides on a taken-in rectangle edge are dropped', () => {
    const {guides} = detect(split(1), 'medium');
    assert.deepEqual(guides.filter(g => g.kind === 'vertical' && g.x >= 199 && g.x <= 202), []);
});

test('only the positions where the region itself reaches the side vote', () => {
    // A C with an 80-pixel spine and 20-pixel arms, 88% full, and a 1-pixel line beside its open
    // side: the line touches the arms' ends only, 40% of the side, though the pocket beside
    // them also differs from the line.
    const c = (...extra) => scene([[100, 100, 100, 100, INK], [180, 120, 20, 60, [200, 230, 200]], ...extra]);
    const ofC = (image, level) => foundWhole(image, level).filter(r => r[0] <= 100 && r[2] >= 100);
    for (const level of ['medium', 'high'])
        assert.deepEqual(ofC(c([200, 100, 1, 100, BLUE]), level), [[100, 100, 100, 100]], level);
    // The same C with the line on its closed side is taken in.
    assert.deepEqual(ofC(c([99, 100, 1, 100, BLUE]), 'high'), [[99, 100, 101, 100]]);
});

test('the fill share is that of the moved box, and a side is judged on the box before it moves', () => {
    // A 16 x 12 region with four separate lines: 18 x 14 with them, 76% filled, so it is no rectangle.
    const small = scene([[100, 100, 16, 12, BLUE], [99, 100, 1, 12, INK], [116, 100, 1, 12, INK],
        [100, 99, 16, 1, INK], [100, 112, 16, 1, INK]]);
    assert.deepEqual(foundWhole(small, 'high'), []);
    // R is 100 wide; its bottom line covers 85 of those 100 positions, which is 84% of the 101
    // positions the side would have once the right line moved it, so only the own box takes it in.
    const image = scene([
        [20, 20, 100, 100, BLUE], [120, 20, 1, 100, INK], [20, 120, 85, 1, INK],
        [121, 20, 100, 100, SAND], [20, 121, 100, 100, SAND], [105, 120, 15, 1, SAND],
    ]);
    assert.deepEqual(foundWhole(image, 'high').find(r => r[0] === 20 && r[1] === 20), [20, 20, 101, 101]);
});
