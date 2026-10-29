---
"@renderyes/server": minor
"@renderyes/react": minor
"@renderyes/planner": minor
"@renderyes/core": minor
---

System One's uncertain band asks instead of refusing when no language model
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
