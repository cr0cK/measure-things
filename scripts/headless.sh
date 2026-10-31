# Sourced by scripts/e2e.sh and scripts/screenshots.sh. Runs the packed checkout in a headless
# GNOME Shell on a private D-Bus session, away from the desktop's extensions and settings, and
# provides helpers to evaluate JavaScript in the shell and to send pointer and keyboard input.
# shellcheck shell=bash

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UUID=measure-things@cr0ck.github.io
EXTENSION="Main.extensionManager.lookup('$UUID').stateObj"
OVERLAY="$EXTENSION._overlay"

# First call: packs the checkout, prepares a scratch XDG tree, and runs the calling script again
# inside a private D-Bus session. Second call: starts the shell and waits for the extension.
# Define headless_seed before calling to write GSettings before the shell starts.
headless_start() {
    local script=$1
    shift
    if [[ ${HEADLESS_INSIDE:-} != 1 ]]; then
        for command in gnome-shell dbus-run-session gdbus gsettings glib-compile-schemas unzip python3; do
            if ! command -v "$command" >/dev/null; then
                echo "Missing $command." >&2
                exit 1
            fi
        done
        make -C "$ROOT" pack >/dev/null

        # Exported before the bus starts, so the services it activates, such as the preferences
        # window, also stay away from the desktop settings.
        WORK=$(mktemp -d)
        export WORK HEADLESS_INSIDE=1 XDG_DATA_HOME=$WORK/data XDG_CONFIG_HOME=$WORK/config
        export GSETTINGS_BACKEND=keyfile GTK_A11Y=none
        export GSETTINGS_SCHEMA_DIR=$XDG_DATA_HOME/gnome-shell/extensions/$UUID/schemas
        # The Wayland socket path must fit in 108 bytes, so the display name stays short.
        export WAYLAND_DISPLAY=mt-$$
        export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
        # Session services log to the bus's stderr; keep that noise in the work directory and
        # hand the script its own stderr back on file descriptor 3.
        exec 3>&2
        exec dbus-run-session -- "$script" "$@" 2>"$WORK/session.log"
    fi
    exec 2>&3 3>&-

    trap headless_cleanup EXIT
    local extensions=$XDG_DATA_HOME/gnome-shell/extensions
    mkdir -p "$extensions/$UUID" "$extensions/unsafe@headless"
    unzip -q "$ROOT/dist/$UUID.shell-extension.zip" -d "$extensions/$UUID"
    glib-compile-schemas "$GSETTINGS_SCHEMA_DIR"
    # Eval and Screenshot refuse callers outside unsafe mode; this throwaway extension enables it.
    cat > "$extensions/unsafe@headless/metadata.json" <<'JSON'
{"uuid": "unsafe@headless", "name": "Unsafe mode", "description": "Tests only",
 "shell-version": ["49"]}
JSON
    cat > "$extensions/unsafe@headless/extension.js" <<'JS'
export default class {
    enable() { global.context.unsafe_mode = true; }
    disable() {}
}
JS
    gsettings set org.gnome.shell enabled-extensions "['$UUID', 'unsafe@headless']"
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "'999'"
    if declare -F headless_seed >/dev/null; then
        headless_seed
    fi

    gnome-shell --headless --wayland --no-x11 --wayland-display="$WAYLAND_DISPLAY" \
        --virtual-monitor "${HEADLESS_MONITOR:-1600x1000}" >"$WORK/shell.log" 2>&1 &
    SHELL_PID=$!
    wait_for "Main.extensionManager.lookup('$UUID')?.state === 1" 60
    wait_for "Main.layoutManager._startingUp === false"
    shell_eval "Main.overview.hide()" >/dev/null
    wait_for "!Main.overview.visible && !Main.overview.animationInProgress"
    shell_eval "const seat = global.stage.context.get_backend().get_default_seat();
        const {InputDeviceType} = imports.gi.Clutter;
        global._headlessPointer = seat.create_virtual_device(InputDeviceType.POINTER_DEVICE);
        global._headlessKeyboard = seat.create_virtual_device(InputDeviceType.KEYBOARD_DEVICE);" >/dev/null
    # A new virtual pointer drops the x axis of its first motions; move until it follows.
    for position in 10 20 30 40 50; do
        pointer_move "$position" "$position"
        [[ $(shell_eval "global.get_pointer().slice(0, 2).join()") == "$position,$position" ]] && return 0
    done
    echo 'The virtual pointer does not follow absolute motion.' >&2
    exit 1
}

headless_cleanup() {
    if [[ -n ${SHELL_PID:-} ]]; then
        kill "$SHELL_PID" 2>/dev/null && wait "$SHELL_PID" 2>/dev/null
    fi
    rm -f "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY.lock"
    rm -rf "$WORK"
}

# Runs JavaScript in the shell and prints its result; Eval returns JSON, so strings arrive quoted.
shell_eval() {
    local reply
    reply=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>&1) || {
        echo "Eval failed: $reply" >&2
        return 1
    }
    if [[ $reply != "(true, "* ]]; then
        echo "Eval error: $reply" >&2
        return 1
    fi
    # The reply is a GVariant tuple holding JSON: print strings bare and other values as JSON.
    python3 -c '
import ast, json, sys
text = ast.literal_eval(sys.argv[1].replace("(true,", "(True,", 1))[1]
value = json.loads(text) if text else ""
print(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":")))
' "$reply"
}

# Polls a JavaScript condition until it reads true, for up to $2 seconds (20 by default).
wait_for() {
    for _ in $(seq $((${2:-20} * 5))); do
        [[ $(shell_eval "$1" 2>/dev/null || true) == true ]] && return 0
        sleep 0.2
    done
    echo "Timed out waiting for: $1" >&2
    tail -20 "$WORK/shell.log" >&2
    exit 1
}

# Virtual input. Each event gets its own Eval and a short pause, so the shell handles it before
# the next one: a click sent right after a motion would otherwise land on the old position.
input_eval() {
    shell_eval "const {Clutter, GLib} = imports.gi; const now = GLib.get_monotonic_time(); $1" >/dev/null
    sleep 0.1
}

pointer_move() {
    input_eval "global._headlessPointer.notify_absolute_motion(now, $1, $2)"
}

# Presses or releases a button: pointer_button PRESSED, or pointer_button RELEASED SECONDARY.
pointer_button() {
    input_eval "global._headlessPointer.notify_button(now, Clutter.BUTTON_${2:-PRIMARY}, Clutter.ButtonState.$1)"
}

# Drags from ($1, $2) to ($3, $4) through a midpoint, with the primary button or button $5.
pointer_drag() {
    pointer_move "$1" "$2"
    pointer_button PRESSED "${5:-PRIMARY}"
    pointer_move $((($1 + $3) / 2)) $((($2 + $4) / 2))
    pointer_move "$3" "$4"
    pointer_button RELEASED "${5:-PRIMARY}"
}

# Holds or releases a key on its own: key_state Control_L PRESSED.
key_state() {
    input_eval "global._headlessKeyboard.notify_keyval(now, Clutter.KEY_$1, Clutter.KeyState.$2)"
}

pointer_click() {
    pointer_move "$1" "$2"
    pointer_button PRESSED
    pointer_button RELEASED
}

# Presses Clutter key names, holding all but the last as modifiers: press_keys Shift_L Right.
press_keys() {
    local key
    for key in "$@"; do
        input_eval "global._headlessKeyboard.notify_keyval(now, Clutter.KEY_$key, Clutter.KeyState.PRESSED)"
    done
    for ((i = $#; i >= 1; i--)); do
        input_eval "global._headlessKeyboard.notify_keyval(now, Clutter.KEY_${!i}, Clutter.KeyState.RELEASED)"
    done
}

# A JavaScript promise of the clipboard text.
CLIPBOARD="new Promise(resolve => imports.gi.St.Clipboard.get_default().get_text(
    imports.gi.St.ClipboardType.CLIPBOARD, (_clipboard, text) => resolve(text)))"

screenshot() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$1" >/dev/null
}
