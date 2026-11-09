---
"@renderyes/core": minor
"@renderyes/data-runtime": minor
"@renderyes/site-sdk": minor
"@renderyes/planner": minor
"@renderyes/server": minor
"@renderyes/react": minor
---

Show the visitor what a view was built from, and ask only for what is missing.

- Every composed view now carries `understood`: each argument or filter field with declared values that its requests use, the values in effect, and the visitor's words that matched none of them (`notFound`, e.g. "Texas" against a region list without it). It is derived in code from the validated plan and the catalog, travels in the `__renderyes` envelope and on `ComposeResult`, and `ViewWorkspace` renders it as an editable "Based on" row (`ViewUnderstood`).
- New refine operation `setInput` changes one of those inputs with no model call. It refuses any input without declared values (identity and session keys included) and any value outside the declared list; `refineComposedView` now also validates params against the capability's full input schema.
- A required argument with declared values that the visitor did not state is asked for: a `needs-clarification` result with the declared values as `options` and `input` naming the field and a held plan. Nothing is fetched until the visitor picks; `answerClarification` applies the pick as a `setInput`. System One leaves such an argument out of its draft instead of deferring, and the planner contract lets a model leave it out instead of guessing.
