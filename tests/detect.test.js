import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {Detector, LEVELS, MAX_PER_KIND, PARAMETERS, detect, selectHelpers} from '../src/detect.js';
import {pixelRange} from '../src/zones.js';
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

test('a one-pixel line gives one guide, at its first boundary, and a two-pixel one gives two', () => {
    const thin = boxes(400, 300, [255, 255, 255], [[100, 150, 200, 1, [20, 40, 160]]]);
    assert.deepEqual(detect(thin, 'low').guides, [{kind: 'horizontal', y: 150}]);
    const thick = boxes(400, 300, [255, 255, 255], [[100, 150, 200, 2, [20, 40, 160]]]);
    assert.deepEqual(detect(thick, 'low').guides, [{kind: 'horizontal', y: 150}, {kind: 'horizontal', y: 152}]);
});

test('Low keeps the quarters of a layout and not a card, at every size above its share', () => {
    const panels = [[0, 0, 200, 150, [230, 234, 242]], [200, 150, 200, 150, [255, 243, 224]]];
    const quarters = detect(boxes(400, 300, [255, 255, 255], panels), 'low').rectangles;
    assert.deepEqual(quarters.map(r => [r.x, r.y, r.width, r.height]),
        [[0, 0, 200, 150], [200, 0, 200, 150], [0, 150, 200, 150], [200, 150, 200, 150]]);
    const card = boxes(400, 300, [255, 255, 255], [[50, 50, 100, 60, [230, 234, 242]]]);
    assert.deepEqual(detect(card, 'low').rectangles, []);
    assert.equal(detect(card, 'medium').rectangles.length, 1);
});

test('Low keeps padded quarters and a side column of a layout', () => {
    const c = [230, 234, 242];
    const padded = boxes(640, 360, [255, 255, 255], [[80, 40, 235, 135, c], [325, 40, 235, 135, c],
        [80, 185, 235, 135, c], [325, 185, 235, 135, c]]);
    assert.equal(detect(padded, 'low').rectangles.length, 4);
    const page = boxes(640, 360, [255, 255, 255], [[0, 0, 640, 80, [31, 42, 68]], [0, 80, 90, 280, c]]);
    assert.ok(detect(page, 'low').rectangles.some(r => r.width === 90 && r.height === 280));
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

test('rectangles that take the slots guides leave also take those their own edges free', () => {
    // 60 rectangles, 5 guides on the edges of the last 30 of them, 10 elsewhere: the guides on
    // rectangles 31 to 35 are dropped once those are kept, so more rectangles fit.
    const rects = Array.from({length: 60}, (_, i) => ({kind: 'rectangle', x: i * 20, y: 0, width: 10, height: 100 - i}));
    const onRects = rects.slice(30, 35).map((rect, i) => ({kind: 'vertical', x: rect.x, cover: 500 - i}));
    const elsewhere = Array.from({length: 10}, (_, i) => ({kind: 'vertical', x: 5000 + i * 5, cover: 100 - i}));
    const kept = selectHelpers(rects, [...onRects, ...elsewhere]);
    assert.equal(kept.rectangles.length, 50);
    assert.equal(kept.guides.length, 10);
    assert.deepEqual(kept.guides.map(guide => guide.x), elsewhere.map(guide => guide.x));
    assert.ok(kept.rectangles.length + kept.guides.length <= 60);

    // Rectangles past 30 take vacant slots only: with 30 guides, one of them on the 31st
    // rectangle's edge, 30 and 30 stay, though that guide would be dropped if the 31st were kept.
    const thirty = Array.from({length: 30}, (_, i) => ({kind: 'vertical', x: 5000 + i * 5, cover: 100 - i}));
    const edgeGuide = {kind: 'vertical', x: rects[30].x, cover: 500};
    const crowded = selectHelpers(rects.slice(0, 31), [edgeGuide, ...thirty.slice(0, 29)]);
    assert.equal(crowded.rectangles.length, 30);
    assert.equal(crowded.guides.length, 30);
    assert.equal(crowded.guides[0].x, edgeGuide.x);

    // With 30 guides to place, the rectangles stay at 30.
    const many = Array.from({length: 30}, (_, i) => ({kind: 'vertical', x: 5000 + i * 5, cover: 100 - i}));
    const full = selectHelpers(rects, many);
    assert.equal(full.rectangles.length, 30);
    assert.equal(full.guides.length, 30);
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

test('the pixels of a zone are those fully inside it, and none outside the capture', () => {
    const zone = {x: 100.4, y: 50, width: 800, height: 600};
    assert.deepEqual(pixelRange({x: 20, y: 40, width: 1000, height: 700}, 1, 1600, 1000),
        {left: 20, top: 40, width: 1000, height: 700});
    // At 125% the edge pixels, partly outside the window, are left out.
    assert.deepEqual(pixelRange(zone, 1.25, 1600, 1000), {left: 126, top: 63, width: 999, height: 749});
    assert.deepEqual(pixelRange({x: 100, y: 100, width: 800, height: 600}, 1.25, 1600, 1000),
        {left: 125, top: 125, width: 1000, height: 750});
    // A capture shorter than the zone, or a zone beyond it, is refused rather than cropped.
    assert.equal(pixelRange({x: 20, y: 40, width: 1000, height: 700}, 1, 1000, 1000), null);
    assert.equal(pixelRange({x: -5, y: 0, width: 100, height: 100}, 1, 1600, 1000), null);
    assert.equal(pixelRange({x: 10, y: 10, width: 1, height: 100}, 1, 1600, 1000), null);
});

/** A black shape on white: `inside(x, y)` for x and y in the 100 × 100 box at (100, 100). */
function shape(inside) {
    const width = 400;
    const height = 300;
    const image = boxes(width, height, [255, 255, 255]);
    for (let y = 100; y < 200; y++) {
        for (let x = 100; x < 200; x++) {
            if (inside(x - 100, y - 100))
                image.data.set([0, 0, 0, 255], (y * width + x) * 4);
        }
    }
    return image;
}

const RECTANGLE = [{kind: 'rectangle', x: 100, y: 100, width: 100, height: 100}];

// Each shape and the rectangles it must give at High. Arms 20 wide and bars 20 high: opening up and
// down, the rows of the box are all spanned from side to side (100%). Opening left or right, the
// 60 middle rows span only the spine, 20 of 100 pixels (52% in all), so a thin one is no
// rectangle; a spine 80 wide fills 88%.
const SHAPES = {
    'U': [(x, y) => x < 20 || x >= 80 || y >= 80, RECTANGLE],
    'inverted U': [(x, y) => x < 20 || x >= 80 || y < 20, RECTANGLE],
    'thin C': [(x, y) => y < 20 || y >= 80 || x < 20, []],
    'thin reversed C': [(x, y) => y < 20 || y >= 80 || x >= 80, []],
    'thick C': [(x, y) => y < 20 || y >= 80 || x < 80, RECTANGLE],
    'thick reversed C': [(x, y) => y < 20 || y >= 80 || x >= 20, RECTANGLE],
    // Spine 75 wide: 60 rows of 75 and 40 of 100 fill exactly 85%; 74 wide just misses it.
    'C at 85%': [(x, y) => y < 20 || y >= 80 || x < 75, RECTANGLE],
    'C at 84.4%': [(x, y) => y < 20 || y >= 80 || x < 74, []],
    // The right arm begins 40 rows below the left branch, so the two lists start on different rows;
    // the box is 90% spanned, and 68% if the lists were merged from the same row.
    'staggered branches': [(x, y) => (y < 40 ? x < 75 : x < 20 || x >= 80) || y >= 80, RECTANGLE],
    'L': [(x, y) => x < 20 || y >= 80, []],
};

test('a region fills its box by its row extents whichever way its branches join', () => {
    for (const [name, [inside, expected]] of Object.entries(SHAPES)) {
        const image = shape(inside);
        for (const bandRows of [300, 1, 7, 64])
            assert.deepEqual(detect(image, 'high', {bandRows}).rectangles, expected, `${name} ${bandRows}`);
    }
});

test('a zone wider than 16 bits keeps its row extents', () => {
    const width = 65560;
    const image = boxes(width, 40, [255, 255, 255], [[width - 40, 10, 30, 20, [0, 0, 0]]]);
    assert.deepEqual(detect(image, 'high').rectangles, [{kind: 'rectangle', x: width - 40, y: 10, width: 30, height: 20}]);
});

test('a region does not inherit the rows of a region that ended before it', () => {
    // A 100 × 40 rectangle ends above a thin C, whose labels reuse its freed ones.
    const image = shape((x, y) => y < 20 || y >= 80 || x < 20);
    for (let y = 10; y < 50; y++) {
        for (let x = 100; x < 200; x++)
            image.data.set([0, 0, 0, 255], (y * 400 + x) * 4);
    }
    for (let y = 100; y < 200; y++)
        image.data.set([255, 255, 255, 255], (y * 400 + 99) * 4);
    assert.deepEqual(detect(image, 'high').rectangles,
        [{kind: 'rectangle', x: 100, y: 10, width: 100, height: 40}]);
});
