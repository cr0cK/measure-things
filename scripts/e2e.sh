#!/usr/bin/env bash
# End-to-end test: runs the checkout in a headless GNOME Shell with plain GTK test windows, drives
# it with a virtual pointer and keyboard, and checks the migration from v0.2, sets and their views
# on windows, editing, snapping, the badge menu, Set settings, the panel menu, the color picker,
# the mockup, the click-through views, fractional scaling, and a clean disable. Exits non-zero on
# any failed check or shell JS error.
set -euo pipefail

# shellcheck source=scripts/headless.sh
source "$(dirname "$0")/headless.sh"
# Logical layout mode, which fractional scaling needs; at scale 1 it changes nothing. The v0.2
# settings hold helpers and a grid, which the migration turns into a set.
headless_seed() {
    gsettings set org.gnome.mutter experimental-features "['scale-monitor-framebuffer']"
    local schema=org.gnome.shell.extensions.measure-things
    gsettings set $schema helpers '[{"kind":"vertical","x":250},{"kind":"rectangle","x":100,"y":50,"width":250,"height":125}]'
    gsettings set $schema zoom 125
    gsettings set $schema grid-columns 4
}
headless_start "$0" "$@"

FAILURES=0
# Evaluates $1 in the shell and compares the result with $2, for up to two seconds, as files are
# written and views redrawn asynchronously.
expect() {
    local actual
    for _ in $(seq 10); do
        actual=$(shell_eval "$1" 2>&1 || true)
        [[ $actual == "$2" ]] && break
        sleep 0.2
    done
    if [[ $actual == "$2" ]]; then
        echo "ok   $3"
    else
        echo "FAIL $3"
        echo "     expected: $2"
        echo "     actual:   $actual"
        FAILURES=$((FAILURES + 1))
    fi
}

MANAGER="$EXTENSION._manager"
E2E=global._e2e
# Shortcuts for the checks: windows, views, and sets by title or name, helpers as short text
# ("V 10", "H 20", "R x,y wxh"), set files, and the centers of actors to click.
shell_eval "const {GLib, St} = imports.gi;
const extension = () => Main.extensionManager.lookup('$UUID').stateObj;
const text = h => h.kind === 'vertical' ? 'V ' + h.x : h.kind === 'horizontal' ? 'H ' + h.y
    : 'R ' + h.x + ',' + h.y + ' ' + h.width + 'x' + h.height;
const labels = actor => {
    const found = [];
    const walk = a => {
        if (a instanceof St.Label)
            found.push(a.text);
        a.get_children().forEach(walk);
    };
    walk(actor);
    return found;
};
const find = (actor, test) => {
    if (test(actor))
        return actor;
    for (const child of actor.get_children()) {
        const found = find(child, test);
        if (found)
            return found;
    }
    return null;
};
global._e2e = {
    win: title => global.display.list_all_windows().find(w => w.title === title) ?? null,
    model: title => extension()._manager.models.find(m => m.view?.window.title === title) ?? null,
    view: title => global._e2e.model(title)?.view ?? null,
    entry: name => extension()._manager.store.entries().find(e => e.name === name) ?? null,
    helpers: title => global._e2e.model(title).content.helpers.map(text).join(' | '),
    ids: title => global._e2e.model(title).content.helpers.map(h => h.id).join(),
    file: id => {
        try {
            const path = GLib.build_filenamev([GLib.get_user_data_dir(), 'measure-things', 'sets', id + '.json']);
            return JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path)[1]));
        } catch {
            return null;
        }
    },
    fileHelpers: id => global._e2e.file(id)?.helpers.map(text).join(' | '),
    labels,
    row: (list, name) => extension()['_' + list].section._getMenuItems().find(item => labels(item)[0] === name),
    button: (actor, label) => find(actor, a => a instanceof St.Button &&
        (a.label === label || a.accessible_name === label)),
    entries: actor => {
        const found = [];
        find(actor, a => {
            if (a instanceof St.Entry)
                found.push(a);
            return false;
        });
        return found;
    },
    dialog: () => Main.layoutManager.modalDialogGroup.get_children().filter(d => d.visible).at(-1) ?? null,
    center: actor => {
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        return Math.round(x + width / 2) + ' ' + Math.round(y + height / 2);
    },
    bounds: actor => [...actor.get_transformed_position(), ...actor.get_transformed_size()]
        .map(value => Math.round(value * 100) / 100).join(),
    inViews: actor => extension()._manager.views.some(view => view.layer.contains(actor)),
};" >/dev/null

click_actor() {
    local x y
    read -r x y < <(shell_eval "$E2E.center($1)")
    pointer_click "$x" "$y"
}

type_keys() {
    local key
    for key in "$@"; do
        press_keys "$key"
    done
}

# Opens a test window and moves its frame: open_window TITLE X Y SIZE BACKGROUND [BLOCK ...].
open_window() {
    local title=$1 x=$2 y=$3
    shift 3
    gjs -m "$ROOT/scripts/test-window.js" "$title" "$@" >>"$WORK/client.log" 2>&1 &
    wait_for "!!$E2E.win('$title')?.get_compositor_private()?.visible" 30
    shell_eval "$E2E.win('$title').move_frame(true, $x, $y)" >/dev/null
    wait_for "(r => r.x === $x && r.y === $y)($E2E.win('$title').get_frame_rect())"
    sleep 0.5
}

open_menu() {
    shell_eval "$EXTENSION._indicator.menu.open()" >/dev/null
    sleep 0.5
}

reactive_at() {
    echo "global.stage.get_actor_at_pos(imports.gi.Clutter.PickMode.REACTIVE, $1, $2)"
}

expect "!!Main.panel.statusArea['$UUID']" true 'adds its indicator to the top bar'

# Migration: the v0.2 helpers become a set in CSS pixels at the v0.2 zoom, not shown.
wait_for "$EXTENSION._settings.get_boolean('migrated')"
MIGRATED=$(shell_eval "$E2E.entry('Untitled 1').id")
expect "$E2E.fileHelpers('$MIGRATED')" 'V 200 | R 80,40 200x100' \
    'the migration turns the v0.2 helpers into a set, in CSS pixels'
expect "(f => [f.migrated, f.zoom, f.grid.columns, f.grid.visible].join())($E2E.file('$MIGRATED'))" \
    'true,125,4,false' 'the migrated set keeps the zoom and the grid settings, and says where it comes from'
expect "$MANAGER.models.length" 0 'the migrated set is not shown'

# A page: a dark backdrop with a red block at CSS (300, 200), 240 × 160. Its frame is at (200, 150),
# so the block covers stage pixels 500 to 740 across and 350 to 510 down.
open_window Page 200 150 800x600 '#3d3846' '300,200,240,160,#e01b24'
open_window Other 1100 150 400x300 '#241f31'

press_keys Super_L Shift_L m
expect "$OVERLAY.editing && Main.modalCount" 1 'the edit shortcut enters edit mode'

pointer_drag 300 250 500 400
expect "$E2E.model('Page')?.name + ' / ' + $E2E.helpers('Page')" 'Untitled 2 / R 100,100 200x150' \
    'dragging on a window draws a rectangle in a new set, relative to the window'
PAGE=$(shell_eval "$E2E.model('Page').id")
expect "$E2E.fileHelpers('$PAGE')" 'R 100,100 200x150' 'the new set is saved to its file'
expect "$E2E.view('Page').layer.get_parent() === $E2E.win('Page').get_compositor_private()" true \
    'the view is a child of the window actor'
expect "$E2E.view('Page')._helperViews.get(1).label.text" '200 × 150' 'the rectangle shows its size'

pointer_move 700 500
press_keys v
expect "$E2E.helpers('Page')" 'R 100,100 200x150 | V 500' 'V adds a vertical guide at the pointer'
expect "$E2E.view('Page')._helperViews.get(2).label.text" 'x 500' \
    'guide labels show their position in the window'
press_keys Shift_L Right
expect "$E2E.helpers('Page')" 'R 100,100 200x150 | V 510' 'Shift+Right nudges the selection by 10'

press_keys Tab
expect "$E2E.view('Page').selectedId" 1 'Tab cycles the selection'
press_keys Alt_L Right
press_keys Control_L c
expect "$E2E.helpers('Page')" 'R 100,100 201x150 | V 510' 'Alt+Right widens a rectangle'
expect "$CLIPBOARD" '201 × 150' 'Ctrl+C copies the selected measurement'

pointer_drag 400 400 400 420
expect "$E2E.helpers('Page')" 'R 100,100 201x170 | V 510' 'dragging an edge resizes'
pointer_drag 350 300 370 310
expect "$E2E.helpers('Page')" 'R 120,110 201x170 | V 510' 'dragging inside the selected rectangle moves it'

pointer_move 710 550
pointer_button PRESSED
pointer_move 760 550
press_keys Escape
pointer_button RELEASED
expect "$E2E.helpers('Page') + ' ' + $OVERLAY.editing" 'R 120,110 201x170 | V 510 true' \
    'Escape cancels a drag in progress and stays in edit mode'

pointer_drag 750 600 900 700
pointer_click 250 700
expect "$E2E.view('Page').selectedId" null 'a click on empty space clears the selection'
pointer_click 820 650
expect "$E2E.view('Page').selectedId" 3 'a click inside a rectangle selects it'
press_keys Delete
expect "$E2E.ids('Page')" 1,2 'Delete removes the selection'
press_keys Control_L z
expect "$E2E.ids('Page')" 1,2,3 'Ctrl+Z undoes the last change'
press_keys Control_L z
press_keys Control_L z
expect "$E2E.helpers('Page')" 'R 100,100 201x170 | V 510' 'Ctrl+Z goes further back, one change at a time'
press_keys Control_L Shift_L z
press_keys Control_L y
expect "$E2E.helpers('Page') + ' / ' + $E2E.fileHelpers('$PAGE')" \
    'R 120,110 201x170 | V 510 | R 550,450 150x100 / R 120,110 201x170 | V 510 | R 550,450 150x100' \
    'Ctrl+Shift+Z and Ctrl+Y redo, and the result is saved'
pointer_click 820 650
press_keys Delete

pointer_move 1200 300
press_keys h
expect "$E2E.model('Other')?.name + ' ' + $E2E.model('Other')?.content.color + ' ' + $E2E.helpers('Other')" \
    'Untitled 3 #2ec2d6 H 150' 'a guide on another window starts a set with the next free color'
expect "$E2E.view('Page').selectedId" null 'targeting another window clears the selection'

# Area measuring and snapping read the capture taken when edit mode started, without the views:
# the rectangle drawn over the block would otherwise cut its area short.
pointer_move 600 420
press_keys d
wait_for "$OVERLAY._readout.text === '240 × 160'"
expect "$OVERLAY._areaWidth.text + ' ' + $OVERLAY._areaHeight.text" '240 160' \
    'D measures the area under the pointer, ignoring the helpers over it'
pointer_move 300 700
expect "$OVERLAY._readout.text" '800 × 600' 'the measured area stops at the edges of the window'
pointer_move 600 420
wait_for "$OVERLAY._readout.text === '240 × 160'"
press_keys Return
expect "$E2E.helpers('Page')" 'R 120,110 201x170 | V 510 | R 300,200 240x160' \
    'Enter adds a rectangle on the measured area'
press_keys d
expect "$OVERLAY._areaGroup.visible" false 'D again stops measuring the area'
press_keys Delete

pointer_drag 503 353 737 507
expect "$E2E.helpers('Page')" 'R 120,110 201x170 | V 510 | R 300,200 240x160' \
    'a dragged corner snaps to the nearest screen edges'
press_keys Delete
key_state Control_L PRESSED
pointer_drag 503 353 737 507
key_state Control_L RELEASED
expect "$E2E.helpers('Page')" 'R 120,110 201x170 | V 510 | R 303,203 234x154' 'Ctrl+drag does not snap'
press_keys Delete
# Release in the same batch as the last motion, before the shell has read the row it needs.
pointer_move 490 720
press_keys v
pointer_button PRESSED
shell_eval "const {Clutter, GLib} = imports.gi;
    global._headlessPointer.notify_absolute_motion(GLib.get_monotonic_time(), 497, 460);
    global._headlessPointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY,
        Clutter.ButtonState.RELEASED);" >/dev/null
wait_for "$OVERLAY._drag === null"
expect "$E2E.helpers('Page') + ' / ' + $E2E.fileHelpers('$PAGE')" \
    'R 120,110 201x170 | V 510 | V 300 / R 120,110 201x170 | V 510 | V 300' \
    'a drag released before its row is read still snaps'
press_keys Delete

# The badge menu, opened from the badge in the window's bottom-right corner.
expect "$E2E.view('Page').badgeActor.visible + ' ' + $E2E.view('Page')._badgeLabel.text" 'true Untitled 2' \
    'edit mode shows the badge of each view'
click_actor "$E2E.view('Page').badgeActor"
expect "$OVERLAY.badgeMenu?.menu.isOpen + ' ' + $E2E.labels($OVERLAY.badgeMenu.menu.box).slice(0, 2).join(' / ')" \
    'true Untitled 2 / Main view · saved' 'a click on the badge opens its menu'
click_actor "$OVERLAY.badgeMenu.chips.grid"
expect "$E2E.view('Page')._grid.get_n_children() + ' ' + $E2E.file('$PAGE').grid.visible" '12 true' \
    'the Grid chip shows the column grid and saves it'
expect "$E2E.bounds($E2E.view('Page')._grid.get_child_at_index(0)).split(',').slice(0, 2).join()" 224,150 \
    'the grid is laid out inside the window'
press_keys Escape
expect "$OVERLAY.badgeMenu + ' ' + $OVERLAY.editing" 'null true' 'Escape closes the badge menu first'

# Set settings: one commit, and one undo step.
click_actor "$E2E.view('Page').badgeActor"
click_actor "$OVERLAY.badgeMenu.menu._getMenuItems()[2]"
wait_for "!!$E2E.dialog()?.visible"
shell_eval "const [name, , zoom, columns] = $E2E.entries($E2E.dialog());
    name.text = 'Landing page';
    zoom.text = '125';
    columns.text = '6';" >/dev/null
click_actor "$E2E.button($E2E.dialog(), 'Save')"
expect "[$E2E.model('Page').name, $E2E.model('Page').content.zoom, $E2E.view('Page')._grid.get_n_children(),
    $E2E.view('Page')._badgeLabel.text].join()" 'Landing page,125,6,Landing page' \
    'Save in Set settings applies the name, the zoom, and the grid'
expect "$E2E.bounds($E2E.view('Page')._helperViews.get(1).shape) + ' ' + $E2E.view('Page')._helperViews.get(1).label.text" \
    '350,287.5,251.25,212.5 201 × 170' 'the zoom scales helpers from the window corner, in CSS pixels'
expect "(f => f.name + ' ' + f.zoom + ' ' + f.grid.columns)($E2E.file('$PAGE'))" 'Landing page 125 6' \
    'Set settings are saved to the file'
pointer_move 600 600
press_keys Control_L z
expect "$E2E.model('Page').name + ' ' + $E2E.model('Page').content.zoom" 'Untitled 2 100' \
    'Ctrl+Z undoes Set settings in one step'
press_keys Control_L y

# The file chooser: the dialog steps aside while it is open, and keeps its draft.
click_actor "$E2E.view('Page').badgeActor"
click_actor "$OVERLAY.badgeMenu.menu._getMenuItems()[2]"
wait_for "!!$E2E.dialog()?.visible"
shell_eval "$E2E.entries($E2E.dialog())[0].text = 'Draft'" >/dev/null
CHOOSER="$E2E.win('Choose a mockup image')"
shell_eval "void ($E2E.chooserDialog = $E2E.dialog())" >/dev/null
click_actor "$E2E.button($E2E.dialog(), 'Choose…')"
wait_for "!!$CHOOSER || $E2E.chooserDialog.visible" 60
if [[ $(shell_eval "!!$CHOOSER") == true ]]; then
    expect "$E2E.chooserDialog.visible + ' ' + $OVERLAY.editing + ' ' + Main.modalCount" 'false false 0' \
        'while the file chooser is open, the dialog hides and releases its grab, and edit mode ends'
    shell_eval "$CHOOSER.activate(global.get_current_time())" >/dev/null
    wait_for "$CHOOSER.has_focus()"
    press_keys Escape
else
    echo 'skip the file chooser portal is not available'
fi
wait_for "$E2E.dialog()?.visible" 30
expect "$E2E.entries($E2E.dialog())[0].text + ' ' + Main.modalCount" 'Draft 1' \
    'when the chooser closes, the dialog comes back with its draft'
click_actor "$E2E.button($E2E.dialog(), 'Cancel')"
expect "$E2E.model('Page').name + ' ' + !!$E2E.dialog()" 'Landing page false' 'Cancel changes nothing'

# Save as new set: the view switches to a new set, and the old file keeps its last content.
press_keys Super_L Shift_L m
pointer_move 600 600
click_actor "$E2E.view('Page').badgeActor"
click_actor "$OVERLAY.badgeMenu.menu._getMenuItems()[3]"
wait_for "!!$E2E.dialog()?.visible"
expect "$E2E.entries($E2E.dialog())[0].text" 'Landing page 2' 'Save as new set suggests a free name'
type_keys v 2 Return
expect "$E2E.model('Page').name + ' ' + ($E2E.model('Page').id !== '$PAGE') + ' ' + $E2E.file('$PAGE').name" \
    'v2 true Landing page' 'Save as new set switches the view to a new set and keeps the old one'
V2=$(shell_eval "$E2E.model('Page').id")
expect "$E2E.fileHelpers('$V2')" 'R 120,110 201x170 | V 510' 'the new set is saved with the helpers'

# The color picker reads the screen without the views: a click inside the rectangle, over the red
# block, copies red, not the rectangle's tint.
SWATCH="$EXTENSION._picker?._label.text"
pointer_move 550 420
press_keys Super_L Shift_L c
wait_for "$SWATCH === '#e01b24'"
expect "$E2E.view('Page').layer.visible + ' ' + $OVERLAY.actor.visible" 'false false' \
    'the picker hides the views while reading pixels'
pointer_click 550 420
wait_for "$EXTENSION._picker === null"
expect "$CLIPBOARD.then(text => text + ' ' + $E2E.view('Page').layer.visible + ' ' + $OVERLAY.editing)" \
    '#e01b24 true true' 'a click copies the color under the helpers, and edit mode comes back'
press_keys Super_L Shift_L c
wait_for "!!$EXTENSION._picker"
press_keys Escape
wait_for "$EXTENSION._picker === null"
expect "$OVERLAY.editing" true 'Escape cancels the picker'

# The mockup, at its CSS size and the set's zoom of 125%.
MOCKUP="$E2E.view('Page')._mockup"
shell_eval "const {GdkPixbuf} = imports.gi;
    const image = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 400, 200);
    image.fill(0x2ec27eff);
    image.savev('$WORK/mockup.png', 'png', [], []);
    const model = $E2E.model('Page');
    Object.assign(model.content.mockup, {file: '$WORK/mockup.png', visible: true});
    $MANAGER.commit(model);" >/dev/null
wait_for "$MOCKUP.visible"
expect "$E2E.bounds($MOCKUP) + ' ' + $MOCKUP.opacity" '200,150,500,250 128' \
    'the mockup shows at its CSS size, the zoom, and half opacity'
pointer_move 300 300
pointer_button PRESSED SECONDARY
pointer_move 340 330
press_keys bracketright
pointer_button RELEASED SECONDARY
press_keys Control_L Shift_L Right
press_keys bracketright
expect "(m => [m.x, m.y, m.opacity].join())($E2E.file('$V2').mockup) + ' ' + $MOCKUP.opacity" '40,24,60 153' \
    'right-drag and Ctrl+arrows move the mockup, ] raises its opacity after the drag'
expect "$E2E.helpers('Page')" 'R 120,110 201x170 | V 510' 'moving the mockup leaves the helpers alone'

press_keys Escape
expect "$OVERLAY.editing + ' ' + $OVERLAY.actor.reactive + ' ' + Main.modalCount" 'false false 0' \
    'Escape leaves edit mode and releases the grab'
for point in '837 600' '450 500' '300 300'; do
    expect "(a => $E2E.inViews(a) || $OVERLAY.actor.contains(a))($(reactive_at $point))" false \
        "outside edit mode, the pointer goes through the views at $point"
done
expect "$E2E.view('Page').badgeActor.visible" true 'the badge shows outside edit mode by default'
shell_eval "$EXTENSION._settings.set_boolean('show-badges', false)" >/dev/null
expect "$E2E.view('Page').badgeActor.visible" false 'the badges can be turned off'
shell_eval "$EXTENSION._settings.set_boolean('show-badges', true)" >/dev/null

shell_eval "$E2E.win('Page').move_frame(true, 250, 200)" >/dev/null
expect "$E2E.bounds($E2E.view('Page')._helperViews.get(1).shape).split(',').slice(0, 2).join()" 400,337.5 \
    'helpers move with their window'
shell_eval "$E2E.win('Page').move_frame(true, 200, 150)" >/dev/null
shell_eval "$E2E.win('Page').minimize()" >/dev/null
expect "$E2E.win('Page').get_compositor_private().visible" false 'helpers hide with a minimized window'
shell_eval "$E2E.win('Page').unminimize()" >/dev/null

# The panel menu lists the sets on screen and the library.
open_menu
expect "$EXTENSION._onScreen.section._getMenuItems().map(item => $E2E.labels(item).join(' / ')).join(' | ')" \
    'v2 / main only · Page | Untitled 3 / main only · Other' 'the menu lists the sets on screen'
expect "$EXTENSION._library.header.count.text + ' ' + $E2E.labels($E2E.row('library', 'v2')).join(' / ')" \
    '4 v2 / edited just now / On screen' 'the library lists every set, and marks those on screen'
click_actor "$E2E.button($E2E.row('onScreen', 'Untitled 3'), 'Hide')"
expect "$E2E.model('Other').hidden + ' ' + $E2E.view('Other').layer.get_parent() + ' ' +
    $E2E.labels($E2E.row('onScreen', 'Untitled 3'))[1]" 'true null main only · Other · hidden' \
    'the eye hides a set'
click_actor "$E2E.button($E2E.row('onScreen', 'Untitled 3'), 'Show')"
expect "$E2E.model('Other').hidden" false 'the eye shows it again'
click_actor "$E2E.row('onScreen', 'v2')"
expect "$OVERLAY.editing + ' ' + $OVERLAY.badgeMenu?.view.model.name" 'true v2' \
    'a set on screen opens in edit mode with its badge menu'
press_keys Escape
press_keys Escape

# Loading a set onto a window replaces the set shown there.
open_menu
click_actor "$E2E.row('library', 'Landing page')"
expect "$OVERLAY._mode + ' ' + $OVERLAY._loadHint.text" 'load Click a window to show “Landing page” · Esc cancels' \
    'a library set waits for a click on a window'
pointer_click 1300 300
expect "$E2E.model('Other')?.name + ' ' + $E2E.helpers('Other') + ' ' + !!$MANAGER.modelOf('$(shell_eval "$E2E.entry('Untitled 3').id")')" \
    'Landing page R 120,110 201x170 | V 510 false' 'a click loads the set onto the window, replacing its set'
open_menu
click_actor "$E2E.row('library', 'Untitled 3')"
press_keys Escape
expect "$OVERLAY._mode + ' ' + Main.modalCount + ' ' + $MANAGER.models.length" 'null 0 2' 'Escape cancels loading'

# Rename and delete from the library, with the buttons that show on hover.
open_menu
click_actor "$E2E.button($E2E.row('library', 'Untitled 3'), 'Rename')"
wait_for "!!$E2E.dialog()?.visible"
type_keys d o c s Return
UNTITLED3=$(shell_eval "$E2E.entry('docs')?.id")
expect "$E2E.file('$UNTITLED3')?.name" docs 'Rename renames a set in its file'
open_menu
click_actor "$E2E.button($E2E.row('library', 'docs'), 'Delete')"
wait_for "!!$E2E.dialog()?.visible"
click_actor "$E2E.button($E2E.dialog(), 'Delete')"
expect "$E2E.file('$UNTITLED3') + ' ' + $MANAGER.store.entries().length" 'null 3' 'Delete removes a set'
[[ -f $XDG_DATA_HOME/Trash/files/$UNTITLED3.json ]] && echo 'ok   the file moves to the trash' ||
    { echo 'FAIL the file moves to the trash'; FAILURES=$((FAILURES + 1)); }

# The grid shortcut acts on the focused window.
shell_eval "$E2E.win('Other').activate(global.get_current_time())" >/dev/null
wait_for "$E2E.win('Other').has_focus()"
press_keys Super_L Shift_L g
expect "$E2E.model('Other').content.grid.visible + ' ' + $E2E.view('Other')._grid.get_n_children()" 'false 0' \
    'the grid shortcut hides the grid of the focused window'
press_keys Super_L Shift_L g
expect "$E2E.model('Other').content.grid.visible + ' ' + $E2E.view('Other')._grid.get_n_children()" 'true 6' \
    'the grid shortcut shows it again'

shell_eval "Main.extensionManager.disableExtension('$UUID')" >/dev/null
wait_for "Main.extensionManager.lookup('$UUID').state !== 1"
expect "global.get_window_actors().some(a => a.get_children().some(c => c.name === 'measure-things-view'))" false \
    'disabling removes every view'
expect "!!Main.panel.statusArea['$UUID'] || Main.layoutManager.uiGroup.get_children().some(a => a.name?.startsWith('measure-things'))" \
    false 'disabling removes the indicator and the layer'
shell_eval "Main.extensionManager.enableExtension('$UUID')" >/dev/null
wait_for "Main.extensionManager.lookup('$UUID').state === 1"
wait_for "$MANAGER.store.entries().length === 3"
expect "$MANAGER.models.length + ' ' + $MANAGER.store.entries().map(e => e.name).sort().join()" \
    '0 Landing page,Untitled 1,v2' 'enabling keeps every set, with no view on screen'

shell_eval "$MANAGER.load('$V2', $E2E.win('Page')); $MANAGER.load('$PAGE', $E2E.win('Other')); 1" >/dev/null
open_menu
click_actor "$E2E.button($E2E.row('onScreen', 'Landing page'), 'Remove from screen')"
expect "$MANAGER.models.map(m => m.name).join() + ' ' + $E2E.win('Other').get_compositor_private().get_children().some(c => c.name === 'measure-things-view')" \
    'v2 false' '✕ removes a set from the screen'
shell_eval "$EXTENSION._indicator.menu.close()" >/dev/null
shell_eval "$E2E.win('Page').delete(global.get_current_time())" >/dev/null
wait_for "!$E2E.win('Page')"
expect "$MANAGER.models.length + ' ' + $E2E.fileHelpers('$V2')" '0 R 120,110 201x170 | V 510' \
    'closing a window removes its view and keeps its set'

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
type_keys p i c k space c o l o r
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
shell_eval "$E2E.win('Other').minimize()" >/dev/null
# GTK draws at 125% itself, from its buffer's corner, 14 CSS pixels left of the frame for the
# shadow: a block at x 300 would start halfway through a device pixel, and its blended edge would
# measure short. At x 302 it starts on device pixel 395 of the buffer, and Mutter moves the buffer
# onto whole device pixels: the block covers stage pixels 402.4 to 642.4 across, 300 to 460 down.
open_window Page 100 100 800x600 '#3d3846' '302,200,240,160,#e01b24'
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
pointer_drag 405 303 639 457
expect "$E2E.helpers('Page') + ' / ' + $E2E.bounds($E2E.view('Page')._helperViews.get(1).shape)" \
    'R 302,200 240x160 / 402.4,300,240,160' 'at 125%, dragged edges snap to screen edges'
press_keys Escape
pointer_move 600 440
press_keys Super_L Shift_L c
wait_for "$SWATCH === '#e01b24'"
pointer_click 600 440
wait_for "$EXTENSION._picker === null"
expect "$CLIPBOARD" '#e01b24' 'at 125%, the picker reads the pixel under the pointer'

if grep -E -A4 'JS (ERROR|WARNING)|Exception in callback|Measure Things:' "$WORK/shell.log"; then
    echo 'FAIL the shell logged JavaScript errors'
    FAILURES=$((FAILURES + 1))
fi
if ((FAILURES > 0)); then
    echo "$FAILURES check(s) failed."
    exit 1
fi
echo 'All end-to-end checks passed.'
