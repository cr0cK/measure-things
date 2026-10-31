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
