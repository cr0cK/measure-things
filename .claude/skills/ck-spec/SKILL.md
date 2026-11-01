---
name: ck-spec
description: Create or change a product spec and its delivery plans, following the repo's spec process in docs/specs/README.md. Picks a spec code, writes docs/specs/<CODE>.md and its mockups, iterates by editing the spec in its PR, runs an adversarial review, and writes the tracking issue with plans <CODE>-P1, <CODE>-P2, and so on. Trigger on "new spec", "spec this feature", "design X", "update the spec", "amend SET", "plan the implementation of X". NOT for implementing a plan or fixing code, which is ck-exec.
---

# ck-spec: design a spec and its plans

`docs/specs/README.md` is the process. Read it first. Where it and this skill disagree, it wins.
This skill only adds the order of operations.

## 0. Read

- `docs/specs/README.md`, AGENTS.md, and CONTRIBUTING.md.
- The state of every spec: `head -20 docs/specs/*.md` shows their front matter (code, status,
  version, plans). Read every spec the new work builds on, in full.
- Open spec PRs: list open PRs with their changed files (`gh pr list --json number,title,files`)
  and keep those that touch `docs/specs/`. Also list the open issues.

## 1. Pick the mode

| Mode | When | Output |
|---|---|---|
| **New** | A new body of work | A new `docs/specs/<CODE>.md`, a spec PR, and a tracking issue |
| **In design** | The spec's PR is still open | New commits on that PR |
| **Amend** | A shipped spec's text needs correcting, without a code change | A spec PR. A small change with code, or a defect, goes to ck-exec's fix mode. A change that needs plans is a **New** spec that builds on the shipped one |
| **Replace** | A new spec takes over part of an older one | A new spec. The older one keeps its rules until the new spec's last plan PR removes them and sets `replaced-by` |
| **Ship** | The release containing a spec's last plan is out | A small `docs` PR that sets the spec `shipped` |

## 2. New spec: the code

- Propose a code of three uppercase letters naming the topic. Add a digit only when the code is
  already taken. Check `docs/specs/` and the open spec PRs.
- Confirm the code with the user through AskUserQuestion, with two or three options. A code is
  never renamed afterwards.
- Create the branch `docs/<code>-spec`, lowercase, in its worktree,
  `.claude/worktrees/docs-<code>-spec`, from `origin/main`. Never work in the main checkout.
- Start the file with its state: `code`, `status: draft`, and `version` (the next minor version
  unless the user says otherwise), plus `builds-on` when it extends a spec.

## 3. The design loop

- Discuss with the user, then **write every decision into the spec file**, in the PR. A decision
  that lives only in the conversation, an issue, or a review comment does not count.
- Follow the rules the process gives for the title, the first paragraph, and the rules
  themselves. A rule is a short bullet with one behavior. The spec is complete and
  self-contained: cover edge cases, the lifecycle, failures, and what is out of scope.
- Mockups help the user decide. Build them where the user can see them, such as an HTML page
  published as a private artifact. Commit the final ones as `docs/specs/images/<CODE>-<name>.png`,
  with the UI text in the product's language.
- Ask one question at a time with AskUserQuestion when a choice is the user's. For the rest, make
  the call, write it down, and say so.

## 4. Plans and the tracking issue

- Write the plans in one issue titled `<CODE>: <summary>`.
- The issue links the spec. Before the merge, link it on the PR branch. After the merge, link it
  on the main branch, images included.
- For each plan `<CODE>-Pn`, in delivery order, the issue gives:
  - **Scope**: the parts of the spec it implements.
  - **Temporary restrictions**: what the plan leaves out or simplifies, and the later plan that
    delivers it.
  - **Acceptance**: tests, checks, and measurements, all verifiable.
  - **Prototype**: for a risky plan, a throwaway prototype with pass/fail criteria, run first.
- A plan never depends on a later one. Each plan is one PR.
- Record the plans in the spec's state, in order, each `todo`, along with `tracking`.
- Add the technical notes an implementer with no context needs: the modules to touch, known
  pitfalls, and the APIs to check first.

## 5. Adversarial review

Before asking the owner to approve, get a review by a reviewer who did not write the spec. Codex
runs read-only, with `< /dev/null`. When Codex is unavailable, fall back to another model, then to
a fresh-context subagent.

The brief gives the spec, the issue body, the specs it builds on, and AGENTS.md. It asks for, at
most 25 findings, each labeled **high**, **medium**, or **low**:

1. Contradictions within the spec, or between the spec and the plans.
2. Ambiguities that force an implementer to guess.
3. Behavior that is infeasible or risky on the platform, with the APIs cited.
4. Plan gaps: ordering, dependencies on later plans, acceptance that can't be verified.
5. Behavior of the spec it builds on that was dropped or changed without being stated.

Arbitrate each finding against the code and the platform. Fix it in the spec or the plan, or
reject it with a reason. Summarize the verdict in the PR, in a `<details>` block, naming the
reviewer that ran. Then wait for CI to be green before asking the owner to approve.

## 6. Merge

- The spec merges when its owner approves it, and not before. Its last commit before the merge
  sets `status: approved`.
- After the merge, update the issue's links to the main branch, and remove the worktree and the
  branch.

## 7. Amend or replace a shipped spec

- **Amend**: edit the rules in place, and add the coming version to `amended` in its state.
- **Replace**: the new spec says, in its first paragraph, which parts it replaces. The older spec
  keeps them for now. The new spec's last plan PR removes them and sets `replaced-by`.
- **Ship**: once the release that contains the last plan is published, set `status: shipped` in a
  small `docs` PR. Check that the released tag, `vX.Y.Z`, belongs to the spec's `version` series,
  `vX.Y`.

## Report

The spec PR, the tracking issue, the review verdict (counts and the reviewer that actually ran),
and what is left for the owner to decide. After the merge, the next step is ck-exec on
`<CODE>-P1`.
