---
code: OVL
status: shipped
version: v0.1
created: 2026-10-31
replaced-by: PIX
---

# Measure Things — OVL specification

The helper overlay: guides, rectangles, the column grid, and the color picker, drawn above every
window. It predates the spec delivery process, so it has no plans. PIX replaced its sections on the
layer, helpers, units, edit mode, the column grid, the color picker, and the preferences.

## Goal

Measure and check the alignment of any UI element on screen, a web page in a browser above all,
without leaving the page: guides, measuring rectangles, a column grid, and a color picker drawn
above every window, which let the pointer through to the page until they are edited.

## Audience and environment

- Web and UI developers on GNOME Shell 49 or 50, Wayland.
- Single and multi-monitor setups, at any monitor scale, fractional ones included.

## Out of scope for v0.1

- Snapping to edges detected in the screen content.
- Browser zoom levels other than 100%.
- Overlaying a mockup image.
- Undo.
