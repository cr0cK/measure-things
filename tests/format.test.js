import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    colorToHex,
    colorToHsl,
    colorToRgb,
    formatColor,
    formatAccelerator,
    formatEdited,
    formatLength,
    formatSize,
    withAlpha,
} from '../src/format.js';

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
    // Fractional channels round to the nearest value.
    assert.equal(colorToHex({red: 127.5, green: 0.4, blue: 254.6}), '#8000ff');
    assert.equal(colorToRgb({red: 127.5, green: 0.4, blue: 254.6}), 'rgb(128, 0, 255)');
});

test('adds an alpha channel to hex colors and falls back on bad input', () => {
    assert.equal(withAlpha('#0a1B2c', 0.5), 'rgba(10, 27, 44, 0.5)');
    assert.equal(withAlpha('pink', 1), 'rgba(255, 45, 149, 1)');
    assert.equal(withAlpha('x#0a1b2c', 1), 'rgba(255, 45, 149, 1)');
    assert.equal(withAlpha('#0a1b2c4', 1), 'rgba(255, 45, 149, 1)');
});

test('formats colors as HSL', () => {
    assert.equal(colorToHsl({red: 255, green: 0, blue: 0}), 'hsl(0, 100%, 50%)');
    assert.equal(colorToHsl({red: 28, green: 113, blue: 216}), 'hsl(213, 77%, 48%)');
    assert.equal(colorToHsl({red: 128, green: 128, blue: 128}), 'hsl(0, 0%, 50%)');
    assert.equal(colorToHsl({red: 255, green: 0, blue: 1}), 'hsl(0, 100%, 50%)');
    assert.equal(colorToHsl({red: 0, green: 255, blue: 128}), 'hsl(150, 100%, 50%)');
    assert.equal(colorToHsl({red: 128, green: 255, blue: 0}), 'hsl(90, 100%, 50%)');
    assert.equal(colorToHsl({red: 0, green: 128, blue: 255}), 'hsl(210, 100%, 50%)');
});

test('formats colors in the chosen format', () => {
    const color = {red: 255, green: 8, blue: 170};
    assert.equal(formatColor(color, 'hex'), '#ff08aa');
    assert.equal(formatColor(color, 'rgb'), 'rgb(255, 8, 170)');
    assert.equal(formatColor(color, 'hsl'), 'hsl(321, 100%, 52%)');
    assert.equal(formatColor(color, 'cmyk'), '#ff08aa');
});

test('says when a set was last edited', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    const minutes = n => now - n * 60 * 1000;
    assert.equal(formatEdited(now, now), 'edited just now');
    assert.equal(formatEdited(minutes(2), now), 'edited 2 min ago');
    assert.equal(formatEdited(minutes(90), now), 'edited 1 h ago');
    assert.equal(formatEdited(minutes(30 * 60), now), 'edited yesterday');
    assert.equal(formatEdited(minutes(3 * 24 * 60), now), 'edited 3 days ago');
    assert.equal(formatEdited(minutes(9 * 24 * 60), now), 'edited last week');
    assert.equal(formatEdited(minutes(21 * 24 * 60), now), 'edited 3 weeks ago');
    assert.equal(formatEdited(Date.parse('2026-01-15T08:00:00Z'), now), 'edited 2026-01-15');
});

test('says when a set was last edited, exactly on each boundary and in between', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    const MIN = 60 * 1000;
    const HOUR = 60 * MIN;
    const DAY = 24 * HOUR;
    const table = [
        [-5000, 'edited just now', 'an edit time in the future'],
        [MIN - 1, 'edited just now', 'just under a minute'],
        [MIN, 'edited 1 min ago', 'a minute'],
        [90 * 1000, 'edited 1 min ago', 'a minute and a half is not rounded up'],
        [HOUR - 1, 'edited 59 min ago', 'just under an hour'],
        [HOUR, 'edited 1 h ago', 'an hour'],
        [DAY - 1, 'edited 23 h ago', 'just under a day'],
        [DAY, 'edited yesterday', 'a day'],
        [2 * DAY - 1, 'edited yesterday', 'just under two days'],
        [2 * DAY, 'edited 2 days ago', 'two days'],
        [3.6 * DAY, 'edited 3 days ago', 'three and a half days are not rounded up'],
        [7 * DAY - 1, 'edited 6 days ago', 'just under a week'],
        [7 * DAY, 'edited last week', 'a week'],
        [14 * DAY - 1, 'edited last week', 'just under two weeks'],
        [14 * DAY, 'edited 2 weeks ago', 'two weeks'],
        [25 * DAY, 'edited 3 weeks ago', 'three and a half weeks are not rounded up'],
        [62 * DAY, 'edited 8 weeks ago', 'just under nine weeks'],
    ];
    for (const [elapsed, text, why] of table)
        assert.equal(formatEdited(now - elapsed, now), text, why);
    assert.equal(formatEdited(now - 63 * DAY, now), 'edited 2026-08-30');
});

test('spells out a keyboard shortcut', () => {
    assert.equal(formatAccelerator('<Super><Shift>m'), 'Super+Shift+M');
    assert.equal(formatAccelerator('<Control><Alt>k'), 'Ctrl+Alt+K');
    assert.equal(formatAccelerator('<Primary>Escape'), 'Ctrl+Escape');
    assert.equal(formatAccelerator(''), '');
    assert.equal(formatAccelerator('<Meta>x'), 'Meta+X');
    assert.equal(formatAccelerator('<Hyper>x'), 'Hyper+X');
    assert.equal(formatAccelerator('<Alt>Up'), 'Alt+Up');
    assert.equal(formatAccelerator('<Super>'), '');
});
