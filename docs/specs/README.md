# Specs and plans

How a feature goes from design to merged code. This process is project-agnostic: everything
specific to this repository is in [This project](#this-project) at the end.

## Specs

- A **spec** is the product contract for one coherent body of work. It describes what the user
  sees and what the system guarantees, not how the code is organized.
- Each spec has an **owner**, who approves it and its plans, and can hold any plan's PR: the
  project maintainer, unless the spec names someone else.
- Each spec has a **code**: three uppercase letters naming its topic, plus a digit only when the
  code is already taken, such as `SET` or `SET2`. A code is never reused or renamed.
- The spec lives in `docs/specs/<CODE>.md`. Its images live in `docs/specs/images/`, named
  `<CODE>-<name>.png`.
- The spec starts with its [state](#state), then the title `# <Project> — <CODE> specification`,
  then one paragraph saying what it covers.
- Internally, refer to a spec by its code: in issues, PRs, commits, code comments, and
  conversations. Version numbers are for releases only.
- A spec is complete and self-contained. Someone with no other context must be able to implement
  it from the spec and its plan alone. It states the whole behavior it covers, including what it
  keeps from the spec it builds on.
- Write rules as short bullets, one behavior each. Cover the edge cases, the lifecycle, failures,
  and what is out of scope. Leave nothing for the implementer to invent.
- Images are mockups. Where an image and the text disagree, the text wins.

## State

Every spec starts with a YAML front matter block that holds its state. It is the single place
where the process records where a spec stands. Agents read it before acting, and update it in the
same PR as the step that changes it.

```yaml
---
code: SET               # the spec code, the same as the file name
status: in-progress     # see the table below
version: v0.3           # the minor release series it ships in, vX.Y
builds-on: PIX          # optional: the spec it extends
tracking: "#8"          # the tracking issue, once there are plans
plans:                  # in delivery order
  SET-P1: "done #12"    # see the plan states below; `#` values are quoted
  SET-P2: approved
owner: someone          # optional: the project maintainer when absent
---
```

A `shipped` spec can also hold:

```yaml
amended: [v0.4]         # the release series whose changes amended it
replaced-by: XYZ        # the spec that replaced part of it
```

| Status | Meaning | Set by |
|---|---|---|
| `draft` | The spec PR is open, and the design is being written | The PR that adds the spec |
| `approved` | A gap read found nothing to guess, and the owner approved. No plan is merged yet | The approval, on the spec PR's last commit |
| `in-progress` | Some plans are merged, not all | The first plan's PR |
| `implemented` | Every plan is merged, and the release isn't out yet | The last plan's PR |
| `shipped` | The release that contains the last plan is out | A small PR right after the release |

Each plan has its own state, which tells an agent where the plan stands and where to resume
after an interruption:

| Plan state | Meaning | Set by, and where |
|---|---|---|
| `todo` | Written, not yet approved | The spec PR, or a spec change that reopens the plan, on main |
| `approved` | A gap read found nothing to guess. Implementation may start | The approval, on main or the spec PR |
| `executing` | Being implemented on its branch | The plan's branch, first commit |
| `blocked` | Implementation hit a gap only the spec can close, flagged on the tracking issue | The plan's branch |
| `"pr-opened #<PR>"` | The PR is open: in review, CI, or iteration | The plan's branch |
| `"done #<PR>"` | Reviewed and ready to merge; true once it merges | The plan's branch, last commit |

- The in-flight states, `executing` to `"done #<PR>"`, live only on the plan's branch. Main goes
  from `approved` to `"done #<PR>"` when the PR merges. The plan's PR also sets the spec's status.
- A spec change that alters a plan's rules sets that plan back to `todo`, so it is approved
  again.
- Only `shipped` specs take `amended` and `replaced-by`.
- Specs and PRs from before this process are adopted, not refused: see
  [Adopting existing work](#adopting-existing-work).

## Designing

- Design a spec in a dedicated PR that adds it, with no code. Iterate by editing the spec in that
  PR. Discussion can happen anywhere, but decisions only count once they are written in the spec.
  They don't count in an issue thread or in a review comment.
- While the spec is designed, a reviewer who did not write it reviews the spec and its plan
  adversarially. The review looks for:
  - contradictions;
  - ambiguities that force guessing;
  - behavior that is infeasible on the target platform;
  - plans that depend on later plans, or have no way to verify them.

  Fix the findings in the spec and the plan, or reject them with a reason.
- Before anything is implemented, a gap read looks for every point where an implementer would
  have to guess: the spec, the specs it builds on, the plans, and the code they touch, in full.
  The owner answers each gap, and each answer is written into the spec. With no gap left, the
  spec or plan is stamped `approved`; a gap the owner leaves open keeps its plan `todo`.
- The owner is questioned while the spec is designed and approved, never during implementation.
  An `approved` plan has no blocker left; a gap found later is the exception, and goes back to
  approval.
- The owner's approval is the stamp. For a spec in design, its last commit sets `approved`, and
  the spec merges.

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

- A plan starts only when it is `approved` on main, its spec is `approved` or `in-progress`, and
  every earlier plan is merged or has its PR open.
- Each plan gets its own branch and PR. A plan whose earlier plan is not merged yet is stacked:
  its branch starts from that plan's branch, and its PR targets it. Plans merge in order. The PR text starts with the plan's name, such
  as `SET-P1`.
- A PR implements its plan's slice and nothing visible beyond it. It adds no stubs in the UI for
  later plans. Its text states the temporary restrictions it carries.
- Plan PRs reference the tracking issue without closing it. Only the last plan's PR closes it.
- A deviation from the spec is a spec change in the same PR, stated in the PR text.
- Every user-visible behavior the PR adds gets an automated test.
- Before any of a PR's commits are pushed, a reviewer who did not write them reviews them
  adversarially. Each later push gets the same review of its new commits, unless they change
  only the spec's state.
- The owner's approval of a plan is the approval of its PR: once its review is arbitrated and CI
  is green, the PR merges, in plan order. The owner can still hold a PR by requesting changes on
  it, or with a comment, until an iteration handles it.
- A spec ships with the release that contains its last plan. No release is published while a spec
  is partly merged, so a spec ships in one version.

## Changing a shipped spec

- A change to shipped behavior updates every spec whose rules it changes, in the same PR, and adds
  the coming version to each one's `amended` list.
- A change to shipped behavior that needs plans is a new spec, which builds on the shipped one.
  A shipped spec never gets new plans.
- A new spec that replaces part of an older one says which parts in its first paragraph. The older
  spec keeps its rules while the new one is designed and implemented. The new spec's last plan
  PR removes the replaced rules from the older spec and sets its `replaced-by`.

## Adopting existing work

Work that the process did not frame is picked up, not refused:

- a spec without a front matter, without plans, or with a state from an older convention;
- a spec marked `approved` before the gap read existed;
- a PR open on a plan, opened before the process, with its old state.

A skill that meets one says so and proposes the process to the owner: the design step adds the
missing state and plans from the spec's text, asking only what the text leaves open; the gap read
then stamps the plans. An adopted plan PR keeps its branch: its whole diff is reviewed as if it
were new, its state is rewritten to the current one, and it then follows the same flow.

## Review labels

Review findings are labeled **high**, **medium**, or **low**, never P1, P2, or P3, which are plan
names.

## This project

- Each spec ships in one minor version. Their state headers say which, and where each stands.
- Tracking issues and PRs are on GitHub. PR titles follow Conventional Commits: a spec PR is
  `docs:`, a plan PR is usually `feat:`.
- release-please opens the release PR. Merge it only once every plan of the spec in progress is
  merged, then mark the spec `shipped`.
- The skills in `.claude/skills/` run the process: `ck-spec` designs and unblocks, `ck-approve`
  runs the gap read and stamps, and `ck-exec` implements approved plans, a fix, or an issue.
- A plan PR also follows the checks in AGENTS.md: lint, unit tests, the end-to-end test in a
  headless GNOME Shell, and screenshots for any visible change.
