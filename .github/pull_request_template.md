## What this changes, and why

<!-- The problem first, then the change. If there is an issue, link it. -->

## Checks

- [ ] `pnpm check` passes
- [ ] `pnpm smoke:install` passes — **required** if this touches a package's
      exports, its `files` list, or anything under `scripts/`
- [ ] A changeset is committed (`pnpm changeset`), or `pnpm changeset --empty`
      if this releases nothing
- [ ] Docs match the new behaviour. A change that makes a document wrong is not
      finished (`AGENTS.md`, "Definition of done")

## Boundaries

- [ ] This does **not** move a trust boundary — nothing new reaches the
      planner, no default now fails open, no unapproved field can surface
- [ ] This does **not** contradict a non-goal in [`docs/PRODUCT.md`](../docs/PRODUCT.md)

<!-- If either is unchecked, say what moved and why. That is the interesting
     part of the review, not a problem with the change. -->

## Anything you want a reviewer to look at hardest

<!-- Optional. Naming your own uncertainty saves everyone a round trip. -->
