# Building a catalog in code

The GraphQL review flow can run in the host's own source: turn a schema into a
review draft, approve it as a literal object, compile the two into a catalog,
and publish it with no browser involved. This is a reproducible option for a
host that already knows its schema.

This page is GraphQL-specific because that is what the code-first helpers
cover today. `INTEGRATION.md`, which ships in `@renderyes/server`, is the wiring reference for
everything around this — `createViewServer`, the HTTP handler, the frontend.

**One extra install.** This route imports
`@renderyes/capability-catalog/graphql`, which the wizard does not install and
`@renderyes/server` does not re-export — it arrives only as a transitive
dependency, and under pnpm's isolated `node_modules` a transitive dependency is
not importable. Add it directly:

```bash
pnpm add @renderyes/capability-catalog
```

You also need `@renderyes/site-sdk` on the server for `defineComponent` and
`toSiteManifest`. The wizard installs that one for a backend or `both` role.

## When to write the catalog in code, and when to click

The review UI (`QUICKSTART.md`, in `@renderyes/server`) and this recipe produce the
same artifacts. They differ in where the decisions live:

- **Code-first** — the catalog is source code in the host's repository. Every
  approval decision goes through code review like any other change, the
  catalog is rebuilt and republished identically on every boot. A schema change
  that invalidates an approval fails the boot. Use this when the catalog should
  be reproducible and reviewed the
  way the rest of your code is.
- **The review UI** — interactive first exploration of a schema you don't yet
  know: see what discovery finds, click through fields and arguments, and
  export an approval file. Use it to *decide* what to approve; then either
  keep its exported approval file, or transcribe the decisions into code with
  this recipe so they live where your reviewers already look.

The two are not exclusive. A common sequence is one session in the UI to
explore, then a code-first publish that encodes what you decided.

## The shape of the work

A host publishes two catalogs, and compose needs both under the same
`catalogId`:

1. The **capability catalog** — what data may be read, field by field. Built
   in three steps: *draft* (mechanical discovery from the schema), *approval*
   (your decisions, as a plain object), *compile* (checks the two against
   each other and the schema). Published with `publishReviewedCatalog`.
2. The **UI catalog** — which components may render the results. Built with
   `defineSite`/`defineSurface`/`defineComponent` and `toSiteManifest`.
   Published with `publishUiCatalog`.

Both publish functions live on the object `createViewServer` returns, and
**both are async** — they persist through `catalogStore` when one is
configured, and a publish that isn't awaited can report a boot as complete
while the only durable trace of the catalog failed to write. Await them.

## Step 1 — draft: discover what the schema offers

```ts
import {
  createGraphQlCatalogInventory,
  compileApprovedGraphQlCatalog,
} from "@renderyes/capability-catalog/graphql";

export function createGraphQlCatalogInventory(
  options: GraphQlCatalogReviewOptions,
): GraphQlCatalogInventory;
```

`GraphQlCatalogReviewOptions`:

- `schema` — SDL text or introspection JSON.
- `catalog` — `{ id, version, description }`. The `id` is the `catalogId`
  everything else keys on.
- `source` — a `SourceDescriptor` (`id`, `label`, `description`) naming the
  upstream for provenance.
- `queries` — one `GraphQlQueryReviewSelection` per root query field you want
  to expose: `fieldName` (the schema's root field), `capabilityId` (your
  stable name for it), `purpose` (planner-facing — this is prose the model
  reads to choose a capability, so write it like documentation), `dataTypeId`,
  `resultShape` (`"collection"`, `"entity"`, `"metric"`, …), optional `fields`
  (labels and semantic types per output field), and optional `supports`
  (filter/sort/group fields and aggregates — never defaulted; the owner opts
  in here, in the capability's shape, not in the approval).
- `relationships?`, `discoveryMaxDepth?` (default 4).

The draft is the reviewable middle artifact: for each selection it carries
`availableVisitorArguments` and `availableOutputFields` — everything discovery
found that you *could* approve — plus a `reviewSourceHash` fingerprinting the
schema and your selections together. It throws immediately on a `fieldName`
the schema doesn't have or a query discovery can't support (polymorphic
roots, for instance), so a schema rename fails at draft time with the field's
name in the error, not at compose time with a planner refusal.

## Step 2 — approve: say what you accept

The approval is a plain object — in the UI flow it's the exported file; here
it's a literal in your source, which is the point: this is the authorization
decision, and it sits in the diff for a reviewer to see. Shape (validated
against `GraphQlCatalogDecisionsSchema`):

```ts
{
  schemaVersion: "1.0",
  reviewSourceHash: draft.reviewSourceHash,
  queries: [
    {
      capabilityId: "bharat-times.posts.list",
      approvedVisitorArguments: ["limit", "page"],    // arguments a visitor's plan may set
      identityArguments: {},                          // arguments the HOST injects from session, never the model
      approvedOutputFields: ["id", "title", "publishedAt"],
      requiredOutputFields: ["id", "title"],          // always selected, subset of approved
      policy: {
        authentication: "public",    // or "session"
        requiredPermissions: [],
        maximumRows: 25,
        timeoutMs: 10_000,
      },
      limits: { maximumSelectionDepth: 3, maximumSelectedFields: 20 },
    },
  ],
}
```

Two things worth being precise about:

- **Field paths are row-relative.** `match.score`, not
  `edges.node.match.score`: discovery unwraps Relay connections and describes
  the row, because the row is what a host reviews and what a component binds
  to. The transport wrapper never appears in an approval. The same holds for a
  declared list envelope such as the `{docs: [Post], totalDocs}` shape used by
  Payload CMS and Strapi.
  Declare it on the query selection and the paths are row-relative
  (`title`, not `docs.title`):

  ```ts
  listEnvelope: {
    rowsField: "docs",              // required: where the rows live
    totalCountField: "totalDocs",   // optional: powers "showing 10 of 42"
    hasNextPageField: "hasNextPage",// optional: powers moreAvailable
    pageSizeArgument: "limit",      // optional: injected and capped like `first`
    pageArguments: ["page"],        // optional: approved but never injected
  }
  ```

  Declared, never detected: an entity that is scalars plus one nested list has
  the same structural signature, and only you know whether those are rows.
  Discovery warns when the shape matches and nothing was declared, naming the
  candidate field.
- **Every argument needs an owner.** `approvedVisitorArguments` may be set by
  the plan; `identityArguments` map an argument name to a session key the
  host injects. The same argument cannot be both, and a required (non-null,
  no-default) argument owned by neither fails the compile — otherwise it
  would fail every request instead.

Fields whose semantic type discovery could not infer need a decision in
`semanticTypeOverrides` (keyed `Query.<field>.<path>`); one compile error lists
all remaining gaps.

## Step 3 — compile: check the two against each other

```ts
export function compileApprovedGraphQlCatalog(
  schemaInput: GraphQlSchemaInput,
  draft: GraphQlCatalogInventory,
  approvalInput: unknown,
): CompiledGraphQlCatalog;
```

The compile re-hashes the schema and the draft and refuses on any drift: a
schema that changed since the draft, an approval whose `reviewSourceHash`
doesn't match, an approved field or argument that was never discovered. In a
boot-time publish all three hashes are computed seconds apart, so drift here
almost always means a typo — an `approvedOutputFields` entry that misspells a
path — and the error names it.

The result carries `catalog` (the planner-facing capability catalog) and
`bindings` (a `Map` of capability id to the exact GraphQL operation the
runtime will execute — the generated operation selects only approved fields,
so an unapproved field isn't filtered from results; it is never requested).

## Step 4 — publish the capability catalog

```ts
const published = await viewServer.publishReviewedCatalog({
  bindingKind: "graphql",
  catalog: compiled.catalog,
  bindings: Object.fromEntries(compiled.bindings),  // the wire shape is a record, not a Map
  schema: typeDefs,
  endpoint: `${ORIGIN}/graphql`,
});
```

`publishReviewedCatalog(body: unknown): Promise<CatalogPublicationSummary>` —
async because it persists the publish input through `catalogStore` so a
restart can replay it; the in-memory publish runs first, so an invalid
catalog is rejected before anything is written.

Publishing checks two host-side preconditions and fails immediately when
either is missing, because both otherwise surface as runtime errors far from
their cause: `endpoint` must be inside `allowedUpstreamOrigins`, and the
server config needs a `graphql` adapter with `resolveProvenance` (every
returned row is attributed to a source; without the resolver each request
fails with `PROVENANCE_UNAVAILABLE` only after it already has data).

The returned summary is worth logging at boot. `capabilityCount` and
`executableCapabilityCount` should match; `uiCatalogRegistered` and
`unrenderableDataTypes` tell you whether the other half is in place; and
`contractBytes`/`approximateTokens` is the planner contract you will pay for
on every plan attempt — the number that tells you whether approving forty
more fields costs real money.

## Step 5 — publish the UI catalog

```ts
import { defineSite, defineSurface, defineComponent, toSiteManifest } from "@renderyes/site-sdk";

const uiPublished = await viewServer.publishUiCatalog({
  manifest: toSiteManifest(site),
  // Optional; defaults to the site's own id. Compose looks the UI catalog up
  // by the CAPABILITY catalog id, so name it when the two differ.
  catalogId: "your-catalog",
});
```

`publishUiCatalog(body: unknown): Promise<UiCatalogPublicationSummary>` —
async for the same persistence reason.

## The twin discipline

Every bespoke component exists twice, under the **same id**:

- In the **browser**, `defineHostComponent` from `@renderyes/react`, with
  `component:` pointing at your real React component. This is what renders.
- On the **server**, `defineComponent` from `@renderyes/site-sdk` — a
  definition-only twin with the same `id`, `version`, `description`, `props`,
  and `dataSlots`, plus a `renderer` mapping. This is what the planner reads.

The planner only sees what `publishUiCatalog` published. A React component
registered in the browser with no server-side twin is simply never chosen —
no error and no refusal; the planner always picks something else. This can look
like a prompt problem even though the component registration is missing. The
starter catalog keeps the discipline for you: register `createDataTable()`
(and friends) in the browser and publish `createDataTable().definition` on
the server. Charts split further — `createBarChartDefinition()` on the
server, so the server never needs a recharts install, and the rendering
`createBarChart()` from `@renderyes/starter-catalog/charts` in the browser.

Rendering-only options (`searchable`, `getRowHref`, `titleKey`, …) belong to
the browser half alone; they change how a component renders, never its
published contract, so the definitions stay untouched when you tune them.

## A complete boot-time publish

Trimmed to the essentials — one capability, one bespoke component, one
starter component. The full version runs five capabilities and eight
components with no new concepts.

```ts
import { createViewServer } from "@renderyes/server";
import {
  createGraphQlCatalogInventory,
  compileApprovedGraphQlCatalog,
} from "@renderyes/capability-catalog/graphql";
import {
  defineComponent, defineProps, field,
  defineSite, defineSurface, toSiteManifest,
} from "@renderyes/site-sdk";
import { createDataTable } from "@renderyes/starter-catalog";
import { typeDefs } from "./schema.js";

const ORIGIN = `http://127.0.0.1:${process.env.PORT || 4000}`;

export const viewServer = createViewServer({
  resolveSession: () => ({ userId: "local-user" }),
  host: {
    isAuthenticated: (session) => Boolean(session?.userId),
    hasPermission: () => true,
    getSessionValue: (session, key) => session?.[key],
  },
  // Required for a GraphQL publish; provenance attribution is not optional.
  graphql: {
    resolveHeaders: () => ({}),
    resolveProvenance: ({ sourceId }) => ({
      sources: [{ sourceId }],
      freshness: { asOf: new Date().toISOString() },
    }),
  },
  allowedUpstreamOrigins: [ORIGIN],
});

// 1. Draft — what the schema offers.
const draft = createGraphQlCatalogInventory({
  schema: typeDefs,
  catalog: { id: "bharat-times", version: "1.0.0", description: "Published content of The Bharat Times." },
  source: { id: "bharat-times-cms", label: "The Bharat Times", description: "The newsroom's own Payload CMS." },
  queries: [
    {
      fieldName: "Posts",
      capabilityId: "bharat-times.posts.list",
      purpose:
        "Published news articles with headline, summary, publication time and section. " +
        "Rows arrive in no meaningful order unless sorted: sort by publishedAt when recency matters.",
      dataTypeId: "Article",
      dataTypeDescription: "One published news article.",
      resultShape: "collection",
      // Payload's { docs, totalDocs, hasNextPage } wrapper — see Step 2. Paths stay row-relative.
      listEnvelope: {
        rowsField: "docs",
        totalCountField: "totalDocs",
        hasNextPageField: "hasNextPage",
        pageSizeArgument: "limit",
        pageArguments: ["page"],
      },
      // Payload emits DateTime as a custom scalar; a reachable scalar with no mapping refuses the compile.
      scalarMappings: { DateTime: { schema: { type: "string" }, semanticType: "date-time" } },
      fields: {
        id: { label: "Id", semanticType: "identifier" },
        title: { label: "Headline", semanticType: "text" },
        publishedAt: { label: "Published", semanticType: "date-time" },
        "categories.title": { label: "Section", semanticType: "text" },
      },
      supports: {
        filterFields: ["title", "publishedAt", "categories.title"],
        sortFields: ["publishedAt", "title"],
        groupFields: [],
        aggregates: ["count"],
      },
    },
  ],
});

// 2 + 3. Approve and compile — what the host accepts.
const compiled = compileApprovedGraphQlCatalog(typeDefs, draft, {
  schemaVersion: "1.0",
  reviewSourceHash: draft.reviewSourceHash,
  queries: [
    {
      capabilityId: "bharat-times.posts.list",
      approvedVisitorArguments: ["limit", "page"],
      // Payload's `sort` is a bare String ("-publishedAt" is newest first): declare its
      // grammar so the planner does not have to infer it.
      orderingArgument: { name: "sort", ascending: "{field}", descending: "-{field}", separator: "," },
      identityArguments: {},
      approvedOutputFields: ["id", "title", "publishedAt", "categories.title"],
      requiredOutputFields: ["id", "title"],
      policy: { authentication: "public", requiredPermissions: [], maximumRows: 25, timeoutMs: 10_000 },
      limits: { maximumSelectionDepth: 3, maximumSelectedFields: 20 },
    },
  ],
});

// 4. Publish the capability catalog.
const published = await viewServer.publishReviewedCatalog({
  bindingKind: "graphql",
  catalog: compiled.catalog,
  bindings: Object.fromEntries(compiled.bindings),
  schema: typeDefs,
  endpoint: `${ORIGIN}/api/graphql`,
});
console.log(`catalog published: ${published.catalogId} (${published.capabilityCount} capabilities)`);

// 5. Publish the UI catalog. BharatTimesStoryList is the definition-only twin
// of the browser's defineHostComponent({ id: "BharatTimesStoryList", ... }) —
// same id, or the planner never picks it.
const storyList = defineComponent({
  id: "BharatTimesStoryList",
  version: "1.0.0",
  description:
    "Editorial story list of published articles. Prefer it when the visitor wants to browse or compare several stories.",
  props: defineProps({ heading: field.string({ default: "From The Bharat Times" }) }),
  renderer: { component: "BharatTimesStoryList", props: { stories: { path: "/stories" } } },
  dataSlots: { stories: { accepts: [{ dataTypeId: "Article", shapes: ["collection"] }] } },
});

const components = [createDataTable().definition, storyList];
await viewServer.publishUiCatalog({
  manifest: toSiteManifest(
    defineSite({
      id: "bharat-times",
      name: "The Bharat Times",
      version: "1.0.0",
      catalogId: "https://localhost/renderyes/bharat-times.json",
      components,
      surfaces: [
        defineSurface({
          id: "main",
          description: "Answers composed from published Bharat Times content.",
          componentIds: components.map((c) => c.id),
        }),
      ],
    }),
  ),
});
```

Run this once at boot, before serving requests, in the same module that mounts
`createViewHttpHandler`. If you also configured `catalogStore`, the publishes
persist and `restorePublishedCatalogs()` replays them. With a boot-time publish,
the publish is the source of truth and the store only makes a restart survivable
if the publish module did not run.

**"At boot" assumes a process with a boot step** — a standalone service or a
Node server that calls `listen()`. A bundled, fetch-native mount (a Next.js
route handler is the common case) has no such moment: the framework evaluates
the route module during its build and again in every server instance, so
module-level work runs at build time too. In that topology, run the publish
lazily — once per process, before the first request is served, the same way
the scaffolded route replays its catalog store — or publish from a script
against the running mount (`POST /api/catalog` behind your `requireAdmin`). The
catalog itself is identical; only the registration time changes.

**The UI half has a second, harder constraint in that topology.** Building a UI
manifest means importing your components, which imports `@renderyes/react`.
Inside a Next.js route handler that pulls a client-side React build into the RSC
bundle, and the module dies on evaluation:

```
⨯ TypeError: {imported module .../vendored/rsc/react.js}.createContext is not a function
```

Every route in that module then 500s, including `/api/compose`, so the entire
mount stops answering and nothing in the trace mentions catalogs. This is not
the build-time problem above; moving
the publish later does not help, because the *import* is what breaks.

The capability catalog is unaffected: it is server-only and touches no React.
Publish it at boot as shown. The UI catalog goes out from a separate process
over `POST /api/ui-catalog` — which is what the scaffolded
`scripts/publish-ui-catalog.mjs` does. Keeping this in a script isolates
privileged publishing from the application mount.

## Failure modes, and what they look like

- **Unapproved field → refusal.** A field absent from `approvedOutputFields`
  is absent from the planner contract, so a prompt that needs it gets a
  refusal ("I can't read that"), not the data. The generated operation never
  selects it either, so there is no post-hoc filtering to get wrong. The fix
  is an approval change — a reviewed diff — not a prompt change.
- **Missing twin → component never chosen.** The browser component renders
  fine in your own tests, and the planner never selects it, silently. Check
  the ids match exactly between `defineHostComponent` (browser) and the
  published `defineComponent` (server); check the component made it into the
  published site's `components` and a surface's `componentIds`. The publish
  summary's `componentIds` list settles it in one log line.
- **Schema drift → compile throws.** "GraphQL review drift: the decisions do not
  match the reviewed schema" at boot means the schema changed under the draft
  or the approval hash is stale — in a same-process publish, usually a typo
  in a path or an edit to the draft options after the approval was written.
- **Endpoint rejected at publish.** An `endpoint` outside
  `allowedUpstreamOrigins` fails publication before it can create a catalog
  whose every execution would fail.
- **`uiCatalogRegistered: false` in the capability summary.** Legitimate
  ordering if the UI publish comes next; a bug if it stays that way.
  `unrenderableDataTypes` names any data type no published component accepts
  — data the planner can fetch but never show, which otherwise surfaces as
  the planner avoiding a capability for no visible reason.

## Verify before you trust it

Publishing validates shape, not whether the upstream will actually serve the
approved queries. The probe call in
`QUICKSTART.md` (in `@renderyes/server`), under "before you publish, check the catalog answers",
(`POST /api/catalog/probe`) executes each capability against the real
upstream and reports `ok` / `failed` / `skipped` per capability — worth
wiring into the same boot script, after the publishes.

---

## The review export — one artifact from review to runtime

Format: `renderyes-review-export`, version 1. Contract lives in
`@renderyes/capability-catalog` (`review-export.ts`); loader lives on the
view server (`loadReviewExport`).

## What it guarantees

A review export keeps the capability catalog, UI catalog, catalog id, and host
requirements in one versioned artifact. The loader checks the bundle's declared
requirements before publishing either catalog, so a missing UI half or upstream
origin is rejected at the publish boundary.

## The bundle

```jsonc
{
  "format": "renderyes-review-export",
  "formatVersion": 1,
  "catalogId": "bharat-times",
  "bindingKind": "graphql",
  "capability": {
    "catalog": {},          // CapabilityCatalog
    "plannerManifest": {},  // what the model sees
    "bindings": {},         // server-only compiled operations
    "schema": "…SDL or introspection…",
    "endpoint": "http://127.0.0.1:4000/graphql",
    "credentialId": "…"     // optional, opaque key — never a secret
  },
  "ui": { "manifest": {} }, // toSiteManifest output; filed under the bundle's
                            // catalogId, whatever the site is named
  "requirements": { "upstreamOrigins": ["http://127.0.0.1:4000"] }
}
```

Producers: `buildGraphQlReviewExport(...)`, used by the catalog-review
curated flow ("Download export bundle" / "Publish to host", which POSTs the
bundle to `/api/review-export`). The review UI fills `ui.manifest` with the
starter components by default; a host can republish its own UI catalog
under the same id later.

## The loader

`viewServer.loadReviewExport(bundle)`:

1. validates the envelope and refuses a `formatVersion` newer than itself;
2. checks every `requirements.upstreamOrigins` entry against
   `allowedUpstreamOrigins` and fails with the missing list **before
   publishing anything** — configuration errors surface as a checklist, not
   as a failed compose later;
3. publishes the capability catalog, then the UI catalog (capability-first:
   both half-loaded states fail closed at compose, so the order is not
   load-bearing);
4. returns `{ catalogId, executableCapabilityCount, componentIds }`.

Hosts expose it as an admin-gated route — `POST /api/review-export`, behind the
same `requireAdmin` as every other publishing route.

## Test coverage

`packages/server/test/review-export.test.mjs` covers a GraphQL review export,
loading its capability and UI catalogs, composing against the loaded catalogs,
origin validation, and refusal of unsupported future format versions.

## Current limits

- GraphQL binding kind only; OpenAPI needs a second `bindingKind`.
- Publishing is sequential, not transactional; a UI-catalog failure after
  capability publication leaves data without UI (visible via the GET
  routes, fixed by re-loading).
- The export does not yet carry the review's provenance (who approved,
  when) or the schema fingerprint check against the live endpoint.
