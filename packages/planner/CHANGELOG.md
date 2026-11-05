# @renderyes/planner

## 0.2.0

### Minor Changes

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

- e653d9a: System One answers what a visitor does after the first view, with no language
  model configured. A typed refinement is decided like a fresh prompt and its
  panel added to the view on screen (`mergeIntoPlan`), bounded by the surface's
  `maxComponents`; a revision naming only a presentation ("as a table") re-renders
  the last panel in another accepting component with no decision call
  (`representLastPanel`); a compound prompt is split at its conjunction and each
  part decided on its own (`splitCompound`), one panel per part or refused whole;
  a capability whose required argument the prompt does not supply asks with the
  other capabilities instead of refusing. The catalog draft now fills a required
  free-text search argument (`q`, `query`, `search`, …) with the visitor's words
  and honours "as a table" / "as a chart" when choosing among accepting
  components. `SystemOneProviderConfig` gains `keepWarmMs` (ping the model server
  on a timer, never while a decision is in flight) and `hostRules` (`override` to
  send a prompt where the host says, `draft` to plan a capability the host would
  rather plan itself), both recorded on the `classify` event (`hostRule`,
  `stage`, `parts`).

  `@renderyes/planner` carries `previousPlan` on the planning context during a
  revision, and `composeDataPlan` takes `visitorPrompt` so a provider that does
  not read prose sees the visitor's own words rather than the revision framing.

- 2a1700d: Adds a System One plan provider to `@renderyes/server`: `SystemOneProviderConfig`
  puts a typed-decision model in front of planning, so a confident
  single-capability prompt is planned from the catalog by rules in a few hundred
  milliseconds with no language model call. Everything else goes to an optional
  `fallback` language model or is refused with a reason. `shadow: true` records
  the decision beside the language model's plan as a `classify` model-call event.

  `@renderyes/planner` now hands every provider request a `planning` context — the
  visitor's prompt, the stage (initial, revision, repair, clarification answer),
  the planner-safe manifest and the site — beside the rendered prompts. Existing
  providers can ignore it.

### Patch Changes

- Updated dependencies [aafe0bb]
  - @renderyes/core@0.2.0
  - @renderyes/data-runtime@0.2.0
  - @renderyes/site-sdk@0.2.0
  - @renderyes/capability-catalog@0.2.0

## 0.1.1

### Patch Changes

- First release published through npm trusted publishing. Every tarball now
  carries provenance linking it to the commit and workflow run that built it;
  0.1.0 was published by hand and cannot. No functional change to any package —
  the catalog-review serve script's comments were rewritten, nothing else under
  `packages/` or `apps/` moved.
- Updated dependencies
  - @renderyes/capability-catalog@0.1.1
  - @renderyes/core@0.1.1
  - @renderyes/data-runtime@0.1.1
  - @renderyes/site-sdk@0.1.1
