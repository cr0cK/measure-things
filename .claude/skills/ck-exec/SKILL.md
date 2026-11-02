---
name: ck-exec
description: Implement the approved plans of a spec (<CODE>-P1, -P2, …) as stacked PRs, one per plan, or fix a defect or an issue, following the repo's spec delivery process in docs/specs/README.md. Runs as a tick every 10 minutes that tracks each plan's state in the spec, delegates the work to background workers in their own worktrees, takes in new information, pushes only what an adversarial review has read, babysits CI, and squash-merges each PR in order once it is green. Never questions the user: it decides spec gaps with a reviewer and records them in the spec's outbox, and stops only on a fatal blocker. Trigger on "implement SET", "implement SET-P1", "exec SET-P2", "start the next plan", "work #42", "fix <bug>", "this behaves wrong". NOT for designing a spec, which is ck-spec, or approving one, which is ck-approve.
---

# ck-exec: implement a spec's plans, a fix, or an issue

`docs/specs/README.md` is the spec delivery process, with the spec and plan states. Read it
first. Where it and this skill disagree, it wins. AGENTS.md gives the project's checks,
commands, and pitfalls.

**ck-exec never questions the user, and it does not stop.** The user was questioned while the
spec was designed and approved, so an `approved` plan has no blocker left. ck-exec takes every
implementation call itself. A gap found anyway (an ambiguity, a contradiction, a product choice)
is decided with a reviewer and recorded in the spec's outbox for the owner to arbitrate, as
[Gaps and the outbox](#gaps-and-the-outbox) says. Only a [fatal blocker](#fatal-blockers) stops a
plan, and it is the worst case.

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
   branch. Otherwise start nothing, and name the next step: `ck-approve <plan>` for a `todo` plan
   or an open `**Blocked:` flag, `ck-spec <CODE>` for a `draft` spec.

   Work from before the process is not refused. A spec with no front matter or no plans: say so,
   and propose its adoption with `ck-spec <CODE>`. A plan PR opened before the process, once its
   plan is `approved`, is adopted as [Adopted PRs](#adopted-prs) says.
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
   plan worker. A fix is one unit outside any spec's plans: its states, `executing` to
   `"done #<PR>"`, live in the ledger instead of a front matter, rows 11 and 12 do not gate it,
   and the first tick creates its branch and dispatches the [fix worker](#fix-worker).

   | # | State | Action |
   |---|---|---|
   | 1 | PR merged | Remove its worktree and local branch. The plan above restacks (row 5) |
   | 1b | PR closed without a merge | The owner turned it down: stop this plan and the plans above, and report it. Running ck-exec on the plan again starts it over: the tick deletes the old branch and worktree, and row 11 builds a new PR |
   | 2 | A worker is running on it | Nothing, unless step 2 has information for it |
   | 2b | An open PR whose head no review in the ledger covers: from before the process, or a lost ledger | With the plan `approved` on main, [adopt](#adopted-prs) it. Otherwise nothing: the report names `ck-approve <plan>` |
   | 3 | `blocked` | With a `**Resolved:` reply on its flag, the plan `approved` on main again, and the plans below restacked on main with no worker running on them: restack it on its base, which brings the spec change, set it back to `executing` or `"pr-opened #<PR>"`, and dispatch its worker. Otherwise nothing |
   | 4 | A worker report not yet published, with any of these missing: the reviewed SHA on the remote, the PR, a `"pr-opened #<PR>"` or `"done #<PR>"` state | [Push](#push-and-pr) the reviewed SHA, open the PR, and commit the state, skipping each step already done, so an interrupted tick finishes it. The ledger then marks the report published |
   | 5 | Its base moved: the base plan merged, the base branch has commits past the ledger's base SHA, the PR conflicts, or, for the lowest open plan, main changed the spec past its base | Dispatch a [restack](#stacked-prs) worker |
   | 6 | Unhandled review comments, a CI failure, or information for it | Dispatch an iteration worker |
   | 7 | CI pending | Nothing |
   | 8 | CI green on `"pr-opened #<PR>"`, nothing left | Commit and push `"done #<PR>"` |
   | 9 | CI green on `"done #<PR>"` | [Merge](#merge) it when every merge condition holds; otherwise nothing, and the report names the condition |
   | 10 | In flight with no worker and no report (interrupted) | Dispatch a worker that resumes it |
   | 11 | No branch, `approved` on main, and either it is the first plan not merged, or the plan below has an open PR that is not `blocked` | Create its branch, commit and push `executing`, and dispatch the [plan worker](#plan-worker) |
   | 12 | `todo` on main | Nothing: the report names `ck-approve <plan>`. The plans above wait |

   At most one plan worker runs at a time, so plans are implemented in order. Iterations and
   restacks of open PRs run alongside it, at most one worker per branch.
4. **End**: when every plan of the spec, or the fix, is merged, remove the ledger and end the
   loop. The last report names `ck-approve <CODE>`, which arbitrates the outbox and sets the spec
   `implemented`. The release PR is not ck-exec's.
5. **Report**, in a few lines: what changed since the last tick, each plan's state, the PRs
   merged, and the flags waiting for ck-spec or ck-approve.

## Workers

A worker is a background subagent (Agent tool), named `ck-<plan>-<task>`, such as
`ck-set-p2-impl`. Its brief is all it knows: give it the target, its worktree's absolute path, the
files to read, the information from the ledger, and what it must return.

- It works only in its worktree, and commits its work there.
- It never pushes, never opens or edits a PR, never changes the plan state, and never asks the
  user. It takes every implementation call itself and reports it. A gap the spec leaves open is
  decided and recorded in the [outbox](#gaps-and-the-outbox); only a
  [fatal blocker](#fatal-blockers) ends its run blocked.
- Before it reports done, it gets the [review](#adversarial-review) of its commits and arbitrates
  it.
- It returns: done or blocked, the blocker when blocked, the reviewed SHA, the review verdict,
  the checks run with their results, the implementation calls it took, the outbox entries it
  added, and the spec changes it made.

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
  routed to this plan. It lists the temporary restrictions, the implementation calls, the outbox
  entries it adds, the spec changes, the prototype verdict, and, in a `<details>` block, the review verdict with the
  reviewer that ran.
- A fix PR names the spec rules it follows or changes, and closes its issue.
- Once a plan PR's number is known, the tick commits `"pr-opened #<PR>"`, with the spec's status
  set to `in-progress`, and pushes it. Only ck-approve sets `implemented`, once the outbox is
  empty.
- CI: each tick reads `gh pr checks` on the head. A failure that is not the code's (runner,
  network) gets one rerun, then becomes an operational blocker, named in every report until a
  rerun passes. Any other failure goes to an iteration worker, which fixes its root cause.
- A new commit on a `"done #<PR>"` branch sets it back to `"pr-opened #<PR>"`.

### Merge

The spec is the contract and ck-approve was the owner's approval, so ck-exec merges each PR as
soon as it is green, without waiting for the owner. The tick merges a PR only when all of these
hold:

- its state is `"done #<PR>"`, and every check on its head is green;
- for a plan PR, the plan is still `approved` on main. A spec change that set it back to `todo` holds it until
  ck-approve stamps it again, whatever its branch says;
- its base is main: the plan below is merged, and the PR is restacked on it;
- the head is the reviewed SHA, or that SHA followed by state commits only;
- no review requests changes, and no owner comment is left without a reply. A review that
  requests changes, or an unanswered comment, holds the merge until an iteration handles it.

It merges with `gh pr merge <PR> --squash --match-head-commit <head SHA>`, so a push that lands
in between makes it fail rather than merge unchecked code. It never uses `--admin`, never queues
an auto-merge, and never merges a PR outside its target, the release PR included.

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
  merged. The outbox is the base's, with the restacked branch's own changes applied on top: the
  entries it added, and the ones it removed, such as a fix closing its `"fix #<issue>"` entry. An
  entry the base removed stays removed. That resolution needs no review; any other conflict resolution
  does.
- The tick force-pushes a restack with `--force-with-lease`.

### Gaps and the outbox

An `approved` plan should have no gap left. When a worker finds one anyway, it decides, and the
decision goes to the spec's outbox for the owner to arbitrate later. ck-exec does not stop for it.

- **Decide**: the worker lists the options, picks the one that keeps closest to the spec and
  costs the later plans least, and has the reviewer challenge that choice before it builds on it,
  with the gap, the options, and its pick. It then implements the choice that survives.
- **Record**: in the spec, on its branch, it adds an outbox entry `<CODE>-Pn-O<k>`, or
  `<CODE>-F<issue>-O<k>` for a fix, the next number within it: `open` in the front matter's
  `outbox`, and detailed in the spec's `## Outbox` section, with the gap, the options, the
  decision, why, and the reviewer's verdict. The spec's rules stay as they are; the entry says
  where they fall short.
- **Report**: the PR text lists the outbox entries it adds. ck-approve arbitrates them with the
  owner, at any time; the spec cannot become `implemented` until the outbox is empty.
- While the PR is open, ck-approve arbitrates its entries with an owner comment on the PR. The
  tick takes it as information, and an iteration applies it on the branch: an accepted entry
  becomes rules and leaves the outbox; a rejected one becomes the owner's rule, the code follows
  it, and the entry leaves the outbox. Once the PR has merged, ck-approve arbitrates on main, and
  a rejection is a fix.

### Fatal blockers

The worst case, and the only one where ck-exec stops: every option breaks the spec or a later
plan, or a prototype fails with no fallback that keeps the spec's goal.

- The worker moves the commits it has not had reviewed to a local branch `wip/<branch>`, resets
  its branch to the last pushed head, and reports the blocker with what it tried. The plan's next
  worker starts from that work.
- The tick commits and pushes `blocked` on the plan's branch, and posts the blocker on the
  tracking issue, starting with `**Blocked: <CODE>-Pn**`. The plans above it wait; the open PRs
  below go on.
- The report tells the user to run `ck-approve <CODE>-Pn`. It asks the user, writes the answer
  into the spec, stamps the plan `approved` again, and replies `**Resolved: <CODE>-Pn**` to the
  flag, handing over to ck-spec first when the answer reshapes the plans. The spec change is on
  main, so row 5 first restacks the stack from its lowest open plan, bottom up, and row 3 then
  resumes the blocked plan on a base that carries it.
- A fix blocked this way posts its flag on its issue and ends its loop. Once the spec answers it,
  run ck-exec on the issue again.

### Adopted PRs

A plan PR opened before the process has no ledger entry and an old state, such as `"done #<PR>"`
written when it opened. Once its plan is `approved` on main, the tick adopts it:

- it reuses the PR and its branch, in a worktree, and records the branch's base;
- a worker has the whole diff against its base reviewed, as for a new PR, and handles the
  findings and any unanswered review comment;
- the tick rewrites the state to `"pr-opened #<PR>"`, restacks it on main, and the PR then
  follows the table like any other.

## Plan worker

1. **Read in full**: `docs/specs/README.md` and AGENTS.md; the spec and the specs it builds on;
   the tracking issue; the PRs of the earlier plans.
2. **Prototype first**, when the plan has one. It is throwaway and never committed.
   - Report each criterion as pass or fail, with its evidence.
   - A fallback to choose is a gap: decide it and record it in the outbox. A failed criterion with
     no fallback that keeps the spec's goal is a fatal blocker.
3. **Implement the plan's slice only.**
   - Keep the temporary restrictions the plan states, and leave later plans out entirely: no UI
     stubs, no dead settings.
   - Put new logic in pure, testable modules when the project has that pattern.
4. **The spec stays true.**
   - A point with one sensible reading is an implementation call: take it, and report it.
   - When the code has to differ from the spec, or the spec leaves a product choice open, that is
     a gap: decide it with the reviewer, and record it in the outbox. The worker never rewrites the
     rules itself; they change once the owner accepts the entry.
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
   - The spec is silent or wrong: decide the behavior with the reviewer, fix the code, and record
     the decision in that spec's outbox.
   - A small behavior change the user asked for: the user decided it, so the fix is a spec change.
     Update every spec whose rules change, and add the version the fix will ship in to each
     shipped spec's `amended` list.
   - An outbox entry the owner rejected (`"fix #<issue>"`): apply the rule the owner wrote, and
     remove the entry from the front matter and the `## Outbox` section.
   - A defect outside the work at hand: follow AGENTS.md, which makes it an issue with its
     reproduction, and stop there.
4. **Checks, commit, and review**, as for a plan, then report.
