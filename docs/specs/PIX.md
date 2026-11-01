---
code: PIX
status: shipped
version: v0.2
builds-on: OVL
---

# Measure Things — PIX specification

Reading the screen's pixels: area measuring, snapping, the picker's loupe, and the mockup. It
predates the spec process, so it has no plans.

## Goal

Measure and check the alignment of any UI element on screen, a web page in a browser above all,
without leaving the page: guides, measuring rectangles, a column grid, a mockup image, and a color
picker drawn above every window, which let the pointer through to the page until they are edited.
Version 0.2 reads the screen itself: it measures areas of the page, snaps helpers to the page's
edges, and magnifies pixels in the color picker.

## Audience and environment

- Web and UI developers on GNOME Shell 49, Wayland.
- Single and multi-monitor setups, at any monitor scale, fractional ones included.

## Layer

- Helpers are drawn above every window, fullscreen windows included, and above the top bar.
- Outside edit mode no helper takes pointer input: clicks, scrolling, and hovering reach the
  window below.
- **Show helpers** hides guides and rectangles outside edit mode without deleting them. Edit
  mode always shows them.
- Measuring areas, snapping, and the color picker read a still capture of the screen without the
  layer, taken when edit mode or the picker starts. Content that changes afterwards, such as a
  video, is read as it was then.

## Helpers

- A vertical guide is a 1-pixel line across the whole screen at an x position, labeled
  `x <position>` at the top of the highest monitor it crosses, below the top bar on the primary
  monitor. A horizontal guide is the same at a y position, labeled `y <position>` at the left of
  the leftmost monitor it crosses.
- Neighboring parallel guides show the distance between them on a line joining them.
- A selected rectangle shows the distance to its nearest neighbor on each side: a guide, or a
  rectangle that overlaps it across the gap. Touching or overlapping neighbors show nothing.
- A rectangle is a 1-pixel outline with a light fill, labeled with its size, `width × height`,
  below it, or above its bottom edge when its monitor ends first. When selected, it also shows its
  top-left position and corner handles.
- Positions are relative to the monitor the helper is on. Sizes and distances use the display
  unit.
- Helpers are saved in GSettings in stage pixels, and restored when the extension is enabled.

## Units

- **CSS pixels** (default): CSS pixels at the browser zoom set in the preferences, 100% by
  default. At 100%, in logical layout mode (Mutter's `scale-monitor-framebuffer`, which fractional
  scaling needs), they equal stage pixels; in physical layout mode, they are stage pixels divided
  by the scale of the monitor the value is on. Other zoom levels divide them by the zoom factor.
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
- **Snapping**: a dragged guide, rectangle edge, or corner of a new rectangle snaps to the nearest
  screen edge within 6 pixels: the boundary between two pixels whose colors differ by more than 12
  on a channel. Vertical edges are searched on the pointer's row, horizontal ones on its column.
  Moving a whole rectangle does not snap. Holding `Ctrl` while dragging turns snapping off.
- **Measuring areas**: `D` toggles area measuring. The crosshair is replaced by the extent of the
  pixels that share the color under the pointer, along its row and column, with their width and
  height; the readout shows `width × height`. `Enter` adds a rectangle on that area.
- Keys: `H`/`V` add a guide at the pointer; arrows nudge the selection by 1 pixel, 10 with
  `Shift`; `Alt`+arrows resize the selected rectangle from its right or bottom edge; `Tab` and
  `Shift+Tab` cycle the selection; `Delete` and `Backspace` remove it; `Ctrl+C` copies the
  selected rectangle's size or the guide's position; `D` toggles area measuring and `Enter` adds
  the measured area; `G` toggles the grid; `Esc` cancels a drag in progress, otherwise leaves
  edit mode.
- Every change is saved when the drag or the key ends.
- **Undo**: `Ctrl+Z` undoes the last change to the helpers, `Ctrl+Shift+Z` and `Ctrl+Y` redo it.
  Clearing the helpers from the menu is a change too. The history keeps the last 100 states and
  lasts until the extension is disabled.

## Column grid

- Toggled with the grid shortcut (`Super+Shift+G`), the **Column grid** switch, or `G` in edit
  mode.
- Laid over the window focused when it was shown, or over the primary monitor's work area when no
  window has focus. It follows the window's moves and resizes, hides while the window is minimized
  or on another workspace, and turns off when the window closes.
- Columns, gutter, side margin, and maximum width are set in CSS pixels, at the browser zoom. The container is the
  window width, or the maximum width when it is set and smaller, centered; the margin pads both
  sides, and the columns share the remaining width after the gutters.

## Color picker

- Started with the picker shortcut (`Super+Shift+C`) or **Pick color**; leaves edit mode first
  and returns to it afterwards.
- Helpers are hidden while it runs. A swatch next to the pointer shows the 11 × 11 device pixels
  around it, magnified 10 times with the center one framed, then the color and value of the pixel
  under the pointer; the swatch itself is never sampled.
- The value is in the color format of the preferences: hex (`#rrggbb`, default), `rgb(r, g, b)`,
  or `hsl(h, s%, l%)`. `Tab` switches to the next format and keeps it.
- A primary click copies the value to the clipboard and confirms with an on-screen display. `Esc`
  or a secondary click cancels.

## Mockup

- An image chosen in the preferences is laid over the screen at its CSS size: one image pixel per
  CSS pixel, or fewer at a pixel density of 2x to 4x, at the browser zoom. Its opacity is 50% by
  default, from 5% to 100%.
- The **Mockup** menu switch and the preferences show or hide it; the switch is unavailable until
  an image is chosen. Choosing an image shows it. It stays shown outside edit mode and, like the
  helpers, lets the pointer through.
- In edit mode, dragging with the secondary button moves it, `Ctrl`+arrows nudge it by 1 pixel
  (10 with `Shift`), and `[` and `]` lower and raise its opacity by 10%. Its position, in stage
  pixels, is saved.

## Preferences

- Unit, browser zoom (25% to 500%), helper color, color format, the mockup image, opacity, and
  pixel density, the four grid settings, and the three shortcuts. Each setting applies as
  soon as it changes.
- A shortcut row shows its keys; activating it asks for the new combination, which must hold
  Ctrl, Alt, or Super. Backspace disables the shortcut and Escape keeps it.
- The keys of edit mode are listed below the shortcuts, read-only. `Ctrl+F` searches the rows.

## Out of scope for v0.2

- Snapping to other helpers.
- Several mockups at once, and blend modes such as difference.
- Keeping the undo history across restarts.
