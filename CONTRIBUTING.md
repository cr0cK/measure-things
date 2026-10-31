# Contributing

Thanks for helping improve Measure Things. By participating, you agree to follow the
[Code of Conduct](.github/CODE_OF_CONDUCT.md).

## Development setup

You need GNOME Shell 49, GLib schema tools, Node.js 24, Python 3, and
[pre-commit](https://pre-commit.com). Node.js and Python are only used for development; the
extension does not need them at runtime.

~~~sh
npm ci                                # ESLint and its plugins
pre-commit install --install-hooks    # pre-commit and commit-msg hooks
~~~

## Layout

Everything that ships lives in `src/`; `make check` packs it into the extension zip. Unit
tests are in `tests/`, development scripts in `scripts/`, and product contracts in `docs/specs/`.

## Checks

~~~sh
npm run lint    # ESLint
make check      # GSettings schema, module parsing, unit tests, extension bundle in dist/
npm run e2e     # end-to-end test in a headless GNOME Shell (scripts/e2e.sh)
~~~

The end-to-end test runs the packed checkout in a headless GNOME Shell on a private D-Bus
session, drives it with a virtual pointer and keyboard, and checks edit mode, click-through,
persistence, the grid, the color picker, and a clean disable. It never touches your desktop
session or settings, and takes about a minute.

The hooks run ESLint, the unit tests, schema validation, gitleaks, typos, and file hygiene on
each commit, and check the commit message format. CI runs the same checks, plus the end-to-end
test, on every pull request. Do not commit `dist/`.

## Trying a change

To run the current checkout without touching your desktop session, use the windowed GNOME Shell
sandbox (it requires `mutter-devel` for the devkit):

~~~sh
scripts/sandbox.sh          # rebuilds, then opens the sandbox window
scripts/sandbox.sh --reset  # same, from fresh settings
~~~

The sandbox keeps its extensions and settings in ~/.cache/measure-things-sandbox (override with
MEASURE_THINGS_SANDBOX) on a private D-Bus session. Preferences and helpers persist between
runs. Close the window and run the script again after a code change.

A change to the helpers, the menu, the picker, or the preferences window also regenerates the
README screenshots:

~~~sh
scripts/screenshots.sh      # rewrites docs/screenshots/*.png
~~~

It runs a headless GNOME Shell and measures the extension's own preferences window. It needs
ImageMagick.

## Code and documentation style

- Follow .editorconfig and the ESLint rules, which match the GNOME Shell code style.
- Keep source comments, documentation, metadata, and user-facing strings in English.
- Use GNOME Shell ES modules and GSettings for extension preferences.
- Keep logic that can live without GNOME APIs in the pure modules (`src/geometry.js`,
  `src/format.js`), with unit tests.
- Update README.md and the relevant docs/specs/v*.md when a change affects the user-visible
  contract.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) with an English
summary:

~~~text
<type>(<scope>): <summary>
~~~

Types are feat, fix, docs, style, refactor, perf, test, build, ci, chore, and revert; the scope
is optional. Pull requests are squash-merged, so the PR title becomes the commit subject and must
follow the same format.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please).
Every merge to `main` updates a release pull request that bumps `package.json`, the
`version-name` in `src/metadata.json`, and CHANGELOG.md from the commit history: `feat` bumps the
minor version, `fix` the patch, and breaking changes the major version, or the minor version
before 1.0.0. `perf`, `refactor`, and `revert` also release a patch; `docs`, `test`, `build`,
`ci`, `chore`, and `style` never trigger a release. Do not edit CHANGELOG.md by hand. Merging the release pull request tags
`vX.Y.Z`, publishes a GitHub Release, and attaches the installable extension zip. The integer
`version` field of src/metadata.json is left to extensions.gnome.org.

release-please opens the release pull request as a GitHub App, so its checks run without manual
approval. The App needs read and write access to Contents and Pull requests on this repository.
Its client ID goes in the `RELEASE_APP_CLIENT_ID` Actions variable and a private key in the
`RELEASE_APP_PRIVATE_KEY` Actions secret.
