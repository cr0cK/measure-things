# AGENTS.md

Guidance for AI agents working on Measure Things, a GNOME Shell 49 and 50 extension with measuring tools
for web and UI work: guides, measuring rectangles, area measuring with snapping, a column grid, a
mockup image, and a color picker, drawn on windows and kept in saved sets. Read CONTRIBUTING.md for the human workflow; this file holds what the code does not
tell you.

## Layout

Everything that ships lives in `src/`; `make check` packs it into the extension zip and picks up
new `src/*.js` modules on its own.

| Path | Role |
|---|---|
| `src/extension.js` | Panel indicator and menu (sets on screen, library), keyboard shortcuts, wiring of the manager, the overlay, and the picker |
| `src/manager.js` | The sets on screen: models, their views, commits, undo, load, rename, delete |
| `src/view.js` | A set drawn inside a window actor: helpers, labels, gaps, grid, mockup, badge; the window's geometry |
| `src/overlay.js` | The stage-wide input layer: edit mode, targeting the window under the pointer, area measuring, snapping, loading a set onto a window |
| `src/store.js` | The sets folder: one JSON file per set, read at start, watched, written atomically through a queue per file; applies what `library.js` decides |
| `src/badge.js` | A view's badge menu |
| `src/dialogs.js` | Shell modal dialogs: names, confirmations, Set settings |
| `src/portal.js` | The file chooser portal, for mockup images |
| `src/mockup.js` | Mockup images, loaded once per file |
| `src/snapshot.js` | Still capture of the screen, read by areas and lines on demand |
| `src/picker.js` | Modal color picker with its loupe |
| `src/cursor.js` | Pointer cursor over an actor, across the GNOME 49 and 50 APIs |
| `src/prefs.js` | Adwaita preferences window; every row writes its setting directly. Its list of edit mode keys mirrors `_onKeyPress()` in `overlay.js`: change both together |
| `src/geometry.js` | Helper storage, hit testing, drag math, grid layout, pixel units (pure) |
| `src/zones.js` | Zone geometry, targeting among the views of a window, badge placement (pure) |
| `src/format.js` | Length and color formatting (pure) |
| `src/edges.js` | Edge and same-color run detection on lines of pixels (pure) |
| `src/history.js` | Undo and redo history (pure) |
| `src/detect.js` | Find helpers detection: guides on long edges, rectangles around uniform regions, fed rows of pixels (pure) |
| `src/finder.js` | Find helpers run: covered check, capture, banded reads, staleness, commit |
| `src/library.js` | What a change in the sets folder means once it settled: own write or not, add, import, replace, remove, conflict, startup scan, notices (pure) |
| `src/sets.js` | Set file parsing and writing, names, colors (pure) |
| `src/schemas/` | GSettings schema; settings live under `org.gnome.shell.extensions.measure-things` |
| `tests/` | `node --test` suites for the pure modules; `tests/fixtures/images.js` draws the synthetic test images and their ground truth, `tests/golden/` holds the detector's output per image and level |
| `docs/specs/` | Product contracts, one per spec code, and the project settings of the spec delivery process in its README.md |
| `scripts/headless.sh` | Shared headless GNOME Shell harness: Eval, virtual input, screenshots |
| `scripts/e2e.sh` | End-to-end test of the packed extension in a headless shell |
| `scripts/test-window.js` | Plain GTK 4 window with colored blocks at known positions, for the tests |
| `scripts/find-speed.sh` | Times Find helpers on a 3840 × 2160 zone in a headless shell; reported, not a CI gate |
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

## How sets, views, and the overlay work

The spec is [docs/specs/SET.md](docs/specs/SET.md). A set is a file; a model is a set on screen,
in `Manager`; a view draws a model inside one window.

- A view's layer is a child of the window actor (`window.get_compositor_private()`), so it moves,
  stacks, and hides with the window. It is attached only while it shows something: Mutter does
  not scan out a window directly when its actor has an extra child. Nothing in it is reactive:
  Clutter picks only reactive actors, so pointer events reach the window. The e2e test proves
  this with `global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...)`; keep every new
  actor non-reactive.
- `windowGeometry()` finds where the frame is drawn. In physical layout mode Mutter scales the
  window actor's children by the window's geometry scale, read from `get_child_transform()`; in
  logical mode that scale is 1. Mutter also moves the surfaces onto whole device pixels of the
  highest-scale monitor the frame touches, as `surfaceOffset()` mirrors; without that, helpers
  land a pixel off at 125%.
- Helpers are stored in CSS pixels at the set's zoom, relative to the zone, the window frame.
  Interaction runs in zone pixels, stage pixels from the zone's corner; `View.toCss()` and
  `zoneHelpers()` convert. Content is drawn in the window actor's units; labels and the badge
  sit in a group scaled back to stage pixels, so text keeps its size. Lines are one device
  pixel wide. The layout mode comes from Mutter's `scale-monitor-framebuffer` experimental
  feature, which is what Mutter itself reads. Do not infer it from the St scale factor.
- The overlay is one stage-sized `St.Widget` for input only: the crosshair, the readout, the
  area, the hint, and load mode's highlight. It is top chrome, restacked below
  `modalDialogGroup`: reactive in edit mode, it would otherwise cover the Set settings dialog.
- Edit mode takes a modal grab (`Main.pushModal`, `Shell.ActionMode.POPUP`) on the overlay,
  which then handles every pointer and key event itself and targets the topmost window under
  the pointer. `POPUP` keeps the extension's own shortcuts working during the grab.
  A Wayland grab always gets the keyboard, so there is no seat state to check; Mutter 50
  removed `Clutter.Grab.get_seat_state()`.
- Every change goes through `Manager.commit()`: one undo step and one file write. A set made
  by a gesture stays provisional, out of the menu and unsaved, until its first commit.
- A guide label and its Ctrl+C copy share `View.guideMeasure()`; keep one code path per
  displayed value so the copy can never disagree with the label.
- Each helper keeps its actors in the view's `_helperViews`, updated in place on every pointer
  motion. Gap labels and grid bands are rebuilt on each sync, because there are few of them.
- Area measuring, snapping, and the picker read `Snapshot`, a capture from
  `Shell.Screenshot.screenshot_stage_to_content`, which paints the stage at once, actors included.
  The overlay and the views hide for that paint when edit mode starts; the picker captures
  before its swatch shows, with them hidden. The e2e test checks with known colors that neither
  the helpers nor the swatch are sampled.
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
- Find helpers (`finder.js`) takes a capture of its own, hidden like edit mode's (`Overlay._syncHidden()`
  counts both), reads the zone through `Snapshot.area()` in bands of 256 rows, and feeds `detect.js`
  in chunks of 64 rows with a `PRIORITY_DEFAULT_IDLE` idle between them, so the frame clock and the
  timers run first. The detector is fast enough at full resolution (a 4K zone in a fraction of a
  second), so nothing is downsampled. A boundary of the capture becomes a stage position the way
  `snapPosition()` does, `boundary / scale`, then goes through `view.toCss()`: a found guide and a snapped
  one are the same number. A run commits only if `_stamp()` (set revision, zone geometry, zoom) is
  what it was at the start. The detector keeps the edge map of the whole zone, a byte per pixel: a
  region's thin lines are judged in `finish()` against its box, and those below it arrive after its last
  row. `finder.js` passes the capture's `scale`, which sets how thick a line a rectangle takes in.
  In the headless shell `View.geometry` lags one window move behind, so the
  e2e test opens sets on windows after they are placed.
- `_pickColor()` resolves only when the picker closes; do not await it from Eval. disable()
  cancels it, and the Shell can re-enable right away, so the continuation checks that the
  overlay and picker it started with are still the current ones.

## The sets folder

- `library.js` decides, `store.js` reads, writes, and waits. A name is judged only once its events
  settle (`CHANGES_DONE_HINT`, or 300 ms of quiet) and its write queue is idle, against the file
  as it is then: the etag or the text of the last successful read or write means the shell's own
  write. A read that overlapped a write is dropped and done again.
- GIO's replace recreates a missing file even with an etag, so every write to a file already read
  or written first checks that it exists. A conflict (`WRONG_ETAG`) drops every queued commit and
  reloads the file; the file on disk wins.
- A local file's etag is its modification time, which the kernel rounds to a few milliseconds:
  the e2e test waits between a write of the shell and an external edit of the same file.
- The e2e test makes races deterministic by replacing `store._onEvent` with a function that
  collects the folder monitor's events, changing the files, and replaying the events. It forces a
  write to fail by making the target path a directory, and an import to fail by replacing
  `store._removeFile`.

## GJS, St, and Clutter pitfalls already hit here

- `PopupSwitchMenuItem.setToggleState()` emits `toggled` (the switch's `notify::state` does).
  A `toggled` handler that toggles state back loops forever and freezes the shell, so compare
  the new state with the model before acting.
- `Shell.Screenshot.pick_color` is not promisified by default; `picker.js` calls
  `Gio._promisify` on it, as the Shell's own screenshot UI does.
- A promise's executor runs synchronously but after the line that builds it. Set any state that
  the first async step depends on before starting that step.
- `PopupMenuManager` closes its menu on Escape from the menu actor's `captured-event`, handlers run in
  connection order, and the stage never sees the key under a grab: a handler that must see Escape first
  connects to `menu.actor` before `addMenu()`, as the badge menu's confirmation does.
- `St.Label` sizes are only right once the label is on the stage; add it before calling
  `get_preferred_width`.
- St's `box-shadow` fills the whole box, so it cannot outline a transparent widget; nest two
  bordered widgets instead, as the loupe marker does.
- A child of a vertical `St.BoxLayout` stretches to the widest sibling unless its `x_align` is set.
- Opacity percentages convert with `Math.round(percent * 255 / 100)`: `percent * 2.55` is a
  hair below .5 for 50 and rounds down.
- `Meta.Cursor` uses CSS cursor names (`POINTER`, not `POINTING_HAND`). An unknown name is
  `undefined`, and `set_cursor(undefined)` aborts the whole shell.
- `Clutter.Actor` has write-only `actions`, `constraints`, and `effect` properties: a JS field
  of that name on an actor calls `add_action()` and throws.
- A popup menu item activates inside its click gesture, which touches the item afterwards:
  destroy a menu from its own action on idle, as `BadgeMenu` does.
- Exceptions in signal handlers log as `Exception in callback`, not `JS ERROR`; the e2e test
  greps for both.
- At fractional scales GTK draws a window's content from its buffer's corner, shadow included,
  so its own edges can fall halfway through a device pixel, where a measured area loses one
  pixel. Test blocks sit where GTK's edges are whole device pixels.

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

The e2e test draws on `scripts/test-window.js` windows, whose blocks sit at known CSS positions,
and reads set files from the scratch `XDG_DATA_HOME`. The harness sets `HOME` there too, so GIO
can trash files: it refuses on a mount other than the home's, such as a tmpfs `/tmp`. The test
turns on Mutter's logical layout mode, then switches the virtual monitor to 125% through
`org.gnome.Mutter.DisplayConfig` for its last checks, which cover fractional scaling.
`global._e2e` holds its Eval shortcuts.

CI runs the e2e test in `fedora:43` (GNOME 49) and `fedora:44` (GNOME 50) containers with
Mesa's software renderer, so every change is proven on both supported Shells. The Shell aborts
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
- Specs and implementation plans follow the spec delivery process of the `sdp` Claude Code
  plugin (`sdp:spec`, `sdp:approve`, `sdp:exec`), with the project settings in
  [docs/specs/README.md](docs/specs/README.md): a spec is named by a code such as `SET`, and
  delivered in plans `SET-P1`, `SET-P2`, and so on, one PR each.
- A user-visible change updates README.md in the same PR. A plan PR never edits a spec: a gap
  becomes an outbox entry. Any other change to shipped behavior updates every spec whose rules
  it changes, in the same PR. When it changes what the overlay, the menu, the picker, or the preferences look like, run
  `scripts/screenshots.sh`, look at the new images, and commit them. Source, docs, and UI strings
  are in English.
- A defect found outside the task at hand becomes a GitHub issue with its reproduction, not a
  wider PR.
