#!/usr/bin/env bash
# Measures Find helpers on a 3840 × 2160 zone, as the SET spec's Speed rule asks: a headless shell with
# a 3840 × 2160 virtual monitor at scale 1 shows the busiest test image in a full-screen client window,
# and Eval runs Find helpers at each level with a 10 ms GLib timeout in the shell as the probe. It
# prints, per run, the time from the capture to the commit and the largest gap between two probe
# ticks. The numbers depend on the machine and are not a CI gate.
set -euo pipefail

# shellcheck source=scripts/headless.sh
source "$(dirname "$0")/headless.sh"
HEADLESS_MONITOR=3840x2160
headless_start "$0" "$@"

if ! command -v node >/dev/null; then
    echo "Missing node." >&2
    exit 1
fi
node "$ROOT/tests/fixtures/images.js" "$WORK/images" 3 dense
TEST_WINDOW_IMAGE=$WORK/images/dense.rgba TEST_WINDOW_IMAGE_SIZE=3840x2160 \
    gjs -m "$ROOT/scripts/test-window.js" Busy 3840x2160 '#ffffff' >>"$WORK/client.log" 2>&1 &
WINDOW="global.display.list_all_windows().find(w => w.title === 'Busy')"
wait_for "(r => r.width === 3840 && r.height === 2160)($WINDOW?.get_frame_rect() ?? {})" 60
sleep 3

shell_eval "const model = $EXTENSION._manager.createSet($WINDOW).model;
    $EXTENSION._manager.addHelper(model, {kind: 'vertical', x: 100});
    $EXTENSION._manager.commit(model);
    global._probe = async level => {
        const {GLib} = imports.gi;
        const view = model.view;
        let last = GLib.get_monotonic_time();
        let gap = 0;
        const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
            const now = GLib.get_monotonic_time();
            gap = Math.max(gap, now - last);
            last = now;
            return GLib.SOURCE_CONTINUE;
        });
        const start = GLib.get_monotonic_time();
        const status = await $OVERLAY._finder.run(view, level);
        const total = GLib.get_monotonic_time() - start;
        GLib.source_remove(source);
        return JSON.stringify({level, status, rectangles: model.content.helpers.filter(h => h.kind === 'rectangle').length,
            guides: model.content.helpers.filter(h => h.kind !== 'rectangle').length,
            totalMs: Math.round(total / 1000), maxGapMs: Math.round(gap / 1000)});
    };
    1" >/dev/null
sleep 1
echo 'Find helpers on a 3840 × 2160 zone at scale 1 (the first run of a shell is cold):'
for run in 1 2 3; do
    for level in low medium high; do
        echo "run $run: $(shell_eval "global._probe('$level')")"
    done
done
if grep -E 'JS (ERROR|WARNING)|Measure Things:' "$WORK/shell.log"; then
    echo 'The shell logged JavaScript errors.' >&2
    exit 1
fi
