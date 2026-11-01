---
name: ck-exec
description: Implement one plan of a spec (<CODE>-Pn), or fix a defect against a spec, following the repo's spec process in docs/specs/README.md. Reads the spec and the plan, runs the plan's prototype first, implements only the plan's slice with tests, writes any deviation into the spec in the same PR, always works in a worktree, has every change reviewed adversarially before it is pushed, opens a PR named after the plan, and babysits CI without merging. Trigger on "implement SET-P1", "exec SET-P2", "start the next plan", "fix <bug>", "this behaves wrong". NOT for designing or changing a spec on its own, which is ck-spec.
---

# ck-exec: implement a plan or fix a defect

`docs/specs/README.md` is the process. Read it first. Where it and this skill disagree, it wins.
AGENTS.md gives the project's checks, commands, and pitfalls.

## Every cycle

These rules hold in both modes, and they are not optional.

- **Worktree, always.** All work happens in `.claude/worktrees/<branch-slug>`, never in the main
  checkout: `git fetch`, then `git worktree add .claude/worktrees/<slug> -b <branch> origin/main`.
  To resume an open PR, add a worktree on its existing branch. Run every check from the worktree.
  Once the PR merges, remove the worktree and the branch.
- **Adversarial review before every push.** No commit reaches the remote before a reviewer who
  did not write it has read it:
  - Before the first push, review the whole diff, `git diff origin/main...HEAD`.
  - Every later iteration (review findings, CI fixes, owner feedback) reviews its new commits
    before they are pushed. Only the plan's state commit (step 8), which changes nothing but the
    spec's state, is exempt.
  - The reviewer is Codex, read-only, with `< /dev/null`. When it is unavailable, hangs, or
    overflows, fall back to Gemini through `agy` in plan mode, then to a fresh-context subagent.
    Give it the diff, the spec rules and plan it implements, and AGENTS.md. Ask for findings
    only, at most 15, labeled **high**, **medium**, or **low**:
    1. Behavior that breaks the spec, or leaks beyond the plan's slice.
    2. Bugs: races with async reads, state left behind by `disable()`, signals or timeouts never
       removed, reactive actors outside edit mode.
    3. Tests that would still pass with the behavior broken, or behavior with no test.
    4. Pitfalls AGENTS.md already lists.
  - Arbitrate each finding against the code: fix the ones that hold, rerun the checks, and
    discard the over-engineered ones with a reason. The PR text gives the verdict, naming the
    reviewer that ran, in a `<details>` block.
- **CI, then wait.** When the cycle had no blocker (no stop, no failed prototype criterion, no
  question left to the user) and the PR is ready, babysit CI: `gh pr checks <PR> --watch` until
  every check is terminal. Fix each failure at its root cause, as an iteration reviewed before
  its push, until CI is green. A failure that is not the code's (runner, network) gets one
  rerun, then becomes a blocker. Then stop: never merge, never queue an auto-merge. The merge is
  the user's. When the cycle had a blocker, report it and stop without babysitting.
- **While the PR waits**: when the main branch moves and the PR conflicts, rebase it in its
  worktree, rerun the checks, and review the conflict resolution before the force push.

## Mode

- **Plan**: the argument is a plan name, such as `SET-P1`. Without one, take the spec whose status
  is `approved` or `in-progress`, and its first `todo` plan. When several specs qualify, ask which
  one. When the plan already has an open PR (branch `feat/<code>-p<n>-*`), resume it on its branch
  instead of starting a new one: read its review comments and CI state first, and handle each as
  an iteration.
- **Fix**: the argument describes a defect, a small behavior change, or an issue. A change that
  needs design or more than one PR goes through ck-spec first, which adds plans for it.

## Plan mode

1. **Read in full**:
   - `docs/specs/README.md` and AGENTS.md;
   - the spec, `docs/specs/<CODE>.md`, and the specs it builds on;
   - the tracking issue, titled `<CODE>: …`;
   - the PRs of the earlier plans.
2. **Check the spec and the order.**
   - Read the state from the main branch, never from a local branch: `git fetch`, then
     `git show origin/main:docs/specs/<CODE>.md`.
   - The spec's `status` must be `approved` or `in-progress`. A `draft` spec belongs to ck-spec:
     stop.
   - The plan must exist and be `todo`. Every earlier plan must be `done`. If not, stop and say
     why.
3. **Worktree**: branch `feat/<code>-p<n>-<slug>`, lowercase, in its worktree (see
   [Every cycle](#every-cycle)).
4. **Prototype first**, when the plan has one. It is throwaway and never committed to the PR.
   - Report each criterion as pass or fail, with its evidence.
   - When a criterion fails, or a fallback must be chosen, stop and ask the user.
5. **Implement the plan's slice only.**
   - Keep the temporary restrictions the plan states, and leave later plans out entirely: no UI
     stubs, no dead settings.
   - Put new logic in pure, testable modules when the project has that pattern.
6. **The spec stays true.**
   - When the code has to differ from the spec, edit the spec in the same PR, and say so in the
     PR text.
   - When the spec is ambiguous or wrong in a way the user must decide, ask with AskUserQuestion,
     then write the answer into the spec.
7. **Tests**: every user-visible behavior the plan adds gets an automated test. Run every check
   AGENTS.md requires, and look at screenshots of any visible change.
8. **PR**, once the review of the whole diff is arbitrated:
   - The title follows the project's commit convention.
   - The body starts with `<CODE>-Pn of #<issue>`.
   - It uses `Refs #<issue>`, and `Closes` only for the spec's last plan.
   - It lists the temporary restrictions, the spec changes, and the prototype verdict.
   - Once the PR number is known, commit the state change to the spec: this plan becomes
     `"done #<PR>"`, quoted because `#` starts a YAML comment, and the status becomes
     `in-progress`, or `implemented` for the last plan. It becomes true when the PR merges.
9. **CI**: babysit it as [Every cycle](#every-cycle) says, then wait. The spec's owner reviews
   and merges each plan's PR.

## Fix mode

For a defect, or a small behavior change the user asked for.

1. **Reproduce first**, with a failing test or a run in the real environment. Keep the evidence.
2. **Find the rules.** Grep `docs/specs/*.md` for the behavior, and name the spec code and section
   that cover it.
3. **Classify**:
   - The code breaks the spec: fix the code, and add a regression test.
   - The spec is silent or wrong: the fix is also a spec change. When the right behavior is a
     product choice, ask the user first. Then update every spec whose rules change, and add the
     version the fix will ship in to each shipped spec's `amended` list.
   - A small behavior change the user asked for: same as a spec change.
   - A defect outside the work at hand: follow AGENTS.md, which makes it an issue with its
     reproduction, and stop there.
4. **Branch** `fix/<slug>` in its worktree. Run the checks, get the review, open the PR, and
   babysit CI, as [Every cycle](#every-cycle) says, without the plan-only parts: no plan name, no
   plan state change, and no tracking issue. The PR text names the spec rules it follows or
   changes, and closes the defect's issue when there is one.
5. Merge only when the user asks.

## Report

The PR, the plan or the spec rules it covers, the checks run with their results, the review
verdict and the reviewer that ran, the CI state, and the decisions left to the user. Keep it short.
