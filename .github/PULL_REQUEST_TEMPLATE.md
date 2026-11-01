<!-- The PR title becomes the squash commit subject: use Conventional Commits, e.g. `feat: add ...`. -->

### Why

<!-- The goal, the trigger, or the bug this PR addresses. Link issues with `Closes #123`.
     A plan PR starts with its plan name, such as `SET-P1`, and references its tracking issue
     without closing it, except for the spec's last plan. -->

### What changes

<!-- The fix in a short paragraph; breaking changes and migration steps on their own line. -->

### Checklist

- [ ] `npm run lint` passes
- [ ] `make check` passes
- [ ] `npm run e2e` passes, with a new check for user-visible changes
- [ ] Tried in GNOME Shell (`scripts/sandbox.sh` or a real session), for user-visible changes
- [ ] `CHANGELOG.md` is left to release-please; README and every spec in `docs/specs/` whose rules change are updated
