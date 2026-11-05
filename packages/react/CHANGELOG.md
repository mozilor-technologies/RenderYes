# @renderyes/react

## 0.2.0

### Minor Changes

- e653d9a: `ViewPage` (and `ViewWorkspace`) renders a × on each panel of a multi-panel
  view that drops the panel through one `removeNode` refinement, never on a
  single-panel view, and `removePanels={false}` hides it under the same
  `resolveViewOwner` rule as `rearrange`. `SurfacePanels` gains `removable` and
  `onRemove`; chrome options gain `removeEnabled`.
- aafe0bb: System One's uncertain band asks instead of refusing when no language model
  is configured. A decision between the new `clarificationThreshold` (0.5) and
  `threshold` returns a `needs-clarification` result carrying two to four
  `candidates` — approved capabilities read from the catalog, the model's pick
  first — and the `classify` event records them as `candidateIds`. Composing
  the same prompt again with `capabilityId` set plans that capability from the
  catalog with no model call (`routeChosenCapability`, reason `chosen` on the
  `classify` event); the server rejects an id the catalog does not hold.

  `@renderyes/react` renders candidates as keyboard-reachable chips under the
  question with a "None of these — show me the full site" way out, adds
  `chooseCandidate(capabilityId)` to `useViewCompose`, and `fullSiteHref` to
  `ViewPage`. `@renderyes/planner` carries `chosenCapabilityId` on the planning
  context and `candidates` on its clarification result; `@renderyes/core` adds
  `ClarificationCandidate` and the `candidates` field on `RUN_ERROR` and a
  fell-back `RUN_FINISHED`.

### Patch Changes

- Updated dependencies [aafe0bb]
  - @renderyes/core@0.2.0
  - @renderyes/site-sdk@0.2.0

## 0.1.1

### Patch Changes

- First release published through npm trusted publishing. Every tarball now
  carries provenance linking it to the commit and workflow run that built it;
  0.1.0 was published by hand and cannot. No functional change to any package —
  the catalog-review serve script's comments were rewritten, nothing else under
  `packages/` or `apps/` moved.
- Updated dependencies
  - @renderyes/core@0.1.1
  - @renderyes/site-sdk@0.1.1
