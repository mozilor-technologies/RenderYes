# Architecture

This document describes the implemented system boundaries, core artifact, and
trust model. Product direction that is not implemented is out of scope here.

## Mental model

RenderYes is a pipeline with a single durable artifact in the middle:

```
visitor intent ──► [Planner: AI] ──► Plan ──► [Executor: deterministic] ──► rendered React view
                                       │
                                    (saved / reopened)
```

The **`Plan`** (`packages/core/src/plan.ts`, a union of `PlanV3_0` | `PlanV3_1`) is the boundary
between the probabilistic half (the planner) and the deterministic half (validation, data
resolution, rendering, persistence). Everything the AI produces is a `Plan`; everything that
touches real data or identity is plain code.

## The two catalogs (host-provided)

The host registers two separate registries. Keeping them separate lets the planner decide _what
data is needed_ before deciding _how to display it_.

### Capability catalog — what the site knows and can do

A versioned inventory of data types, typed read-only capabilities, semantic field descriptions,
sources, policies, and approved relationships, owned by `packages/capability-catalog`. GraphQL is
the preferred host-facing entry (see "Vendor & protocol stance" below); manual registration and
OpenAPI remain adapters that compile into the same internal contract.

Rules:

- The model may choose a capability `id` and fill **content params**.
- Identity/session keys are declared server-side and supplied later by the executor. They are
  removed from the planner manifest and cannot also appear in the input schema.
- Capability input and output are represented as portable JSON Schemas and validated
  deterministically.
- `execute()` remains in a separate runtime map and returns source-tagged, freshness-stamped data.
- GraphQL and OpenAPI discovery never grant capabilities automatically.
- GraphQL review receives host decisions for query eligibility, argument ownership, field scope,
  semantics, authorization declarations, operational limits, provenance, and freshness.
- A model-proposed structured GraphQL request is parsed and validated against the approved
  surface before deterministic server execution.

One registration produces two artifacts:

```text
trusted catalog + runtime handlers      planner-safe manifest
----------------------------------      ---------------------
loaders and server adapters             capability ids and purposes
session-key names                       content parameter schemas
authorization/cache/timeout policy      result types and safe limits
source URLs and join keys               semantic relationships
```

### UI catalog — how information may be shown

An inventory of component contracts, registered through
`@renderyes/site-sdk`. The matching React implementations are registered in the
browser through `@renderyes/react` under the same component ids:

```ts
defineComponent({
  id: "timeline",
  version: "1.0.0",
  description: "Chronological list of dated events",
  props: defineProps({ title: field.string() }),
  renderer: {
    component: "timeline",
    props: { items: { path: "/items" } }
  },
  dataSlots: {
    items: {
      accepts: [{ dataTypeId: "event", shapes: ["collection"] }]
    }
  }
})
```

The planner may only reference component `id`s that exist in this catalog. It cannot introduce new
component names, scripts, styles, or network calls. Data slots declare only what a component can
render — they do not declare or restrict query operations (filter, sort, aggregate, pagination, set
operations). Operation support and policy remain exclusively in the capability catalog and the
trusted executor. A slot corresponds to a registered, immutable renderer path (for example
`report: "/report"`); model-visible props cannot override that path.

## The `Plan`

A small, validated, versioned JSON document. It is inspectable, cacheable,
diffable, savable, owner-bookmarkable, and can be produced with or without AI.
`PlanV3_0` is the existing component-only plan;
`PlanV3_1` adds data-aware fields (`dataCatalog`, `dataRequests`, `dataCompositions`, `dataJoins`,
and `dataBindings` on nodes) while keeping `PlanV3_0`'s persisted wire contract valid.

```json
{
  "planId": "plan-01",
  "siteId": "bharat-times",
  "schemaVersion": "3.1",
  "sourcePrompt": "The latest politics coverage, and how many stories we've published",
  "catalog": { "id": "bharat-times", "version": "1.1.0", "fingerprint": "39c1b08e" },
  "dataCatalog": { "id": "bharat-times", "version": "1.1.0", "hash": "39c1b08e" },
  "dataRequests": [
    {
      "requestId": "politics",
      "capabilityId": "bharat-times.posts.list",
      "params": {},
      "query": {
        "filter": {
          "combine": "all",
          "conditions": [
            { "field": "categories.title", "operator": "eq", "value": "Politics" }
          ]
        },
        "sort": [{ "field": "publishedAt", "direction": "desc" }]
      }
    },
    {
      "requestId": "published-count",
      "capabilityId": "bharat-times.posts.count",
      "params": {}
    }
  ],
  "surfaces": [
    {
      "id": "main",
      "nodes": [
        {
          "nodeId": "politics-stories",
          "componentId": "BharatTimesStoryList",
          "props": { "heading": "Politics coverage" },
          "dataBindings": { "stories": { "requestId": "politics" } }
        },
        {
          "nodeId": "published-total",
          "componentId": "StarterMetricCard",
          "props": {},
          "dataBindings": { "metric": { "requestId": "published-count" } }
        }
      ]
    }
  ],
  "generation": {
    "providerId": "openai",
    "modelId": "gpt-4o",
    "createdAt": "2026-08-27T00:00:00Z",
    "repairCount": 0
  }
}
```

Notes:

- `capabilityId` names an approved capability; `params` are content only.
- `dataRequests` are reusable and independent of presentation nodes; `dataCompositions` and
  `dataJoins` combine them.
- `componentId` names a UI-catalog entry; a node's `dataBindings` map a named data slot to a
  request, composition, or join id (never a literal row).
- The validator checks parameter schemas, catalog drift, request references, and component/data
  compatibility before execution.
- No identity params appear anywhere in a `Plan`.

## Query semantics

`QuerySpec` (`packages/core/src/plan.ts`) is the model-selectable, transport-neutral query
language applied to one capability result. It is declarative data only — it cannot contain
executable code, identity, endpoint details, renderer paths, or a reference to another request.

- **Filter.** `FilterGroup`/`FilterCondition` form a tree: `combine: "all"` is AND, `"any"` is OR,
  `"none"` is NOT(any)/NOR. `FilterOperator` covers `eq`, `not-eq`, `gt`, `gte`, `lt`, `lte`,
  `between` (inclusive `[min, max]`), `contains`, `starts-with`, `ends-with`, `in`, `not-in`,
  `is-null`, `is-not-null`. Text operators (`eq`, `not-eq`, `in`, `not-in`, `contains`,
  `starts-with`, `ends-with`) apply Unicode NFKC normalization, trim surrounding whitespace, and
  compare case-insensitively — a provider emitting `"politics"` still matches a canonical
  `"Politics"`. Non-string values, join keys, and sort comparisons remain exact.
- **Sort.** `Sort[]` gives stable multi-field sorting (`field`, `direction`).
- **Aggregate.** `AggregateOp` is `count`, `sum`, `average`, `minimum`, `maximum`, with an optional
  `groupBy`. `field` is required for every op except `count`; `as` names the output column.
- **Projection, offset, limit.** `project`, `offset`, `limit` bound and shape the result.
- Semantic validation against the selected capability and its data type happens in the trusted
  data runtime, not the planner — the planner's JSON Schema only constrains shape.

**Set composition.** `DataComposition` combines two or more top-level `dataRequests` with a
`SetOperation` (`union`, `intersection`, `difference`). Rows are matched by the shared output data
type's catalog-declared match key, resolved by the executor at execution time — the match key is
never part of the wire contract. `inputs` reference only top-level requests (no nested
compositions). An optional post-merge `query` may sort, project, or limit; a filter is not
permitted there.

**Joins.** `DataJoin` enriches one dataset's rows with a related dataset's fields through an
owner-approved catalog relationship (`relationshipId`). Join keys are never in the wire contract —
only the relationship id; the trusted executor resolves the keys from the catalog. `left`/`right`
reference top-level requests; joined right-side fields are namespaced under `as`. Join support is
to-one only; to-many joins are not implemented.

**Entity/value resolution.** A capability's `inputSchema` may declare resolution params handled
entirely by the trusted runtime, never by the planner. A host's `orders.list`, for example, can
declare `placedByReference` (a natural-language staff name, including a possessive like
`"Dara's"`, resolved against a server-only staff directory using the same NFKC/trim/case-fold
normalization, fail-closed to no rows if unresolved or ambiguous) and `placedByScope: "me"`
(resolved from the trusted session's staff id, matched exactly, never fuzzily). The model passes only a term or the
`"me"` scope; it never sees the directory or the resolved canonical value. Generic filter-value
references (a filter value that resolves from another request's result) and catalog-owned
aliases/synonyms are not yet implemented.

## Catalog registration

Two onboarding sources produce the same canonical capability catalog: host-authored
TypeScript/Zod registrations, and GraphQL/OpenAPI import. Every capability input schema must be an
object that rejects additional properties; a session key cannot also be a content parameter.

**Manual registration:**

```ts
const Product = z.strictObject({
  id: z.string(),
  name: z.string(),
  image: z.string().url(),
  price: z.number(),
  stock: z.number().int(),
});

const bundle = createManualCatalog({
  id: "posters",
  version: "1.0.0",
  description: "Approved Posters capabilities.",
  dataTypes: [
    defineDataType({
      id: "product",
      version: "1.0",
      description: "A sellable poster product.",
      schema: Product,
      matchKey: "id",
      fields: {
        id: { label: "Product ID", semanticType: "identifier" },
        name: { label: "Product", semanticType: "text" },
        image: { label: "Image", semanticType: "image-url" },
        price: { label: "Price", semanticType: "money", currency: "USD" },
        stock: { label: "Stock", semanticType: "quantity", unit: "item" },
      },
    }),
  ],
  sources: [{ id: "catalog", label: "Product catalog" }],
  capabilities: [
    defineCapability({
      id: "products.search",
      version: "1.0",
      purpose: "Find sellable products using inventory filters.",
      kind: "query",
      inputSchema: z.strictObject({
        stockMin: z.number().int().optional(),
        stockMax: z.number().int().optional(),
      }),
      outputSchema: z.array(Product),
      output: { dataTypeId: "product", shape: "collection" },
      requiredSessionKeys: ["viewerId"],
      sourceIds: ["catalog"],
      supports: {
        filterFields: ["stock"],
        sortFields: ["stock", "price"],
        setOperations: ["union", "intersection", "difference"],
      },
      policy: {
        authentication: "session",
        requiredPermissions: ["catalog.products.read"],
        maximumRows: 100,
      },
      execute: async (input, context) => hostProducts.search(input, context),
    }),
  ],
});
```

`bundle.catalog` is serializable, `bundle.plannerManifest` is safe to send to a planner, and
`bundle.runtimes` contains the trusted server functions.

**OpenAPI import** accepts OpenAPI 3.x behind an explicit allow-list. Each selected operation also
declares the query/path parameters and response fields approved for generated views:

```ts
const draft = importOpenApiCatalogInventory({
  document: openApiDocument,
  catalog: {
    id: "posters-api",
    version: "1.0.0",
    description: "Approved Posters API capabilities.",
  },
  source: { id: "poster-api", label: "Poster API" },
  operations: [
    {
      operationId: "listProducts",
      capabilityId: "products.search",
      dataTypeId: "product",
      resultShape: "collection",
      contentParameters: ["stockMin", "stockMax"],
      exposeFields: ["id", "name", "image", "price", "stock"],
      requiredSessionKeys: ["viewerId"],
      policy: { authentication: "session", maximumRows: 100 },
    },
  ],
});
```

The importer imports read-only GET operations, resolves local OpenAPI references, derives JSON
Schemas, and suggests field semantics; header and cookie parameters are never planner-controlled.
The draft retains server-side operation bindings for the executor; it does not itself make network
calls.

For assisted onboarding, a host first selects operation metadata (not fields or parameters) to
review with `createOpenApiCatalogInventory`, then approves candidate inputs/fields, then compiles
with `compileApprovedOpenApiCatalog`. `apps/catalog-review` (`@renderyes/catalog-review`) is the
local developer tool for this. Schema review runs in the browser. When connected
to a RenderYes host, the packaged server proxies an allowlisted set of admin
routes for publishing and optional model-assisted suggestions.

```bash
pnpm review:dev
pnpm review:build
```

Compilation rejects a changed source document (the approval file is bound to a fingerprint of the
reviewed document), unknown/duplicate selections, an empty output surface, and any attempt to
select headers or cookies.

## GraphQL

GraphQL is additive to the manual/OpenAPI capability-catalog contract; it does not change existing
catalog, runtime-result, or planner-manifest exports.

```text
SDL or introspection JSON
        │
        ▼
deterministic discovery (no approval)
        │
        ▼
host review and explicit allowlists/policy
        │
        ├── canonical CapabilityCatalog
        ├── PlannerManifest
        └── server-only GraphQL bindings
```

The host supplies all security and operating decisions during review: eligible root `Query`
fields; visitor-controlled versus trusted-identity arguments; approved and always-required output
leaf fields; semantic field types and custom-scalar JSON Schemas; authentication and required
permissions; maximum rows, timeout, cache TTL, selection depth, selected fields, and freshness age;
approved source metadata and host-resolved provenance. Schema discovery grants nothing by itself.
Mutations and subscriptions are excluded.

The planner may propose only structured data requirements:

```json
{
  "capabilityId": "products.search",
  "params": { "minStock": 1, "maxStock": 9 },
  "selection": ["id", "name", "image", "price", "stock"]
}
```

`selection` is optional; omission requests the complete approved field envelope. Required fields
are added deterministically. Identity arguments never appear in planner parameters or the planner
manifest.

`compileGraphQlOperation` checks the schema fingerprint, validates the capability and approved leaf
selection, enforces depth and selected-field limits, maps trusted identity keys to GraphQL
variables, and creates and validates a GraphQL document. `executeApprovedGraphQlRequest` then
performs catalog preflight, delegates the approved document to a host transport, degrades a
partial GraphQL response per field, requires host-resolved provenance, enforces the freshness
limit, and validates the output envelope before rendering. A field error on a non-required
approved field drops that field and names it in `provenance.degradedFields`; a request-level
error, a wrapper error, a required field, or a nulled result still fails the whole request. The host transport owns endpoint URLs, credentials, headers,
cookies, tenant routing, network policy, authorization enforcement, timeout enforcement, and
auditing — none of it enters the planner manifest.

Supported: SDL and introspection JSON; read-only root object/list queries; scalars, custom-scalar
mappings, enums, input objects, lists, and nullability; nested object/interface fields without
required nested arguments; structured approved field selections; schema drift detection.
Deferred: unions requiring inline fragments; implementation-only interface fields, which need the
same fragments — these are named in each query's
exclusion ledger with the concrete type that declares them, and reached by registering that type
as its own capability; mutations and subscriptions; arbitrary model-generated GraphQL text;
federation and multi-service composition.

A host with a dedicated, already-visitor-safe GraphQL Query API can also approve that schema
fingerprint as a whole with `compileCuratedGraphQlCatalog` (packages/capability-catalog/src/graphql.ts),
deriving one capability per supported root `Query` field under shared limits. Detailed field-level
review remains available for broad or
internal schemas.

## Runtime stages

### 1. Capture intent

A single natural-language goal produces an initial view. Suggested chips submit
their text as that goal. A semantic revision sends a follow-up together with a
summary of the current plan; autonomous or agentic loops are not implemented.

### 2. Plan (AI, constrained)

Given the intent, selected surface, and two catalogs, a model produces a `Plan`.
The built-in providers request structured output and can retry in validated JSON
mode when a provider rejects the response schema. In every mode, the result must
pass the generated schema and semantic validation before execution.

The server can reuse validated plans through an opt-in `planCache`, keyed by
normalized prompt, provider, surface, capability-catalog hash, and UI-catalog
fingerprint. Capability retrieval by embedding similarity is not implemented.

The planner is the _only_ AI stage in the render path. Everything below is deterministic.

### 3. Validate & enforce policy

1. Validate the `Plan` against its versioned schema.
2. Confirm every component and capability id exists in the current catalogs.
3. Validate content parameters against the selected capability input schemas.
4. Validate each node's props and named data-slot compatibility.
5. Check UI and capability catalog hashes for drift.
6. Apply mandatory-content and exclusion policies.
7. Reject unknown ids and invalid props. `composeDataPlan` can make up to two
   additional model attempts with validation feedback (`maxRetries`, default 2).

### 4. Resolve data (deterministic)

For each reusable data request, the executor calls the named capability runtime with validated
content params and a separate context containing **identity injected from the session**.
Independent requests run in parallel, per-request failures are isolated, and results carry
provenance and freshness. The model is never in this loop.

### 5. Render (deterministic)

Map the resolved blocks to UI-catalog components. Starter components provide
client-side interactions such as table filtering and sorting. `ViewWorkspace`
provides save, reopen, pin, and panel reordering. Hosts can call deterministic
refinement for sort, filter, limit, remove, and reorder operations; the package
does not ship controls for every refinement. A model is invoked again only for
a semantic revision the visitor submits.

### 6. Persist

Save the `Plan`, prompt, owner key, catalog fingerprints, and metadata. Do not
persist fetched business data or generated code. Reopening validates the stored
plan against the current catalogs and fetches current data.

Implemented end to end. `ViewStore`, `SavedView`, and the
save/reopen/list/delete methods on `@renderyes/server` hold the plan,
owner-scoped; `useViewCompose` in `@renderyes/react` exposes `save`,
`listSaved`, `reopen`, and `deleteSaved`; and a saved view has a URL — `save()`
writes its id into a query parameter and a load carrying that parameter reopens
it. Reopening re-executes the plan's data requests, so a bookmark restores the
question and retrieves current answers.

Catalog drift is not migrated during reopen. The server attempts the replay. A
compatible replay returns `stale` and `staleReason`; an
incompatible plan returns an `invalid` result. Automatic migration is not
attempted.

Saved-view URLs are owner-scoped. A URL pasted to another visitor does not grant
access to the saved view.

## Isolation & rendering boundary

In `"isolated"` render mode, the composed view's CSS is isolated from host-page
CSS through a Web Component + Shadow DOM boundary (`IsolatedView` in
`@renderyes/react`). It is not a JavaScript sandbox: registered components are
trusted host code and execute in the page's JavaScript realm. If RenderYes is
unavailable, the host's existing site remains available.

## Failure & fallback

Current failure behavior is explicit:

- A planner may return `unsupported`, request clarification, or fail validation
  after its repair attempts. A failed revision keeps the previous validated
  view; a failed initial compose has no automatic grounded-link fallback.
- Streaming emits pending slots before data settles. Data-request failures are
  isolated per slot, and successful slots remain renderable in a partial view.
- A drifted saved view is attempted against current catalogs. Compatible plans
  return with a stale reason; incompatible plans return `invalid`.
- The host site remains mounted, but navigation back to it is controlled by the
  host through `onExit` or its own layout. The runtime does not redirect on a
  total failure.

## Security and trust boundaries

The trust-boundary table and the enforced boundaries are in
[`BUILD_A_HOST.md`](https://github.com/mozilor-technologies/RenderYes/blob/main/docs/BUILD_A_HOST.md#security-and-trust-boundaries),
which ships in `@renderyes/server`, so a host can read them from an installed
tarball. What follows is the transport-level detail behind them.

### OpenAPI transport adapter: retry, cancellation, and credential refresh

`createOpenApiRuntime` (`packages/data-runtime/src/openapi-adapter.ts`) turns one compiled
`OpenApiOperationBinding` into a `CapabilityRuntime` — the sole authority on what an operation,
parameter, or output field is approved remains the capability-catalog package; this adapter only
executes what that package already compiled.

- **Timeout and cancellation are not reimplemented.** The trusted executor already derives a
  combined `AbortSignal` from the capability's policy timeout and any caller signal before calling
  `runtime.execute`. The adapter passes that same signal straight into `fetch`.
- **Approved-params-only forwarding.** The adapter builds the request URL exclusively from
  `binding.contentParameters` — a name that appears as a `{placeholder}` in the path is substituted
  there, otherwise it becomes a query parameter. Any other key present on the input is silently
  dropped, not just filtered by the earlier schema check.
- **Bounded retry with error normalization.** GET operations retry up to `maxAttempts` (default 3)
  attempts with exponential backoff plus jitter, retrying only network failures, HTTP 429, and 5xx;
  a 4xx never retries. A host-approved POST is never automatically retried (`maxAttempts` is forced
  to 1), because retrying it after a network failure could repeat an upstream operation whose
  outcome is uncertain, even if the operation is semantically read-only. Failures normalize to
  stable codes (`UPSTREAM_UNAVAILABLE`, `UPSTREAM_RATE_LIMITED`, `UPSTREAM_ERROR`,
  `UPSTREAM_INVALID_RESPONSE`, `CONFIGURATION_ERROR`) with a generic message. If the abort signal
  fires mid-retry, the adapter immediately re-throws the signal's reason; cancellation is not a
  retryable transient failure.
- **Response validation.** The adapter returns the parsed JSON
  body as-is. The compiled `outputSchema` has `additionalProperties: false`, and
  `validateCapabilityResult` already rejects a result carrying any field the owner didn't approve
  (`INVALID_RUNTIME_RESULT`). Filtering inside the adapter would hide the invalid response.
- **Credentials are server-only, and resolved fresh on every attempt.** `headers` is a
  caller-supplied `() => Record<string,string>` resolved once per retry attempt, not once up front,
  so a short-lived token minted or refreshed between attempts is used on the retried request.
  Resolution happens inside the loop, right
  after the per-attempt abort check, so a slow or hanging resolver is subject to the same
  cancellation path as the network call itself.
- **Filter/sort run against real fetched rows, unless the source can take them.** The query engine
  (see [Query semantics](https://github.com/mozilor-technologies/RenderYes/blob/main/docs/ARCHITECTURE.md#query-semantics) in `docs/ARCHITECTURE.md`) applies after the runtime call; a condition the upstream's own
  filter argument can carry is compiled into it instead, so the database narrows and nothing is
  left to a page. An owner may declare `supports.filterFields`/`sortFields` explicitly on the
  operation selection; when they do not, compilation defaults them to the approved leaf fields —
  the owner's decision about what may be seen at all was already made when they approved the
  output, and filtering reveals nothing beyond it. Paths that cross a nested list are offered to
  filter but not to sort, where ordering rows by a field with several values per row names no
  ordering.
- **A field that cannot reach the source is not offered to the planner.** Where the filter argument
  covers some advertised fields and not others, compilation publishes the reachable subset as
  `supports.sourceFilterFields` and warns naming the rest. The planner's filter vocabulary is that
  subset, because two field names give it nothing to choose by — a relation's title and a stored
  projection of the same relation read identically and answer differently. `filterFields` stays the
  runtime's permission list, so refinement the host triggers itself is unaffected.
- **Deferred:** transparent multi-page pagination. Approved pagination content-parameters are
  forwarded faithfully and a Relay connection is bounded by a page size, but no adapter walks
  multiple upstream pages to satisfy a larger requested row count. A result cut short by the cap
  reports `provenance.truncated`.

## Cost model

The publisher pays, so cost is an architectural constraint:

- No model call occurs until a compose or semantic revision is submitted.
- A clean compose uses one planning attempt. Validation repair allows up to two
  additional attempts, and a provider's structured-schema fallback can add an
  HTTP call within an attempt.
- Deterministic refinement and component-local sorting/filtering use no model.
- Surface scoping and compiled-contract reuse are automatic. `planCache` is
  opt-in and caches plans, never fetched data.
- `allowCompose` is the admission hook for host-defined quotas. Compose metrics
  report timing, model-call counts, and token usage; pricing and task-completion
  measurement remain the host's responsibility.

## Vendor & protocol stance

Keep model-provider, data-source, and renderer adapters behind stable interfaces. Manual
registration, OpenAPI import, and native GraphQL onboarding all compile into the same canonical
catalog. **GraphQL is the preferred host-facing data boundary** because its typed graph can express
arguments, return types, field selection, and relationships through one inspectable schema. Hosts
without GraphQL can onboard through OpenAPI import without changing their business backend;
OpenAPI remains a fully supported fallback path, not a deprecated one. The differentiated core remains the `Plan` lifecycle, host approval, the two-catalog contract,
grounding, and low-friction integration.

## Where discovery fits

Automatic crawling / sitemap ingestion / `/.well-known` manifests are a _later_ onboarding
convenience for reducing host effort — **not** the foundation. The host registers its catalogs
directly (React-first). Discovery earns its place only after composition quality is proven and
only as assisted drafting of catalog entries for owner review. Extracted content remains untrusted
until validated and bound to stable source identifiers.
