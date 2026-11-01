---
name: ck-exec
description: Implement the plans of a spec (<CODE>-P1, -P2, …) one PR each, stacked, or fix a defect against a spec, following the repo's spec process in docs/specs/README.md. Runs as a tick every 10 minutes that delegates the work to background workers, each in its own worktree; the tick keeps the work going, takes in new information, pushes only what an adversarial review has read, babysits CI, and never merges. Trigger on "implement SET", "implement SET-P1", "exec SET-P2", "start the next plan", "fix <bug>", "this behaves wrong". NOT for designing or changing a spec on its own, which is ck-spec.
---

# ck-exec: implement a spec's plans or fix a defect

`docs/specs/README.md` is the process. Read it first. Where it and this skill disagree, it wins.
AGENTS.md gives the project's checks, commands, and pitfalls.

**ck-exec never questions the user.** It takes every implementation call itself. A gap only the
spec can close (an ambiguity, a contradiction, a failed prototype, a product choice) becomes a
[spec blocker](#spec-blockers), which ck-spec resolves by changing the spec.

## Start: a loop of ticks

The work runs as a loop: a **tick** every 10 minutes orchestrates, and **workers** do the work.

- An argument that starts with `tick` is a tick: follow [The tick](#the-tick).
- Any other argument starts the work. Resolve the target first:
  - **Spec**: a spec code, such as `SET`, or a plan name, such as `SET-P2`, which starts there.
    Without an argument, take the spec whose status is `approved` or `in-progress`; when several
    qualify, list them and stop.
  - **Issue**: `#<n>` or an issue link. Read it with its comments, then route it:
    - the tracking issue of a spec (titled `<CODE>: …`): that spec;
    - an issue that names a plan not yet merged (`<CODE>-Pn`): information for that plan. Add it
      to the spec's ledger when its loop runs, or start the spec's loop with it. The plan's PR
      then closes the issue;
    - any other issue: a fix. A spec code or plan it names tells the fix worker where the rules
      are.
  - **Fix**: a defect or a small behavior change described in the argument.

  A change that needs design or more than one PR goes through ck-spec first, which adds plans for
  it: say so and stop.

- **Readiness read**, for a spec, before any loop starts. A worker reads in full the spec, the
  specs it builds on, the tracking issue, AGENTS.md, and the code each plan not yet merged
  touches. It reports, per plan, every gap only the spec can close, with what the spec says and
  the options it sees, and takes every other call itself. Each gap becomes a
  [spec blocker](#spec-blockers), flagged before any code is written.
  - When the first plan to implement is blocked, start no loop: report the blockers and tell the
    user to run `ck-spec <CODE>`. Once the fixes are merged, ck-exec runs again from the start.
  - Otherwise the loop starts, and stops at the first blocked plan.
- Then invoke the `loop` skill with `10m /ck-exec tick <target>`, and do nothing else in this
  run.

## The ledger

The ledger carries the work from tick to tick: `$(git rev-parse --path-format=absolute
--git-common-dir)/ck-exec/<target>.md`, outside the tracked tree. It holds, per plan or fix:

- the branch, the worktree, the PR, and its base;
- the running worker, with its name and task;
- the last reviewed SHA, with the reviewer and the verdict;
- open blockers: spec blockers with their flag comment, and operational ones (CI infrastructure);
- information received for the work and not yet handed to a worker.

GitHub and git are the truth; the ledger only adds what they cannot say. Each tick reconciles the
two and fixes the ledger.

## The tick

Idempotent: a tick that finds nothing to do changes nothing and reports one line.

1. **Read**: the ledger, `git fetch`, the spec state on `origin/main`, the tracking issue, the
   open PRs on the spec's branches with their CI state, review comments and base, the
   worktrees, and the workers' reports received since the last tick.
2. **Take in new information**: messages from the user, owner review comments, new comments on
   the tracking issue, open issues that name the spec or one of its plans (`gh issue list
   --search <CODE>`), and spec changes merged to main. Note each in the ledger against the plan
   it concerns. Send it to the running worker of that plan with SendMessage, or put it in the
   brief of its next worker. A change that invalidates finished work reopens that plan.
3. **Act**, for each plan in order, on the first state that matches:

   | State | Action |
   |---|---|
   | A worker is running | Nothing, unless step 2 has information for it |
   | Open spec blocker | Nothing until a spec change on main resolves it; the report names it |
   | Worker finished, reviewed SHA not pushed | [Push](#push-and-pr) that exact SHA, open or update the PR |
   | PR conflicts with its base, or its base plan merged | Dispatch a [restack](#stacked-prs) worker |
   | Review comments or CI failures to handle | Dispatch an iteration worker |
   | CI pending | Nothing |
   | CI green, nothing left | Waits for the owner's merge |
   | PR merged | Remove its worktree and local branch, mark it in the ledger |
   | No PR, earlier plan's PR open or merged | Dispatch the [implementation](#plan-worker) worker |

   Plans are implemented one at a time: the next plan starts once the previous plan's PR is open
   with no unresolved blocker. Iterations and restacks of open PRs run alongside it, at most one
   worker per PR.
4. **Flag**: a worker that reports a gap only the spec can close opens a
   [spec blocker](#spec-blockers). It stops its own plan and the plans stacked above it, not the
   open PRs below.
5. **End**: when every plan of the spec, or the fix, is merged, remove the ledger, and end the
   loop. Never merge, never queue an auto-merge, never use `--admin`: the merge is the owner's.
6. **Report**, in a few lines: what changed since the last tick, each plan's state, and the
   decisions waiting for the user.

## Workers

A worker is a background subagent (Agent tool), named `ck-<plan>-<task>`, such as
`ck-set-p2-impl`. Its brief is all it knows: give it the target, its worktree's absolute path, the
files to read, the answers and information from the ledger, and what it must return.

- It works only in its worktree, and commits its work there.
- It never pushes, never opens or edits a PR, and never asks the user. It takes every
  implementation call itself and reports it. A gap only the spec can close ends its run blocked,
  with the gap stated: what the spec says, why it cannot be implemented as written, and the
  options it sees.
- Before it reports done, it gets the [review](#adversarial-review) of its commits and arbitrates
  it.
- It returns: done or blocked, the gap when blocked, the reviewed SHA, the review verdict,
  the checks run with their results, and the spec changes it made.

### Worktrees

- Every branch has its own worktree under the main checkout:
  `$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/worktrees/<branch-slug>`,
  never a path relative to the current directory.
- The tick creates it before dispatching the worker: from `origin/main` for the first plan or a
  fix, from the previous plan's branch for a stacked plan. When the branch already has a
  worktree (`git worktree list`), reuse it.

### Adversarial review

No commit reaches the remote before a reviewer who did not write it has read it.

- The worker commits first, then has the commits it adds reviewed: the whole diff against its
  base for a new PR, the new commits for an iteration, the conflict resolution for a restack.
- The reviewer is Codex, read-only, with `< /dev/null`. When it is unavailable, hangs, or
  overflows, fall back to Gemini through `agy` in plan mode, then to a fresh-context subagent.
- The brief gives the diff, the spec rules and plan it implements, and AGENTS.md, and asks for
  findings only, at most 15, labeled **high**, **medium**, or **low**:
  1. Behavior that breaks the spec, or leaks beyond the plan's slice.
  2. Bugs: races with async reads, state left behind by `disable()`, signals or timeouts never
     removed, reactive actors outside edit mode.
  3. Tests that would still pass with the behavior broken, or behavior with no test.
  4. Pitfalls AGENTS.md already lists.
- The worker fixes the findings that hold, reruns the checks, commits, and has those fixes
  reviewed in turn. It discards the over-engineered ones with a reason.
- The SHA the worker reports is the one the review covered. The tick pushes only that SHA, after
  checking that the branch head still matches it.
- Only the plan's state commit, which changes nothing but the spec's state, is exempt.

### Push and PR

The tick pushes and opens PRs; workers never do.

- The PR title follows the project's commit convention. A stacked plan's PR has the previous
  plan's branch as its base.
- A plan PR's body starts with `<CODE>-Pn of #<issue>`, then `Stacked on #<PR>` when it is
  stacked. It uses `Refs #<issue>`, and `Closes` only for the spec's last plan. It lists the
  temporary restrictions, the spec changes, the prototype verdict, and, in a `<details>` block,
  the review verdict with the reviewer that ran.
- A fix PR names the spec rules it follows or changes, and closes the defect's issue when there is
  one.
- Once a plan PR's number is known, the tick commits the state change to the spec in its
  worktree: this plan becomes `"done #<PR>"`, quoted because `#` starts a YAML comment, and the
  status becomes `in-progress`, or `implemented` for the last plan. It becomes true when the PR
  merges. Push it, and watch CI on that head.
- CI: each tick reads `gh pr checks`. A failure that is not the code's (runner, network) gets one
  rerun, then becomes an operational blocker, named in every report until a rerun passes. Any other failure goes to an iteration worker, which fixes its
  root cause.

### Stacked PRs

A spec with several plans is delivered plan after plan without waiting for merges: plan `n + 1`
branches from plan `n`'s branch, and its PR targets that branch.

- When the owner changes a plan, the plans above it are rebased on it, bottom up.
- When a plan merges, GitHub deletes its branch and retargets the next PR to main. Its squash
  commit replaces the original commits, so the restack worker runs
  `git rebase --onto origin/main <old head of the merged branch> <branch>`, then the plans above
  in turn. The ledger keeps each branch's head for that.
- A restack that needed conflict resolution gets that resolution reviewed before the tick
  force-pushes it, with `--force-with-lease`.

### Spec blockers

- The tick flags it on GitHub, so ck-spec finds it: a comment on the tracking issue, or on the
  input issue for a fix, that starts with `**Blocked: <CODE>-Pn**` (or `**Blocked: fix**`) and
  gives the worker's gap and options. It records the comment link in the ledger.
- Its report tells the user to run `ck-spec <CODE>` to resolve it. It asks nothing.
- ck-spec resolves it with a spec change merged to main that replies to the flag comment. The
  tick sees the change in step 2, closes the blocker, and dispatches the plan's next worker, which
  restacks on main when the plan's PR is already open.

## Plan worker

1. **Read in full**: `docs/specs/README.md` and AGENTS.md; the spec and the specs it builds on;
   the tracking issue; the PRs of the earlier plans.
2. **Check the spec and the order**, from `origin/main`, never from a local branch:
   - The spec's `status` must be `approved` or `in-progress`. A `draft` spec belongs to ck-spec:
     report it blocked.
   - The plan must exist and be `todo`. Every earlier plan must be `done`, or have its PR open
     below this one in the stack.
3. **Prototype first**, when the plan has one. It is throwaway and never committed.
   - Report each criterion as pass or fail, with its evidence.
   - When a criterion fails, or a fallback must be chosen, stop blocked: the plan needs ck-spec.
4. **Implement the plan's slice only.**
   - Keep the temporary restrictions the plan states, and leave later plans out entirely: no UI
     stubs, no dead settings.
   - Put new logic in pure, testable modules when the project has that pattern.
5. **The spec stays true.**
   - When the code has to differ from the spec, edit the spec in the same branch, and report it
     for the PR text.
   - When the spec is ambiguous or wrong in a way that is a product choice, stop blocked. A gap
     with one sensible reading is an implementation call: take it, write it into the spec in the
     branch, and report it.
6. **Tests**: every user-visible behavior the plan adds gets an automated test. Run every check
   AGENTS.md requires, and look at screenshots of any visible change.
7. **Commit and review**, as [Adversarial review](#adversarial-review) says, then report.

## Fix worker

For a defect, or a small behavior change the user asked for, on branch `fix/<slug>`.

1. **Reproduce first**, with a failing test or a run in the real environment. Keep the evidence.
2. **Find the rules.** Start from the spec or plan the issue names, if any, then grep
   `docs/specs/*.md` for the behavior. Name the spec code and section that cover it. A plan the
   issue names that is already merged points at the rules to amend, not at new plan work.
3. **Classify**:
   - The code breaks the spec: fix the code, and add a regression test.
   - The spec is silent or wrong: the fix is also a spec change. When the right behavior is a
     product choice, stop blocked. Otherwise update every spec whose rules change, and add
     the version the fix will ship in to each shipped spec's `amended` list.
   - A small behavior change the user asked for: same as a spec change.
   - A defect outside the work at hand: follow AGENTS.md, which makes it an issue with its
     reproduction, and stop there.
4. **Checks, commit, and review**, as for a plan, then report.
