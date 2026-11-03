---
"@renderyes/server": minor
"@renderyes/planner": minor
---

System One answers what a visitor does after the first view, with no language
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
