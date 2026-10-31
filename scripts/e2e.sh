#!/usr/bin/env bash
# End-to-end test: runs the checkout in a headless GNOME Shell, drives it with a virtual pointer
# and keyboard, and checks the helpers, the click-through layer, the grid, the color picker,
# persistence, and a clean disable. Exits non-zero on any failed check or shell JS error.
set -euo pipefail

# shellcheck source=scripts/headless.sh
source "$(dirname "$0")/headless.sh"
headless_start "$0" "$@"

FAILURES=0
# Evaluates $1 in the shell and compares the result with $2.
expect() {
    local actual
    actual=$(shell_eval "$1" 2>&1 || true)
    if [[ $actual == "$2" ]]; then
        echo "ok   $3"
    else
        echo "FAIL $3"
        echo "     expected: $2"
        echo "     actual:   $actual"
        FAILURES=$((FAILURES + 1))
    fi
}

LAST="JSON.stringify($OVERLAY._helpers.at(-1))"
VIEW_LABEL() { echo "$OVERLAY._views.get($1).label.text"; }

expect "!!Main.panel.statusArea['$UUID']" true 'adds its indicator to the top bar'

press_keys Super_L Shift_L m
expect "$OVERLAY.editing && Main.modalCount" 1 'the edit shortcut enters edit mode'

pointer_drag 400 300 720 480
expect "$LAST" '{"id":1,"kind":"rectangle","x":400,"y":300,"width":320,"height":180}' \
    'dragging draws a rectangle'
expect "$(VIEW_LABEL 1)" '320 × 180' 'the rectangle shows its size'

pointer_move 720 600
press_keys v
pointer_move 900 600
press_keys v
expect "$LAST" '{"id":3,"kind":"vertical","x":900}' 'V adds a vertical guide at the pointer'
expect "$OVERLAY._gapGroup.get_children().filter(a => a.text).map(a => a.text).join()" 180 \
    'neighboring guides show their gap'

press_keys Shift_L Right
expect "$LAST" '{"id":3,"kind":"vertical","x":910}' 'Shift+Right nudges the selection by 10'

press_keys Tab
expect "$OVERLAY._selectedId" 1 'Tab cycles the selection'
press_keys Alt_L Right
press_keys Control_L c
expect "JSON.stringify($OVERLAY._helpers[0])" \
    '{"id":1,"kind":"rectangle","x":400,"y":300,"width":321,"height":180}' 'Alt+Right widens a rectangle'
expect "$CLIPBOARD" '321 × 180' 'Ctrl+C copies the selected measurement'

pointer_drag 560 480 560 500
expect "JSON.stringify($OVERLAY._helpers[0])" \
    '{"id":1,"kind":"rectangle","x":400,"y":300,"width":321,"height":200}' 'dragging an edge resizes'
pointer_drag 560 400 580 410
expect "JSON.stringify($OVERLAY._helpers[0])" \
    '{"id":1,"kind":"rectangle","x":420,"y":310,"width":321,"height":200}' \
    'dragging inside the selected rectangle moves it'

pointer_move 910 700
pointer_button PRESSED
pointer_move 960 700
press_keys Escape
pointer_button RELEASED
expect "$LAST" '{"id":3,"kind":"vertical","x":910}' 'Escape cancels a drag in progress'
expect "$OVERLAY.editing" true 'Escape during a drag stays in edit mode'

pointer_drag 1100 200 1300 300
pointer_click 50 900
expect "$OVERLAY._selectedId" null 'a click on empty space clears the selection'
pointer_click 1200 250
expect "$OVERLAY._selectedId" 4 'a click inside a rectangle selects it'
press_keys Delete
expect "$OVERLAY._helpers.map(h => h.id).join()" 1,2,3 'Delete removes the selection'

pointer_move 100 100
press_keys h
press_keys Escape
expect "$OVERLAY.editing + ' ' + $OVERLAY.actor.reactive + ' ' + Main.modalCount" 'false false 0' \
    'Escape leaves edit mode and releases the grab'
expect "$OVERLAY.actor.contains(global.stage.get_actor_at_pos(imports.gi.Clutter.PickMode.REACTIVE, 910, 500))" \
    false 'outside edit mode, the pointer goes through guides'
expect "$OVERLAY.actor.contains(global.stage.get_actor_at_pos(imports.gi.Clutter.PickMode.REACTIVE, 500, 400))" \
    false 'outside edit mode, the pointer goes through rectangles'

STORED='[{"kind":"rectangle","x":420,"y":310,"width":321,"height":200},{"kind":"vertical","x":720},{"kind":"vertical","x":910},{"kind":"horizontal","y":100}]'
expect "$EXTENSION._settings.get_string('helpers')" "$STORED" 'helpers are saved to GSettings'

shell_eval "Main.extensionManager.disableExtension('$UUID')" >/dev/null
wait_for "Main.extensionManager.lookup('$UUID').state !== 1"
expect "Main.layoutManager.uiGroup.get_children().some(a => a.name?.startsWith('measure-things'))" false \
    'disabling removes the layer'
expect "!!Main.panel.statusArea['$UUID']" false 'disabling removes the indicator'
shell_eval "Main.extensionManager.enableExtension('$UUID')" >/dev/null
wait_for "Main.extensionManager.lookup('$UUID').state === 1"
expect "$OVERLAY._helpers.length + ' ' + $(VIEW_LABEL 2)" '4 x 720' 'enabling restores the helpers'

shell_eval "$EXTENSION._settings.set_boolean('show-helpers', false)" >/dev/null
expect "$OVERLAY._helperGroup.visible + ' ' + $EXTENSION._showItem._switch.state" 'false false' \
    'Show helpers off hides them'
shell_eval "$OVERLAY.enterEdit()" >/dev/null
expect "$OVERLAY._helperGroup.visible" true 'edit mode shows hidden helpers'
press_keys Escape
shell_eval "$EXTENSION._settings.set_boolean('show-helpers', true)" >/dev/null

press_keys Super_L Shift_L g
expect "$OVERLAY.gridVisible + ' ' + $OVERLAY._gridGroup.get_n_children() + ' ' + $EXTENSION._gridItem._switch.state" \
    'true 12 true' 'the grid shortcut shows 12 columns and syncs the menu'
shell_eval "$EXTENSION._settings.set_int('grid-columns', 4)" >/dev/null
expect "$OVERLAY._gridGroup.get_n_children()" 4 'the grid follows its settings'
press_keys Super_L Shift_L g
expect "$OVERLAY.gridVisible + ' ' + $OVERLAY._gridGroup.get_n_children()" 'false 0' \
    'the grid shortcut hides the grid'

# Known colors under the layer: red, and blue under the vertical guide at x 910.
shell_eval "for (const [name, color, x, y, width, height] of [
        ['red', '#e01b24', 1000, 600, 300, 300], ['blue', '#1c71d8', 860, 600, 100, 100]]) {
    const block = new imports.gi.St.Widget({name: 'e2e-' + name, x, y, width, height,
        style: 'background-color: ' + color + ';'});
    Main.uiGroup.insert_child_below(block, $OVERLAY.actor);
}" >/dev/null
SWATCH="$EXTENSION._picker?._label.text"
pointer_move 1100 700
press_keys Super_L Shift_L c
wait_for "$SWATCH === '#e01b24'"
expect "$OVERLAY.actor.visible" false 'the picker hides the helpers while reading pixels'
# The swatch sits below and right of the pointer; move onto where it was.
pointer_move 1180 735
wait_for "$EXTENSION._picker._swatch.x > 1190"
expect "$SWATCH" '#e01b24' 'the picker never samples its own swatch'
pointer_click 910 650
wait_for "$EXTENSION._picker === null"
expect "$CLIPBOARD.then(text => text + ' ' + $OVERLAY.actor.visible + ' ' + Main.modalCount)" \
    '#1c71d8 true 0' 'a click copies the color under the pointer, not the guide over it'
shell_eval "Main.uiGroup.get_children().filter(a => a.name?.startsWith('e2e-')).forEach(a => a.destroy())" \
    >/dev/null
press_keys Super_L Shift_L c
wait_for "!!$EXTENSION._picker"
press_keys Escape
wait_for "$EXTENSION._picker === null"
expect "Main.modalCount" 0 'Escape cancels the picker'

shell_eval "$EXTENSION._indicator.menu.open()" >/dev/null
shell_eval "$EXTENSION._indicator.menu._getMenuItems()[2].activate(imports.gi.Clutter.get_current_event())" >/dev/null
expect "$OVERLAY.editing + ' ' + $LAST" 'true {"id":5,"kind":"horizontal","y":500}' \
    'Add horizontal guide edits a new guide in the middle of the screen'
press_keys Escape
shell_eval "$EXTENSION._clearItem.activate(imports.gi.Clutter.get_current_event())" >/dev/null
expect "$OVERLAY._helpers.length + ' ' + $EXTENSION._clearItem.sensitive + ' ' + $EXTENSION._settings.get_string('helpers')" \
    '0 false []' 'Clear helpers removes and forgets every helper'

if grep -E 'JS (ERROR|WARNING)|Measure Things:' "$WORK/shell.log"; then
    echo 'FAIL the shell logged JavaScript errors'
    FAILURES=$((FAILURES + 1))
fi
if ((FAILURES > 0)); then
    echo "$FAILURES check(s) failed."
    exit 1
fi
echo 'All end-to-end checks passed.'
