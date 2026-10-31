# Measure Things

[![PR checks](https://github.com/cr0cK/measure-things/actions/workflows/pr-checks.yml/badge.svg)](https://github.com/cr0cK/measure-things/actions/workflows/pr-checks.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A GNOME Shell extension with measuring tools for web and UI work. It draws pixel guides, measuring rectangles, and a column grid above every window, and it picks colors anywhere on screen. Outside edit mode, clicks go through the helpers, so the page under them stays usable.

<p align="center">
  <img src="docs/screenshots/edit.png" alt="Edit mode measuring a settings card: a 555 × 218 rectangle, guides on its edges with their positions, and the gaps between them" width="100%">
</p>

<p align="center">
  <img src="docs/screenshots/menu.png" alt="The Measure Things menu in the top bar" width="49%">
  <img src="docs/screenshots/picker.png" alt="The color picker showing the hex value of the pixel under the pointer" width="49%">
</p>

## Features

- **Guides**: horizontal and vertical 1-pixel lines labeled with their position. The gap between neighboring parallel guides is shown live, which makes alignment checks quick.
- **Measuring rectangles**: drag to draw, then move, resize from any edge or corner, or nudge with the arrow keys. The label shows the size, and the position too when the rectangle is selected.
- **Click-through**: helpers stay on screen above every window, including fullscreen ones, and let the pointer through to the windows below. Only edit mode captures input.
- **Column grid**: a layout grid (columns, gutter, side margin, optional centered max width) laid over the focused window, which follows it when it moves or resizes.
- **Color picker**: shows the color under the pointer and copies its hex value on click.
- **CSS pixels**: values are shown in CSS pixels at 100% browser zoom, so they match your stylesheet on a scaled display (for example 125%). Switch to device pixels in the preferences.
- Helpers are saved and come back after a restart or a lock.

## Usage

| Shortcut | Action |
|---|---|
| <kbd>Super</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> | Enter or leave edit mode |
| <kbd>Super</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> | Show or hide the column grid over the focused window |
| <kbd>Super</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> | Pick a color |

The top bar menu has the same actions, plus **Add vertical guide**, **Add horizontal guide**, **Show helpers**, and **Clear helpers**. The shortcuts can be changed in the preferences.

In edit mode, a hint bar lists the keys:

| Input | Action |
|---|---|
| Drag on empty space | Draw a rectangle |
| <kbd>H</kbd> / <kbd>V</kbd> | Add a horizontal or vertical guide at the pointer |
| Drag a guide, a rectangle edge, or a corner | Move or resize it |
| Click a rectangle, then drag inside it | Select it, then move it |
| Arrows | Nudge the selection by 1 pixel (<kbd>Shift</kbd>: 10) |
| <kbd>Alt</kbd>+arrows | Resize the selected rectangle |
| <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> | Select the next or previous helper |
| <kbd>Delete</kbd> | Remove the selection |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | Copy the selected size or position |
| <kbd>G</kbd> | Toggle the column grid |
| <kbd>Esc</kbd> | Cancel the current drag, or leave edit mode |

Positions are relative to the monitor they are on. CSS pixel values assume 100% browser zoom; at another zoom level, divide by the zoom factor.

## Requirements

- GNOME Shell 49 on Wayland

## Install

Download the latest release and install it:

```sh
curl -fsSLo /tmp/measure-things.zip https://github.com/cr0cK/measure-things/releases/latest/download/measure-things@cr0ck.github.io.shell-extension.zip
gnome-extensions install --force /tmp/measure-things.zip
```

The same commands update an existing install. For a specific version, replace `latest/download`
with `download/vX.Y.Z`.

To install from a checkout instead, run `make install` from the repository root.

Log out and back in (Wayland cannot restart GNOME Shell in place), then enable the extension:

```sh
gnome-extensions enable measure-things@cr0ck.github.io
```

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md): `npm run lint`, `make check`, `scripts/e2e.sh` for the headless end-to-end test, and `scripts/sandbox.sh` to try a change in a windowed GNOME Shell.

## License

[MIT](LICENSE)
