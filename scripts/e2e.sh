#!/usr/bin/env bash
# End-to-end test: runs the checkout in a headless GNOME Shell with plain GTK test windows, drives
# it with a virtual pointer and keyboard, and checks the migration from v0.2, sets and their views
# on windows, editing, snapping, copies and zones, the badge menu, Set settings, the panel menu,
# the color picker, the mockup, the click-through views, fractional scaling, and a clean disable.
# Exits non-zero on any failed check or shell JS error.
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

# Checks a condition of the shell script itself: check 'description' '[[ -f file ]]'.
check() {
    if eval "$2"; then
        echo "ok   $1"
    else
        echo "FAIL $1"
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
    set: id => extension()._manager.modelOf(id),
    views: title => extension()._manager.viewsOn(global._e2e.win(title)),
    item: (badgeMenu, label) => badgeMenu.menu._getMenuItems().find(item => labels(item)[0] === label),
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

# Types text through the virtual keyboard: type_text /tmp/some/path.png.
type_text() {
    local i
    for ((i = 0; i < ${#1}; i++)); do
        input_eval "const keyval = Clutter.unicode_to_keysym('${1:i:1}'.codePointAt(0));
            global._headlessKeyboard.notify_keyval(now, keyval, Clutter.KeyState.PRESSED);
            global._headlessKeyboard.notify_keyval(now, keyval, Clutter.KeyState.RELEASED);"
    done
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

# Past 1,000 helpers, the migration keeps the first 1,000 and says how many it left out. The check
# migrates again from 1,003 helpers, then puts the library back as it was.
shell_eval "const settings = $EXTENSION._settings;
    settings.set_string('helpers', JSON.stringify(Array.from({length: 1003}, (_, i) => ({kind: 'vertical', x: i}))));
    settings.set_boolean('migrated', false);
    $MANAGER.store._entries.delete('$MIGRATED.json');
    $MANAGER._migrate();" >/dev/null
wait_for "$EXTENSION._settings.get_boolean('migrated')"
expect "$MANAGER.store.entries().filter(e => e.id !== '$MIGRATED').map(e => $MANAGER.store.get(e.id).content.helpers.length).join()" \
    1000 'the migration keeps at most 1,000 helpers'
expect "Main.messageTray.getSources().flatMap(source => source.notifications).some(n => n.body.includes('3 v0.2 helpers'))" \
    true 'the migration says how many helpers it left out'
EXTRA=$(shell_eval "$MANAGER.store.entries().find(e => e.id !== '$MIGRATED').id")
shell_eval "$MANAGER.delete('$EXTRA'); $MANAGER.store._read('$MIGRATED.json'); $EXTENSION._settings.reset('helpers');" >/dev/null
expect "$MANAGER.store.entries().map(e => e.name).join()" 'Untitled 1' 'the library is back to the migrated set'

# A page: a dark backdrop with a red block at CSS (300, 200), 240 × 160. Its frame is at (200, 150),
# so the block covers stage pixels 500 to 740 across and 350 to 510 down.
open_window Page 200 150 800x600 '#3d3846' '300,200,240,160,#e01b24'
open_window Other 1100 150 400x300 '#241f31'

press_keys Super_L Shift_L m
expect "$OVERLAY.editing && Main.modalCount" 1 'the edit shortcut enters edit mode'

pointer_move 300 250
pointer_button PRESSED
pointer_move 400 320
pointer_move 500 400
expect "$E2E.view('Page')._helperViews.size + ' ' + $E2E.view('Page').badgeActor.visible + ' ' + $MANAGER.onScreen.length" \
    '1 false 0' 'a drag shows its rectangle, but the set has no badge and is not listed before its first commit'
pointer_button RELEASED
expect "$E2E.model('Page')?.name + ' / ' + $E2E.helpers('Page')" 'Untitled 2 / R 100,100 200x150' \
    'dragging on a window draws a rectangle in a new set, relative to the window'
expect "$E2E.view('Page').badgeActor.visible + ' ' + $MANAGER.onScreen.length" 'true 1' \
    'the first commit gives the set its badge and lists it'
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

# GNOME 50 sets cursors per actor; GNOME 49 sets one on the display, which Eval cannot read.
if [[ $(shell_eval "'get_cursor_type' in $OVERLAY.actor") == true ]]; then
    pointer_move 400 400
    expect "$OVERLAY.actor.get_cursor_type() === imports.gi.Clutter.CursorType.S_RESIZE" true \
        'an edge of the selected rectangle shows a resize cursor'
fi
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

# A drag cancelled before its first commit creates no set.
pointer_move 1150 400
pointer_button PRESSED
pointer_move 1250 450
press_keys Escape
pointer_button RELEASED
expect "$MANAGER.models.length + ' ' + $MANAGER.store.entries().length + ' ' + $OVERLAY.editing" '1 2 true' \
    'cancelling a drag on a window with no set creates none'

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
click_actor "$E2E.item($OVERLAY.badgeMenu, 'Set settings…')"
wait_for "!!$E2E.dialog()?.visible"
# Numbers are rounded; an empty entry keeps the previous value.
shell_eval "const [name, , zoom, columns, gutter] = $E2E.entries($E2E.dialog());
    name.text = 'Landing page';
    zoom.text = '125';
    columns.text = '5.6';
    gutter.text = '';" >/dev/null
click_actor "$E2E.button($E2E.dialog(), 'Save')"
expect "[$E2E.model('Page').name, $E2E.model('Page').content.zoom, $E2E.view('Page')._grid.get_n_children(),
    $E2E.view('Page')._badgeLabel.text].join()" 'Landing page,125,6,Landing page' \
    'Save in Set settings applies the name, the zoom, and the grid'
expect "$E2E.bounds($E2E.view('Page')._helperViews.get(1).shape) + ' ' + $E2E.view('Page')._helperViews.get(1).label.text" \
    '350,287.5,251.25,212.5 201 × 170' 'the zoom scales helpers from the window corner, in CSS pixels'
expect "(f => f.name + ' ' + f.zoom + ' ' + f.grid.columns + ' ' + f.grid.gutter)($E2E.file('$PAGE'))" \
    'Landing page 125 6 24' 'Set settings are saved to the file, with numbers rounded and empty ones kept'
pointer_move 600 600
press_keys Control_L z
expect "$E2E.model('Page').name + ' ' + $E2E.model('Page').content.zoom" 'Untitled 2 100' \
    'Ctrl+Z undoes Set settings in one step'
press_keys Control_L y

# A long name is cut in the badge.
shell_eval "const model = $E2E.model('Page'); model.name = 'x'.repeat(40); model.view.sync();" >/dev/null
expect "$E2E.view('Page')._badgeLabel.text" "$(printf 'x%.0s' $(seq 23))…" 'the badge cuts a long name'
shell_eval "const model = $E2E.model('Page'); model.name = 'Landing page'; model.view.sync();" >/dev/null

# The file chooser: the dialog steps aside while it is open, and keeps its draft.
click_actor "$E2E.view('Page').badgeActor"
click_actor "$E2E.item($OVERLAY.badgeMenu, 'Set settings…')"
wait_for "!!$E2E.dialog()?.visible"
shell_eval "$E2E.entries($E2E.dialog())[0].text = 'Draft'" >/dev/null
CHOOSER="$E2E.win('Choose a mockup image')"
shell_eval "void ($E2E.chooserDialog = $E2E.dialog())" >/dev/null
click_actor "$E2E.button($E2E.dialog(), 'Choose…')"
wait_for "!!$CHOOSER || $E2E.chooserDialog.visible" 60
PORTAL=0
if [[ $(shell_eval "!!$CHOOSER") == true ]]; then
    PORTAL=1
    expect "$E2E.chooserDialog.visible + ' ' + $OVERLAY.editing + ' ' + Main.modalCount" 'false false 0' \
        'while the file chooser is open, the dialog hides and releases its grab, and edit mode ends'
    shell_eval "$CHOOSER.activate(global.get_current_time())" >/dev/null
    wait_for "$CHOOSER.has_focus()"
    press_keys Super_L Shift_L m
    press_keys Super_L Shift_L g
    expect "$OVERLAY.editing + ' ' + $MANAGER.models.length + ' ' + !!$EXTENSION._picker" 'false 2 false' \
        'the shortcuts do nothing while Set settings or its file chooser is open'
    press_keys Escape
else
    echo 'skip the file chooser portal is not available'
fi
wait_for "$E2E.dialog()?.visible" 30
expect "$E2E.entries($E2E.dialog())[0].text + ' ' + Main.modalCount" 'Draft 1' \
    'when the chooser closes, the dialog comes back with its draft'
click_actor "$E2E.button($E2E.dialog(), 'Cancel')"
expect "$E2E.model('Page').name + ' ' + !!$E2E.dialog()" 'Landing page false' 'Cancel changes nothing'

# An image chosen in the file chooser becomes the set's mockup, and turns it on.
if ((PORTAL)); then
    shell_eval "const {GdkPixbuf} = imports.gi;
        const image = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 40, 20);
        image.fill(0x2ec27eff);
        image.savev('$WORK/chosen.png', 'png', [], []);" >/dev/null
    press_keys Super_L Shift_L m
    pointer_move 600 600
    click_actor "$E2E.view('Page').badgeActor"
    click_actor "$E2E.item($OVERLAY.badgeMenu, 'Set settings…')"
    wait_for "!!$E2E.dialog()?.visible"
    shell_eval "void ($E2E.chooserDialog = $E2E.dialog())" >/dev/null
    click_actor "$E2E.button($E2E.dialog(), 'Choose…')"
    wait_for "!!$CHOOSER" 60
    shell_eval "$CHOOSER.activate(global.get_current_time())" >/dev/null
    wait_for "$CHOOSER.has_focus()"
    press_keys Control_L l
    type_text "$WORK/chosen.png"
    # The first Return goes to the file, the second chooses it.
    press_keys Return
    sleep 0.5
    press_keys Return
    wait_for "$E2E.chooserDialog.visible" 30
    click_actor "$E2E.button($E2E.dialog(), 'Save')"
    expect "(m => m.file + ' ' + m.visible)($E2E.model('Page').content.mockup)" "$WORK/chosen.png true" \
        'an image chosen in the file chooser becomes the mockup, shown'
    shell_eval "const model = $E2E.model('Page');
        Object.assign(model.content.mockup, {file: '', visible: false});
        $MANAGER.commit(model);" >/dev/null
fi

# Save as new set: the view switches to a new set, and the old file keeps its last content.
press_keys Super_L Shift_L m
pointer_move 600 600
click_actor "$E2E.view('Page').badgeActor"
click_actor "$E2E.item($OVERLAY.badgeMenu, 'Save as new set…')"
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

# An image replaced at the same path shows its new content, one that goes is not drawn, and it
# comes back with its file.
shell_eval "const {GdkPixbuf} = imports.gi;
    const image = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 200, 100);
    image.fill(0xe66100ff);
    image.savev('$WORK/mockup.png', 'png', [], []);" >/dev/null
expect "$E2E.bounds($MOCKUP).split(',').slice(2).join() + ' ' + $MOCKUP.visible" '250,125 true' \
    'a mockup image replaced at the same path shows its new content'
rm "$WORK/mockup.png"
expect "$MOCKUP.visible" false 'a mockup image that goes is not drawn'
shell_eval "const {GdkPixbuf} = imports.gi;
    const image = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 400, 200);
    image.fill(0x2ec27eff);
    image.savev('$WORK/mockup.png', 'png', [], []);" >/dev/null
expect "$E2E.bounds($MOCKUP).split(',').slice(2).join() + ' ' + $MOCKUP.visible" '500,250 true' \
    'a mockup image that comes back is drawn again'

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
# A view's geometry follows the window actor: the window reports a move before its actor moves.
for point in '300 220' '120 90'; do
    shell_eval "$E2E.win('Page').move_frame(true, ${point% *}, ${point#* })" >/dev/null
    expect "(v => [v.geometry.originX - v._actor.x - v.geometry.layerX * v.geometry.k,
        v.geometry.originY - v._actor.y - v.geometry.layerY * v.geometry.k].map(d => Math.round(d * 1000) / 1000).join())($E2E.view('Page'))" \
        '0,0' "a view's geometry follows its window actor after a move to $point"
done
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
# A click on a set on screen shows its window first: a minimized one comes back, and edit mode
# starts once the window stopped animating, so its capture holds no animation frame.
shell_eval "$E2E.win('Page').minimize()" >/dev/null
wait_for "$E2E.win('Page').minimized"
shell_eval "const overlay = $OVERLAY, enter = overlay.enterEdit.bind(overlay);
    overlay.enterEdit = () => {
        const window = $E2E.win('Page'), actor = window.get_compositor_private();
        global._enterState = [window.minimized,
            ['opacity', 'scale-x', 'scale-y'].some(name => actor.get_transition(name))].join();
        return enter();
    };" >/dev/null
click_actor "$E2E.row('onScreen', 'v2')"
wait_for "$OVERLAY.editing"
expect "global._enterState + ' ' + $OVERLAY.badgeMenu?.view.model.name" 'false,false v2' \
    'a set on screen opens in edit mode, with its badge menu, once its window is shown'
shell_eval "delete $OVERLAY.enterEdit" >/dev/null
press_keys Escape

# The selection and the gesture belong to a window that stays on screen.
pointer_click 450 380
expect "$E2E.view('Page').selectedId" 1 'a click inside a rectangle selects it'
pointer_move 600 600
pointer_button PRESSED
pointer_move 650 640
shell_eval "$E2E.win('Page').minimize()" >/dev/null
expect "$OVERLAY._drag + ' ' + $E2E.view('Page').selectedId + ' ' + $E2E.helpers('Page')" \
    'null null R 120,110 201x170 | V 510' 'minimizing the window cancels the gesture and clears the selection'
pointer_button RELEASED
shell_eval "$E2E.win('Page').unminimize()" >/dev/null
wait_for "$E2E.win('Page').get_compositor_private().visible"
pointer_click 450 380
expect "$E2E.view('Page').selectedId" 1 'the rectangle can be selected again'
shell_eval "const workspaces = global.workspace_manager;
    workspaces.append_new_workspace(false, global.get_current_time()).activate(global.get_current_time());" >/dev/null
expect "$E2E.view('Page').selectedId" null 'leaving the workspace clears the selection'
shell_eval "global.workspace_manager.get_workspace_by_index(0).activate(global.get_current_time())" >/dev/null
wait_for "$E2E.win('Page').get_compositor_private().visible"
press_keys Escape

# Loading a set onto a window that shows another set adds a view there.
open_menu
click_actor "$E2E.row('library', 'Landing page')"
expect "$OVERLAY._mode + ' ' + $OVERLAY._loadHint.text" 'load Click a window to show “Landing page” · Esc cancels' \
    'a library set waits for a click on a window'
pointer_click 1300 300
expect "$MANAGER.viewsOn($E2E.win('Other')).map(view => view.set.name + ' ' + view.isMain).join()" \
    'Untitled 3 true,Landing page true' 'a click loads the set onto a window that shows another set, as a second view'
shell_eval "$MANAGER.removeFromScreen($MANAGER.modelOf($E2E.entry('Untitled 3').id))" >/dev/null
open_menu
click_actor "$E2E.row('library', 'Untitled 3')"
press_keys Escape
expect "$OVERLAY._mode + ' ' + Main.modalCount + ' ' + $MANAGER.models.length" 'null 0 2' 'Escape cancels loading'

# Rename and delete from the library, with the buttons that show on hover.
open_menu
UNTITLED3=$(shell_eval "$E2E.entry('Untitled 3').id")
REVISION=$(shell_eval "$E2E.file('$UNTITLED3').revision")
click_actor "$E2E.button($E2E.row('library', 'Untitled 3'), 'Rename')"
wait_for "!!$E2E.dialog()?.visible"
shell_eval "$E2E.entries($E2E.dialog())[0].text = ''" >/dev/null
type_keys Return
expect "$E2E.dialog() + ' ' + $E2E.file('$UNTITLED3').name + ' ' + ($E2E.file('$UNTITLED3').revision === $REVISION)" \
    'null Untitled 3 true' 'an empty name keeps the current one, and writes nothing'
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
check 'the file moves to the trash' "[[ -f $XDG_DATA_HOME/Trash/files/$UNTITLED3.json ]]"

# Rename and delete work on a set on screen too: its view follows the rename, and leaves once the
# file is in the trash.
open_window Third 100 780 300x200 '#26a269'
shell_eval "const model = $MANAGER.createSet($E2E.win('Third')).model;
    $MANAGER.addHelper(model, {kind: 'vertical', x: 50});
    $MANAGER.commit(model);" >/dev/null
THIRD=$(shell_eval "$E2E.model('Third').id")
THIRD_NAME=$(shell_eval "$E2E.model('Third').name")
open_menu
click_actor "$E2E.button($E2E.row('library', '$THIRD_NAME'), 'Rename')"
wait_for "!!$E2E.dialog()?.visible"
shell_eval "$E2E.entries($E2E.dialog())[0].text = 'scratch'" >/dev/null
type_keys Return
expect "$E2E.model('Third').name + ' ' + $E2E.view('Third')._badgeLabel.text + ' ' + $E2E.file('$THIRD').name" \
    'scratch scratch scratch' 'renaming a set on screen renames its view and its file'
open_menu
click_actor "$E2E.button($E2E.row('library', 'scratch'), 'Delete')"
wait_for "!!$E2E.dialog()?.visible"
click_actor "$E2E.button($E2E.dialog(), 'Delete')"
expect "$MANAGER.modelOf('$THIRD') + ' ' + $E2E.file('$THIRD') + ' ' + $E2E.win('Third').get_compositor_private().get_children().some(c => c.name === 'measure-things-view')" \
    'null null false' 'deleting a set on screen removes its views'
check 'the file of a set deleted on screen moves to the trash' "[[ -f $XDG_DATA_HOME/Trash/files/$THIRD.json ]]"

# A delete issued while a write is in flight leaves the file in the trash, as that write left it;
# the commit made after the delete does not bring the file back.
shell_eval "const model = $MANAGER.createSet($E2E.win('Third')).model;
    $MANAGER.addHelper(model, {kind: 'vertical', x: 60});
    $MANAGER.commit(model);
    global._deleted = model.id;
    $MANAGER.delete(model.id);
    model.content.helpers.length = 0;
    $MANAGER.commit(model);" >/dev/null
DELETED=$(shell_eval "global._deleted")
wait_for "!$MANAGER.modelOf('$DELETED')"
sleep 0.5
check 'a delete issued while a write is in flight leaves the file in the trash' \
    "grep -q '\"x\": 60' $XDG_DATA_HOME/Trash/files/$DELETED.json && [[ ! -e $XDG_DATA_HOME/measure-things/sets/$DELETED.json ]]"

# When the file cannot go to the trash, nothing changes: the set stays on screen and in the
# library, the commit made meanwhile is saved, and a notice says so. The ID is forgotten, so a
# later delete works.
mv "$XDG_DATA_HOME/Trash" "$XDG_DATA_HOME/Trash.off"
touch "$XDG_DATA_HOME/Trash"
shell_eval "const model = $MANAGER.createSet($E2E.win('Third')).model;
    $MANAGER.addHelper(model, {kind: 'vertical', x: 70});
    $MANAGER.commit(model);
    global._kept = model.id;
    $MANAGER.delete(model.id);
    $MANAGER.addHelper(model, {kind: 'horizontal', y: 80});
    $MANAGER.commit(model);" >/dev/null
KEPT=$(shell_eval "global._kept")
expect "Main.messageTray.getSources().flatMap(source => source.notifications).some(n => n.body.includes('Could not delete'))" \
    true 'a file that cannot go to the trash shows a notice'
expect "!!$MANAGER.modelOf('$KEPT') + ' ' + $MANAGER.store.entries().some(e => e.id === '$KEPT') + ' ' + $E2E.fileHelpers('$KEPT')" \
    'true true V 70 | H 80' 'the set stays on screen, with the commits made meanwhile saved'
rm "$XDG_DATA_HOME/Trash"
mv "$XDG_DATA_HOME/Trash.off" "$XDG_DATA_HOME/Trash"
shell_eval "$MANAGER.delete('$KEPT')" >/dev/null
expect "$MANAGER.modelOf('$KEPT')" null 'the set can be deleted once the trash works'
check 'and its file is in the trash' "[[ -f $XDG_DATA_HOME/Trash/files/$KEPT.json ]]"
# A helper outside its zone is hidden, and neither drawn nor selectable, but still stored. It comes
# back in its place in the stack, and a view with nothing left to show leaves its window.
shell_eval "const model = $MANAGER.createSet($E2E.win('Third')).model;
    $MANAGER.addHelper(model, {kind: 'rectangle', x: -500, y: 10, width: 50, height: 20});
    $MANAGER.addHelper(model, {kind: 'vertical', x: 50});
    $MANAGER.commit(model);" >/dev/null
expect "(v => v.zoneHelpers().length + ' ' + v.content.helpers.length + ' ' + v._helperViews.size)($E2E.view('Third'))" \
    '1 2 1' 'a helper outside its zone is hidden, but still stored'
shell_eval "const model = $E2E.model('Third'); model.content.helpers[0].x = 10; $MANAGER.commit(model);" >/dev/null
expect "(v => v._shapes.get_children().map(a => [...v._helperViews].find(([, views]) => views.shape === a)[0]).join())($E2E.view('Third'))" \
    '1,2' 'a helper that comes back into its zone keeps its place in the stack'
shell_eval "const model = $E2E.model('Third');
    model.content.helpers = [{...model.content.helpers[0], x: -500}];
    $EXTENSION._settings.set_boolean('show-badges', false);
    $MANAGER.commit(model);" >/dev/null
expect "$E2E.view('Third').layer.get_parent()" null 'a view with nothing to show in its zone is not attached to its window'
shell_eval "$EXTENSION._settings.set_boolean('show-badges', true)" >/dev/null
HIDDEN=$(shell_eval "$E2E.model('Third').id")
shell_eval "$MANAGER.delete('$HIDDEN')" >/dev/null
wait_for "!$MANAGER.modelOf('$HIDDEN')"

shell_eval "$E2E.win('Third').delete(global.get_current_time())" >/dev/null
wait_for "!$E2E.win('Third')"

# A native popup menu stays mapped when edit mode takes its grab, and blocks targeting below it.
TEST_WINDOW_MENU=60,60 open_window Menu 1100 500 400x300 '#241f31'
POPUP="global.get_window_actors().map(a => a.meta_window).find(w => w.get_window_type() === imports.gi.Meta.WindowType.DROPDOWN_MENU)"
wait_for "!!$POPUP" 20
press_keys Super_L Shift_L m
read -r POPUP_X POPUP_Y < <(shell_eval "(r => r.x + 20 + ' ' + (r.y + 20))($POPUP.get_frame_rect())")
expect "$OVERLAY.editing + ' ' + !!$POPUP + ' ' + $POPUP.get_compositor_private().visible" 'true true true' \
    'a native popup menu stays mapped when edit mode takes its grab'
expect "$OVERLAY._targetAt($POPUP_X, $POPUP_Y) + ' ' + $OVERLAY._targetAt(1480, 780).window.title" 'null Menu' \
    'a native popup menu blocks targeting below it'
pointer_drag "$POPUP_X" "$POPUP_Y" $((POPUP_X + 30)) $((POPUP_Y + 20))
expect "$MANAGER.models.map(m => m.view.window.title).sort().join()" 'Other,Page' \
    'a drag on a popup menu draws nothing'
press_keys Escape
shell_eval "$E2E.win('Menu').delete(global.get_current_time())" >/dev/null
wait_for "!$E2E.win('Menu')"

# Copies, linking, and zones. Split is two panes with a divider at CSS x 280 and a red block in each;
# Host and the Promo windows are plain. Sets are made in the shell where the check is about what
# happens next, and the interaction itself is driven with the pointer and the keyboard.
shell_eval "global._libraryBefore = $MANAGER.store.entries().map(entry => entry.id)" >/dev/null
open_window Split 1020 480 560x400 '#deddda' '280,0,280,400,#f6f5f4' '40,40,100,60,#e01b24' '320,40,100,60,#e01b24'
open_window Host 20 780 400x200 '#241f31'
shell_eval "const model = $MANAGER.createSet($E2E.win('Split')).model;
    $MANAGER.addHelper(model, {kind: 'vertical', x: 50});
    $MANAGER.commit(model);" >/dev/null
SPLIT_SET=$(shell_eval "$E2E.model('Split').id")
SPLIT_NAME=$(shell_eval "$E2E.model('Split').name")
M="$E2E.set('$SPLIT_SET')"
HOST_COPY="$E2E.views('Host')[0]"
SPLIT_COPY="$E2E.views('Split')[1]"

# A adds a linked copy of the set edited last, on the window under the pointer.
press_keys Super_L Shift_L m
pointer_move 200 880
press_keys a
expect "$E2E.views('Host').map(view => [view.set.id === '$SPLIT_SET', view.isMain, view.linked].join()).join(' | ')" \
    'true,false,true' 'A adds a linked copy of the set edited last on the window under the pointer'
expect "$HOST_COPY._helperViews.get(1).shape.x + ' ' + $HOST_COPY._badgeLabel.text + ' ' + $HOST_COPY._badgeLink.visible" \
    '50 Copy true' 'the copy shows the helpers of the set, and a badge that reads Copy with a link icon'

# A linked copy follows a drag live, and its edits are the set's.
pointer_move 70 880
pointer_button PRESSED
pointer_move 90 880
pointer_move 100 880
expect "$M.content.helpers[0].x + ' ' + $E2E.view('Split')._helperViews.get(1).shape.x" '80 80' \
    'a drag on a linked copy moves the helper of the main view live'
pointer_button RELEASED
expect "$E2E.fileHelpers('$SPLIT_SET')" 'V 80' 'and the set is saved when the drag ends'

# Unlinking: the copy holds a copy of the content, and the set and the copy stop following each other.
click_actor "$HOST_COPY.badgeActor"
expect "$OVERLAY.badgeMenu?.view === $HOST_COPY && $E2E.labels($OVERLAY.badgeMenu.menu.box).slice(0, 2).join(' / ')" \
    "Copy of $SPLIT_NAME / Follows the main view" 'the badge of a copy opens its own menu'
expect "$E2E.item($OVERLAY.badgeMenu, 'Reset zone').sensitive + ' ' + $E2E.item($OVERLAY.badgeMenu, 'Save as new set…').visible" \
    'false false' 'Reset zone is unavailable on an automatic zone, and Save as new set… on a linked copy'
click_actor "$E2E.item($OVERLAY.badgeMenu, 'Linked')"
expect "$HOST_COPY.linked + ' ' + $E2E.labels($OVERLAY.badgeMenu.menu.box)[1] + ' ' + $E2E.item($OVERLAY.badgeMenu, 'Save as new set…').visible" \
    'false Unlinked true' 'the Linked switch unlinks the copy'
press_keys Escape
SET_REVISION=$(shell_eval "$E2E.file('$SPLIT_SET').revision")
pointer_drag 100 880 120 880
expect "[$HOST_COPY.local.content.helpers[0].x, $M.content.helpers[0].x, $HOST_COPY.local.localChanges].join()" '100,80,1' \
    'an edit of an unlinked copy stays in the copy'
expect "$E2E.fileHelpers('$SPLIT_SET') + ' ' + $E2E.view('Split')._helperViews.get(1).shape.x + ' ' + $E2E.file('$SPLIT_SET').revision" \
    "V 80 80 $SET_REVISION" 'and is never saved'
shell_eval "$M.content.helpers[0].x = 60; $MANAGER.commit($M);" >/dev/null
expect "$HOST_COPY.local.content.helpers[0].x + ' ' + $HOST_COPY._helperViews.get(1).shape.x" '100 100' \
    'a change of the set does not reach an unlinked copy'
click_actor "$HOST_COPY.badgeActor"
expect "$E2E.labels($OVERLAY.badgeMenu.menu.box)[1]" 'Unlinked · 1 local change' 'the badge counts the local changes'

# Relinking with local changes asks first: Keep leaves the copy as it was, Discard drops its changes.
click_actor "$E2E.item($OVERLAY.badgeMenu, 'Linked')"
expect "$HOST_COPY.linked + ' ' + $E2E.labels($OVERLAY.badgeMenu.menu.box).some(text => text.startsWith('Discard 1 local change'))" \
    'false true' 'relinking a copy with local changes asks in place'
click_actor "$E2E.button($OVERLAY.badgeMenu.menu.box, 'Keep')"
expect "$HOST_COPY.linked + ' ' + $HOST_COPY.local.localChanges + ' ' + $OVERLAY.badgeMenu" 'false 1 null' \
    'Keep leaves the copy unlinked, with its changes'
click_actor "$HOST_COPY.badgeActor"
click_actor "$E2E.item($OVERLAY.badgeMenu, 'Linked')"
click_actor "$E2E.button($OVERLAY.badgeMenu.menu.box, 'Discard')"
expect "$HOST_COPY.linked + ' ' + $HOST_COPY._helperViews.get(1).shape.x" 'true 60' \
    'Discard drops the changes, and the copy shows the set again'

# Undo history belongs to the set for linked views, and to the copy once unlinked.
pointer_move 200 880
press_keys Control_L z
expect "$E2E.fileHelpers('$SPLIT_SET') + ' ' + $HOST_COPY._helperViews.get(1).shape.x" 'V 80 80' \
    'Ctrl+Z on a linked copy undoes the set'
press_keys Control_L y
click_actor "$HOST_COPY.badgeActor"
click_actor "$E2E.item($OVERLAY.badgeMenu, 'Linked')"
press_keys Escape
pointer_drag 80 880 90 880
expect "$HOST_COPY.local.localChanges" 1 'a local change counts'
pointer_move 200 880
press_keys Control_L z
expect "$HOST_COPY.local.localChanges + ' ' + $HOST_COPY.local.content.helpers[0].x + ' ' + $E2E.fileHelpers('$SPLIT_SET')" \
    '0 60 V 60' 'Ctrl+Z on an unlinked copy undoes its own change, and the count follows'
click_actor "$HOST_COPY.badgeActor"
click_actor "$E2E.item($OVERLAY.badgeMenu, 'Linked')"
expect "$HOST_COPY.linked + ' ' + $E2E.labels($OVERLAY.badgeMenu.menu.box).some(text => text.startsWith('Discard'))" \
    'true false' 'relinking a copy without local changes is immediate'
press_keys Escape

# Remove copy: a copy with local changes asks first.
click_actor "$HOST_COPY.badgeActor"
click_actor "$E2E.item($OVERLAY.badgeMenu, 'Linked')"
press_keys Escape
pointer_drag 80 880 90 880
click_actor "$HOST_COPY.badgeActor"
click_actor "$OVERLAY.badgeMenu.removeButton"
expect "$E2E.views('Host').length + ' ' + $E2E.labels($OVERLAY.badgeMenu.menu.box).some(text => text.startsWith('Remove this copy? Its 1 local change'))" \
    '1 true' 'Remove copy asks first when the copy has local changes'
click_actor "$E2E.button($OVERLAY.badgeMenu.menu.box, 'Cancel')"
expect "$E2E.views('Host').length" 1 'Cancel keeps the copy'
click_actor "$HOST_COPY.badgeActor"
click_actor "$OVERLAY.badgeMenu.removeButton"
click_actor "$E2E.button($OVERLAY.badgeMenu.menu.box, 'Remove')"
expect "$E2E.views('Host').length + ' ' + $M.copies.length" '0 0' 'the confirmation removes the copy'

# Add a copy… waits for a click on a window without leaving edit mode, and Escape cancels it.
click_actor "$E2E.view('Split').badgeActor"
click_actor "$E2E.item($OVERLAY.badgeMenu, 'Add a copy…')"
expect "$OVERLAY.editing + ' ' + $OVERLAY._loadHint.text" "true Click a window to add a copy of “$SPLIT_NAME” · Esc cancels" \
    'Add a copy… shows a crosshair and a hint in edit mode'
press_keys Escape
expect "$OVERLAY.editing + ' ' + $OVERLAY._copyPick + ' ' + $M.copies.length" 'true null 0' \
    'Escape cancels Add a copy… and edit mode goes on'
click_actor "$E2E.view('Split').badgeActor"
click_actor "$E2E.item($OVERLAY.badgeMenu, 'Add a copy…')"
pointer_click 200 880
expect "$E2E.views('Host').map(view => view.linked).join() + ' ' + $OVERLAY.editing" 'true true' \
    'a click on a window adds a linked copy there'
click_actor "$E2E.view('Split').badgeActor"
click_actor "$E2E.item($OVERLAY.badgeMenu, 'Add a copy…')"
pointer_click 800 20
expect "$M.copies.length + ' ' + $OVERLAY._copyPick" '1 null' 'a click outside any window cancels Add a copy…'

# Two views in one window: a second copy on Split starts on the whole window, and its badge shifts left.
pointer_move 1400 700
press_keys a
expect "$E2E.views('Split').map(view => view.isMain + ' ' + view.fixed).join()" 'true false,false false' \
    'A adds a second view to a window, with an automatic zone'
expect "(([a, b]) => b.x + b.width < a.x && a.y === b.y)($E2E.views('Split').map(view => view.badgeRect))" true \
    'overlapping badges shift left, the newest outermost'
# Framing the copy: its left edge is dragged to the divider and snaps to it, so its zone becomes fixed.
pointer_move 1021 700
pointer_button PRESSED
pointer_move 1100 700
pointer_move 1295 700
pointer_button RELEASED
wait_for "$OVERLAY._drag === null"
expect "(v => [v.fixed, v.geometry.visibleInFrame.x, v.geometry.visibleInFrame.width].join())($SPLIT_COPY)" 'true,280,280' \
    'dragging a zone edge snaps it to the divider and fixes the zone'
expect "$E2E.view('Split').fixed" false 'and the other view keeps its zone'
# The edge press latched the view; a press elsewhere lets the zones target again.
expect "$OVERLAY._latched === $SPLIT_COPY" true 'a press on a zone edge latches its view'
pointer_click 1450 800
pointer_move 1400 700
expect "$OVERLAY._target.view === $SPLIT_COPY" true 'the smallest zone under the pointer is the target'
expect "(v => v._helperViews.get(1).shape.x + ' ' + v.geometry.originX)($SPLIT_COPY)" '60 1300' \
    'the helpers of a view follow the corner of its zone'
pointer_move 1100 700
expect "$OVERLAY._target.view === $E2E.view('Split')" true 'a point outside the smaller zone targets the larger one'
click_actor "$SPLIT_COPY.badgeActor"
click_actor "$E2E.item($OVERLAY.badgeMenu, 'Reset zone')"
expect "$SPLIT_COPY.fixed + ' ' + $SPLIT_COPY.geometry.visibleInFrame.width" 'false 560' 'Reset zone makes the zone automatic again'
pointer_click 1450 800

# Hit testing, Tab, and measuring stay in the visible part of a fixed zone. The zone is the square at
# frame (100, 100), 100 pixels wide, over the left pane; the set has guides at 60, 300, and 0.
shell_eval "const model = $M;
    $MANAGER.addHelper(model, {kind: 'vertical', x: 300});
    $MANAGER.addHelper(model, {kind: 'vertical', x: 0});
    $MANAGER.commit(model);
    $SPLIT_COPY.setZone({x: 100, y: 100, width: 100, height: 100});" >/dev/null
expect "$SPLIT_COPY.zoneHelpers().map(h => h.id).join() + ' ' + $E2E.view('Split').zoneHelpers().map(h => h.id).join()" \
    '1,3 1,2,3' 'a helper outside the visible part of a zone is hidden'
pointer_move 1170 640
press_keys Tab
press_keys Tab
press_keys Tab
expect "$SPLIT_COPY.selectedId" 1 'Tab cycles only the helpers of the zone'
press_keys Tab
expect "$SPLIT_COPY.selectedId" 3 'and visits each of them'
pointer_move 1050 640
press_keys Tab
press_keys Tab
expect "$SPLIT_COPY.selectedId + ' ' + $E2E.view('Split').selectedId" 'null 2' \
    'Tab in the larger zone cycles all of its helpers, and the selection of the other view is cleared'
pointer_move 1170 640
press_keys d
wait_for "$OVERLAY._readout.text === '100 × 100'"
expect "$OVERLAY._readout.text" '100 × 100' 'measuring an area stops at the edges of the zone'
pointer_move 1050 640
wait_for "$OVERLAY._readout.text === '280 × 400'"
expect "$OVERLAY._readout.text" '280 × 400' 'and measures the whole window outside it'
press_keys d

# Latching: a press on a helper, a badge, or a zone edge keeps its view as the target.
pointer_move 1180 640
pointer_button PRESSED
pointer_button RELEASED
expect "$OVERLAY._latched === $SPLIT_COPY && $SPLIT_COPY.selectedId" 1 'a press on a helper latches its view'
pointer_move 1450 800
expect "$OVERLAY._target.view === $SPLIT_COPY && $OVERLAY._readout.visible" false \
    'a latched view stays the target outside its zone, where the readout shows nothing'
shell_eval "global._count = $M.content.helpers.length" >/dev/null
press_keys h
press_keys v
press_keys d
expect "$M.content.helpers.length - global._count + ' ' + $OVERLAY._measuring" '0 false' \
    'H, V, and D do nothing outside the latched zone'
pointer_click 1450 800
expect "$OVERLAY._latched + ' ' + ($OVERLAY._target.view === $E2E.view('Split')) + ' ' + $SPLIT_COPY.selectedId" \
    'null true null' 'a press elsewhere unlatches, and the selection of the view left is cleared'
pointer_move 1450 800
press_keys h
expect "$M.content.helpers.length - global._count" 1 'H works again in the zone of the target'
press_keys Control_L z
click_actor "$SPLIT_COPY.badgeActor"
expect "$OVERLAY._latched === $SPLIT_COPY" true 'a press on a badge latches its view'
press_keys Escape
pointer_move 1120 640
pointer_button PRESSED
pointer_button RELEASED
expect "$SPLIT_COPY.selectedId + ' ' + ($OVERLAY._latched === $SPLIT_COPY) + ' ' + $SPLIT_COPY.fixed + ' ' + $SPLIT_COPY.geometry.visibleInFrame.x" \
    '3 true true 100' 'a short press on an edge acts on the helper under it, and latches its view'
pointer_move 1220 640
pointer_button PRESSED
pointer_move 1230 640
pointer_move 1240 640
expect "$OVERLAY._latched === $SPLIT_COPY && $SPLIT_COPY.geometry.visibleInFrame.width" 120 \
    'dragging an edge resizes the zone, and latches its view'
pointer_button RELEASED
pointer_move 1240 640
pointer_button PRESSED
pointer_move 1200 640
pointer_move 1130 640
pointer_button RELEASED
expect "$SPLIT_COPY.geometry.visibleInFrame.width" 40 'a zone keeps at least 40 pixels'
pointer_move 1140 680
pointer_button PRESSED
pointer_move 1140 800
pointer_move 1140 950
pointer_button RELEASED
expect "$SPLIT_COPY.geometry.visibleInFrame.y + ' ' + $SPLIT_COPY.geometry.visibleInFrame.height" '100 300' \
    'a zone stays within the window frame'
# The edge of a larger zone can be dragged from inside a smaller one.
shell_eval "$E2E.view('Split').setZone({x: 0, y: 0, width: 400, height: 300});" >/dev/null
pointer_move 1140 780
pointer_button PRESSED
pointer_move 1140 800
pointer_move 1140 840
pointer_button RELEASED
expect "$E2E.view('Split').geometry.visibleInFrame.height + ' ' + $SPLIT_COPY.geometry.visibleInFrame.height" '360 300' \
    'a zone edge wins over the zone it crosses, so a larger zone can be resized from inside a smaller one'
# Escape cancels a zone edge drag and restores the zone.
pointer_move 1140 840
pointer_button PRESSED
pointer_move 1140 860
pointer_move 1140 890
press_keys Escape
pointer_button RELEASED
expect "$E2E.view('Split').geometry.visibleInFrame.height + ' ' + $OVERLAY._drag" '360 null' \
    'Escape cancels a zone edge drag'
# A fixed zone keeps its place when the window is resized; what lies outside the frame is not shown.
shell_eval "for (const view of $E2E.views('Host'))
        $MANAGER.removeCopy(view);
    const model = $MANAGER.createSet($E2E.win('Host')).model;
    $MANAGER.addHelper(model, {kind: 'vertical', x: 10});
    $MANAGER.commit(model);
    global._zoned = model.id;
    $MANAGER.addCopy(model, $E2E.win('Host')).setZone({x: 300, y: 0, width: 100, height: 100});" >/dev/null
ZONED="$E2E.set(global._zoned).copies[0]"
expect "$ZONED.geometry.visibleInFrame.x + ' ' + $ZONED.geometry.visibleInFrame.width" '300 100' 'a fixed zone shows inside the frame'
shell_eval "$E2E.win('Host').move_resize_frame(true, 20, 780, 250, 200)" >/dev/null
wait_for "$ZONED.geometry.frame.width === 250"
expect "$ZONED.geometry.visibleInFrame + ' ' + $ZONED.fixed + ' ' + $ZONED.hasBadge + ' ' + $ZONED.layer.get_parent()" \
    'null true true null' 'a fixed zone outside the frame shows nothing, and its badge stays reachable'
pointer_move 100 880
click_actor "$ZONED.badgeActor"
click_actor "$E2E.item($OVERLAY.badgeMenu, 'Reset zone')"
expect "$ZONED.fixed + ' ' + $ZONED.geometry.visibleInFrame.width" 'false 250' 'Reset zone brings the view back'
shell_eval "$E2E.win('Host').move_resize_frame(true, 20, 780, 400, 200)" >/dev/null
wait_for "$ZONED.geometry.frame.width === 400"
shell_eval "$MANAGER.removeFromScreen($E2E.set(global._zoned))" >/dev/null
press_keys Escape

# Badges that would cross the frame's left edge wrap to a row above, and never overlap.
open_window PromoA 440 780 280x200 '#241f31'
open_window PromoB 740 780 200x200 '#241f31'
shell_eval "const model = $MANAGER.createSet($E2E.win('PromoB')).model;
    $MANAGER.addHelper(model, {kind: 'vertical', x: 20});
    $MANAGER.commit(model);
    for (let i = 0; i < 3; i++)
        $MANAGER.addCopy(model, $E2E.win('PromoB'));
    global._wrap = model.id;" >/dev/null
expect "(rs => rs.every(r => r.x >= 0) && rs.every((a, i) => rs.every((b, j) => i === j || a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y)) && new Set(rs.map(r => r.y)).size)($E2E.views('PromoB').map(view => view.badgeRect))" \
    2 'badges that would cross the left edge of the frame start a new row above, without overlapping'
expect "$E2E.bounds($E2E.views('PromoB')[0]._badgeBox) + ' ' + $E2E.views('PromoB')[0]._badgeBox.clip_to_allocation" \
    '740,780,200,200 true' 'badges are clipped to the window frame'
shell_eval "const view = $E2E.views('PromoB')[0]; view.setCaptureHidden(true); view.sync();" >/dev/null
expect "$E2E.views('PromoB')[0]._badgeBox.visible" false 'a view hidden for a capture stays hidden when it is laid out again'
shell_eval "$E2E.views('PromoB')[0].setCaptureHidden(false)" >/dev/null
shell_eval "$MANAGER.delete(global._wrap)" >/dev/null
wait_for "$E2E.views('PromoB').length === 0"

# When the main view's window closes without a linked copy, the set leaves the screen with its
# unlinked copies.
shell_eval "const model = $MANAGER.createSet($E2E.win('PromoA')).model;
    $MANAGER.addHelper(model, {kind: 'vertical', x: 40});
    $MANAGER.commit(model);
    global._gone = model.id;
    $MANAGER.unlink($MANAGER.addCopy(model, $E2E.win('PromoB')));" >/dev/null
GONE=$(shell_eval "global._gone")
shell_eval "$E2E.win('PromoA').delete(global.get_current_time())" >/dev/null
wait_for "!$E2E.win('PromoA')"
expect "!!$MANAGER.modelOf('$GONE') + ' ' + $E2E.views('PromoB').length" 'false 0' \
    'closing the main view window without a linked copy removes the set and its unlinked copies'
check 'the set stays in the library' "[[ -f $XDG_DATA_HOME/measure-things/sets/$GONE.json ]]"

# Otherwise the oldest linked copy becomes the main view.
open_window PromoC 440 780 280x200 '#241f31'
shell_eval "const model = $MANAGER.createSet($E2E.win('PromoC')).model;
    $MANAGER.addHelper(model, {kind: 'vertical', x: 40});
    $MANAGER.commit(model);
    global._promo = model.id;
    $MANAGER.addCopy(model, $E2E.win('PromoB'));
    $MANAGER.addCopy(model, $E2E.win('Host'));
    const unlinked = $MANAGER.addCopy(model, $E2E.win('Host'));
    $MANAGER.unlink(unlinked);
    unlinked.local.content.helpers[0].x = 5;
    $MANAGER.commit(unlinked.local);" >/dev/null
PROMO=$(shell_eval "global._promo")
PROMO_SET="$E2E.set('$PROMO')"
# A badge menu open on the copy that takes over closes, since it no longer describes a copy.
press_keys Super_L Shift_L m
shell_eval "$OVERLAY.openBadgeMenu($PROMO_SET.copies[0]); null" >/dev/null
expect "$OVERLAY.badgeMenu?.view === $PROMO_SET.copies[0]" true 'a badge menu is open on the oldest linked copy'
shell_eval "$E2E.win('PromoC').delete(global.get_current_time())" >/dev/null
wait_for "!$E2E.win('PromoC')"
expect "$OVERLAY.badgeMenu" null 'the badge menu of a copy that becomes the main view closes'
expect "$PROMO_SET.view.window.title + ' ' + $PROMO_SET.view.isMain + ' ' + $PROMO_SET.copies.map(c => c.window.title + ' ' + c.linked).join()" \
    'PromoB true Host true,Host false' 'when the main view window closes, the oldest linked copy becomes the main view'
expect "$PROMO_SET.view._badgeLabel.text + ' ' + $PROMO_SET.view._badgeLink.visible" "$(shell_eval "$PROMO_SET.name") false" \
    'and shows the set badge'
shell_eval "$E2E.win('PromoB').delete(global.get_current_time())" >/dev/null
wait_for "!$E2E.win('PromoB')"
expect "$PROMO_SET.view.window.title + ' ' + $PROMO_SET.copies.map(c => c.linked).join()" 'Host false' \
    'the next linked copy takes over in turn'
press_keys Escape

# Loading a set that is already on screen adds a linked copy, and the panel menu counts the copies.
PROMO_NAME=$(shell_eval "$PROMO_SET.name")
open_menu
expect "$E2E.labels($E2E.row('onScreen', '$PROMO_NAME'))[1]" 'main + 1 copy · Host' \
    'the On screen row counts the copies and names the main view window'
click_actor "$E2E.row('library', '$PROMO_NAME')"
expect "$OVERLAY._mode + ' ' + $OVERLAY._loadHint.text" "load Click a window to show “$PROMO_NAME” · Esc cancels" \
    'a library set that is on screen can be loaded again'
pointer_click 1450 800
expect "$E2E.views('Split').filter(view => view.set.id === '$PROMO').map(view => view.isMain + ' ' + view.linked).join()" \
    'false true' 'loading a set already on screen shows it as a linked copy'
open_menu
expect "$E2E.labels($E2E.row('onScreen', '$PROMO_NAME'))[1]" 'main + 2 copies · Host' 'the count follows'

# ✕ asks first when unlinked copies hold local changes, and says what will be lost.
click_actor "$E2E.button($E2E.row('onScreen', '$PROMO_NAME'), 'Remove from screen')"
expect "$EXTENSION._onScreen.section._getMenuItems().some(item => item.removeConfirmation) + ' ' + !!$MANAGER.modelOf('$PROMO')" \
    'true true' '✕ asks for a confirmation in the menu when an unlinked copy has local changes'
expect "$E2E.labels($EXTENSION._onScreen.section._getMenuItems().find(item => item.removeConfirmation))[0]" \
    "Remove “$PROMO_NAME” from the screen? 1 local change in its unlinked copies will be lost." \
    'and says what will be lost'
click_actor "$E2E.button($EXTENSION._onScreen.section._getMenuItems().find(item => item.removeConfirmation), 'Cancel')"
expect "$EXTENSION._onScreen.section._getMenuItems().some(item => item.removeConfirmation) + ' ' + !!$MANAGER.modelOf('$PROMO')" \
    'false true' 'Cancel keeps the set'
click_actor "$E2E.button($E2E.row('onScreen', '$PROMO_NAME'), 'Remove from screen')"
click_actor "$E2E.button($EXTENSION._onScreen.section._getMenuItems().find(item => item.removeConfirmation), 'Remove')"
expect "!!$MANAGER.modelOf('$PROMO') + ' ' + $E2E.views('Host').length + ' ' + $E2E.views('Split').length" 'false 0 2' \
    'Remove takes the main view and every copy off the screen'
# Without local changes the set itself is saved, and ✕ removes it at once.
shell_eval "const model = $MANAGER.createSet($E2E.win('Host')).model;
    $MANAGER.addHelper(model, {kind: 'vertical', x: 30});
    $MANAGER.commit(model);
    global._quick = model.name;
    $MANAGER.addCopy(model, $E2E.win('Split'));
    null;" >/dev/null
QUICK=$(shell_eval "global._quick")
click_actor "$E2E.button($E2E.row('onScreen', '$QUICK'), 'Remove from screen')"
expect "$E2E.views('Host').length + ' ' + $E2E.views('Split').length" '0 2' \
    '✕ removes a set at once when no unlinked copy has local changes'

# The delete dialog says how many views leave the screen.
shell_eval "const model = $MANAGER.createSet($E2E.win('Host')).model;
    $MANAGER.addHelper(model, {kind: 'vertical', x: 30});
    $MANAGER.commit(model);
    global._doomed = model.name;
    global._doomedId = model.id;
    $MANAGER.addCopy(model, $E2E.win('Split'));
    $MANAGER.addCopy(model, $E2E.win('Split'));
    null;" >/dev/null
DOOMED=$(shell_eval "global._doomed")
DOOMED_ID=$(shell_eval "global._doomedId")
open_menu
click_actor "$E2E.button($E2E.row('library', '$DOOMED'), 'Delete')"
wait_for "!!$E2E.dialog()?.visible"
expect "$E2E.labels($E2E.dialog()).some(text => text.includes('3 views will leave the screen'))" true \
    'the delete dialog says how many views will leave the screen'
click_actor "$E2E.button($E2E.dialog(), 'Delete')"
expect "!!$MANAGER.modelOf('$DOOMED_ID') + ' ' + $E2E.views('Host').length + ' ' + $E2E.views('Split').length" 'false 0 2' \
    'deleting the set removes the main view and its copies'

# Save as new set… on an unlinked copy: the copy becomes the main view of the new set, with its content,
# and the set it came from does not change.
shell_eval "const model = $MANAGER.createSet($E2E.win('Host')).model;
    $MANAGER.addHelper(model, {kind: 'vertical', x: 30});
    $MANAGER.commit(model);
    global._origin = model.id;
    const copy = $MANAGER.addCopy(model, $E2E.win('Split'));
    $MANAGER.unlink(copy);
    copy.local.content.helpers[0].x = 5;
    $MANAGER.commit(copy.local);" >/dev/null
ORIGIN=$(shell_eval "global._origin")
press_keys Super_L Shift_L m
pointer_move 1450 700
click_actor "$E2E.set('$ORIGIN').copies[0].badgeActor"
click_actor "$E2E.item($OVERLAY.badgeMenu, 'Save as new set…')"
wait_for "!!$E2E.dialog()?.visible"
type_keys F o r k Return
FORK=$(shell_eval "$E2E.entry('Fork')?.id")
expect "(view => [view.isMain, view.linked, view.set.name, view.set.id === '$FORK', view.set.content.helpers[0].x].join())($E2E.views('Split').find(view => view.set.id === '$FORK'))" \
    'true,true,Fork,true,5' 'Save as new set… makes the copy the main view of a new set with its content'
expect "$E2E.fileHelpers('$FORK') + ' ' + $E2E.fileHelpers('$ORIGIN') + ' ' + $E2E.set('$ORIGIN').copies.length" 'V 5 V 30 0' \
    'the new set is saved, and the set it came from is unchanged'
press_keys Escape
# On the main view, its linked and unlinked copies follow the new set.
ORIGIN_NAME=$(shell_eval "$E2E.file('$ORIGIN').name")
shell_eval "const model = $E2E.set('$ORIGIN');
    $MANAGER.addCopy(model, $E2E.win('Split'));
    $MANAGER.unlink($MANAGER.addCopy(model, $E2E.win('Split')));
    global._forked = model;
    $MANAGER.saveAsNew(model, 'Main fork');" >/dev/null
expect "(m => m.name + ' ' + (m.id !== '$ORIGIN') + ' ' + [m.view, ...m.copies].map(v => v.linked + '/' + (v.set === m)).join())(global._forked) + ' ' + $E2E.file('$ORIGIN').name" \
    "Main fork true true/true,true/true,false/true $ORIGIN_NAME" \
    'Save as new set… on a main view moves its linked and unlinked copies to the new set'

# Loading a set does not change the set A copies once a set was edited.
shell_eval "global._lastEdited = $MANAGER.lastEdited; $MANAGER.load('$ORIGIN', $E2E.win('Host')); null" >/dev/null
expect "$MANAGER.lastEdited === global._lastEdited && !!global._lastEdited" true \
    'loading a set does not take the place of the set edited last'
# Save as new set… is not an edit: before any edit, the set loaded last is the one A copies.
shell_eval "const manager = $MANAGER;
    manager._anyEdit = false;
    manager.lastEdited = manager.modelOf('$ORIGIN');
    manager.saveAsNew(manager.lastEdited, 'Third fork');
    global._third = manager.lastEdited;
    manager.load('$FORK', $E2E.win('Host'));
    global._loaded = manager.lastEdited?.id;
    null;" >/dev/null
expect "global._loaded" "$FORK" 'Save as new set… is not an edit: the set loaded after it is the one A copies'
shell_eval "const manager = $MANAGER;
    manager._anyEdit = false;
    manager.lastEdited = manager.modelOf('$FORK');
    manager.saveAsNew(global._third, 'Fourth fork');
    global._created = manager.lastEdited === global._third;
    manager.lastEdited = global._third;
    manager._anyEdit = false;
    manager.removeFromScreen(global._third);
    manager.load('$FORK', $E2E.win('Host'));
    global._blocked = manager.lastEdited;
    manager._anyEdit = true;
    manager.lastEdited = manager.modelOf('$FORK');
    null;" >/dev/null
expect "global._created + ' ' + global._blocked" 'true null' \
    'a set saved under a new name counts as created, and A stays off once its set left the screen until a set is edited'
# After A, the keys act on the new view without the pointer moving.
open_window Fresh 440 780 280x200 '#241f31'
press_keys Super_L Shift_L m
pointer_move 580 880
shell_eval "global._copied = $MANAGER.lastEdited; global._helpers = global._copied.content.helpers.length; global._models = $MANAGER.models.length" >/dev/null
press_keys a
press_keys h
expect "$MANAGER.models.length - global._models + ' ' + (global._copied.content.helpers.length - global._helpers)" '0 1' \
    'after A, the keys act on the new view without the pointer moving, not on a new set'
press_keys Escape

# Tidy: every set made here leaves the screen and the library, and its windows close.
shell_eval "for (const model of [...$MANAGER.models]) {
        if (!['Page', 'Other'].includes(model.view.window.title))
            $MANAGER.removeFromScreen(model);
    }
    for (const id of $MANAGER.store.entries().map(entry => entry.id)) {
        if (!global._libraryBefore.includes(id))
            $MANAGER.delete(id);
    }
    null;" >/dev/null
wait_for "$MANAGER.store.entries().length === global._libraryBefore.length"
shell_eval "for (const title of ['Split', 'Host', 'Fresh']) $E2E.win(title).delete(global.get_current_time());" >/dev/null
wait_for "!$E2E.win('Split') && !$E2E.win('Host') && !$E2E.win('Fresh')"

# The grid shortcut acts on the focused window.
shell_eval "$E2E.win('Other').activate(global.get_current_time())" >/dev/null
wait_for "$E2E.win('Other').has_focus()"
press_keys Super_L Shift_L g
expect "$E2E.model('Other').content.grid.visible + ' ' + $E2E.view('Other')._grid.get_n_children()" 'false 0' \
    'the grid shortcut hides the grid of the focused window'
press_keys Super_L Shift_L g
expect "$E2E.model('Other').content.grid.visible + ' ' + $E2E.view('Other')._grid.get_n_children()" 'true 6' \
    'the grid shortcut shows it again'
press_keys Super_L Shift_L m
pointer_move 1150 420
pointer_button PRESSED
pointer_move 1200 440
press_keys Super_L Shift_L g
press_keys Escape
pointer_button RELEASED
expect "$E2E.model('Other').content.grid.visible + ' ' + $E2E.helpers('Other') + ' ' + $E2E.file('$PAGE').grid.visible" \
    'true R 120,110 201x170 | V 510 true' 'the grid shortcut does nothing during a drag'
press_keys Escape

# A write still in flight when the extension is disabled lands before the next run reads the files:
# the next run holds the committed revision, not the one before it.
shell_eval "const proto = Object.getPrototypeOf($MANAGER.store), replace = proto._replace;
    global._restoreReplace = () => { proto._replace = replace; };
    proto._replace = async function (name, bytes) {
        await new Promise(resolve => imports.gi.GLib.timeout_add(imports.gi.GLib.PRIORITY_DEFAULT, 1000,
            () => { resolve(); return false; }));
        return replace.call(this, name, bytes);
    };
    const model = $E2E.model('Other');
    model.content.grid.visible = !model.content.grid.visible;
    $MANAGER.commit(model);
    global._inFlight = [model.id, model.revision];" >/dev/null
IN_FLIGHT=$(shell_eval "global._inFlight[0]")
IN_FLIGHT_REVISION=$(shell_eval "global._inFlight[1]")
shell_eval "Main.extensionManager.disableExtension('$UUID')" >/dev/null
wait_for "Main.extensionManager.lookup('$UUID').state !== 1"
expect "global.get_window_actors().some(a => a.get_children().some(c => c.name === 'measure-things-view'))" false \
    'disabling removes every view'
expect "!!Main.panel.statusArea['$UUID'] || Main.layoutManager.uiGroup.get_children().some(a => a.name?.startsWith('measure-things'))" \
    false 'disabling removes the indicator and the layer'
shell_eval "Main.extensionManager.enableExtension('$UUID')" >/dev/null
wait_for "Main.extensionManager.lookup('$UUID').state === 1"
wait_for "$MANAGER.store.entries().length === 3"
shell_eval "global._restoreReplace()" >/dev/null
expect "$MANAGER.store.get('$IN_FLIGHT').revision" "$IN_FLIGHT_REVISION" \
    'a write in flight when the extension is disabled lands before the next run reads its file'
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

# A missing sets folder is created again by the next write, and loading a set is a write.
SETS=$XDG_DATA_HOME/measure-things/sets
mv "$SETS" "$SETS.off"
shell_eval "void $MANAGER.load('$PAGE', $E2E.win('Other'))" >/dev/null
wait_for "$MANAGER.models.length === 1"
sleep 0.5
check 'a missing sets folder is created again on write' "[[ -f $SETS/$PAGE.json ]]"
rm -r "$SETS"
mv "$SETS.off" "$SETS"
shell_eval "$MANAGER.removeFromScreen($MANAGER.modelOf('$PAGE'))" >/dev/null

# The preferences list the edit mode keys the overlay handles, `A` and the zone edges among them.
check 'the preferences list A and the zone edges among the edit mode keys' \
    "grep -q \"title: 'Add a linked copy of the set edited last'.*keys: 'a'\" '$ROOT/src/prefs.js' && grep -q \"title: 'Resize a zone'\" '$ROOT/src/prefs.js'"

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

# The warnings the checks above provoke on purpose: a mockup image that went away, and a trash that
# does not exist.
if grep -vE 'Measure Things: could not (load the mockup|move .* to the trash)' "$WORK/shell.log" |
    grep -E -A4 'JS (ERROR|WARNING)|Exception in callback|Measure Things:'; then
    echo 'FAIL the shell logged JavaScript errors'
    FAILURES=$((FAILURES + 1))
fi
if ((FAILURES > 0)); then
    echo "$FAILURES check(s) failed."
    exit 1
fi
echo 'All end-to-end checks passed.'
