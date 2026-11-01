# AGENTS.md

Guidance for AI agents working on Measure Things, a GNOME Shell 49 extension with measuring tools
for web and UI work: guides, measuring rectangles, area measuring with snapping, a column grid, a
mockup image, and a color picker, drawn above every window. Read CONTRIBUTING.md for the human workflow; this file holds what the code does not
tell you.

## Layout

Everything that ships lives in `src/`; `make check` packs it into the extension zip and picks up
new `src/*.js` modules on its own.

| Path | Role |
|---|---|
| `src/extension.js` | Panel indicator and menu, keyboard shortcuts, wiring of the overlay and the picker |
| `src/overlay.js` | The layer above all windows: helper rendering, gap labels, column grid, edit mode, area measuring, snapping, undo |
| `src/mockup.js` | The mockup image in the layer |
| `src/snapshot.js` | Still capture of the screen, read by areas and lines on demand |
| `src/picker.js` | Modal color picker with its loupe |
| `src/prefs.js` | Adwaita preferences window; every row writes its setting directly. Its list of edit mode keys mirrors `_onKeyPress()` in `overlay.js`: change both together |
| `src/geometry.js` | Helper storage, hit testing, drag math, grid layout, pixel units (pure) |
| `src/format.js` | Length and color formatting (pure) |
| `src/edges.js` | Edge and same-color run detection on lines of pixels (pure) |
| `src/history.js` | Undo and redo history (pure) |
| `src/schemas/` | GSettings schema; settings live under `org.gnome.shell.extensions.measure-things` |
| `tests/` | `node --test` suites for the pure modules |
| `docs/specs/v*.md` | Product contracts, one per minor version |
| `scripts/headless.sh` | Shared headless GNOME Shell harness: Eval, virtual input, screenshots |
| `scripts/e2e.sh` | End-to-end test of the packed extension in a headless shell |
| `scripts/screenshots.sh` | Regenerates `docs/screenshots/` |
| `scripts/sandbox.sh` | Windowed, isolated GNOME Shell running the checkout |

The pure modules import nothing from `gi://`, so `node --test` covers them. Keep new logic there
when it can live without GNOME APIs.

## Commands

```sh
npm ci && pre-commit install --install-hooks   # once
npm run lint                                   # ESLint
make check                                     # schema, parse, unit tests, zip in dist/
npm run e2e                                    # headless end-to-end test
scripts/sandbox.sh                             # try it in a windowed GNOME Shell
```

`npm run lint`, `make check`, and `npm run e2e` must pass before you declare work done. A
user-visible change also gets a new check in `scripts/e2e.sh`.

## How the overlay works

- The overlay is one stage-sized `St.Widget` added with `Main.layoutManager.addTopChrome`, so it
  sits above windows, fullscreen ones included. Nothing in it is reactive outside edit mode:
  Clutter picks only reactive actors, so pointer events reach the window below. The e2e test
  proves this with `global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...)`; keep
  every new actor non-reactive.
- Edit mode takes a modal grab (`Main.pushModal`, `Shell.ActionMode.POPUP`) on the overlay,
  which then handles every pointer and key event itself. `POPUP` keeps the extension's own
  shortcuts working during the grab. Always check `grab.get_seat_state()` for the keyboard and
  pop the grab when it is missing.
- Helpers are stored in stage pixels. Labels convert to the display unit with
  `pixelRatios()`: in logical layout mode (fractional scaling) the stage is in logical pixels,
  which are CSS pixels at 100% zoom; in physical mode the stage is in device pixels. The layout
  mode comes from Mutter's `scale-monitor-framebuffer` experimental feature, which is what
  Mutter itself reads. Do not infer it from the St scale factor: in physical mode that follows
  the primary monitor only, so mixed scales would convert wrongly. The grid settings are always
  CSS pixels.
- A guide label and its Ctrl+C copy share `_guideMeasure()`; keep one code path per displayed
  value so the copy can never disagree with the label.
- Each helper keeps its actors in `_views`, updated in place on every pointer motion. Gap
  labels and grid bands are rebuilt on each sync, because there are few of them.
- Area measuring, snapping, and the picker read `Snapshot`, a capture from
  `Shell.Screenshot.screenshot_stage_to_content`, which paints the stage at once, actors included.
  The overlay hides itself for that paint when edit mode starts; the picker captures before its
  swatch shows, with the overlay hidden. The e2e test checks with known colors that neither the
  helpers nor the swatch are sampled.
- The capture stays on the GPU. Reading a whole 4K screen into memory takes over a second, so
  `Snapshot` reads only what is needed through `Shell.Screenshot.composite_to_stream`: a full row
  or column for edges (a few milliseconds, cached), 11 × 11 pixels for the loupe. Its pixels are
  device pixels, stage coordinates times its `scale`; at fractional scales a screen edge can fall
  between two stage pixels, and snapping rounds it.
- Lines arrive asynchronously. `Snapshot.line()` returns null and calls back once the read ends;
  the overlay then replays the drag and redraws the area from the last pointer position. A drag
  released while a line it snaps to is still being read finishes after that read.
- Anything on screen when edit mode or the picker starts is captured. Menu actions run before
  the menu starts closing, so the menu closes itself without animation first, and the picker
  re-enters edit mode before it shows its confirmation.
- `_pickColor()` resolves only when the picker closes; do not await it from Eval. disable()
  cancels it, and the Shell can re-enable right away, so the continuation checks that the
  overlay and picker it started with are still the current ones.

## GJS, St, and Clutter pitfalls already hit here

- `PopupSwitchMenuItem.setToggleState()` emits `toggled` (the switch's `notify::state` does).
  A `toggled` handler that toggles state back loops forever and freezes the shell, so compare
  the new state with the model before acting.
- `Shell.Screenshot.pick_color` is not promisified by default; `picker.js` calls
  `Gio._promisify` on it, as the Shell's own screenshot UI does.
- A promise's executor runs synchronously but after the line that builds it. Set any state that
  the first async step depends on before starting that step.
- `St.Label` sizes are only right once the label is on the stage; add it before calling
  `get_preferred_width`.
- St's `box-shadow` fills the whole box, so it cannot outline a transparent widget; nest two
  bordered widgets instead, as the loupe marker does.
- A child of a vertical `St.BoxLayout` stretches to the widest sibling unless its `x_align` is set.
- Opacity percentages convert with `Math.round(percent * 255 / 100)`: `percent * 2.55` is a
  hair below .5 for 50 and rounds down.

## Verify UI changes in a real GNOME Shell

Unit tests do not prove the overlay works. `scripts/headless.sh` holds what it takes to drive
a headless shell; reuse it rather than starting from scratch:

- It runs `gnome-shell --headless --virtual-monitor` inside `dbus-run-session`, with
  `XDG_DATA_HOME` and `XDG_CONFIG_HOME` in a scratch directory and `GSETTINGS_BACKEND=keyfile`,
  and never touches the user's dconf. The Wayland display name stays short: the socket path must
  fit in 108 bytes. A shell killed with SIGKILL leaves its socket and `.lock` behind in
  `$XDG_RUNTIME_DIR`, and the next shell with the same name fails with `Failed to create_socket`.
- `org.gnome.Shell.Eval` and `org.gnome.Shell.Screenshot` need unsafe mode, which a throwaway
  helper extension enables. Never ship that helper. Eval awaits promises.
- A new Clutter virtual pointer drops the x axis of its first absolute motions; the harness moves
  it until `global.get_pointer()` follows. Send each event in its own Eval, motion before the
  click.
- `notify_keyval` takes `Clutter.KEY_*` values; hold modifiers by pressing them first, as
  `press_keys Super_L Shift_L m` does.
- GNOME Shell caches extension modules. After editing code, restart the headless shell;
  disabling and re-enabling the extension keeps running the old code.
- Look at the screenshots, and grep the shell log for `JS ERROR` and `JS WARNING`.

The e2e test turns on Mutter's logical layout mode, then switches the virtual monitor to 125%
through `org.gnome.Mutter.DisplayConfig` for its last checks, which cover fractional scaling.

CI runs the e2e test in a `fedora:43` container with Mesa's software renderer. The Shell aborts
at startup there unless the workflow starts a system D-Bus and deletes `/run/systemd/seats`:
installing systemd creates that directory, which makes the Shell expect logind.

`scripts/sandbox.sh` uses the mutter devkit instead. Do not pass `--virtual-monitor` there: the
devkit shows its own monitor. While the desktop session is locked, the devkit window gets no
frames and the sandbox shell never finishes starting up; use the headless shell then.

## Versions, releases, and docs

- The UUID is `measure-things@cr0ck.github.io`. Never change it casually: changing it makes users
  reinstall.
- release-please owns `CHANGELOG.md`, `package.json` `version`, and `src/metadata.json`
  `version-name`. Do not edit them by hand. `metadata.json` must not get an integer `version`:
  extensions.gnome.org sets it.
- Never put session links, local paths, or private organization and repository names in commits,
  PR texts, docs, or test fixtures.
- Commits and PR titles use Conventional Commits. PRs are squash-merged, so the PR title is the
  commit release-please reads. `feat` bumps the minor version, `fix` the patch, and breaking
  changes the major version, except before 1.0.0, where they bump the minor version. The first
  release is 0.1.0. `docs`, `test`, `build`, `ci`, `chore`, and `style` are hidden changelog
  sections and never trigger a release.
- release-please runs as a GitHub App (`RELEASE_APP_CLIENT_ID` variable,
  `RELEASE_APP_PRIVATE_KEY` secret), not with GITHUB_TOKEN: GitHub holds `pull_request`
  workflows on PRs opened by GITHUB_TOKEN for manual approval.
- Design a new minor version in a `docs` PR that adds its `docs/specs/v*.md`, and iterate on the
  design by editing that spec in the PR, not in an issue or in review comments. Once the spec is
  merged, the implementation issue holds only the delivery plan and links the spec.
- A user-visible change updates README.md and the current `docs/specs/v*.md` in the same PR. When
  it changes what the overlay, the menu, the picker, or the preferences look like, run
  `scripts/screenshots.sh`, look at the new images, and commit them. Source, docs, and UI strings
  are in English.
- A defect found outside the task at hand becomes a GitHub issue with its reproduction, not a
  wider PR.
