// Set files: parsing, validation, serialization, naming, and the v0.2 migration. Imports nothing
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
const MAX_NAME_LENGTH = 200;
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
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
    if (!COLOR_PATTERN.test(raw.color ?? '') || !inRange(raw.zoom, ZOOM_RANGE) ||
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

    const edited = Date.parse(raw.edited);
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const content = parseContent(raw);
    if (!ID_PATTERN.test(raw.id ?? '') || !name || name.length > MAX_NAME_LENGTH ||
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

/** The name itself when free, otherwise the name with the first free numeric suffix from 2. */
export function uniqueName(name, takenNames) {
    const taken = new Set(takenNames);
    if (!taken.has(name))
        return name;
    let suffix = 2;
    while (taken.has(`${name} ${suffix}`))
        suffix++;
    return `${name} ${suffix}`;
}

/** The first palette color that no set on screen uses, or the first one when all are. */
export function nextColor(usedColors) {
    const used = new Set(usedColors.map(color => color.toLowerCase()));
    return PALETTE.find(color => !used.has(color)) ?? PALETTE[0];
}

/**
 * The content of the set that v0.2 settings become, or null when they hold nothing worth keeping:
 * no helpers, no mockup image, and the default grid. `toCss` converts a stage-pixel length to CSS
 * pixels, and `origin` is the primary monitor's top-left corner in stage pixels.
 */
export function migrateSettings(old, {origin: [originX, originY], toCss}) {
    const defaults = defaultContent();
    const grid = {
        columns: old.gridColumns,
        gutter: old.gridGutter,
        margin: old.gridMargin,
        maxWidth: old.gridMaxWidth,
    };
    const gridChanged = Object.entries(grid).some(([key, value]) => value !== defaults.grid[key]);
    let helpers = [];
    try {
        const raw = JSON.parse(old.helpers);
        helpers = Array.isArray(raw) ? raw.map(parseHelper).filter(Boolean) : [];
    } catch {
        // Unreadable helpers migrate as none.
    }
    if (helpers.length === 0 && !old.mockupFile && !gridChanged)
        return null;

    const position = (value, axisOrigin) => roundCss(toCss(value - axisOrigin));
    helpers = helpers.slice(0, MAX_HELPERS).map(helper => {
        const moved = {kind: helper.kind};
        if ('x' in helper)
            moved.x = position(helper.x, originX);
        if ('y' in helper)
            moved.y = position(helper.y, originY);
        if (helper.kind === 'rectangle') {
            moved.width = roundCss(toCss(helper.width));
            moved.height = roundCss(toCss(helper.height));
        }
        return moved;
    });
    const clamp = (value, [min, max], fallback) =>
        (Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback);
    return {
        ...defaults,
        color: COLOR_PATTERN.test(old.color) ? old.color.toLowerCase() : defaults.color,
        zoom: clamp(old.zoom, ZOOM_RANGE, defaults.zoom),
        helpersVisible: old.showHelpers,
        grid: {
            visible: false,
            ...Object.fromEntries(Object.entries(grid).map(([key, value]) =>
                [key, clamp(value, GRID_RANGES[key], defaults.grid[key])])),
        },
        mockup: {
            file: old.mockupFile,
            visible: Boolean(old.mockupFile) && old.mockupVisible,
            x: position(old.mockupPosition[0], originX),
            y: position(old.mockupPosition[1], originY),
            opacity: clamp(old.mockupOpacity, OPACITY_RANGE, defaults.mockup.opacity),
            density: clamp(old.mockupDensity, DENSITY_RANGE, defaults.mockup.density),
        },
        helpers,
    };
}
