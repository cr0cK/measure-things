---
name: ck-exec
description: Implement the approved plans of a spec (<CODE>-P1, -P2, …) as stacked PRs, one per plan, or fix a defect or an issue, following the repo's spec process in docs/specs/README.md. Runs as a tick every 10 minutes that tracks each plan's state in the spec, delegates the work to background workers in their own worktrees, takes in new information, pushes only what an adversarial review has read, babysits CI, and never merges. Never questions the user; spec gaps go back to ck-spec. Trigger on "implement SET", "implement SET-P1", "exec SET-P2", "start the next plan", "work #42", "fix <bug>", "this behaves wrong". NOT for designing a spec, which is ck-spec, or approving one, which is ck-approve.
---

# ck-exec: implement a spec's plans, a fix, or an issue

`docs/specs/README.md` is the process, with the spec and plan states. Read it first. Where it and
this skill disagree, it wins. AGENTS.md gives the project's checks, commands, and pitfalls.

**ck-exec never questions the user.** It takes every implementation call itself and reports it.
A gap only the spec can close (an ambiguity, a contradiction, a failed prototype, a product
choice) is flagged for ck-spec, as [Spec gaps](#spec-gaps) says.

## Start

An argument that starts with `tick` is a tick: follow [The tick](#the-tick). Any other argument
starts the work:

1. **Resolve the target**:
   - **Spec**: a spec code, such as `SET`, or a plan, such as `SET-P2`, which starts there.
     Without an argument, take the spec whose status is `approved` or `in-progress`; when several
     qualify, list them and stop.
   - **Issue**: `#<n>` or an issue link. Read it with its comments, then route it:
     - the tracking issue of a spec (titled `<CODE>: …`): that spec;
     - an issue that names a plan not yet merged (`<CODE>-Pn`): information for that plan. Add it
       to the spec's ledger when its loop runs, or start the spec's loop with it. The plan's PR
       then closes the issue;
     - any other issue: a fix. A spec code or plan it names tells the fix worker where the rules
       are.
   - **Fix**: a defect or a small behavior change described in the argument. Open an issue that
     states it, so the fix has a home for its flags and its PR closes it.

   A change that needs design or more than one PR goes through ck-spec first: say so and stop.
2. **The gate**, for a spec, read from `origin/main` after `git fetch`: the spec is `approved` or
   `in-progress`, and the first plan not merged is `approved`, or already in flight on its
   branch. Otherwise start nothing, and name the next step: `ck-approve <plan>` for a `todo` plan,
   `ck-spec <CODE>` for a `draft` spec or an open `**Blocked:` flag.
3. Invoke the `loop` skill with `10m /ck-exec tick <target>`, and do nothing else in this run.

## Where the state lives

- **The spec's front matter** holds each plan's state: `todo` and `approved` on main, then
  `executing`, `blocked`, `"pr-opened #<PR>"`, and `"done #<PR>"` on the plan's branch. A tick
  reads a plan's state from `origin/<branch>` when the branch exists, from `origin/main`
  otherwise. Every state change is a commit that changes nothing else; the tick commits and
  pushes it at once.
- **GitHub** holds the PRs, their CI, review comments, and the `**Blocked:` and `**Resolved:`
  flags.
- **The ledger**, `$(git rev-parse --path-format=absolute --git-common-dir)/ck-exec/<target>.md`,
  outside the tracked tree, holds what neither can say: the running workers with their names and
  tasks, the last reviewed SHA per branch, the base SHA each branch sits on, information not yet
  handed to a worker, and operational blockers.

The tick can rebuild the ledger from the other two: after an interruption, a plan whose branch
says `executing` or `"pr-opened #<PR>"` with no running worker gets a worker that resumes from its
worktree, or from `origin/<branch>` when the worktree is gone. Work committed in a worktree but
never reviewed is reviewed before anything else.

## The tick

Idempotent: a tick that finds nothing to do changes nothing and reports one line.

1. **Read**: the ledger, `git fetch`, the states on main and on each plan's branch, the tracking
   issue and its comments, the spec's PRs, open and merged, with their CI, review comments, and
   base, the worktrees, and the workers' reports received since the last tick.
2. **Take in new information**: messages from the user, owner review comments, new comments on
   the tracking issue, issues that name the spec or one of its plans (`gh issue list --search
   <CODE>`), and spec changes merged to main. Note each in the ledger against the plan it
   concerns. Send it to the plan's running worker with SendMessage, or keep it for the plan's next
   worker. An issue about a merged plan is a fix: name it in the report for its own ck-exec run.
3. **Act** on each plan in delivery order, on the first row that matches. Rows 3 to 10 apply only
   to a plan that has a branch; information for a plan without one waits in the ledger for its
   plan worker. A fix is one unit with no plan state: rows 11 and 12 do not gate it, and the
   first tick creates its branch and dispatches the [fix worker](#fix-worker).

   | # | State | Action |
   |---|---|---|
   | 1 | PR merged | Remove its worktree and local branch. The plan above restacks (row 5) |
   | 1b | PR closed without a merge | The owner turned it down: stop this plan and the plans above, and report it. Running ck-exec on the plan again starts it over: the tick deletes the old branch and worktree, and row 11 builds a new PR |
   | 2 | A worker is running on it | Nothing, unless step 2 has information for it |
   | 3 | `blocked` | With a `**Resolved:` reply on its flag and the plan `approved` on main again: restack it on its base, which brings the spec change, set it back to `executing` or `"pr-opened #<PR>"`, and dispatch its worker. Otherwise nothing |
   | 4 | Worker done, and its work not yet pushed, in a PR, and in `"pr-opened #<PR>"` | [Push](#push-and-pr) the reviewed SHA, open the PR, and commit the state, skipping each step already done, so an interrupted tick finishes it |
   | 5 | Its base moved: the base plan merged, the base branch has commits past the ledger's base SHA, the PR conflicts, or, for the lowest open plan, main changed the spec past its base | Dispatch a [restack](#stacked-prs) worker |
   | 6 | Unhandled review comments, a CI failure, or information for it | Dispatch an iteration worker |
   | 7 | CI pending | Nothing |
   | 8 | CI green on `"pr-opened #<PR>"`, nothing left | Commit and push `"done #<PR>"` |
   | 9 | CI green on `"done #<PR>"` | Waits for the owner's merge |
   | 10 | In flight with no worker and no report (interrupted) | Dispatch a worker that resumes it |
   | 11 | No branch, `approved` on main, and either it is the first plan not merged, or the plan below has an open PR that is not `blocked` | Create its branch, commit and push `executing`, and dispatch the [plan worker](#plan-worker) |
   | 12 | `todo` on main | Nothing: the report names `ck-approve <plan>`. The plans above wait |

   At most one plan worker runs at a time, so plans are implemented in order. Iterations and
   restacks of open PRs run alongside it, at most one worker per branch.
4. **End**: when every plan of the spec, or the fix, is merged, remove the ledger and end the
   loop. Never merge, never queue an auto-merge, never use `--admin`: the merge is the owner's.
5. **Report**, in a few lines: what changed since the last tick, each plan's state, the flags
   waiting for ck-spec or ck-approve, and the PRs waiting for the owner.

## Workers

A worker is a background subagent (Agent tool), named `ck-<plan>-<task>`, such as
`ck-set-p2-impl`. Its brief is all it knows: give it the target, its worktree's absolute path, the
files to read, the information from the ledger, and what it must return.

- It works only in its worktree, and commits its work there.
- It never pushes, never opens or edits a PR, never changes the plan state, and never asks the
  user. It takes every implementation call itself and reports it. A gap only the spec can close
  ends its run blocked, with the gap stated: what the spec says, why it cannot be implemented as
  written, and the options.
- Before it reports done, it gets the [review](#adversarial-review) of its commits and arbitrates
  it.
- It returns: done or blocked, the gap when blocked, the reviewed SHA, the review verdict, the
  checks run with their results, the implementation calls it took, and the spec changes it made.

### Worktrees

- Every branch has its own worktree under the main checkout:
  `$(git rev-parse --path-format=absolute --git-common-dir)/../.claude/worktrees/<branch-slug>`,
  never a path relative to the current directory. When the branch already has a worktree
  (`git worktree list`), reuse it.
- The tick creates it: from `origin/main` for the first plan not merged or a fix, from
  `origin/<branch of the plan below>` for a stacked plan, never from a local branch, which can
  hold commits not yet reviewed. It records the base SHA in the ledger.

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
- The tick pushes only the SHA the review covered, after checking that the branch head still
  matches it. Two kinds of commit need no review: state commits, and a restack whose
  `git range-diff` shows every commit unchanged.

### Push and PR

The tick pushes and opens PRs; workers never do.

- The PR title follows the project's commit convention. A stacked plan's PR has the branch of the
  plan below as its base.
- A plan PR's body starts with `<CODE>-Pn of #<issue>`, then `Stacked on #<PR>` when it is
  stacked. It uses `Refs #<issue>`, and `Closes` only for the spec's last plan and the issues
  routed to this plan. It lists the temporary restrictions, the implementation calls, the spec
  changes, the prototype verdict, and, in a `<details>` block, the review verdict with the
  reviewer that ran.
- A fix PR names the spec rules it follows or changes, and closes its issue.
- Once a plan PR's number is known, the tick commits `"pr-opened #<PR>"`, with the spec's status
  set to `in-progress`, or `implemented` for the last plan, and pushes it.
- CI: each tick reads `gh pr checks` on the head. A failure that is not the code's (runner,
  network) gets one rerun, then becomes an operational blocker, named in every report until a
  rerun passes. Any other failure goes to an iteration worker, which fixes its root cause.
- A new commit on a `"done #<PR>"` branch sets it back to `"pr-opened #<PR>"`.

### Stacked PRs

Plans are delivered one after another without waiting for merges: each plan's branch starts from
the branch of the plan below, and its PR targets it.

- When a plan's branch moves (an iteration, a restack), the plans above are restacked on it,
  bottom up: `git rebase --onto origin/<base branch> <ledger's base SHA> <branch>`. The ledger
  then records the new base SHA.
- When a plan merges, GitHub deletes its branch and retargets the next PR to main. Its squash
  commit replaces the original commits, so the next plan is restacked with
  `git rebase --onto origin/main <ledger's base SHA> <branch>`, which drops them.
- The front matter conflicts on almost every restack, since each branch changes its own plan's
  line. Resolve it mechanically: each plan's line comes from its own branch, or from main once
  merged. That resolution needs no review; any other conflict resolution does.
- The tick force-pushes a restack with `--force-with-lease`.

### Spec gaps

- A worker blocked on a gap stops its plan. It moves the commits it has not had reviewed to a
  local branch `wip/<branch>`, and resets its branch to the last pushed head; the plan's next
  worker starts from that work. The tick then commits and pushes `blocked` on the plan's branch, and posts the gap on the tracking issue, starting with `**Blocked: <CODE>-Pn**`. The
  plans above it wait; the open PRs below go on.
- The report tells the user to run `ck-spec <CODE>`. ck-spec writes the decision into the spec and
  sets the plan back to `todo`; ck-approve stamps it `approved` again and replies
  `**Resolved: <CODE>-Pn**` to the flag. The spec change is on main, so row 5 first restacks the
  stack from its lowest open plan, bottom up, and row 3 then resumes the blocked plan on a base
  that carries it.
- A blocked fix posts its flag on its issue and ends its loop. Once the spec answers it, run
  ck-exec on the issue again.

## Plan worker

1. **Read in full**: `docs/specs/README.md` and AGENTS.md; the spec and the specs it builds on;
   the tracking issue; the PRs of the earlier plans.
2. **Prototype first**, when the plan has one. It is throwaway and never committed.
   - Report each criterion as pass or fail, with its evidence.
   - A failed criterion, or a fallback to choose, is a gap: stop blocked.
3. **Implement the plan's slice only.**
   - Keep the temporary restrictions the plan states, and leave later plans out entirely: no UI
     stubs, no dead settings.
   - Put new logic in pure, testable modules when the project has that pattern.
4. **The spec stays true.**
   - When the code has to differ from the spec, edit the spec in the same branch, and report it
     for the PR text.
   - A point with one sensible reading is an implementation call: take it, and report it. A
     product choice is a gap: stop blocked.
5. **Tests**: every user-visible behavior the plan adds gets an automated test. Run every check
   AGENTS.md requires, and look at screenshots of any visible change.
6. **Commit and review**, as [Adversarial review](#adversarial-review) says, then report.

An iteration worker handles its review comments, CI failure, or information the same way, from
step 3, on the branch as it stands.

## Fix worker

For a defect, or a small behavior change the user asked for, on branch `fix/<slug>`.

1. **Reproduce first**, with a failing test or a run in the real environment. Keep the evidence.
2. **Find the rules.** Start from the spec or plan the issue names, if any, then grep
   `docs/specs/*.md` for the behavior. Name the spec code and section that cover it. A plan the
   issue names that is already merged points at the rules to amend, not at new plan work.
3. **Classify**:
   - The code breaks the spec: fix the code, and add a regression test.
   - The spec is silent or wrong: the fix is also a spec change. When the right behavior is a
     product choice, stop blocked. Otherwise update every spec whose rules change, and add the
     version the fix will ship in to each shipped spec's `amended` list.
   - A small behavior change the user asked for: same as a spec change.
   - A defect outside the work at hand: follow AGENTS.md, which makes it an issue with its
     reproduction, and stop there.
4. **Checks, commit, and review**, as for a plan, then report.
