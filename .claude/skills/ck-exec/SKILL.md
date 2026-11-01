---
name: ck-exec
description: Implement one plan of a spec (<CODE>-Pn), or fix a defect against a spec, following the repo's spec process in docs/specs/README.md. Reads the spec and the plan, runs the plan's prototype first, implements only the plan's slice with tests, writes any deviation into the spec in the same PR, opens a PR named after the plan, and runs a Codex review. Trigger on "implement SET-P1", "exec SET-P2", "start the next plan", "fix <bug>", "this behaves wrong". NOT for designing or changing a spec on its own, which is ck-spec.
---

# ck-exec: implement a plan or fix a defect

`docs/specs/README.md` is the process. Read it first. Where it and this skill disagree, it wins.
AGENTS.md gives the project's checks, commands, and pitfalls.

## Mode

- **Plan**: the argument is a plan name, such as `SET-P1`. Without one, take the first plan whose
  state is `todo` in the spec's front matter. When that plan already has an open PR, resume it on its branch
  instead of starting a new one.
- **Fix**: the argument describes a defect, a small behavior change, or an issue. A change that
  needs design or more than one PR goes through ck-spec first, which adds plans for it.

## Plan mode

1. **Read in full**:
   - `docs/specs/README.md` and AGENTS.md;
   - the spec, `docs/specs/<CODE>.md`, and the specs it builds on;
   - the tracking issue, titled `<CODE>: …`;
   - the PRs of the earlier plans.
2. **Check the spec and the order.**
   - The spec's `status` on the main branch must be `approved` or `in-progress`. A `draft` spec
     belongs to ck-spec: stop.
   - Every earlier plan must be `done` in the spec's state. If one isn't, stop and say which.
3. **Worktree**: branch `feat/<code>-p<n>-<slug>`, lowercase, from the main branch.
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
8. **PR**:
   - The title follows the project's commit convention.
   - The body starts with `<CODE>-Pn of #<issue>`.
   - It uses `Refs #<issue>`, and `Closes` only for the spec's last plan.
   - It lists the temporary restrictions, the spec changes, and the prototype verdict.
   - Once the PR number is known, commit the state change to the spec: this plan becomes
     `"done #<PR>"`, quoted because `#` starts a YAML comment, and the status becomes
     `in-progress`, or `implemented` for the last plan. It becomes true when the PR merges.
9. **Review**: right after the PR opens, run a Codex review of its diff, read-only, with
   `< /dev/null`. Fix the findings that hold in the same PR, and say in one line which ones you
   discarded and why.
10. **Do not merge**: the spec's owner reviews each plan's PR.

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
4. **Branch** `fix/<slug>` in a worktree. Run the checks, open the PR, and get the Codex review,
   as in plan mode.
5. Merge only when the user asks.

## Report

The PR, the plan or the spec rules it covers, the checks run with their results, the review
verdict, and the decisions left to the user. Keep it short.
