---
"@renderyes/server": minor
"@renderyes/planner": minor
---

Adds a System One plan provider to `@renderyes/server`: `SystemOneProviderConfig`
puts a typed-decision model in front of planning, so a confident
single-capability prompt is planned from the catalog by rules in a few hundred
milliseconds with no language model call. Everything else goes to an optional
`fallback` language model or is refused with a reason. `shadow: true` records
the decision beside the language model's plan as a `classify` model-call event.

`@renderyes/planner` now hands every provider request a `planning` context — the
visitor's prompt, the stage (initial, revision, repair, clarification answer),
the planner-safe manifest and the site — beside the rendered prompts. Existing
providers can ignore it.
