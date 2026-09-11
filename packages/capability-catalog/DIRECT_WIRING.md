# Integrating the capability catalog directly

Most hosts never need this document: `@renderyes/server` performs every step
below and exposes the result over HTTP. Read on only if you are wiring this
package into your own executor instead.

## What this package owns

- Canonical data types, semantic fields, sources, capabilities, policies and relationships
- Manual TypeScript/Zod registration
- OpenAPI 3.x GET discovery and explicit approval compilation
- GraphQL SDL/introspection discovery, host approval, query compilation and runtime validation
- Planner-safe catalog projection
- Capability-owned runtime contract and lookup by `capabilityId`
- Parameter, preflight, output, provenance and freshness validation

It is the source of truth for data capability metadata. Do not recreate parallel
data-type or capability schemas in your application.

## What your application continues to own

- The plan format and its persisted data-request representation
- Authentication, authorization, session resolution, rate limits, timeouts and auditing
- The deterministic executor and its application error model
- UI catalog, component compatibility, rendering
- Partial-result and user-visible fallback behavior

In the RenderYes packages these are `@renderyes/planner`,
`@renderyes/data-runtime`, `@renderyes/site-sdk` and `@renderyes/server`;
a custom integration replaces them, not this package.

## Required integration flow

1. Give only `PlannerManifest` to the planner.
2. Persist a request as `capabilityId` plus planner-controlled `params`.
3. Resolve the capability and runtime by `capabilityId` on the server.
4. Call `validateCapabilityPreflight` with the params and trusted session/permission context.
5. Apply your own authorization, timeout, rate-limit and audit policy.
6. Call `runtime.execute(params, { identity, signal })`.
7. Call `validateCapabilityResult` before binding returned data to any UI component.
8. Translate standardized failures into your existing per-request error/fallback model.
9. Pass only validated data plus provenance/freshness into the rendering path.

## Non-negotiable boundaries

- Model-produced params never contain session identity.
- Raw data is never sent back to the planner.
- OpenAPI operation bindings and runtime maps stay server-side.
- GraphQL operation bindings, identity argument mappings and transports stay server-side.
- An OpenAPI description is onboarding metadata, not authorization.
- Permission declarations do not replace the host's authorization checks.
- The runtime is capability-owned; a semantic source may expose several capabilities.

## Suggested persisted request shape

Use your own naming, but preserve this separation:

```ts
interface DataRequest {
  requestId: string;
  capabilityId: string;
  params: Record<string, unknown>;
}
```

Identity, permissions, endpoint details and runtime functions do not belong in
that persisted request.

## Acceptance checks

- Unknown capabilities and invalid parameters are rejected before execution.
- Model-controlled identity fields are rejected.
- Missing trusted session keys or permissions fail preflight.
- The runtime selected by `capabilityId` executes.
- Invalid data, provenance or freshness never reaches rendering.
- Planner serialization contains no runtime, endpoint, session-key or permission details.
- A saved request can execute again without a model call.

## Deferred

Generated REST-to-GraphQL wrappers, GraphQL mutations/subscriptions, federation,
and write actions remain deferred.
