import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    MAX_FILE_BYTES,
    MAX_HELPERS,
    PALETTE,
    SCHEMA_VERSION,
    badgeName,
    defaultContent,
    nextColor,
    nextUntitledName,
    parseSet,
    readWholeNumber,
    roundCss,
    serializeSet,
    uniqueName,
} from '../src/sets.js';

const EDITED = Date.parse('2026-11-01T12:00:00.000Z');
const sample = (content = {}) => ({
    id: 'a1b2-c3',
    name: 'Project A',
    revision: 3,
    edited: EDITED,
    migrated: false,
    content: {...defaultContent(), ...content},
});
const fileOf = (set, changes = {}) => JSON.stringify({...JSON.parse(serializeSet(set)), ...changes});

test('serializes a set and reads it back', () => {
    const set = sample({helpers: [
        {kind: 'vertical', x: 100.5},
        {kind: 'horizontal', y: -20},
        {kind: 'rectangle', x: 1, y: 2, width: 30.25, height: 5},
    ]});
    const text = serializeSet(set);
    assert.equal(JSON.parse(text).schema, SCHEMA_VERSION);
    assert.equal(JSON.parse(text).edited, '2026-11-01T12:00:00.000Z');
    assert.deepEqual(parseSet(text), {set});
});

test('leaves runtime helper ids and an unset migration flag out of the file', () => {
    const file = JSON.parse(serializeSet(sample({helpers: [{id: 7, kind: 'vertical', x: 1}]})));
    assert.deepEqual(file.helpers, [{kind: 'vertical', x: 1}]);
    assert.equal('migrated' in file, false);
    assert.equal(JSON.parse(serializeSet({...sample(), migrated: true})).migrated, true);
});

test('rounds lengths to two decimals', () => {
    assert.equal(roundCss(100.456), 100.46);
    assert.equal(roundCss(-0.001), 0);
    const {set} = parseSet(fileOf(sample(), {helpers: [{kind: 'vertical', x: 33.3333}]}));
    assert.deepEqual(set.content.helpers, [{kind: 'vertical', x: 33.33}]);
});

test('reports files that are not valid sets', () => {
    const valid = sample();
    for (const changes of [
        {id: ''},
        {id: '../escape'},
        {id: 123},
        {color: ['#ff2d95']},
        {name: '   '},
        {revision: -1},
        {edited: 'yesterday'},
        {color: 'pink'},
        {zoom: 20},
        {tolerance: 'extreme'},
        {helpersVisible: 'yes'},
        {grid: {...valid.content.grid, columns: 30}},
        {mockup: {...valid.content.mockup, density: 5}},
        {helpers: [{kind: 'circle', x: 1}]},
        {helpers: [{kind: 'rectangle', x: 1, y: 1, width: 0, height: 4}]},
        {schema: 0},
        {migrated: 'no'},
    ])
        assert.deepEqual(parseSet(fileOf(valid, changes)), {error: 'invalid'}, JSON.stringify(changes));
    assert.deepEqual(parseSet('{not json'), {error: 'invalid'});
    assert.deepEqual(parseSet('[]'), {error: 'invalid'});
});

test('refuses newer schemas and files over the limits', () => {
    assert.deepEqual(parseSet(fileOf(sample(), {schema: SCHEMA_VERSION + 1})), {error: 'newer'});
    assert.deepEqual(parseSet('{}', MAX_FILE_BYTES + 1), {error: 'too-large'});
    const helpers = Array.from({length: MAX_HELPERS + 1}, () => ({kind: 'vertical', x: 1}));
    assert.deepEqual(parseSet(fileOf(sample(), {helpers})), {error: 'invalid'});
    assert.ok(parseSet(fileOf(sample(), {helpers: helpers.slice(1)})).set);
});

test('numbers new sets after the highest Untitled number', () => {
    assert.equal(nextUntitledName([]), 'Untitled 1');
    assert.equal(nextUntitledName(['Untitled 1', 'Untitled 4', 'Untitled 2 2', 'Project']), 'Untitled 5');
});

test('suffixes a name that is already taken', () => {
    assert.equal(uniqueName('Project A', ['Project B']), 'Project A');
    assert.equal(uniqueName('Project A', ['Project A']), 'Project A 2');
    assert.equal(uniqueName('Project A', ['Project A', 'Project A 2', 'Project A 3']), 'Project A 4');
    const long = 'x'.repeat(250);
    assert.equal(uniqueName(long, []), 'x'.repeat(200));
    assert.equal(uniqueName(long, ['x'.repeat(200)]), `${'x'.repeat(198)} 2`);
});

test('gives a new set the first palette color nobody on screen uses', () => {
    assert.equal(nextColor([]), PALETTE[0]);
    assert.equal(nextColor(['#FF2D95', '#f5a623']), PALETTE[1]);
    assert.equal(nextColor(PALETTE), PALETTE[0]);
});

test('reads and writes a migrated set file as it is', () => {
    const text = serializeSet({...sample(), migrated: true});
    const {set} = parseSet(text);
    assert.equal(set.migrated, true);
    assert.equal(serializeSet(set), text);
});

test('counts names in Unicode characters and does not normalize a name read from a file', () => {
    const emoji = '🎨'.repeat(200);
    assert.equal(parseSet(fileOf(sample(), {name: emoji})).set.name, emoji);
    assert.deepEqual(parseSet(fileOf(sample(), {name: `${emoji}x`})), {error: 'invalid'});
    assert.equal(parseSet(fileOf(sample(), {name: '  padded '})).set.name, '  padded ');
    assert.equal(uniqueName(`${emoji}x`, []), emoji);
    assert.equal(uniqueName(emoji, [emoji]), `${'🎨'.repeat(198)} 2`);
});

test('refuses an edited time that is not a date string', () => {
    assert.deepEqual(parseSet(fileOf(sample(), {edited: 1762000000000})), {error: 'invalid'});
});

test('reads a number from an entry: rounded, clamped, or the previous value', () => {
    const range = [1, 24];
    assert.equal(readWholeNumber('12', range, 6), 12);
    assert.equal(readWholeNumber(' 7.6 ', range, 6), 8);
    assert.equal(readWholeNumber('99', range, 6), 24);
    assert.equal(readWholeNumber('-3', range, 6), 1);
    assert.equal(readWholeNumber('', range, 6), 6);
    assert.equal(readWholeNumber('  ', range, 6), 6);
    assert.equal(readWholeNumber('twelve', range, 6), 6);
});

test('cuts a long set name for its badge', () => {
    assert.equal(badgeName('Project A'), 'Project A');
    assert.equal(badgeName('x'.repeat(24)), 'x'.repeat(24));
    assert.equal(badgeName('x'.repeat(25)), `${'x'.repeat(23)}…`);
    assert.equal(badgeName('🎨'.repeat(30)), `${'🎨'.repeat(23)}…`);
    assert.equal(badgeName('Project A', 5), 'Proj…');
});
