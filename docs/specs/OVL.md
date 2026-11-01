---
code: OVL
status: shipped
version: v0.1
---

# Measure Things — OVL specification

The helper overlay: guides, rectangles, the column grid, and the color picker, drawn above every
window. It predates the spec process, so it has no plans.

## Goal

Measure and check the alignment of any UI element on screen, a web page in a browser above all,
without leaving the page: guides, measuring rectangles, a column grid, and a color picker drawn
above every window, which let the pointer through to the page until they are edited.

## Audience and environment

- Web and UI developers on GNOME Shell 49, Wayland.
- Single and multi-monitor setups, at any monitor scale, fractional ones included.

## Layer

- Helpers are drawn above every window, fullscreen windows included, and above the top bar.
- Outside edit mode no helper takes pointer input: clicks, scrolling, and hovering reach the
  window below.
- **Show helpers** hides guides and rectangles outside edit mode without deleting them. Edit
  mode always shows them.

## Helpers

- A vertical guide is a 1-pixel line across the whole screen at an x position, labeled
  `x <position>` at the top of the highest monitor it crosses, below the top bar on the primary
  monitor. A horizontal guide is the same at a y position, labeled `y <position>` at the left of
  the leftmost monitor it crosses.
- Neighboring parallel guides show the distance between them on a line joining them.
- A rectangle is a 1-pixel outline with a light fill, labeled with its size, `width × height`,
  below it, or above its bottom edge when its monitor ends first. When selected, it also shows its
  top-left position and corner handles.
- Positions are relative to the monitor the helper is on. Sizes and distances use the display
  unit.
- Helpers are saved in GSettings in stage pixels, and restored when the extension is enabled.

## Units

- **CSS pixels** (default): CSS pixels at 100% browser zoom. In logical layout mode (Mutter's
  `scale-monitor-framebuffer`, which fractional scaling needs), they equal stage pixels; in
  physical layout mode, they are stage pixels divided by the scale of the monitor the value is
  on.
- **Device pixels**: physical screen pixels.
- Values are rounded to two decimals, without trailing zeros.

## Edit mode

- Entered with the edit shortcut (`Super+Shift+M`), **Edit helpers**, **Add vertical guide**, or
  **Add horizontal guide**; the last two add a guide through the center of the primary monitor
  and select it. Edit mode takes a modal grab; when another grab holds the keyboard, it does not
  start.
- The pointer is a crosshair with full-screen lines and a position readout, and a hint bar lists
  the keys.
- Dragging on empty space, or inside a rectangle that is not selected, draws a rectangle once the
  pointer has moved 3 pixels. A click without drag selects the rectangle under the pointer, or
  clears the selection.
- Dragging a guide moves it along its axis. Dragging a rectangle edge or corner resizes it, within
  4 pixels of the edge; dragging past the opposite edge flips it, and it keeps at least 1 pixel.
  Dragging inside the selected rectangle moves it. The topmost helper wins.
- Keys: `H`/`V` add a guide at the pointer; arrows nudge the selection by 1 pixel, 10 with
  `Shift`; `Alt`+arrows resize the selected rectangle from its right or bottom edge; `Tab` and
  `Shift+Tab` cycle the selection; `Delete` and `Backspace` remove it; `Ctrl+C` copies the
  selected rectangle's size or the guide's position; `G` toggles the grid; `Esc` cancels a drag
  in progress, otherwise leaves edit mode.
- Every change is saved when the drag or the key ends.

## Column grid

- Toggled with the grid shortcut (`Super+Shift+G`), the **Column grid** switch, or `G` in edit
  mode.
- Laid over the window focused when it was shown, or over the primary monitor's work area when no
  window has focus. It follows the window's moves and resizes, hides while the window is minimized
  or on another workspace, and turns off when the window closes.
- Columns, gutter, side margin, and maximum width are set in CSS pixels. The container is the
  window width, or the maximum width when it is set and smaller, centered; the margin pads both
  sides, and the columns share the remaining width after the gutters.

## Color picker

- Started with the picker shortcut (`Super+Shift+C`) or **Pick color**; leaves edit mode first
  and returns to it afterwards.
- Helpers are hidden while it runs. A swatch next to the pointer shows the color and hex value of
  the pixel under it; the swatch itself is never sampled.
- A primary click copies the hex value (`#rrggbb`) to the clipboard and confirms with an
  on-screen display. `Esc` or a secondary click cancels.

## Preferences

- Unit, helper color, the four grid settings, and the three shortcuts. Each setting applies as
  soon as it changes; a shortcut applies with its row's apply button, and an empty shortcut
  disables it.

## Out of scope for v0.1

- Snapping to edges detected in the screen content.
- Browser zoom levels other than 100%.
- Overlaying a mockup image.
- Undo.
