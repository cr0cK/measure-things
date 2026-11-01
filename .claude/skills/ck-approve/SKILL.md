---
name: ck-approve
description: Gate a spec, or one of its plans (<CODE> or <CODE>-Pn), before implementation, following the repo's spec process in docs/specs/README.md. Reads the spec, the specs it builds on, the plans, and the code they touch, in full, looking for every gap an implementer would have to guess at, and questions the user on each one, writing the answers into the spec. With no gap left, stamps the spec or plan `approved`, the state ck-exec requires before it starts. Also resolves the gaps ck-exec flags, and adopts specs and plan PRs from before the process. Trigger on "approve SET", "approve SET-P2", "is SET ready", "gate SET-P1". NOT for designing or changing the spec, which is ck-spec, or implementing it, which is ck-exec.
---

# ck-approve: the gate before implementation

`docs/specs/README.md` is the process. Read it first. Where it and this skill disagree, it wins.

ck-exec never questions the user, so every question a plan raises is answered here, before it
starts. ck-approve is the last place, with ck-spec, where the user is questioned. Running it is
the owner's approval: it merges what it stamps, and the plans it stamps then merge on their own.

**Work from before the process**, as `docs/specs/README.md` lists it under Adopting existing
work, is not refused. A spec with no front matter or no plans: say so, propose to adopt it with
AskUserQuestion, and on yes run ck-spec's Adopt mode first. A plan with a PR opened before the
process is read like any other plan; its PR is adopted by ck-exec once the plan is stamped.

## 1. Target

- `**Blocked:` flags with no `**Resolved:` reply, from ck-exec or an earlier run, are gaps too:
  read them first, and resolve them in this run.

- `<CODE>`: the spec and every plan not yet past `approved`.
- `<CODE>-Pn`: that plan only. Its spec must already be `approved` or `in-progress`, or this
  stamps the spec too.
- Where the spec is read from:
  - an open ck-spec PR for the target, a design or an unblock PR: that PR's branch;
  - otherwise `origin/main`, after `git fetch`.

## 2. The gap read

A fresh-context subagent reads, in full: the spec, the specs it builds on, the tracking issue and
its comments, AGENTS.md, and the code each targeted plan touches. It writes no code. For each
target it lists every **gap**, a point where an implementer would have to guess or choose:

1. Behavior the spec leaves unstated: an edge case, a failure, a lifecycle step.
2. Rules that contradict each other, the plan, or a spec they build on.
3. Behavior that is infeasible or risky on the platform, with the APIs cited.
4. A plan that depends on a later one, a scope that does not match the spec, or acceptance that
   cannot be verified.
5. A prototype with no clear pass or fail.

A point with one sensible reading is not a gap: the implementer takes it. Each gap gives what the
spec says, why it blocks, and the options. Arbitrate the list yourself against the code: drop
what does not hold.

## 3. Grill

Take the gaps one at a time with AskUserQuestion, each with what the spec says, why it blocks, and
the options, the recommended one first. Write each answer into the spec, as a rule, on the branch
the stamp goes on. Then run the gap read again on what changed, until it finds nothing.

- An answer that reshapes the plans (their scope, order, or count) is a design change: stop, and
  hand over to `ck-spec <CODE>` with the answers so far.
- A gap the user chooses to leave open stays open.

## 4. Verdict

- **No gap left**: stamp it. In the spec's front matter, each targeted plan becomes `approved`, and a
  `draft` spec becomes `approved`. Commit with `docs: approve <target>`:
  - on that open ck-spec PR's branch, which then merges;
  - otherwise on a branch `docs/approve-<target>` from `origin/main`, in its worktree under the
    main checkout, in a PR titled the same.

  When the user's answers changed rules, have the diff reviewed adversarially, as ck-spec's
  step 5 does, before the push. Wait for green CI, then squash-merge. Reply to every open `**Blocked: <plan>**` comment of the
  stamped plans, and to every open `**Blocked: <CODE>**` comment when the read of the whole spec
  found no gap, with `**Resolved: <plan or CODE>** by #<PR>`. Remove the worktree and the branch.
- **Gaps left open**: a plan with an open gap stays `todo`, and an open gap in the spec as a
  whole stamps nothing at all. Post each one as a comment on the open ck-spec PR, or on the
  tracking issue when there is none, starting with `**Blocked: <CODE>-Pn**`, or
  `**Blocked: <CODE>**` for the whole spec. The plans without one are stamped as above.

## Report

The target, the verdict per plan, the stamp PR, and the gaps with their links. Then the next step:
`ck-exec <CODE>` when the first plan to implement is `approved`; `ck-approve` again, or
`ck-spec <CODE>` for a design change, otherwise.
