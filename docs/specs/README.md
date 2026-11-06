# Specs

The specs of this repository, one file per spec code, follow the **spec delivery process** of the
`sdp` Claude Code plugin: `sdp:spec` designs a spec and its plans, `sdp:approve` gates them and
arbitrates the outbox, and `sdp:exec` implements the approved plans as stacked PRs. Each spec's
delivery is recorded as stamps in its tracking issue.

## Project settings

- **Owner**: `cr0cK`.
- **Releases**: release-please opens the release PR. Each spec ships in one minor version, and
  its `version` is that series, vX.Y. Merge the release PR only once every plan of the spec in
  progress is merged.
- **Commits and PR titles**: Conventional Commits, as AGENTS.md describes; a spec PR is `docs:`,
  a plan PR is usually `feat:`. PRs are squash-merged, so the PR title is the commit
  release-please reads.
- **Checks**: `npm run lint`, `make check`, and `npm run e2e`, the end-to-end test in a headless
  GNOME Shell. A user-visible change gets a new check in `scripts/e2e.sh`. A change to what the
  overlay, the menu, the picker, or the preferences look like reruns `scripts/screenshots.sh`,
  and the new images in `docs/screenshots/` are looked at and committed.
- **Reviewers**: Codex read-only (`codex exec --sandbox read-only ... < /dev/null`), then a
  fresh-context agent.

## Specs

- `OVL` (2026-10-31): the screen-wide overlay, guides, rectangles, column grid, and color picker
  of v0.1, replaced by PIX.
- `PIX` (2026-10-31): reading the screen's pixels: area measuring, snapping, the picker's loupe,
  and the mockup, in v0.2, partly replaced by SET.
- `SET` (2026-11-01): window-scoped helpers in saved sets, with main views and copies, in v0.3.
  Tracking issue #8.
