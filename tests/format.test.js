import assert from 'node:assert/strict';
import {test} from 'node:test';

import {colorToHex, colorToRgb, formatLength, formatSize, withAlpha} from '../src/format.js';

test('formats lengths with at most two decimals', () => {
    assert.equal(formatLength(120), '120');
    assert.equal(formatLength(150.4), '150.4');
    assert.equal(formatLength(100 / 3), '33.33');
    assert.equal(formatLength(-0.001), '0');
});

test('formats sizes', () => {
    assert.equal(formatSize(320, 180.5), '320 × 180.5');
});

test('formats colors', () => {
    const color = {red: 255, green: 8, blue: 170};
    assert.equal(colorToHex(color), '#ff08aa');
    assert.equal(colorToRgb(color), 'rgb(255, 8, 170)');
});

test('adds an alpha channel to hex colors and falls back on bad input', () => {
    assert.equal(withAlpha('#0a1B2c', 0.5), 'rgba(10, 27, 44, 0.5)');
    assert.equal(withAlpha('pink', 1), 'rgba(255, 45, 149, 1)');
});
