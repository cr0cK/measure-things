#!/usr/bin/env bash
# End-to-end test: runs the checkout in a headless GNOME Shell, drives it with a virtual pointer
# and keyboard, and checks the helpers, the click-through layer, the grid, the color picker,
# persistence, and a clean disable. Exits non-zero on any failed check or shell JS error.
set -euo pipefail

# shellcheck source=scripts/headless.sh
source "$(dirname "$0")/headless.sh"
# Logical layout mode, which fractional scaling needs; at scale 1 it changes nothing.
headless_seed() {
    gsettings set org.gnome.mutter experimental-features "['scale-monitor-framebuffer']"
}
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

# Measuring on known screen content: a plain backdrop and a red block above the windows and below
# the top bar, its menus, and the layer, captured when edit mode starts.
shell_eval "let below = global.window_group;
for (const [name, color, x, y, width, height] of [
        ['backdrop', '#3d3846', 0, 0, 1600, 1000], ['red', '#e01b24', 800, 400, 300, 200]]) {
    const block = new imports.gi.St.Widget({name: 'e2e-' + name, x, y, width, height,
        style: 'background-color: ' + color + ';'});
    Main.uiGroup.insert_child_above(block, below);
    below = block;
}" >/dev/null
shell_eval "$EXTENSION._indicator.menu.open()" >/dev/null
shell_eval "$EXTENSION._editItem.activate(imports.gi.Clutter.get_current_event())" >/dev/null
wait_for "!!$OVERLAY._snapshot"
pointer_move 1450 200
press_keys d
wait_for "$OVERLAY._areaGroup.visible"
expect "$OVERLAY._readout.text" '1600 × 968' 'edit mode started from the menu does not capture the menu'
press_keys Escape
shell_eval "$EXTENSION._indicator.menu.open()" >/dev/null
sleep 0.5
press_keys Super_L Shift_L m
wait_for "!!$OVERLAY._snapshot"
press_keys d
wait_for "$OVERLAY._areaGroup.visible"
expect "$OVERLAY._readout.text + ' ' + $EXTENSION._indicator.menu.isOpen" '1600 × 968 false' \
    'the edit shortcut closes an open menu before the capture'
press_keys d
pointer_move 950 900
press_keys v
pointer_move 900 500
press_keys d
wait_for "$OVERLAY._readout.text === '300 × 200'"
expect "$OVERLAY._areaWidth.text + ' ' + $OVERLAY._areaHeight.text" '300 200' \
    'D measures the area under the pointer, ignoring the guide over it'
press_keys Return
expect "$LAST" '{"id":7,"kind":"rectangle","x":800,"y":400,"width":300,"height":200}' \
    'Enter adds a rectangle on the measured area'
press_keys d
expect "$OVERLAY._areaGroup.visible" false 'D again stops measuring the area'

pointer_drag 603 403 1097 597
expect "$LAST" '{"id":8,"kind":"rectangle","x":603,"y":403,"width":497,"height":197}' \
    'a dragged corner snaps to the nearest screen edges'
press_keys Delete
pointer_move 603 403
key_state Control_L PRESSED
pointer_drag 603 403 1097 597
key_state Control_L RELEASED
expect "$LAST" '{"id":9,"kind":"rectangle","x":603,"y":403,"width":494,"height":194}' \
    'Ctrl+drag does not snap'
press_keys Delete
# Release in the same batch as the last motion, before the shell has read the row it needs.
pointer_move 790 700
press_keys v
pointer_button PRESSED
shell_eval "const {Clutter, GLib} = imports.gi;
    global._headlessPointer.notify_absolute_motion(GLib.get_monotonic_time(), 797, 450);
    global._headlessPointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY,
        Clutter.ButtonState.RELEASED);" >/dev/null
wait_for "$OVERLAY._drag === null"
expect "$LAST + ' ' + JSON.parse($EXTENSION._settings.get_string('helpers')).at(-1).x" \
    '{"id":10,"kind":"vertical","x":800} 800' 'a drag released before its row is read still snaps'
press_keys Delete

pointer_drag 200 450 520 550
pointer_click 960 900
pointer_click 400 500
expect "$OVERLAY._gapGroup.get_children().filter(a => a.text).map(a => a.text).join()" 280 \
    'a selected rectangle shows the distance to its nearest neighbor'
shell_eval "$EXTENSION._settings.set_int('zoom', 125)" >/dev/null
expect "$(VIEW_LABEL 11)" '256 × 80' 'CSS pixel values follow the browser zoom'
shell_eval "$EXTENSION._settings.set_int('zoom', 100)" >/dev/null

press_keys Delete
expect "$OVERLAY._helpers.map(h => h.id).join()" 6,7 'Delete removes the rectangle'
press_keys Control_L z
expect "$OVERLAY._helpers.map(h => h.id).join()" 6,7,11 'Ctrl+Z undoes the last change'
press_keys Control_L z
press_keys Control_L z
expect "$OVERLAY._helpers.map(h => h.id).join()" 6,7,10 'Ctrl+Z goes further back, one change at a time'
press_keys Control_L Shift_L z
press_keys Control_L y
expect "$OVERLAY._helpers.map(h => h.id).join() + ' ' + $EXTENSION._settings.get_string('helpers')" \
    '6,7,11 [{"kind":"vertical","x":950},{"kind":"rectangle","x":800,"y":400,"width":300,"height":200},{"kind":"rectangle","x":200,"y":450,"width":320,"height":100}]' \
    'Ctrl+Shift+Z and Ctrl+Y redo, and the result is saved'
shell_eval "$OVERLAY._select(7)" >/dev/null
press_keys Delete
press_keys Control_L z
expect "$OVERLAY._helpers.map(h => $OVERLAY._helperGroup.get_children().indexOf($OVERLAY._views.get(h.id).shape))
    .every((index, i, all) => i === 0 || index > all[i - 1])" true \
    'undo stacks helpers in list order, as hit testing reads them'
press_keys Escape

shell_eval "$EXTENSION._settings.set_string('color-format', 'rgb')" >/dev/null
pointer_move 1000 450
press_keys Super_L Shift_L c
wait_for "$SWATCH === 'rgb(224, 27, 36)'"
expect "$EXTENSION._picker._loupeImage.width + ' ' + $EXTENSION._picker._loupeImage.x" '110 0' \
    'the loupe magnifies the pixels around the pointer'
press_keys Tab
expect "$SWATCH + ' ' + $EXTENSION._settings.get_string('color-format')" 'hsl(357, 78%, 49%) hsl' \
    'Tab switches the color format'
pointer_click 1000 450
wait_for "$EXTENSION._picker === null"
expect "$CLIPBOARD" 'hsl(357, 78%, 49%)' 'a click copies the color in the chosen format'
shell_eval "$EXTENSION._settings.set_string('color-format', 'hex')" >/dev/null

MOCKUP="$OVERLAY._mockup.actor"
shell_eval "const {GdkPixbuf} = imports.gi;
    const image = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 400, 200);
    image.fill(0x2ec27eff);
    image.savev('$WORK/mockup.png', 'png', [], []);
    $EXTENSION._settings.set_string('mockup-file', '$WORK/mockup.png');
    $EXTENSION._settings.set_boolean('mockup-visible', true);" >/dev/null
wait_for "$MOCKUP.visible"
expect "[$MOCKUP.x, $MOCKUP.y, $MOCKUP.width, $MOCKUP.height, $MOCKUP.opacity, $EXTENSION._mockupItem._switch.state].join()" \
    0,0,400,200,128,true 'the mockup shows at its CSS size and half opacity'
shell_eval "$EXTENSION._settings.set_int('mockup-density', 2); $EXTENSION._settings.set_int('zoom', 150)" >/dev/null
expect "$MOCKUP.width + 'x' + $MOCKUP.height" 300x150 'the mockup follows its pixel density and the zoom'
shell_eval "$EXTENSION._settings.set_int('zoom', 100)" >/dev/null
expect "$OVERLAY.actor.contains(global.stage.get_actor_at_pos(imports.gi.Clutter.PickMode.REACTIVE, 100, 50))" \
    false 'outside edit mode, the pointer goes through the mockup'
press_keys Super_L Shift_L m
pointer_move 100 50
pointer_button PRESSED SECONDARY
pointer_move 140 80
press_keys bracketright
pointer_button RELEASED SECONDARY
press_keys Control_L Shift_L Right
press_keys bracketright
expect "$EXTENSION._settings.get_value('mockup-position').deepUnpack().join() + ' ' + $MOCKUP.opacity" \
    '50,30 153' 'right-drag and Ctrl+arrows move the mockup, ] raises its opacity after the drag'
expect "$OVERLAY._helpers.length" 3 'moving the mockup leaves the helpers alone'
press_keys Escape
shell_eval "$EXTENSION._settings.set_boolean('mockup-visible', false)" >/dev/null
expect "$MOCKUP.visible + ' ' + $EXTENSION._mockupItem._switch.state" 'false false' 'the mockup hides'
shell_eval "Main.uiGroup.get_children().filter(a => a.name?.startsWith('e2e-')).forEach(a => a.destroy())" \
    >/dev/null

# A global shortcut changed in the preferences: found with Ctrl+F, captured as pressed, and bound
# by the shell at once.
gnome-extensions prefs "$UUID"
# The preferences service can wait on portal timeouts before it shows its window.
PREFS="global.display.list_all_windows().find(w => w.get_wm_class() === 'org.gnome.Shell.Extensions')"
wait_for "!!$PREFS" 120
shell_eval "$PREFS.activate(global.get_current_time())" >/dev/null
wait_for "$PREFS.has_focus()"
sleep 1
press_keys Control_L f
for key in p i c k space c o l o r; do
    press_keys "$key"
done
sleep 0.5
# The only search result, the first row under the header bar; it focuses the row it finds.
read -r RESULT_X RESULT_Y < <(shell_eval "const r = $PREFS.get_frame_rect(); \`\${Math.round(r.x + r.width / 2)} \${r.y + 97}\`")
pointer_click "$RESULT_X" "$RESULT_Y"
sleep 0.5
press_keys Return
sleep 0.5
press_keys Control_L Alt_L k
sleep 1
expect "$EXTENSION._settings.get_strv('pick-color-shortcut').join()" '<Control><Alt>k' \
    'the preferences capture a new global shortcut'
press_keys Control_L Alt_L k
sleep 1
expect "!!$EXTENSION._picker" true 'the shell binds the new shortcut at once'
press_keys Escape
wait_for "$EXTENSION._picker === null"
shell_eval "$EXTENSION._settings.reset('pick-color-shortcut'); $PREFS.delete(global.get_current_time())" >/dev/null
wait_for "!$PREFS"

# Fractional scaling: at 125% the stage is 1280x800 logical pixels over 1600x1000 device pixels.
gdbus call --session --dest org.gnome.Mutter.DisplayConfig --object-path /org/gnome/Mutter/DisplayConfig \
    --method org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig \
    "$(gdbus call --session --dest org.gnome.Mutter.DisplayConfig --object-path /org/gnome/Mutter/DisplayConfig \
        --method org.gnome.Mutter.DisplayConfig.GetCurrentState | grep -o '^(uint32 [0-9]*' | cut -c8-)" \
    1 "[(0, 0, 1.25, 0, true, [('Meta-0', '1600x1000@60.000', @a{sv} {})])]" "@a{sv} {}" >/dev/null
wait_for "global.stage.width === 1280"
shell_eval "$OVERLAY.clear()" >/dev/null
shell_eval "let below = global.window_group;
for (const [name, color, x, y, width, height] of [
        ['backdrop', '#3d3846', 0, 0, 1280, 800], ['red', '#e01b24', 400, 300, 240, 160]]) {
    const block = new imports.gi.St.Widget({name: 'e2e-' + name, x, y, width, height,
        style: 'background-color: ' + color + ';'});
    Main.uiGroup.insert_child_above(block, below);
    below = block;
}" >/dev/null
press_keys Super_L Shift_L m
wait_for "!!$OVERLAY._snapshot"
expect "$OVERLAY._snapshot.scale + ' ' + $OVERLAY._snapshot.width" '1.25 1600' \
    'at 125%, the capture is in device pixels'
pointer_move 500 380
press_keys d
wait_for "$OVERLAY._readout.text === '240 × 160'"
shell_eval "$EXTENSION._settings.set_string('unit', 'device')" >/dev/null
pointer_move 501 380
wait_for "$OVERLAY._readout.text === '300 × 200'"
expect "$OVERLAY._areaWidth.text" 300 'at 125%, areas measure in CSS and device pixels'
shell_eval "$EXTENSION._settings.set_string('unit', 'css')" >/dev/null
press_keys d
pointer_drag 300 200 637 457
expect "$LAST" '{"id":12,"kind":"rectangle","x":300,"y":200,"width":340,"height":260}' \
    'at 125%, dragged edges snap to screen edges'
press_keys Escape
pointer_move 600 440
press_keys Super_L Shift_L c
wait_for "$SWATCH === '#e01b24'"
pointer_click 600 440
wait_for "$EXTENSION._picker === null"
expect "$CLIPBOARD" '#e01b24' 'at 125%, the picker reads the pixel under the pointer'
shell_eval "Main.uiGroup.get_children().filter(a => a.name?.startsWith('e2e-')).forEach(a => a.destroy())" \
    >/dev/null

if grep -E 'JS (ERROR|WARNING)|Measure Things:' "$WORK/shell.log"; then
    echo 'FAIL the shell logged JavaScript errors'
    FAILURES=$((FAILURES + 1))
fi
if ((FAILURES > 0)); then
    echo "$FAILURES check(s) failed."
    exit 1
fi
echo 'All end-to-end checks passed.'
