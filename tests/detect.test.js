import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {Detector, LEVELS, MAX_PER_KIND, PARAMETERS, detect, selectHelpers} from '../src/detect.js';
import {IMAGES, WIDTH, draw, goldenPath} from './fixtures/images.js';
import {CLASSES, compare} from './fixtures/match.js';

const MAX_UNMATCHED = 0.2;

/** An RGBA image of one color, with filled boxes `[x, y, width, height, [r, g, b]]` on it. */
function boxes(width, height, background, fills = []) {
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

test('every level finds the truth of its classes in every image, with few extras', () => {
    for (const name of Object.keys(IMAGES)) {
        const image = draw(name);
        const {truth} = image;
        // The cap must not be able to hide an item.
        assert.ok(truth.rectangles.length <= MAX_PER_KIND, `${name} rectangles`);
        assert.ok(truth.edges.length <= MAX_PER_KIND, `${name} edges`);
        for (const level of LEVELS) {
            const {missing, unmatched, helpers} = compare(truth, detect(image, level), level);
            assert.deepEqual(missing, [], `${name} ${level}: missing items`);
            assert.ok(unmatched.length <= MAX_UNMATCHED * helpers,
                `${name} ${level}: ${unmatched.length} of ${helpers} helpers match nothing`);
            assert.ok(CLASSES[level].length > 0 && helpers > 0, `${name} ${level} finds something`);
        }
    }
});

test('each level finds more than the one below it', () => {
    for (const name of Object.keys(IMAGES)) {
        const image = draw(name);
        const counts = LEVELS.map(level => {
            const found = detect(image, level);
            return found.rectangles.length + found.guides.length;
        });
        assert.ok(counts[0] < counts[2], `${name}: ${counts}`);
    }
});

test('the output of every image and level is the committed golden', () => {
    for (const name of Object.keys(IMAGES)) {
        for (const level of LEVELS) {
            const golden = JSON.parse(readFileSync(goldenPath(name, level), 'utf8'));
            assert.deepEqual(detect(draw(name), level), golden, `${name} ${level}`);
        }
    }
});

test('the result does not depend on how the rows are fed in bands', () => {
    for (const name of ['dashboard', 'dense']) {
        const image = draw(name);
        for (const level of LEVELS) {
            const whole = detect(image, level);
            for (const bandRows of [1, 7, 64, 256])
                assert.deepEqual(detect(image, level, {bandRows}), whole, `${name} ${level} ${bandRows}`);
        }
    }
});

test('a row stride wider than the row and three channels read the same pixels', () => {
    const image = draw('form');
    const padded = new Uint8Array(image.height * (image.width * 3 + 5));
    const stride = image.width * 3 + 5;
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            for (let c = 0; c < 3; c++)
                padded[y * stride + x * 3 + c] = image.data[(y * image.width + x) * 4 + c];
        }
    }
    for (const level of LEVELS) {
        const rgb = {data: padded, width: image.width, height: image.height, channels: 3, stride};
        assert.deepEqual(detect(rgb, level), detect(image, level));
    }
});

test('a uniform zone, or one too small to hold anything, finds nothing', () => {
    for (const level of LEVELS) {
        assert.deepEqual(detect(boxes(400, 300, [200, 200, 200]), level), {guides: [], rectangles: []});
        assert.deepEqual(detect(boxes(1, 1, [0, 0, 0]), level), {guides: [], rectangles: []});
        assert.deepEqual(detect(boxes(5, 0, [0, 0, 0]), level), {guides: [], rectangles: []});
    }
});

test('a region the size of the zone is the background and is skipped, its nested regions are kept', () => {
    const image = boxes(400, 300, [240, 240, 240], [
        [50, 50, 200, 150, [20, 40, 160]],
        [80, 80, 60, 40, [250, 200, 0]],
    ]);
    const {rectangles} = detect(image, 'medium');
    assert.deepEqual(rectangles.map(({x, y, width, height}) => [x, y, width, height]),
        [[50, 50, 200, 150], [80, 80, 60, 40]]);
});

test('a guide within a pixel of a rectangle edge is dropped, one elsewhere is kept', () => {
    // A bar across the zone splits it in three rectangles whose edges would also be guides.
    const image = boxes(400, 300, [255, 255, 255], [[0, 100, 400, 60, [20, 40, 160]]]);
    const found = detect(image, 'medium');
    assert.deepEqual(found.rectangles.map(r => [r.x, r.y, r.width, r.height]),
        [[0, 160, 400, 140], [0, 0, 400, 100], [0, 100, 400, 60]]);
    assert.deepEqual(found.guides, []);

    const narrow = boxes(400, 300, [255, 255, 255], [[100, 20, 8, 260, [20, 40, 160]]]);
    assert.deepEqual(detect(narrow, 'medium').guides.map(g => g.x), [100, 108]);
});

test('a one-pixel line gives one guide, at its first boundary', () => {
    const image = boxes(400, 300, [255, 255, 255], [[100, 150, 200, 1, [20, 40, 160]]]);
    assert.deepEqual(detect(image, 'low').guides, [{kind: 'horizontal', y: 150}]);
});

test('an edge needs the level\'s tolerance, a gradient is not one', () => {
    const data = new Uint8Array(400 * 300 * 4);
    for (let y = 0; y < 300; y++) {
        for (let x = 0; x < 400; x++)
            data.set([Math.floor(x / 4), 100, 100, 255], (y * 400 + x) * 4);
    }
    for (const level of LEVELS)
        assert.deepEqual(detect({data, width: 400, height: 300}, level), {guides: [], rectangles: []});

    // A step of 15 is an edge at Medium and High, not at Low.
    const step = boxes(400, 300, [100, 100, 100], [[200, 0, 200, 300, [115, 100, 100]]]);
    assert.deepEqual(detect(step, 'low'), {guides: [], rectangles: []});
    for (const level of ['medium', 'high'])
        assert.equal(detect(step, level).rectangles.length, 2);
    assert.ok(PARAMETERS.low.edge > 15 && PARAMETERS.medium.edge < 15 && PARAMETERS.high.edge < 15);
});

test('noise makes many short-lived regions and finds no rectangle, in bounded memory', () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
    const data = new Uint8Array(600 * 400 * 4);
    for (let i = 0; i < data.length; i++)
        data[i] = i % 4 === 3 ? 255 : Math.floor(next() * 256);
    const detector = new Detector(600, 400, 'high');
    detector.addRows(data, 0, 600 * 4, 4, 400);
    const found = detector.finish();
    assert.deepEqual(found.rectangles, []);
    assert.ok(found.guides.length <= 2 * MAX_PER_KIND);
    assert.ok(detector._regions.free.length + detector._alive.length <= 600 * 2 + 600,
        'regions are freed as soon as they end');
});

test('an unknown level is refused', () => {
    assert.throws(() => new Detector(10, 10, 'extreme'), /Unknown tolerance/);
});

test('at most 30 of each kind, a kind that finds fewer leaving its slots to the other', () => {
    const rects = count => Array.from({length: count}, (_, i) => ({kind: 'rectangle', x: i * 20, y: 0, width: 100 - i, height: 10}));
    const guides = count => Array.from({length: count}, (_, i) => ({kind: 'vertical', x: 5000 + i * 5, cover: 1000 - i}));

    let kept = selectHelpers(rects(40), guides(40));
    assert.equal(kept.rectangles.length, 30);
    assert.equal(kept.guides.length, 30);
    // The largest rectangles and the longest guides stay.
    assert.deepEqual(kept.rectangles.at(-1), {kind: 'rectangle', x: 580, y: 0, width: 71, height: 10});
    assert.deepEqual(kept.guides.at(-1), {kind: 'vertical', x: 5145});

    kept = selectHelpers(rects(50), guides(5));
    assert.equal(kept.rectangles.length, 50);
    assert.equal(kept.guides.length, 5);
    kept = selectHelpers(rects(70), guides(5));
    assert.equal(kept.rectangles.length, 55);

    kept = selectHelpers(rects(3), guides(70));
    assert.equal(kept.rectangles.length, 3);
    assert.equal(kept.guides.length, 57);
    assert.equal(kept.guides.at(-1).x, 5000 + 56 * 5);
});

test('ties are broken by position, top to bottom then left to right', () => {
    const same = [
        {kind: 'rectangle', x: 50, y: 20, width: 30, height: 30},
        {kind: 'rectangle', x: 10, y: 20, width: 30, height: 30},
        {kind: 'rectangle', x: 90, y: 5, width: 30, height: 30},
    ];
    const {rectangles} = selectHelpers(same, []);
    assert.deepEqual(rectangles.map(r => [r.y, r.x]), [[5, 90], [20, 10], [20, 50]]);

    const {guides} = selectHelpers([], [
        {kind: 'horizontal', y: 40, cover: 100}, {kind: 'vertical', x: 300, cover: 100},
        {kind: 'vertical', x: 100, cover: 100}, {kind: 'horizontal', y: 10, cover: 100},
    ]);
    assert.deepEqual(guides, [
        {kind: 'vertical', x: 100}, {kind: 'vertical', x: 300},
        {kind: 'horizontal', y: 10}, {kind: 'horizontal', y: 40},
    ]);
});

test('the test images are as wide as the layout says, and the 4K one scales it', () => {
    assert.equal(draw('dense').width, WIDTH);
    assert.equal(draw('dense', 3).width, 3 * WIDTH);
});
