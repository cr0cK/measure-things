import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    SETTLE_MS,
    eventAction,
    idOfName,
    importedSet,
    isOwn,
    isSetFileName,
    judge,
    noticeFor,
    planScan,
    renamedSet,
} from '../src/library.js';
import {defaultContent, parseSet, serializeSet} from '../src/sets.js';

const EDITED = Date.parse('2026-11-01T12:00:00.000Z');
const set = (id, name = 'Project A', changes = {}) => ({
    id,
    name,
    revision: 3,
    edited: EDITED,
    migrated: false,
    content: defaultContent(),
    ...changes,
});
/** A file as the store reads it. */
const disk = (name, text, etag = 'e1', title = name) => ({
    name,
    etag,
    text,
    title,
    parsed: text === null ? {error: 'unreadable'} : parseSet(text),
});
const fileOf = (value, changes = {}) => JSON.stringify({...JSON.parse(serializeSet(value)), ...changes});
const free = () => false;
const taken = ids => id => ids.includes(id);

test('a file is a set file when it ends in .json and is not a temporary file', () => {
    assert.equal(isSetFileName('a1.json'), true);
    assert.equal(isSetFileName('.goutputstream-X.json'), false);
    assert.equal(isSetFileName('a1.json~'), false);
    assert.equal(isSetFileName('notes.txt'), false);
    assert.equal(idOfName('a1.json'), 'a1');
});

test('events settle on the hint, or after a quiet time; unmount events are ignored', () => {
    assert.equal(SETTLE_MS, 300);
    const table = {
        CHANGES_DONE_HINT: 'now',
        CREATED: 'later',
        CHANGED: 'later',
        DELETED: 'later',
        RENAMED: 'later',
        MOVED_IN: 'later',
        MOVED_OUT: 'later',
        ATTRIBUTE_CHANGED: 'later',
        PRE_UNMOUNT: 'ignore',
        UNMOUNTED: 'ignore',
    };
    for (const [event, action] of Object.entries(table))
        assert.equal(eventAction(event), action, event);
});

test('a file is the shell\'s own write when it has the known etag or the known text', () => {
    const known = {etag: 'e1', text: 'one'};
    const table = [
        [known, {etag: 'e1', text: 'two'}, true, 'same etag'],
        [known, {etag: 'e2', text: 'one'}, true, 'same text, written again by someone else'],
        [known, {etag: 'e2', text: 'two'}, false, 'another etag and another text'],
        [known, {etag: null, text: null}, false, 'unreadable'],
        [{etag: 'e1', text: null}, {etag: 'e2', text: null}, false, 'no text to compare'],
        [{etag: null, text: 'one'}, {etag: null, text: 'two'}, false, 'no etag to compare'],
        [null, {etag: 'e1', text: 'one'}, false, 'nothing known'],
        [known, null, false, 'gone'],
    ];
    for (const [last, current, own, why] of table)
        assert.equal(isOwn(last, current), own, why);
});

test('judging a name once it settled', () => {
    const a = set('a1');
    const text = serializeSet(a);
    const known = {etag: 'e1', text};
    const other = serializeSet(set('a1', 'Edited'));
    const stranger = serializeSet(set('b2'));
    const table = [
        // [description, entry, disk, known, isTaken, expected action]
        ['nothing there, nothing known', null, null, null, free, 'none'],
        ['a set\'s file is gone', 'set', null, known, free, 'remove'],
        ['an unavailable file is gone', 'unavailable', null, null, free, 'remove'],
        ['the shell\'s own write', 'set', disk('a1.json', text, 'e1'), known, free, 'none'],
        ['a rewrite of the same text', 'set', disk('a1.json', text, 'e9'), known, free, 'none'],
        ['an edit by another program', 'set', disk('a1.json', other, 'e2'), known, free, 'replace'],
        ['a file that now holds another ID', 'set', disk('a1.json', stranger, 'e2'), known, free, 'reimport'],
        ['a file that became invalid', 'set', disk('a1.json', '{', 'e2'), known, free, 'unavailable'],
        ['a file that became unreadable', 'set', disk('a1.json', null, null), known, free, 'unavailable'],
        ['an unavailable file, unchanged', 'unavailable', disk('a1.json', '{', 'e1'), {etag: 'e1', text: '{'}, free,
            'none'],
        ['an unavailable file that turned valid, free', 'unavailable', disk('a1.json', text, 'e2'),
            {etag: 'e1', text: '{'}, free, 'add'],
        ['an unavailable file that turned valid, misnamed', 'unavailable', disk('copy.json', text, 'e2'),
            {etag: 'e1', text: '{'}, free, 'import'],
        ['a new file named after its ID', null, disk('a1.json', text), null, free, 'add'],
        ['a new file named after its ID, deleted this session', null, disk('a1.json', text), null,
            taken(['a1']), 'import'],
        ['a new file named differently', null, disk('copy.json', text), null, free, 'import'],
        ['a new file whose name only starts with its ID', null, disk('a1-copy.json', text), null, free, 'import'],
        ['an existing file whose name only starts with its ID', 'set', disk('a1x.json', other, 'e2'), known, free,
            'reimport'],
        ['a new file holding the ID of another file', null, disk('b2.json', text), null, free, 'import'],
        ['a new invalid file', null, disk('a1.json', '[]'), null, free, 'unavailable'],
        ['a new file of a newer version', null, disk('a1.json', fileOf(a, {schema: 2})), null, free, 'unavailable'],
        ['a new unreadable file', null, disk('a1.json', null, null), null, free, 'unavailable'],
    ];
    for (const [why, entry, current, last, isTaken, action] of table)
        assert.equal(judge({name: current?.name ?? 'a1.json', entry, disk: current, known: last, isTaken}).action, action, why);
});

test('a file that comes back after its removal settled is never the shell\'s own write', () => {
    // The removal forgets the etag and the text, so the same bytes are judged as a new file; the
    // ID is covered by a tombstone, so it is imported.
    const text = serializeSet(set('a1'));
    assert.equal(judge({name: 'a1.json', entry: null, disk: disk('a1.json', text, 'e1'), known: null,
        isTaken: taken(['a1'])}).action, 'import');
});

test('a conflict reloads the file even when it holds the text the shell knows', () => {
    const text = serializeSet(set('a1'));
    const known = {etag: 'e1', text};
    const args = {name: 'a1.json', entry: 'set', disk: disk('a1.json', text, 'e2'), known, isTaken: free};
    assert.equal(judge(args).action, 'none');
    assert.equal(judge({...args, force: true}).action, 'replace');
    assert.equal(judge({...args, disk: null, force: true}).action, 'remove');
});

test('a judged file carries the set it holds', () => {
    const text = serializeSet(set('a1', 'Edited'));
    const verdict = judge({name: 'a1.json', entry: 'set', disk: disk('a1.json', text, 'e2'),
        known: {etag: 'e1', text: ''}, isTaken: free});
    assert.equal(verdict.set.name, 'Edited');
    const bad = judge({name: 'a1.json', entry: null, disk: disk('a1.json', '{}', 'e2', 'My title'), known: null,
        isTaken: free});
    assert.equal(bad.error, 'invalid');
    assert.equal(bad.title, 'My title');
});

test('an imported set has a fresh ID, the import time, and a free name', () => {
    const original = set('a1', 'Project A', {migrated: true});
    const copy = importedSet(original, {id: 'n1', now: 1234, taken: ['Project A', 'Project A 2']});
    assert.equal(copy.id, 'n1');
    assert.equal(copy.name, 'Project A 3');
    assert.equal(copy.edited, 1234);
    assert.equal(copy.revision, 0);
    assert.equal(copy.migrated, false);
    assert.deepEqual(copy.content, original.content);
    assert.notEqual(copy.content, original.content);
    assert.equal(original.id, 'a1');
});

test('a suffix on a found file bumps its revision and keeps the time it was edited', () => {
    const original = set('a1');
    const renamed = renamedSet(original, 'Project A 2');
    assert.equal(renamed.name, 'Project A 2');
    assert.equal(renamed.revision, 4);
    assert.equal(renamed.edited, EDITED);
    assert.notEqual(renamed.content, original.content);
    assert.deepEqual(renamed.content, original.content);
});

test('the startup scan sorts files into the library, imports, and unavailable', () => {
    let next = 0;
    const files = [
        disk('a1.json', serializeSet(set('a1', 'One'))),
        disk('copy.json', serializeSet(set('a1', 'One'))),
        disk('b2.json', serializeSet(set('zz', 'Two'))),
        disk('c3.json', '{'),
        disk('d4.json', serializeSet(set('d4', 'Four'))),
        disk('e5.json', serializeSet(set('e5', 'Five'))),
    ];
    const plan = planScan(files, {isTaken: taken(['e5']), newId: () => `n${++next}`, now: 99});
    assert.deepEqual(plan.library.map(item => item.name), ['a1.json', 'd4.json']);
    assert.deepEqual(plan.imports.map(item => [item.name, item.copy.id, item.copy.name, item.copy.edited]), [
        ['b2.json', 'n1', 'Two', 99],
        ['copy.json', 'n2', 'One 2', 99],
        ['e5.json', 'n3', 'Five', 99],
    ]);
    assert.deepEqual(plan.unavailable.map(item => item.name), ['c3.json']);
});

test('among files found with the same name, the earliest edited keeps it, then the lower ID', () => {
    const files = [
        disk('c3.json', serializeSet(set('c3', 'Same', {edited: EDITED + 10}))),
        disk('b2.json', serializeSet(set('b2', 'Same', {edited: EDITED}))),
        disk('a1.json', serializeSet(set('a1', 'Same', {edited: EDITED}))),
        disk('d4.json', serializeSet(set('d4', 'Same 2', {edited: EDITED + 20}))),
    ];
    const plan = planScan(files, {isTaken: free, newId: () => 'n', now: 0});
    assert.deepEqual(plan.library.map(item => [item.set.id, item.set.name, item.renamed]), [
        ['a1', 'Same', false],
        ['b2', 'Same 2', true],
        ['c3', 'Same 3', true],
        ['d4', 'Same 2 2', true],
    ]);
    // The suffix goes to the file once: its revision moves, its edit time does not.
    assert.equal(plan.library[1].set.revision, 4);
    assert.equal(plan.library[1].set.edited, EDITED);
});

test('imports take names after the library has settled its own', () => {
    const files = [
        disk('a1.json', serializeSet(set('a1', 'One'))),
        disk('copy.json', serializeSet(set('a1', 'One'))),
        disk('copy2.json', serializeSet(set('a1', 'One'))),
    ];
    const plan = planScan(files, {isTaken: free, newId: (() => { let n = 0; return () => `n${++n}`; })(), now: 5});
    assert.deepEqual(plan.library.map(item => item.set.name), ['One']);
    assert.deepEqual(plan.imports.map(item => item.copy.name), ['One 2', 'One 3']);
});

test('the notices say what happened, once', () => {
    const table = [
        [['edited', {name: 'A'}],
            '“A” was changed outside Measure Things; the file on disk was kept and the undo history starts over.'],
        [['edited', {name: 'A', dropped: 1}],
            '“A” was changed outside Measure Things; the file on disk was kept and the undo history starts over. ' +
            '1 change not saved was dropped.'],
        [['edited', {name: 'A', dropped: 3}],
            '“A” was changed outside Measure Things; the file on disk was kept and the undo history starts over. ' +
            '3 changes not saved were dropped.'],
        [['removed', {name: 'A'}], '“A” was removed from the sets folder, and left the screen.'],
        [['removed', {name: 'A', lost: 2}],
            '“A” was removed from the sets folder, and left the screen. 2 local changes in its unlinked copies were lost.'],
        [['unavailable', {name: 'A', lost: 1}],
            '“A” can no longer be read, and left the screen. 1 local change in its unlinked copies was lost.'],
        [['removed', {name: 'A', dropped: 2, lost: 1}],
            '“A” was removed from the sets folder, and left the screen. 2 changes not saved were dropped. ' +
            '1 local change in its unlinked copies was lost.'],
        [['unavailable', {name: 'A', dropped: 1, lost: 3}],
            '“A” can no longer be read, and left the screen. 1 change not saved was dropped. ' +
            '3 local changes in its unlinked copies were lost.'],
        [['replaced', {name: 'A'}], 'The file of “A” now holds another set; “A” left the screen.'],
        [['replaced', {name: 'A', dropped: 1, lost: 2}],
            'The file of “A” now holds another set; “A” left the screen. 1 change not saved was dropped. ' +
            '2 local changes in its unlinked copies were lost.'],
    ];
    for (const [[kind, details], text] of table)
        assert.equal(noticeFor(kind, details), text);
    assert.throws(() => noticeFor('unknown', {name: 'A'}));
});
