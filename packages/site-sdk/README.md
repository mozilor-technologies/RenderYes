# @renderyes/site-sdk

The site SDK is the host-facing registration layer for RenderYes. It adds
validated site, surface, theme, semantic-component, and renderer-binding
definitions on top of `@renderyes/core`.

```ts
import { defineComponent, defineProps, field } from "@renderyes/site-sdk";

const TicketQueue = defineComponent({
  id: "TicketQueue",
  version: "1.0.0",
  description: "The approved support ticket queue.",
  props: defineProps({
    density: field.enum(["comfortable", "compact"], {
      default: "comfortable",
    }),
  }),
  renderer: {
    component: "ResponsiveDataTable",
    props: {
      title: { path: "/tickets/title" },
      columns: { path: "/tickets/columns" },
      rows: { path: "/tickets/rows" },
    },
  },
  dataSlots: {
    rows: {
      accepts: [
        {
          dataTypeId: "SupportTicket",
          shapes: ["collection", "search-results"],
        },
      ],
    },
  },
});
```

The SDK validates cross-references and produces a deterministic manifest and
registration fingerprint. `compileSurfaceMessages()` converts approved
instances into A2UI messages without allowing model-authored component
types or bindings. Registered renderer-binding keys are immutable: a
model-visible component prop may not reuse or override a binding such as
`rows: { path: "/tickets/rows" }`.

`dataSlots` declares only which capability result data a trusted component can
render. A slot name must match an immutable owner-registered renderer path.
Compatibility uses the external catalog's canonical `dataTypeId` and result
`shape`.

Components do **not** declare or restrict filter, sort, aggregate, pagination,
union, intersection, difference, or other query operations. Those permissions
belong only to the capability catalog and the trusted executor.

`validatePlanDataBindings()` checks that a Plan 3.1 binding references a
known capability and that its output type/shape fits the selected component
slot. It does not execute the request or interpret the capability's supported
operations.

`projectPlanDataModel()` accepts only executor-produced results for the same
plan, stores their safe state/provenance/freshness in the reserved
`__renderyes` envelope, and copies result data into immutable
owner-registered renderer paths. It clears collection data and writes trusted
error state when execution fails, rejects caller injection into the reserved
envelope, and rejects conflicting writes to one fixed path.

`compilePlanDataSurfaceMessages()` combines that projection with the existing
A2UI surface compiler for a flat semantic plan surface. The plan still
contains request IDs only; it never supplies a renderer path.

The integration surface is exported from the package root. Consumers should
import site, source, resolver, snapshot, manifest, and A2UI compilation
contracts from `@renderyes/site-sdk`, never from internal source files.

The external capability catalog (`@renderyes/capability-catalog`) remains
the source of truth for data types, capabilities, operations, policies,
relationships, planner-safe metadata, and OpenAPI/GraphQL approval. This
package owns site/component registration, result-to-component compatibility,
and A2UI compilation, and introduces no second capability schema.

CLI workflow (the shipped binary is `renderyes-site`):

```sh
renderyes-site init ./my-site
renderyes-site scan ./my-site/renderyes.site.mjs
renderyes-site sync ./my-site/renderyes.site.mjs
```
