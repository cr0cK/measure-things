#!/usr/bin/env bash
# Regenerates the README screenshots in docs/screenshots/ from a headless GNOME Shell running the
# checkout, with the preferences window as the UI being measured. Needs ImageMagick.
set -euo pipefail

# shellcheck source=scripts/headless.sh
source "$(dirname "$0")/headless.sh"
OUT=$ROOT/docs/screenshots
HEADLESS_MONITOR=1280x800
headless_seed() {
    gsettings set org.gnome.desktop.interface color-scheme "'prefer-dark'"
    # A plain background keeps the images small and the eye on what is measured.
    gsettings set org.gnome.desktop.background picture-options "'none'"
    gsettings set org.gnome.desktop.background primary-color "'#3d3846'"
    # Two saved sets, so the menu shows a library.
    python3 - "$XDG_DATA_HOME/measure-things/sets" <<'PY'
import json, os, sys, time
folder = sys.argv[1]
os.makedirs(folder, exist_ok=True)
for number, (name, days) in enumerate([('Pricing page', 1.5), ('Checkout', 4.2)], 1):
    set_id = f'00000000-0000-4000-8000-00000000000{number}'
    edited = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - days * 86400))
    with open(os.path.join(folder, f'{set_id}.json'), 'w') as file:
        json.dump({
            'schema': 1, 'id': set_id, 'name': name, 'revision': 1, 'edited': edited,
            'color': '#2ec2d6', 'zoom': 100, 'helpersVisible': True, 'tolerance': 'medium',
            'grid': {'visible': False, 'columns': 12, 'gutter': 24, 'margin': 24, 'maxWidth': 0},
            'mockup': {'file': '', 'visible': False, 'x': 0, 'y': 0, 'opacity': 50, 'density': 1},
            'helpers': [{'kind': 'vertical', 'x': 120}],
        }, file)
PY
}
if ! command -v magick >/dev/null; then
    echo "Missing magick (ImageMagick)." >&2
    exit 1
fi
headless_start "$0" "$@"
mkdir -p "$OUT"

gnome-extensions prefs "$UUID"
# The preferences service can wait on portal timeouts before it shows its window.
PREFS="global.display.list_all_windows().find(w => w.get_wm_class() === 'org.gnome.Shell.Extensions')"
wait_for "!!$PREFS" 120
shell_eval "$PREFS.activate(global.get_current_time())" >/dev/null
# The window can still be placed after it shows: move it until it stays.
wait_for "$PREFS.get_compositor_private()?.visible && $PREFS.has_focus()"
for _ in $(seq 10); do
    shell_eval "$PREFS.move_resize_frame(true, 280, 30, 720, 680)" >/dev/null
    sleep 0.5
    [[ $(shell_eval "$PREFS.get_frame_rect().x === 280 && $PREFS.get_frame_rect().width === 720") == true ]] && break
done
sleep 1.5
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.ScreenshotWindow true false false \
    "$OUT/preferences.png" >/dev/null

# Measure the preferences window: its Display group, with guides on the card edges. The window
# ends above the hint bar, so its badge shows.
shell_eval "$OVERLAY.enterEdit()" >/dev/null
wait_for "!!$OVERLAY._snapshot"
# Without snapping, which the card's rounded corners would pull inward.
key_state Control_L PRESSED
pointer_drag 362 140 917 249
key_state Control_L RELEASED
pointer_move 362 600
press_keys v
pointer_move 917 600
press_keys v
pointer_move 600 140
press_keys h
pointer_move 600 249
press_keys h
# Back to the rectangle, to show its handles and position, with the pointer still on the window:
# leaving it clears the selection.
press_keys Tab
pointer_move 960 600
sleep 0.5
screenshot "$OUT/edit.png"
press_keys Escape


shell_eval "$EXTENSION._indicator.menu.open()" >/dev/null
sleep 0.8
screenshot "$WORK/menu.png"
shell_eval "$EXTENSION._indicator.menu.close()" >/dev/null
magick "$WORK/menu.png" -crop 400x560+880+0 +repage "$OUT/menu.png"

# _pickColor() resolves only when the picker closes, so do not wait for it.
shell_eval "$EXTENSION._pickColor(); null" >/dev/null
pointer_move 875 340
wait_for "!!$EXTENSION._picker?._label.text"
sleep 0.5
screenshot "$WORK/picker.png"
press_keys Escape
magick "$WORK/picker.png" -crop 400x300+680+220 +repage "$OUT/picker.png"

# Measure the area under the pointer, without the helpers: the size of a preferences row.
shell_eval "const manager = $EXTENSION._manager;
    manager.models.slice().forEach(model => manager.removeFromScreen(model))" >/dev/null
shell_eval "$OVERLAY.enterEdit()" >/dev/null
wait_for "!!$OVERLAY._snapshot"
pointer_move 700 340
press_keys d
wait_for "$OVERLAY._areaGroup.visible"
sleep 0.5
screenshot "$WORK/measure.png"
press_keys d
press_keys Escape
magick "$WORK/measure.png" -crop 760x300+260+120 +repage "$OUT/measure.png"

if grep -E 'JS (ERROR|WARNING)|Measure Things:' "$WORK/shell.log"; then
    echo "The shell logged JavaScript errors; check the screenshots." >&2
fi
# Drop metadata such as creation time so unchanged screenshots stay byte-identical.
for image in "$OUT"/*.png; do
    magick "$image" -strip "$image"
done
echo "Screenshots written to $OUT"
