// Set files: parsing, validation, serialization, naming. Imports nothing
// from gi://, so node --test covers it. Helper geometry is CSS pixels relative to the zone's
// top-left corner, at the set's browser zoom.

import {HELPER_KINDS} from './geometry.js';

export const SCHEMA_VERSION = 1;
export const MAX_HELPERS = 1000;
export const MAX_FILE_BYTES = 1024 * 1024;
export const PALETTE = ['#ff2d95', '#2ec2d6', '#f5a623', '#33d17a', '#9a6bff'];
export const TOLERANCES = ['low', 'medium', 'high'];
export const ZOOM_RANGE = [25, 500];
export const GRID_RANGES = {columns: [1, 24], gutter: [0, 400], margin: [0, 800], maxWidth: [0, 10000]};
export const OPACITY_RANGE = [5, 100];
export const DENSITY_RANGE = [1, 4];
export const MAX_NAME_LENGTH = 200;
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
// A set's name is counted in Unicode characters, not UTF-16 units.
const BADGE_NAME_LENGTH = 24;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/** A length rounded to two decimals, as set files store them. */
export function roundCss(value) {
    const rounded = Math.round(value * 100) / 100;
    return Object.is(rounded, -0) ? 0 : rounded;
}

/** The content of a new set: everything a set holds but its name. */
export function defaultContent(color = PALETTE[0]) {
    return {
        color,
        zoom: 100,
        helpersVisible: true,
        tolerance: 'medium',
        grid: {visible: false, columns: 12, gutter: 24, margin: 24, maxWidth: 0},
        mockup: {file: '', visible: false, x: 0, y: 0, opacity: 50, density: 1},
        helpers: [],
    };
}

const characters = text => Array.from(text);
const cut = (text, length) => characters(text).slice(0, length).join('');

/** A number typed in an entry: rounded, clamped to a range; `fallback` when empty or not a number. */
export function readWholeNumber(text, [min, max], fallback) {
    const trimmed = text.trim();
    const value = trimmed === '' ? NaN : Number(trimmed);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/** A set's name as its badge shows it: cut with `…` past 24 characters, or `length` when given. */
export function badgeName(name, length = BADGE_NAME_LENGTH) {
    return characters(name).length > length ? `${cut(name, Math.max(0, length - 1))}…` : name;
}

const inRange = (value, [min, max]) => Number.isInteger(value) && value >= min && value <= max;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseHelper(entry) {
    if (!isObject(entry) || !HELPER_KINDS.includes(entry.kind))
        return null;
    const keys = entry.kind === 'horizontal' ? ['y']
        : entry.kind === 'vertical' ? ['x'] : ['x', 'y', 'width', 'height'];
    if (!keys.every(key => Number.isFinite(entry[key])))
        return null;
    const helper = {kind: entry.kind};
    for (const key of keys)
        helper[key] = roundCss(entry[key]);
    if (entry.kind === 'rectangle' && (helper.width <= 0 || helper.height <= 0))
        return null;
    return helper;
}

/** The content of a parsed file, or null when anything in it is invalid. */
function parseContent(raw) {
    const {grid, mockup} = raw;
    if (typeof raw.color !== 'string' || !COLOR_PATTERN.test(raw.color) || !inRange(raw.zoom, ZOOM_RANGE) ||
        typeof raw.helpersVisible !== 'boolean' || !TOLERANCES.includes(raw.tolerance) ||
        !isObject(grid) || typeof grid.visible !== 'boolean' ||
        !Object.entries(GRID_RANGES).every(([key, range]) => inRange(grid[key], range)) ||
        !isObject(mockup) || typeof mockup.file !== 'string' || typeof mockup.visible !== 'boolean' ||
        !Number.isFinite(mockup.x) || !Number.isFinite(mockup.y) ||
        !inRange(mockup.opacity, OPACITY_RANGE) || !inRange(mockup.density, DENSITY_RANGE) ||
        !Array.isArray(raw.helpers) || raw.helpers.length > MAX_HELPERS)
        return null;

    const helpers = raw.helpers.map(parseHelper);
    if (helpers.includes(null))
        return null;
    return {
        color: raw.color.toLowerCase(),
        zoom: raw.zoom,
        helpersVisible: raw.helpersVisible,
        tolerance: raw.tolerance,
        grid: {
            visible: grid.visible,
            columns: grid.columns,
            gutter: grid.gutter,
            margin: grid.margin,
            maxWidth: grid.maxWidth,
        },
        mockup: {
            file: mockup.file,
            visible: mockup.visible,
            x: roundCss(mockup.x),
            y: roundCss(mockup.y),
            opacity: mockup.opacity,
            density: mockup.density,
        },
        helpers,
    };
}

/**
 * Reads a set file. Returns `{set}`, or `{error}`: `too-large` past MAX_FILE_BYTES, `newer` for a
 * later schema version, and `invalid` for anything else that is wrong.
 */
export function parseSet(text, bytes = text.length) {
    if (bytes > MAX_FILE_BYTES)
        return {error: 'too-large'};
    let raw;
    try {
        raw = JSON.parse(text);
    } catch {
        return {error: 'invalid'};
    }
    if (!isObject(raw) || !Number.isInteger(raw.schema) || raw.schema < 1)
        return {error: 'invalid'};
    if (raw.schema > SCHEMA_VERSION)
        return {error: 'newer'};

    // A name read from a file is not normalized: it is invalid, not cut or trimmed.
    const edited = typeof raw.edited === 'string' ? Date.parse(raw.edited) : NaN;
    const name = typeof raw.name === 'string' ? raw.name : '';
    const content = parseContent(raw);
    if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id) || !name.trim() || characters(name).length > MAX_NAME_LENGTH ||
        !Number.isInteger(raw.revision) || raw.revision < 0 || Number.isNaN(edited) ||
        (raw.migrated !== undefined && typeof raw.migrated !== 'boolean') || !content)
        return {error: 'invalid'};
    const migrated = raw.migrated === true;
    return {set: {id: raw.id, name, revision: raw.revision, edited, migrated, content}};
}

/** The file text of a set. Runtime fields, such as helper ids, are left out. */
export function serializeSet({id, name, revision, edited, migrated, content}) {
    const {helpers, ...rest} = content;
    const file = {
        schema: SCHEMA_VERSION,
        id,
        name,
        revision,
        edited: new Date(edited).toISOString(),
        ...(migrated ? {migrated: true} : {}),
        ...rest,
        helpers: helpers.map(({id: _id, ...helper}) => helper),
    };
    return `${JSON.stringify(file, null, 2)}\n`;
}

/** `Untitled N`, with N one more than the highest existing `Untitled` number. */
export function nextUntitledName(names) {
    let highest = 0;
    for (const name of names) {
        const match = /^Untitled (\d+)$/.exec(name);
        if (match)
            highest = Math.max(highest, Number(match[1]));
    }
    return `Untitled ${highest + 1}`;
}

/**
 * The name itself when free, otherwise the name with the first free numeric suffix from 2, cut
 * so that it fits MAX_NAME_LENGTH, as files with longer names do not load.
 */
export function uniqueName(name, takenNames) {
    const taken = new Set(takenNames);
    const fitting = cut(name, MAX_NAME_LENGTH).trim();
    if (!taken.has(fitting))
        return fitting;
    let suffix = 2;
    const withSuffix = () => `${cut(name, MAX_NAME_LENGTH - ` ${suffix}`.length).trim()} ${suffix}`;
    while (taken.has(withSuffix()))
        suffix++;
    return withSuffix();
}

/** The first palette color that no set on screen uses, or the first one when all are. */
export function nextColor(usedColors) {
    const used = new Set(usedColors.map(color => color.toLowerCase()));
    return PALETTE.find(color => !used.has(color)) ?? PALETTE[0];
}
