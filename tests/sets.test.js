import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    MAX_FILE_BYTES,
    MAX_HELPERS,
    PALETTE,
    SCHEMA_VERSION,
    defaultContent,
    migrateSettings,
    nextColor,
    nextUntitledName,
    parseSet,
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
});

test('gives a new set the first palette color nobody on screen uses', () => {
    assert.equal(nextColor([]), PALETTE[0]);
    assert.equal(nextColor(['#FF2D95', '#f5a623']), PALETTE[1]);
    assert.equal(nextColor(PALETTE), PALETTE[0]);
});

const V02 = {
    helpers: '[]',
    showHelpers: true,
    color: '#ff2d95',
    zoom: 100,
    gridColumns: 12,
    gridGutter: 24,
    gridMargin: 24,
    gridMaxWidth: 0,
    mockupFile: '',
    mockupVisible: false,
    mockupOpacity: 50,
    mockupDensity: 1,
    mockupPosition: [0, 0],
};

test('migrates nothing from default v0.2 settings', () => {
    assert.equal(migrateSettings(V02, {origin: [0, 0], toCss: v => v}), null);
});

test('migrates v0.2 helpers relative to the primary monitor, in CSS pixels', () => {
    const content = migrateSettings({
        ...V02,
        helpers: JSON.stringify([
            {kind: 'vertical', x: 1700},
            {kind: 'horizontal', y: 50},
            {kind: 'rectangle', x: 1610, y: 110, width: 125, height: 50},
        ]),
        showHelpers: false,
        color: '#33D17A',
        zoom: 125,
        mockupPosition: [1500, 0],
    }, {origin: [1600, 100], toCss: value => value / 1.25});
    assert.deepEqual(content.helpers, [
        {kind: 'vertical', x: 80},
        {kind: 'horizontal', y: -40},
        {kind: 'rectangle', x: 8, y: 8, width: 100, height: 40},
    ]);
    assert.equal(content.color, '#33d17a');
    assert.equal(content.zoom, 125);
    assert.equal(content.helpersVisible, false);
    assert.deepEqual([content.mockup.x, content.mockup.y], [-80, -80]);
});

test('migrates a v0.2 mockup and non-default grid', () => {
    const content = migrateSettings({
        ...V02,
        gridColumns: 6,
        mockupFile: '/home/me/design.png',
        mockupVisible: true,
        mockupOpacity: 70,
        mockupDensity: 2,
    }, {origin: [0, 0], toCss: v => v});
    assert.deepEqual(content.grid, {visible: false, columns: 6, gutter: 24, margin: 24, maxWidth: 0});
    assert.deepEqual(content.mockup, {file: '/home/me/design.png', visible: true, x: 0, y: 0, opacity: 70, density: 2});
    assert.deepEqual(content.helpers, []);
});
