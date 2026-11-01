import assert from 'node:assert/strict';
import {test} from 'node:test';

import {History} from '../src/history.js';

test('undoes and redoes recorded states', () => {
    const history = new History('a');
    history.record('b');
    history.record('c');
    assert.equal(history.undo(), 'b');
    assert.equal(history.undo(), 'a');
    assert.equal(history.undo(), null);
    assert.equal(history.redo(), 'b');
    assert.equal(history.redo(), 'c');
    assert.equal(history.redo(), null);
});

test('skips a state equal to the current one', () => {
    const history = new History('a');
    assert.equal(history.record('a'), false);
    assert.equal(history.undo(), null);
});

test('drops the redo states when recording after an undo', () => {
    const history = new History('a');
    history.record('b');
    history.undo();
    history.record('c');
    assert.equal(history.redo(), null);
    assert.equal(history.undo(), 'a');
});

test('forgets the oldest states past the limit', () => {
    const history = new History('a', 2);
    history.record('b');
    history.record('c');
    assert.equal(history.undo(), 'b');
    assert.equal(history.undo(), null);
});

test('rewrites every state without moving through them', () => {
    const history = new History('a1');
    history.record('b1');
    history.undo();
    history.rewrite(state => state.replace('1', '2'));
    assert.equal(history.current, 'a2');
    assert.equal(history.redo(), 'b2');
});
