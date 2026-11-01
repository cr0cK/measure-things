# Specs and plans

How a feature goes from design to merged code. This process is project-agnostic: everything
specific to this repository is in [This project](#this-project) at the end.

## Specs

- A **spec** is the product contract for one coherent body of work. It describes what the user
  sees and what the system guarantees, not how the code is organized.
- Each spec has an **owner**, who approves it and reviews its plans' PRs: the project maintainer,
  unless the spec names someone else.
- Each spec has a **code**: three uppercase letters naming its topic, plus a digit only when the
  code is already taken, such as `SET` or `SET2`. A code is never reused or renamed.
- The spec lives in `docs/specs/<CODE>.md`. Its images live in `docs/specs/images/`, named
  `<CODE>-<name>.png`.
- The title gives the code and the version the spec ships in:
  `# <Project> — <CODE> specification (<version>)`. The first paragraph says what the spec covers,
  which spec it builds on, and the names of its plans.
- Internally, refer to a spec by its code: in issues, PRs, commits, code comments, and
  conversations. Version numbers are for releases only.
- A spec is complete and self-contained. Someone with no other context must be able to implement
  it from the spec and its plan alone. It states the whole behavior it covers, including what it
  keeps from the spec it builds on.
- Write rules as short bullets, one behavior each. Cover the edge cases, the lifecycle, failures,
  and what is out of scope. Leave nothing for the implementer to invent.
- Images are mockups. Where an image and the text disagree, the text wins.

## Designing

- Design a spec in a dedicated PR that adds it, with no code. Iterate by editing the spec in that
  PR. Discussion can happen anywhere, but decisions only count once they are written in the spec.
  They don't count in an issue thread or in a review comment.
- Before the spec merges, a reviewer who did not write it reviews the spec and its plan
  adversarially. The review looks for:
  - contradictions;
  - ambiguities that force guessing;
  - behavior that is infeasible on the target platform;
  - plans that depend on later plans, or have no way to verify them.

  Fix the findings in the spec and the plan, or reject them with a reason.
- The spec merges when its owner approves it.

## Plans

- The implementation splits into **plans** named `<CODE>-P1`, `<CODE>-P2`, and so on, delivered
  in order. **One plan is one PR.**
- The plans live in one tracking issue, titled with the spec's code, which links the spec. For
  each plan, the issue gives:
  - its scope, as the parts of the spec it implements;
  - any temporary restriction: a behavior of the spec that the plan leaves out or simplifies, and
    the later plan that delivers it. The spec always describes the final behavior;
  - its acceptance: tests, checks, and measurements;
  - for a risky plan, a throwaway prototype with pass/fail criteria, which runs first.
- Apart from those stated restrictions, the spec wins over the plan. When they disagree, fix the
  plan.

## Implementing

- Each plan gets its own branch and PR. The PR text starts with the plan's name, such as
  `SET-P1`.
- A PR implements its plan's slice and nothing visible beyond it. It adds no stubs in the UI for
  later plans. Its text states the temporary restrictions it carries.
- Plan PRs reference the tracking issue without closing it. Only the last plan's PR closes it.
- A deviation from the spec is a spec change in the same PR, stated in the PR text.
- Every user-visible behavior the PR adds gets an automated test.
- The spec's owner reviews each plan's PR before it merges.
- A spec ships with the release that contains its last plan. No release is published while a spec
  is partly merged, so a spec ships in one version.

## Changing a shipped spec

- A change to shipped behavior updates every spec whose rules it changes, in the same PR. The
  spec keeps its title, and a line at its end records each version that amended it.
- A new spec that replaces part of an older one says which parts in its first paragraph. The
  older spec gets a line at the top pointing to it, and its replaced rules are removed.

## Review labels

Review findings are labeled **high**, **medium**, or **low**, never P1, P2, or P3, which are plan
names.

## This project

- Specs: `OVL` (v0.1), `PIX` (v0.2), and `SET` (v0.3, planned). Each one ships in one minor
  version.
- Tracking issues and PRs are on GitHub. PR titles follow Conventional Commits: a spec PR is
  `docs:`, a plan PR is usually `feat:`.
- release-please opens the release PR. Merge it only once every plan of the spec in progress is
  merged.
- The `ck-spec` skill runs the design and planning steps, and `ck-exec` runs a plan or a fix
  (`.claude/skills/`).
- A plan PR also follows the checks in AGENTS.md: lint, unit tests, the end-to-end test in a
  headless GNOME Shell, and screenshots for any visible change.
