// Undo and redo over snapshots of a set. Imports nothing from gi://.

/**
 * A linear history of states, compared as strings. Recording after an undo drops the states
 * that could have been redone; the oldest states go first past the limit.
 */
export class History {
    constructor(state, limit = 100) {
        this._states = [state];
        this._index = 0;
        this._limit = limit;
    }

    /** Adds a state unless it equals the current one; returns whether it was added. */
    record(state) {
        if (state === this._states[this._index])
            return false;
        this._states.splice(this._index + 1);
        this._states.push(state);
        if (this._states.length > this._limit)
            this._states.shift();
        this._index = this._states.length - 1;
        return true;
    }

    /** The state undo and redo move from. */
    get current() {
        return this._states[this._index];
    }

    /** Replaces every state with `change(state)`, for edits that are not undoable themselves. */
    rewrite(change) {
        this._states = this._states.map(change);
    }

    /** The previous state, or null at the start. */
    undo() {
        return this._index > 0 ? this._states[--this._index] : null;
    }

    /** The next state, or null at the end. */
    redo() {
        return this._index < this._states.length - 1 ? this._states[++this._index] : null;
    }
}
