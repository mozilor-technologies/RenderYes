---
"@renderyes/react": minor
---

`ViewPage` (and `ViewWorkspace`) renders a × on each panel of a multi-panel
view that drops the panel through one `removeNode` refinement, never on a
single-panel view, and `removePanels={false}` hides it under the same
`resolveViewOwner` rule as `rearrange`. `SurfacePanels` gains `removable` and
`onRemove`; chrome options gain `removeEnabled`.
