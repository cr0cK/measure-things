---
code: PIX
status: shipped
version: v0.2
created: 2026-10-31
builds-on: OVL
replaced-by: SET
---

# Measure Things — PIX specification

Reading the screen's pixels: area measuring, snapping, the picker's loupe, and the mockup. It
predates the spec delivery process, so it has no plans. It replaced the sections of OVL on the
layer, helpers, units, edit mode, the column grid, the color picker, and the preferences. SET
replaced its sections on the layer, helpers, units, edit mode, the column grid, the mockup, and the
preferences, and the color picker's rule on hiding the layer.

## Goal

Measure and check the alignment of any UI element on screen, a web page in a browser above all,
without leaving the page: guides, measuring rectangles, a column grid, a mockup image, and a color
picker drawn above every window, which let the pointer through to the page until they are edited.
Version 0.2 reads the screen itself: it measures areas of the page, snaps helpers to the page's
edges, and magnifies pixels in the color picker.

## Audience and environment

- Web and UI developers on GNOME Shell 49 or 50, Wayland.
- Single and multi-monitor setups, at any monitor scale, fractional ones included.

## Color picker

- Started with the picker shortcut (`Super+Shift+C`) or **Pick color**; leaves edit mode first
  and returns to it afterwards.
- A swatch next to the pointer shows the 11 × 11 device pixels around it, magnified 10 times with
  the center one framed, then the color and value of the pixel under the pointer; the swatch
  itself is never sampled.
- The value is in the color format of the preferences: hex (`#rrggbb`, default), `rgb(r, g, b)`,
  or `hsl(h, s%, l%)`. `Tab` switches to the next format and keeps it.
- A primary click copies the value to the clipboard and confirms with an on-screen display. `Esc`
  or a secondary click cancels.

## Out of scope for v0.2

- Snapping to other helpers.
- Several mockups at once, and blend modes such as difference.
- Keeping the undo history across restarts.
