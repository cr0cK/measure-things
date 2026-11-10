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
    resolveName,
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

test('resolveName trims, keeps the current name when empty, and suffixes a taken name', () => {
    assert.equal(resolveName('  Page B  ', 'Page A', ['Page A']), 'Page B');
    assert.equal(resolveName('', 'Page A', ['Page B']), 'Page A');
    assert.equal(resolveName('   \t', 'Page A', ['Page B']), 'Page A');
    assert.equal(resolveName('Page B', 'Page A', ['Page B']), 'Page B 2');
    assert.equal(resolveName('Page B', 'Page A', ['Page B', 'Page B 2']), 'Page B 3');
    assert.equal(resolveName('Page A', 'Page A', []), 'Page A');
    assert.equal(resolveName('', 'Page A', ['Page A']), 'Page A 2');
    assert.equal(resolveName('x'.repeat(250), 'Page A', []), 'x'.repeat(200));
    assert.equal(resolveName('x'.repeat(250), 'Page A', ['x'.repeat(200)]), `${'x'.repeat(198)} 2`);
});

test('a new set starts from the documented defaults', () => {
    assert.deepEqual(defaultContent(), {
        color: '#ff2d95',
        zoom: 100,
        helpersVisible: true,
        tolerance: 'medium',
        grid: {visible: false, columns: 12, gutter: 24, margin: 24, maxWidth: 0},
        mockup: {file: '', visible: false, x: 0, y: 0, opacity: 50, density: 1},
        helpers: [],
    });
    assert.equal(defaultContent('#33d17a').color, '#33d17a');
});

test('every numeric field accepts its bounds and refuses a whole number past them', () => {
    const valid = sample();
    const grid = changes => ({grid: {...valid.content.grid, ...changes}});
    const mockup = changes => ({mockup: {...valid.content.mockup, ...changes}});
    const table = [
        [{zoom: 25}, {zoom: 24}, 'zoom min'],
        [{zoom: 500}, {zoom: 501}, 'zoom max'],
        [grid({columns: 1}), grid({columns: 0}), 'columns min'],
        [grid({columns: 24}), grid({columns: 25}), 'columns max'],
        [grid({gutter: 0}), grid({gutter: -1}), 'gutter min'],
        [grid({gutter: 400}), grid({gutter: 401}), 'gutter max'],
        [grid({margin: 0}), grid({margin: -1}), 'margin min'],
        [grid({margin: 800}), grid({margin: 801}), 'margin max'],
        [grid({maxWidth: 0}), grid({maxWidth: -1}), 'maxWidth min'],
        [grid({maxWidth: 10000}), grid({maxWidth: 10001}), 'maxWidth max'],
        [mockup({opacity: 5}), mockup({opacity: 4}), 'opacity min'],
        [mockup({opacity: 100}), mockup({opacity: 101}), 'opacity max'],
        [mockup({density: 1}), mockup({density: 0}), 'density min'],
        [mockup({density: 4}), mockup({density: 5}), 'density max'],
    ];
    for (const [ok, refused, why] of table) {
        assert.ok(parseSet(fileOf(valid, ok)).set, `${why}: bound`);
        assert.deepEqual(parseSet(fileOf(valid, refused)), {error: 'invalid'}, `${why}: past the bound`);
    }
    for (const changes of [
        {zoom: 100.5},
        grid({columns: 12.5}),
        mockup({opacity: 50.5}),
        mockup({density: 1.5}),
        {revision: 1.5},
        {schema: 1.5},
    ])
        assert.deepEqual(parseSet(fileOf(valid, changes)), {error: 'invalid'}, JSON.stringify(changes));
    assert.equal(parseSet(fileOf(valid, {revision: 0})).set.revision, 0);
});

test('refuses a file whose objects are null or whose fields have the wrong type', () => {
    const valid = sample();
    assert.deepEqual(parseSet('null'), {error: 'invalid'});
    for (const changes of [
        {grid: null},
        {mockup: null},
        {helpers: [null]},
        {helpers: null},
        {grid: {...valid.content.grid, visible: 'no'}},
        {mockup: {...valid.content.mockup, file: 3}},
        {mockup: {...valid.content.mockup, visible: 1}},
        {mockup: {...valid.content.mockup, x: '5'}},
        {mockup: {...valid.content.mockup, y: null}},
    ])
        assert.deepEqual(parseSet(fileOf(valid, changes)), {error: 'invalid'}, JSON.stringify(changes));
});

test('refuses helpers that lack a coordinate or have no area', () => {
    const valid = sample();
    for (const helper of [
        {kind: 'vertical', y: 1},
        {kind: 'vertical', x: '1'},
        {kind: 'horizontal', x: 1},
        {kind: 'rectangle', x: 1, y: 1, width: 4},
        {kind: 'rectangle', x: 1, y: 1, height: 4},
        {kind: 'rectangle', x: 1, width: 4, height: 4},
        {kind: 'rectangle', x: 1, y: 1, width: 4, height: 0},
        {kind: 'rectangle', x: 1, y: 1, width: 0, height: 4},
        {kind: 'rectangle', x: 1, y: 1, width: 4, height: -2},
        {kind: 'rectangle', x: 1, y: 1, width: -2, height: 4},
        {kind: 'rectangle', x: 1, y: 1, width: 0.001, height: 4},
    ])
        assert.deepEqual(parseSet(fileOf(valid, {helpers: [helper]})), {error: 'invalid'}, JSON.stringify(helper));
    const {set} = parseSet(fileOf(valid, {helpers: [{kind: 'rectangle', x: 1, y: 1, width: 0.01, height: 0.01}]}));
    assert.equal(set.content.helpers[0].width, 0.01);
});

test('reads a color in either case and stores it in lower case', () => {
    assert.equal(parseSet(fileOf(sample(), {color: '#FF2D95'})).set.content.color, '#ff2d95');
    assert.deepEqual(parseSet(fileOf(sample(), {color: '#ff2d95zz'})), {error: 'invalid'});
    assert.deepEqual(parseSet(fileOf(sample(), {color: 'x#ff2d95'})), {error: 'invalid'});
    assert.deepEqual(parseSet(fileOf(sample(), {color: '#ff2d9'})), {error: 'invalid'});
});

test('rounds the mockup position like helper lengths', () => {
    const mockup = {...sample().content.mockup, x: 10.456, y: -3.3333};
    const {set} = parseSet(fileOf(sample(), {mockup}));
    assert.equal(set.content.mockup.x, 10.46);
    assert.equal(set.content.mockup.y, -3.33);
});

test('measures the file size limit in bytes, by default the text length', () => {
    assert.deepEqual(parseSet(' '.repeat(MAX_FILE_BYTES + 1)), {error: 'too-large'});
    assert.deepEqual(parseSet(' '.repeat(MAX_FILE_BYTES)), {error: 'invalid'});
    assert.deepEqual(parseSet('{}', MAX_FILE_BYTES), {error: 'invalid'});
    assert.deepEqual(parseSet(serializeSet(sample()), 5), {set: sample()});
});

test('set IDs are 1 to 64 letters, digits, and dashes', () => {
    for (const id of ['a', 'A-9', 'x'.repeat(64)])
        assert.equal(parseSet(fileOf(sample(), {id})).set.id, id, id);
    for (const id of ['x'.repeat(65), 'a_b', 'a.b', 'a b', 'a/b'])
        assert.deepEqual(parseSet(fileOf(sample(), {id})), {error: 'invalid'}, id);
});

test('writes a set file indented by two spaces and ends it with a newline', () => {
    const text = serializeSet(sample());
    assert.ok(text.endsWith('}\n'));
    assert.ok(text.startsWith('{\n  "schema": 1,\n  "id": "a1b2-c3",\n'));
    assert.deepEqual(Object.keys(JSON.parse(text)), [
        'schema', 'id', 'name', 'revision', 'edited',
        'color', 'zoom', 'helpersVisible', 'tolerance', 'grid', 'mockup', 'helpers',
    ]);
});

test('numbers new sets after the highest Untitled number wherever it is', () => {
    assert.equal(nextUntitledName(['Untitled 7', 'Untitled 3']), 'Untitled 8');
    assert.equal(nextUntitledName(['My Untitled 9', 'Untitled 9 copy', 'Untitled 2']), 'Untitled 3');
});

test('trims a name, also where the cut leaves a space at its end', () => {
    assert.equal(uniqueName('  Page A ', []), 'Page A');
    assert.equal(uniqueName(`${'x'.repeat(199)} y`, []), 'x'.repeat(199));
    const name = `${'x'.repeat(197)} ${'y'.repeat(10)}`;
    assert.equal(uniqueName(name, [`${'x'.repeat(197)} yy`]), `${'x'.repeat(197)} 2`);
});

test('makes room for a suffix of several digits', () => {
    const long = 'x'.repeat(250);
    const taken = ['x'.repeat(200)];
    for (let n = 2; n < 10; n++)
        taken.push(`${'x'.repeat(198)} ${n}`);
    assert.equal(uniqueName(long, taken), `${'x'.repeat(197)} 10`);
});

test('reads an entry that is not a finite number as the previous value', () => {
    assert.equal(readWholeNumber('Infinity', [1, 24], 6), 6);
    assert.equal(readWholeNumber('-Infinity', [1, 24], 6), 6);
    assert.equal(readWholeNumber('0', [1, 24], 6), 1);
});

test('cuts a badge name to nothing but the ellipsis for a zero length', () => {
    assert.equal(badgeName('abc', 0), '…');
    assert.equal(badgeName('abc', 1), '…');
});

test('matches used colors without regard to case', () => {
    assert.equal(nextColor(['#FF2D95']), PALETTE[1]);
    assert.equal(nextColor(['#FF2D95', '#2EC2D6', '#F5A623']), PALETTE[3]);
});
