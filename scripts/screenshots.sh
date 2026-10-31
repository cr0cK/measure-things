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
shell_eval "$PREFS.move_resize_frame(true, 280, 10, 720, 780)" >/dev/null
wait_for "$PREFS.has_focus() && $PREFS.get_frame_rect().x === 280"
sleep 1.5
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.ScreenshotWindow true false false \
    "$OUT/preferences.png" >/dev/null

# Measure the preferences window: its Display group, with guides on the card edges.
shell_eval "$OVERLAY.enterEdit()" >/dev/null
wait_for "!!$OVERLAY._snapshot"
pointer_drag 362 120 917 339
pointer_move 362 600
press_keys v
pointer_move 917 600
press_keys v
pointer_move 600 120
press_keys h
pointer_move 600 339
press_keys h
# Back to the rectangle, to show its handles and position.
press_keys Tab
pointer_move 1120 640
sleep 0.5
screenshot "$OUT/edit.png"
press_keys Escape


shell_eval "$EXTENSION._indicator.menu.open()" >/dev/null
sleep 0.8
screenshot "$WORK/menu.png"
shell_eval "$EXTENSION._indicator.menu.close()" >/dev/null
magick "$WORK/menu.png" -crop 400x460+880+0 +repage "$OUT/menu.png"

# _pickColor() resolves only when the picker closes, so do not wait for it.
shell_eval "$EXTENSION._pickColor(); null" >/dev/null
pointer_move 872 201
wait_for "!!$EXTENSION._picker?._label.text"
sleep 0.5
screenshot "$WORK/picker.png"
press_keys Escape
magick "$WORK/picker.png" -crop 400x300+700+90 +repage "$OUT/picker.png"

# Measure the area under the pointer, without the helpers: the size of a preferences row.
shell_eval "$OVERLAY.clear()" >/dev/null
shell_eval "$OVERLAY.enterEdit()" >/dev/null
wait_for "!!$OVERLAY._snapshot"
pointer_move 700 250
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
