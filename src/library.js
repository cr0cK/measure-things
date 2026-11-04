// Decision rules for the sets folder: what a change in it means once it has settled, how files
// found there become sets, and what the user is told. Imports nothing from gi://, so node --test
// covers it; store.js does the reading, the writing, and the waiting.

import {uniqueName} from './sets.js';

/** How long a name must stay without an event before the shell acts on it. */
export const SETTLE_MS = 300;

/** The ID a file name stands for: `<id>.json`. */
export const idOfName = name => name.replace(/\.json$/, '');

/** Whether a name in the folder can be a set file: `.json`, and not a temporary file. */
export const isSetFileName = name => name.endsWith('.json') && !name.startsWith('.');

/**
 * What a folder event asks of the shell, from the name of its `Gio.FileMonitorEvent`: act at
 * once (`CHANGES_DONE_HINT`), act once the name has been quiet for SETTLE_MS, or nothing.
 */
export function eventAction(eventName) {
    if (eventName === 'CHANGES_DONE_HINT')
        return 'now';
    return ['ATTRIBUTE_CHANGED', 'PRE_UNMOUNT', 'UNMOUNTED'].includes(eventName) ? 'ignore' : 'later';
}

/**
 * Whether a file as it is now is the shell's own write, or no change: it has the etag or the text
 * of the last successful read or write of that file. `known` and `current` are `{etag, text}`.
 */
export function isOwn(known, current) {
    if (!known || !current)
        return false;
    return (current.etag !== null && current.etag === known.etag) ||
        (current.text !== null && current.text === known.text);
}

/**
 * Judges a name once its events settled and its write queue is idle, against the file as it is
 * now. `entry` is what the library holds for the name: `'set'`, `'unavailable'`, or null. `disk`
 * is null when the file is gone, otherwise `{etag, text, title, parsed}` with `parsed` the result
 * of parseSet(). `force` skips the own-write test, for a write that failed on a conflict.
 *
 * Returns `{action}`, one of:
 * - `none`: nothing changed, or the shell's own write;
 * - `add`: a new file named after the ID it holds, whose ID is free: it joins the library;
 * - `import`: any other new file, such as a copy, a file named differently, or one holding an
 *   ID deleted this session; a file that turns from unavailable to valid is a new file;
 * - `reimport`: an existing file whose ID now differs from its name: the set it held goes, and
 *   the file is imported;
 * - `replace`: another program edited an existing file;
 * - `remove`: the file is gone;
 * - `unavailable`: the file cannot be read, is invalid, is too large, or is of a newer version.
 */
export function judge({name, entry, disk, known, force = false, isTaken}) {
    if (!disk)
        return {action: entry ? 'remove' : 'none'};
    if (entry && !force && isOwn(known, disk))
        return {action: 'none'};
    if (disk.parsed.error)
        return {action: 'unavailable', error: disk.parsed.error, title: disk.title};
    const {set} = disk.parsed;
    const named = name === `${set.id}.json`;
    if (entry === 'set')
        return named ? {action: 'replace', set} : {action: 'reimport', set};
    return named && !isTaken(set.id) ? {action: 'add', set} : {action: 'import', set};
}

/** A set as a file of another name or ID is imported: a fresh ID, edited now, a free name. */
export function importedSet(set, {id, now, taken}) {
    return {
        ...JSON.parse(JSON.stringify(set)),
        id,
        name: uniqueName(set.name, taken),
        edited: now,
        revision: 0,
        migrated: false,
    };
}

/** The set with another name, for the write that gives a file found in the folder its suffix. */
export function renamedSet(set, name) {
    return {...JSON.parse(JSON.stringify(set)), name, revision: set.revision + 1};
}

/**
 * The startup scan, over every file read: `disks` are `{name, etag, text, title, parsed}`.
 * Returns `{library, imports, unavailable}`:
 * - `library`: `{name, disk, set}` for each file that joins the library. Among files found with
 *   the same name, the one edited earliest keeps it, then the lower ID; the others get a numeric
 *   suffix, and `renamed` is true on them, as the suffix is written to their file once;
 * - `imports`: `{name, disk, copy}`, `copy` being the set to write under a fresh ID;
 * - `unavailable`: `{name, disk}`.
 */
export function planScan(disks, {isTaken, newId, now}) {
    const library = [];
    const imports = [];
    const unavailable = [];
    for (const disk of [...disks].sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const {action, set} = judge({name: disk.name, entry: null, disk, known: null, isTaken});
        if (action === 'add')
            library.push({name: disk.name, disk, set, renamed: false});
        else if (action === 'import')
            imports.push({name: disk.name, disk, set});
        else
            unavailable.push({name: disk.name, disk});
    }
    library.sort((a, b) => a.set.edited - b.set.edited || (a.set.id < b.set.id ? -1 : 1));
    const taken = [];
    for (const item of library) {
        const name = uniqueName(item.set.name, taken);
        if (name !== item.set.name) {
            item.set = renamedSet(item.set, name);
            item.renamed = true;
        }
        taken.push(name);
    }
    for (const item of imports) {
        item.copy = importedSet(item.set, {id: newId(), now, taken});
        taken.push(item.copy.name);
    }
    return {library, imports: imports.map(({name, disk, copy}) => ({name, disk, copy})), unavailable};
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * What the user is told when a set changes under them. `kind` is `edited` (another program
 * edited the file), `removed`, `unavailable`, or `replaced` (the file now holds another set);
 * `dropped` counts the commits a conflicting write lost, and `lost` the local changes of the
 * unlinked copies that left the screen with the set.
 */
export function noticeFor(kind, {name, dropped = 0, lost = 0}) {
    const droppedText = dropped > 0 ? ` ${plural(dropped, 'change')} not saved ${dropped === 1 ? 'was' : 'were'} dropped.` : '';
    const lostText = lost > 0 ? ` ${plural(lost, 'local change')} in its unlinked copies ${lost === 1 ? 'was' : 'were'} lost.` : '';
    switch (kind) {
    case 'edited':
        return `“${name}” was changed outside Measure Things; the file on disk was kept and the undo ` +
            `history starts over.${droppedText}`;
    case 'removed':
        return `“${name}” was removed from the sets folder, and left the screen.${droppedText}${lostText}`;
    case 'unavailable':
        return `“${name}” can no longer be read, and left the screen.${droppedText}${lostText}`;
    case 'replaced':
        return `The file of “${name}” now holds another set; “${name}” left the screen.${droppedText}${lostText}`;
    default:
        throw new Error(`Unknown notice ${kind}`);
    }
}
