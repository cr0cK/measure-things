#!/usr/bin/env bash
# Runs the current checkout in a windowed GNOME Shell (mutter devkit), isolated from the
# desktop session: extensions and GSettings live under the sandbox directory, on a private
# D-Bus session. Preferences persist between runs; pass --reset to start from scratch.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=measure-things@cr0ck.github.io
SANDBOX=${MEASURE_THINGS_SANDBOX:-${XDG_CACHE_HOME:-$HOME/.cache}/measure-things-sandbox}
EXTENSION_DIR=$SANDBOX/data/gnome-shell/extensions/$UUID

if [[ ${1:-} == --reset ]]; then
    rm -rf "$SANDBOX"
elif [[ $# -gt 0 ]]; then
    echo "Usage: $0 [--reset]" >&2
    exit 2
fi

for command in gnome-shell dbus-run-session glib-compile-schemas unzip; do
    if ! command -v "$command" >/dev/null; then
        echo "Missing $command." >&2
        exit 1
    fi
done
if [[ ! -x /usr/libexec/mutter-devkit ]]; then
    echo "Missing mutter devkit; install mutter-devel." >&2
    exit 1
fi

make -C "$ROOT" pack
rm -rf "$EXTENSION_DIR"
mkdir -p "$EXTENSION_DIR" "$SANDBOX/config"
unzip -q "$ROOT/dist/$UUID.shell-extension.zip" -d "$EXTENSION_DIR"
glib-compile-schemas "$EXTENSION_DIR/schemas"

sandbox_gsettings() {
    XDG_CONFIG_HOME="$SANDBOX/config" GSETTINGS_BACKEND=keyfile gsettings set "$@"
}
# Set on every run, so a sandbox created before a UUID change still enables this checkout.
sandbox_gsettings org.gnome.shell enabled-extensions "['$UUID']"
sandbox_gsettings org.gnome.shell disable-user-extensions false
sandbox_gsettings org.gnome.shell welcome-dialog-last-shown-version "'999'"

echo "Sandbox: $SANDBOX"
exec env \
    XDG_DATA_HOME="$SANDBOX/data" \
    XDG_CONFIG_HOME="$SANDBOX/config" \
    GSETTINGS_BACKEND=keyfile \
    dbus-run-session -- gnome-shell --devkit --wayland
