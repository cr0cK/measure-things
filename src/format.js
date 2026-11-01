// Pure text formatting for lengths and colors. Imports nothing from gi://.

/** A length rounded to two decimals, without trailing zeros: 120, 150.4, 33.33. */
export function formatLength(value) {
    const rounded = Math.round(value * 100) / 100;
    return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** `320 × 180` from a width and a height in the display unit. */
export function formatSize(width, height) {
    return `${formatLength(width)} × ${formatLength(height)}`;
}

/** `#rrggbb` from 0-255 channels. */
export function colorToHex({red, green, blue}) {
    return '#' + [red, green, blue]
        .map(channel => Math.round(channel).toString(16).padStart(2, '0'))
        .join('');
}

/** `rgb(r, g, b)` from 0-255 channels. */
export function colorToRgb({red, green, blue}) {
    return `rgb(${[red, green, blue].map(Math.round).join(', ')})`;
}

/** `hsl(h, s%, l%)` from 0-255 channels, rounded to whole degrees and percents. */
export function colorToHsl({red, green, blue}) {
    const [r, g, b] = [red, green, blue].map(channel => channel / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    const chroma = max - min;
    let hue = 0;
    let saturation = 0;
    if (chroma > 0) {
        saturation = chroma / (1 - Math.abs(2 * lightness - 1));
        if (max === r)
            hue = ((g - b) / chroma + 6) % 6;
        else if (max === g)
            hue = (b - r) / chroma + 2;
        else
            hue = (r - g) / chroma + 4;
    }
    return `hsl(${Math.round(hue * 60) % 360}, ${Math.round(saturation * 100)}%, ${Math.round(lightness * 100)}%)`;
}

export const COLOR_FORMATS = ['hex', 'rgb', 'hsl'];

/** A color in one of COLOR_FORMATS; unknown formats fall back to hex. */
export function formatColor(color, format) {
    if (format === 'rgb')
        return colorToRgb(color);
    if (format === 'hsl')
        return colorToHsl(color);
    return colorToHex(color);
}

/** An `rgba()` CSS color from `#rrggbb` and an opacity, for St inline styles. */
export function withAlpha(hex, alpha) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    const [red, green, blue] = match
        ? match.slice(1).map(part => parseInt(part, 16))
        : [255, 45, 149];
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** When a set was last edited, from milliseconds since the epoch: `edited 2 min ago`. */
export function formatEdited(edited, now) {
    const elapsed = Math.max(0, now - edited);
    if (elapsed < MINUTE)
        return 'edited just now';
    if (elapsed < HOUR)
        return `edited ${Math.floor(elapsed / MINUTE)} min ago`;
    if (elapsed < DAY)
        return `edited ${Math.floor(elapsed / HOUR)} h ago`;
    if (elapsed < 2 * DAY)
        return 'edited yesterday';
    if (elapsed < 7 * DAY)
        return `edited ${Math.floor(elapsed / DAY)} days ago`;
    if (elapsed < 14 * DAY)
        return 'edited last week';
    const weeks = Math.floor(elapsed / (7 * DAY));
    if (weeks < 9)
        return `edited ${weeks} weeks ago`;
    return `edited ${new Date(edited).toISOString().slice(0, 10)}`;
}

const MODIFIER_NAMES = {Super: 'Super', Shift: 'Shift', Control: 'Ctrl', Primary: 'Ctrl', Alt: 'Alt', Meta: 'Meta'};

/** A GTK accelerator such as `<Super><Shift>m` as `Super+Shift+M`; empty when disabled. */
export function formatAccelerator(accelerator) {
    const modifiers = [...accelerator.matchAll(/<(\w+)>/g)].map(([, name]) => MODIFIER_NAMES[name] ?? name);
    const key = accelerator.replace(/<\w+>/g, '');
    if (!key)
        return '';
    return [...modifiers, key.length === 1 ? key.toUpperCase() : key].join('+');
}
