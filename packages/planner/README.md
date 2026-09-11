# @renderyes/planner

`@renderyes/planner` composes provider-neutral Plan 3.1 plans from:

- a registered RenderYes site and surface;
- the external capability catalog's planner-safe manifest; and
- the shared `PlanProvider` interface from `@renderyes/core`.

The package does not execute capabilities or render UI. It builds a closed JSON
Schema, treats provider output as untrusted, applies deterministic validation,
and returns either a validated plan, a structured unsupported result, or a
controlled failure with an optional previous-plan fallback.

The planner composes one surface whose compatible data slots may bind to a
single approved request or a provider-selected set composition. A composition
may use only `union`, `intersection`, or `difference` over two or more declared
requests whose catalog capabilities advertise that operation and share one
output data type. The trusted executor still owns matching, provenance,
freshness, and row projection.

Relationship-join and nested-layout planning are both implemented, backed by
their deterministic execution contracts.
