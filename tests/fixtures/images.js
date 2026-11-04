// Synthetic test images for Find helpers, drawn as raw RGBA, with the ground truth of what was
// drawn. No real screenshots: blocks, cards, elements, text, gradients, and shadows are drawn from
// rectangles and a seeded random generator, so the images are the same on every machine.
//
//   node tests/fixtures/images.js <directory> [scale] [name]   writes <name>.rgba and <name>.truth.json
//   node tests/fixtures/images.js --goldens             rewrites tests/golden/ from the detector
//
// The ground truth lists the rectangles and the edges drawn, each labeled `block` (a main layout
// block), `card` (a section or card), or `element` (a button, field, badge, ...). A rectangle is
// `{class, x, y, width, height}` in pixels; an edge is `{class, axis, position, from, to}`:
// a `vertical` edge at x `position` from y `from` to `to`, a `horizontal` one the same the other
// way. Text is drawn as small glyph blocks and is not part of the truth: it is noise.

import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const WIDTH = 1280;
export const HEIGHT = 720;

const INK = [31, 42, 68];
const MUTED = [150, 160, 180];
const WHITE = [255, 255, 255];
const BLUE = [79, 124, 255];
const LINE = [201, 208, 222];
const BORDER = [213, 219, 232];
const PANEL = [230, 234, 242];

/** A seeded random generator, so the glyphs are the same on every run. */
function random(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const mix = (a, b, t) => a.map((value, i) => Math.round(value + (b[i] - value) * t));

/** Everything is drawn in units of the 1280 × 720 layout and multiplied by `scale`. */
class Drawing {
    constructor(seed, scale, background) {
        this.scale = scale;
        this.width = WIDTH * scale;
        this.height = HEIGHT * scale;
        this.data = new Uint8Array(this.width * this.height * 4);
        this.truth = {rectangles: [], edges: []};
        this.random = random(seed);
        this._fill(0, 0, this.width, this.height, background);
    }

    _s(value) {
        return Math.round(value * this.scale);
    }

    _fill(x, y, width, height, color, alpha = 1) {
        const left = Math.max(0, x);
        const top = Math.max(0, y);
        const right = Math.min(this.width, x + width);
        const bottom = Math.min(this.height, y + height);
        for (let row = top; row < bottom; row++) {
            for (let column = left, i = (row * this.width + left) * 4; column < right; column++, i += 4) {
                for (let c = 0; c < 3; c++) {
                    const blended = this.data[i + c] * (1 - alpha) + color[c] * alpha;
                    this.data[i + c] = alpha === 1 ? color[c] : Math.round(blended);
                }
                this.data[i + 3] = 255;
            }
        }
    }

    /** A filled rectangle; with `kind` it is also in the truth. */
    rect(x, y, width, height, color, kind = null) {
        const [px, py, pw, ph] = [x, y, width, height].map(value => this._s(value));
        this._fill(px, py, pw, ph, color);
        if (kind)
            this.truth.rectangles.push({class: kind, x: px, y: py, width: pw, height: ph});
    }

    /** A rectangle already drawn, such as the background around other things, put in the truth. */
    claim(x, y, width, height, kind) {
        const [px, py, pw, ph] = [x, y, width, height].map(value => this._s(value));
        this.truth.rectangles.push({class: kind, x: px, y: py, width: pw, height: ph});
    }

    /** A rectangle with a gradient from `from` to `to`, down or across. */
    gradient(x, y, width, height, from, to, across, kind = null) {
        const [px, py, pw, ph] = [x, y, width, height].map(value => this._s(value));
        const steps = across ? pw : ph;
        for (let i = 0; i < steps; i++) {
            const color = mix(from, to, steps > 1 ? i / (steps - 1) : 0);
            if (across)
                this._fill(px + i, py, 1, ph, color);
            else
                this._fill(px, py + i, pw, 1, color);
        }
        if (kind)
            this.truth.rectangles.push({class: kind, x: px, y: py, width: pw, height: ph});
    }

    /** A box shadow: darkest next to the box, fading over `blur`. */
    shadow(x, y, width, height, {blur = 14, dy = 4, alpha = 0.3} = {}) {
        const [px, py, pw, ph] = [x, y + dy, width, height].map(value => this._s(value));
        const reach = this._s(blur);
        const falloff = d => {
            const t = Math.min(1, Math.max(0, 0.5 - d / (2 * reach)));
            return t * t * (3 - 2 * t);
        };
        for (let row = py - reach; row < py + ph + reach; row++) {
            const dyp = row < py ? py - row : row >= py + ph ? row - (py + ph - 1) : 0;
            for (let column = px - reach; column < px + pw + reach; column++) {
                const dxp = column < px ? px - column : column >= px + pw ? column - (px + pw - 1) : 0;
                const a = alpha * falloff(dxp) * falloff(dyp);
                if (a > 0.002)
                    this._fill(column, row, 1, 1, [0, 0, 0], a);
            }
        }
    }

    /** A card: a shadow, a 1-pixel border, and a white inside. The truth is the outer box. */
    card(x, y, width, height, kind = 'card', fill = WHITE) {
        this.shadow(x, y, width, height);
        const border = this._s(1);
        const [px, py, pw, ph] = [x, y, width, height].map(value => this._s(value));
        this._fill(px, py, pw, ph, BORDER);
        this._fill(px + border, py + border, pw - 2 * border, ph - 2 * border, fill);
        if (kind)
            this.truth.rectangles.push({class: kind, x: px, y: py, width: pw, height: ph});
    }

    /** A field: a bordered white box. */
    field(x, y, width, height) {
        const border = this._s(1);
        const [px, py, pw, ph] = [x, y, width, height].map(value => this._s(value));
        this._fill(px, py, pw, ph, [168, 176, 194]);
        this._fill(px + border, py + border, pw - 2 * border, ph - 2 * border, WHITE);
        this.truth.rectangles.push({class: 'element', x: px, y: py, width: pw, height: ph});
    }

    /** A 1-pixel line across, in the truth as an edge at its top. */
    horizontal(x, y, length, color, kind) {
        this.rect(x, y, length, 1 / this.scale, color);
        const [px, py, pl] = [x, y, length].map(value => this._s(value));
        this.truth.edges.push({class: kind, axis: 'horizontal', position: py, from: px, to: px + pl});
    }

    /** A 1-pixel line down, in the truth as an edge at its left. */
    vertical(x, y, length, color, kind) {
        this.rect(x, y, 1 / this.scale, length, color);
        const [px, py, pl] = [x, y, length].map(value => this._s(value));
        this.truth.edges.push({class: kind, axis: 'vertical', position: px, from: py, to: py + pl});
    }

    /** Lines of glyph blocks, about `width` wide, as noise: text is not part of the truth. */
    text(x, y, width, lines, color, glyph = 10) {
        const rnd = this.random;
        for (let line = 0; line < lines; line++) {
            let at = 0;
            const top = y + line * (glyph + 8);
            while (at < width - 14) {
                const word = 3 + Math.floor(rnd() * 6);
                for (let i = 0; i < word && at < width - 8; i++) {
                    const w = 4 + Math.floor(rnd() * 3);
                    this._fill(this._s(x + at), this._s(top), this._s(w), this._s(glyph), color);
                    at += w + 2;
                }
                at += 8;
            }
        }
    }

    image() {
        const {width, height, data, truth} = this;
        return {width, height, channels: 4, stride: width * 4, data, truth};
    }
}

/** A dashboard: a header, a sidebar, a content area with cards, a table, and a footer. */
function dashboard(scale) {
    const d = new Drawing(1, scale, WHITE);
    d.rect(0, 0, 1280, 56, INK, 'block');
    d.rect(16, 12, 32, 32, BLUE, 'element');
    for (let i = 0; i < 3; i++)
        d.rect(300 + i * 104, 14, 90, 28, [54, 69, 107], 'element');
    d.text(310, 22, 70, 1, [200, 208, 230]);
    d.rect(220, 56, 1060, 608, WHITE, 'block');
    d.rect(0, 56, 220, 608, PANEL, 'block');
    d.rect(12, 100, 196, 36, WHITE, 'element');
    d.text(24, 111, 120, 1, INK);
    d.text(24, 160, 140, 3, MUTED);
    d.horizontal(12, 304, 196, LINE, 'element');
    d.text(24, 324, 140, 4, MUTED);
    d.rect(0, 664, 1280, 56, INK, 'block');
    d.text(24, 685, 300, 1, [150, 160, 190]);

    // Cards, with a title, a badge, a progress track, and a button.
    for (let i = 0; i < 3; i++) {
        const x = 252 + i * 322;
        d.card(x, 80, 300, 220);
        d.text(x + 20, 100, 180, 1, INK, 14);
        d.rect(x + 228, 98, 52, 20, [223, 245, 232], 'element');
        d.text(x + 20, 136, 260, 2, MUTED);
        d.rect(x + 20, 180, 260, 14, PANEL, 'element');
        d.rect(x + 20, 204, 56, 20, [255, 236, 200], 'element');
        d.rect(x + 20, 244, 100, 32, BLUE, 'element');
        d.text(x + 34, 253, 60, 1, WHITE, 12);
    }

    // A table card with a header row, a divider, and rows of status badges.
    d.card(252, 330, 944, 310);
    d.rect(256, 334, 936, 36, [238, 241, 247], 'element');
    d.text(272, 344, 600, 1, INK);
    d.vertical(640, 380, 244, LINE, 'card');
    for (let i = 0; i < 4; i++) {
        d.text(272, 392 + i * 56, 300, 1, MUTED);
        d.text(660, 392 + i * 56, 200, 1, MUTED);
        d.rect(1060, 388 + i * 56, 96, 24, i % 2 ? [253, 228, 228] : [223, 245, 232], 'element');
    }
    return d.image();
}

/** A landing page: a gradient hero, call-to-action buttons, a grid of feature cards, a footer. */
function landing(scale) {
    const d = new Drawing(2, scale, WHITE);
    d.rect(0, 0, 1280, 63, WHITE, 'block');
    d.rect(40, 16, 120, 32, BLUE, 'element');
    for (let i = 0; i < 3; i++)
        d.text(700 + i * 120, 26, 80, 1, INK);
    d.rect(1120, 16, 120, 32, INK, 'element');
    d.horizontal(0, 63, 1280, LINE, 'block');
    d.gradient(0, 64, 1280, 340, [43, 58, 103], [86, 100, 190], false, 'block');
    d.text(120, 140, 640, 2, WHITE, 24);
    d.text(120, 240, 480, 2, [200, 208, 240]);
    d.rect(120, 320, 180, 48, [255, 210, 77], 'element');
    d.rect(330, 320, 140, 48, WHITE, 'element');
    d.rect(331, 321, 138, 46, [70, 84, 150]);
    d.gradient(760, 120, 380, 220, [255, 255, 255], [225, 232, 255], true, 'card');

    for (let row = 0; row < 2; row++) {
        for (let column = 0; column < 3; column++) {
            const x = 80 + column * 380;
            const y = 436 + row * 120;
            d.card(x, y, 340, 104);
            d.rect(x + 16, y + 16, 40, 40, [255, 138, 76], 'element');
            d.text(x + 72, y + 20, 240, 1, INK, 14);
            d.text(x + 72, y + 48, 240, 2, MUTED);
        }
    }
    d.claim(0, 404, 1280, 276, 'block');
    d.rect(0, 680, 1280, 40, INK, 'block');
    return d.image();
}

/** A sign-up form: a header, a form card with sections, fields, a checkbox, and buttons. */
function form(scale) {
    const d = new Drawing(3, scale, [233, 237, 243]);
    d.rect(0, 0, 1280, 56, INK, 'block');
    d.rect(16, 12, 32, 32, BLUE, 'element');
    d.claim(0, 56, 1280, 664, 'block');
    d.card(360, 80, 560, 600, 'block');
    d.text(392, 104, 300, 1, INK, 22);
    d.text(392, 148, 440, 1, MUTED);
    // A section of fields on a tinted panel.
    d.rect(384, 190, 512, 212, [238, 241, 246], 'card');
    d.text(400, 202, 120, 1, INK);
    d.field(400, 232, 480, 40);
    d.text(400, 286, 100, 1, INK);
    d.field(400, 316, 480, 40);
    d.horizontal(392, 426, 496, LINE, 'card');
    d.text(400, 440, 100, 1, INK);
    d.field(392, 464, 232, 40);
    d.field(648, 464, 232, 40);
    d.rect(392, 530, 18, 18, [168, 176, 194], 'element');
    d.rect(393, 531, 16, 16, WHITE);
    d.text(422, 534, 280, 1, MUTED);
    d.rect(392, 580, 496, 44, BLUE, 'element');
    d.text(600, 594, 80, 1, WHITE, 14);
    d.rect(392, 636, 240, 28, [233, 237, 243], 'element');
    return d.image();
}

/** The busiest: a toolbar, a tree, thumbnails with captions, an inspector, and a status bar. */
function dense(scale) {
    const d = new Drawing(4, scale, WHITE);
    d.rect(0, 0, 1280, 48, [244, 246, 250], 'block');
    for (let i = 0; i < 6; i++)
        d.rect(16 + i * 64, 10, 52, 28, i === 2 ? BLUE : [214, 220, 234], 'element');
    d.horizontal(0, 48, 1280, LINE, 'block');
    d.rect(261, 49, 1019, 631, WHITE, 'block');
    d.rect(0, 49, 260, 631, PANEL, 'block');
    for (let i = 0; i < 5; i++) {
        d.rect(16, 66 + i * 36, 20, 20, i % 2 ? [255, 138, 76] : [76, 175, 124], 'element');
        d.text(48, 70 + i * 36, 160, 1, INK);
    }
    d.vertical(260, 49, 631, LINE, 'block');
    for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 3; column++) {
            const x = 288 + column * 150;
            const y = 72 + row * 168;
            d.gradient(x, y, 132, 100, mix([76, 175, 124], BLUE, (row + column) / 5), [232, 236, 246], false, 'element');
            d.text(x, y + 112, 110, 1, MUTED);
        }
    }
    d.card(910, 64, 340, 300, 'card');
    d.text(930, 84, 180, 1, INK, 14);
    for (let i = 0; i < 3; i++)
        d.rect(930 + i * 48, 128, 32, 32, mix([255, 138, 76], [76, 175, 124], i / 3), 'element');
    d.field(930, 188, 300, 36);
    d.text(930, 250, 280, 4, MUTED);
    d.rect(1130, 310, 100, 32, BLUE, 'element');
    d.rect(0, 680, 1280, 40, INK, 'block');
    d.text(16, 696, 400, 1, [150, 160, 190], 8);
    return d.image();
}

/** Four panels, one in each quarter, with cards and elements in two of them: no band or column. */
function quadrants(scale) {
    const d = new Drawing(5, scale, WHITE);
    d.rect(0, 0, 640, 360, PANEL, 'block');
    d.rect(640, 0, 640, 360, WHITE, 'block');
    d.rect(0, 360, 640, 360, [255, 243, 224], 'block');
    d.rect(640, 360, 640, 360, [226, 240, 230], 'block');
    d.text(24, 24, 300, 3, INK, 14);
    d.rect(24, 120, 120, 36, BLUE, 'element');
    d.card(660, 24, 280, 160);
    d.rect(680, 44, 80, 28, [255, 138, 76], 'element');
    d.text(680, 100, 220, 3, MUTED);
    d.card(960, 24, 280, 160);
    d.rect(980, 44, 80, 28, [76, 175, 124], 'element');
    d.card(24, 384, 280, 160, 'card', [255, 250, 240]);
    d.rect(44, 404, 80, 28, BLUE, 'element');
    d.text(664, 384, 300, 4, MUTED);
    return d.image();
}

export const IMAGES = {dashboard, landing, form, dense, quadrants};

/** An image by name, at `scale` times the 1280 × 720 layout. */
export function draw(name, scale = 1) {
    return IMAGES[name](scale);
}

const GOLDENS = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden');

export const goldenPath = (name, level) => join(GOLDENS, `${name}.${level}.json`);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [target, scale, only] = process.argv.slice(2);
    if (target === '--goldens') {
        const {detect, LEVELS} = await import('../../src/detect.js');
        mkdirSync(GOLDENS, {recursive: true});
        for (const name of Object.keys(IMAGES)) {
            for (const level of LEVELS)
                writeFileSync(goldenPath(name, level), `${JSON.stringify(detect(draw(name), level), null, 1)}\n`);
        }
    } else if (target) {
        mkdirSync(target, {recursive: true});
        for (const name of Object.keys(IMAGES).filter(candidate => !only || candidate === only)) {
            const {data, truth, width, height} = draw(name, Number(scale ?? 1));
            writeFileSync(join(target, `${name}.rgba`), data);
            writeFileSync(join(target, `${name}.truth.json`), `${JSON.stringify({width, height, ...truth}, null, 1)}\n`);
        }
    } else {
        console.error('Usage: images.js <directory> [scale] [name] | --goldens');
        process.exit(1);
    }
}
