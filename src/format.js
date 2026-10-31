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

/** An `rgba()` CSS color from `#rrggbb` and an opacity, for St inline styles. */
export function withAlpha(hex, alpha) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    const [red, green, blue] = match
        ? match.slice(1).map(part => parseInt(part, 16))
        : [255, 45, 149];
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
