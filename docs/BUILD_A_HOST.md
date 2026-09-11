# Build a host — a complete worked example

An AI-composed view surface for an app you already have. A visitor asks in
words; RenderYes plans against the data **you** approved, executes it against
**your** endpoint, and renders it with **your** React components. No model key
in the browser, no data leaving your infrastructure to be rendered, and nothing
composed that you did not approve field by field.

This is the long way round: one host, built end to end, every decision shown.
For the short path see [`QUICKSTART.md`](QUICKSTART.md).

---

## Table of contents

1. [What this gives you](#1-what-this-gives-you)
2. [Prerequisites](#2-prerequisites)
3. [Install](#3-install)
4. [Backend: mount the service](#4-backend-mount-the-service)
5. [Publish a catalog](#5-publish-a-catalog)
6. [Frontend: mount the provider](#6-frontend-mount-the-provider)
7. [Registering components](#7-registering-components)
8. [Generating a bespoke component](#8-generating-a-bespoke-component)
9. [Updating and rolling back](#9-updating-and-rolling-back)
10. [Quick reference](#10-quick-reference)

Signatures and routes live in [`API.md`](API.md); symptoms and their causes in
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

---

## 1. What this gives you

| A visitor does this | They get this |
|---|---|
| Types "what can I cook right now?" | An approved, validated view composed from your data, drawn with your components |
| Types "only the ones under 30 minutes" into the same box | A **revision** of the view on screen, not a new question |
| Clicks a column header in your own table | A **refinement** — sort, filter, limit, remove, reorder — applied as a plan edit with **no model call** |
| Asks something the approved data cannot answer | A refusal that says why, plus your own suggestion chips as "what you can ask instead" |
| Asks something answerable two materially different ways | A clarifying question, not a guess |
| Keeps a view | A saved view with its own URL, replayed against current data on reopen |
| Drags a panel, or focuses its grip and presses an arrow | The panels rearrange on screen instantly and the arrangement persists in the background |
| Pins one panel of a multi-panel view | That panel filed as its own saved view |

And for you:

| Feature | Detail |
|---|---|
| Streaming compose | The surface renders a skeleton the moment the plan validates and fills each slot as its data lands. On by default; `stream: false` for a buffering proxy. |
| Revision | `previousPlanId` interprets a prompt in the context of the current view. Your UI passes it only from revision controls. |
| Declarative refinement | `setSort`, `setFilter`, `clearFilter`, `setLimit`, `removeNode`, `reorderNodes`. Re-validated against the approved catalog, so a refinement can never widen what a visitor may see. |
| Clarification questions | `errorKind: "needs-clarification"` plus a `clarification` object. Not an error — render it as a question. |
| Refusal with suggestions | Your `suggestions` chips are rendered inside a refusal, so a dead end becomes a next step. Nothing in them is model-generated. |
| Saved views + bookmarkable URLs | `save()`, `listSaved()`, `reopen()`, `deleteSaved()`, `pin()`. The URL is owner-scoped: pasting it to a colleague will not open it for them. |
| Drag / keyboard rearrange | Built into `ViewWorkspace`; `reorderPanels(nodeIds)` if you build your own UI. |
| Coverage report | `GET /api/coverage?catalogId=<id>` maps every approved data type to the components that can render it. The fastest way to find the next component worth writing. |
| Observability | `onComposeMetrics` (once per compose: `planMs` vs `dataMs`, tokens, outcome, `cached`) and `onModelCall` (once per model call, with an OTLP/GenAI exporter for Langfuse or any collector). No prompt text or fetched rows unless you opt in. |

### The published packages

| Package | What it is |
|---|---|
| `@renderyes/react` | **Frontend entry point.** `ViewProvider`, `ViewWorkspace`, `ViewLauncher`, `ViewSurface`, `useViewCompose`, `defineView`, `ingestViews`, `defineHostComponent`. |
| `@renderyes/server` | **Backend entry point.** `createViewServer`, `createViewHttpHandler`, the catalog registries, and the compose pipeline. `toNodeHandler` is exported by `@renderyes/server/node`. Model keys and upstream credentials live here. |
| `@renderyes/starter-catalog` | Prebuilt components: data table, metric card, card grid, item list, detail panel, media gallery, record-with-lines, and charts. Matched to data by *shape*, not by your type names. |
| `@renderyes/site-sdk` | `defineSite`, `defineSurface`, `defineComponent`, `toSiteManifest`, `defineProps`, `field`. Builds the UI catalog you publish. |
| `@renderyes/capability-catalog` | Capability catalog contracts, schema discovery, and the code-first GraphQL helpers (`@renderyes/capability-catalog/graphql`). Ships the `renderyes-catalog` CLI. |
| `@renderyes/core` | Plan schema, validation, migration, A2UI interop. |
| `@renderyes/planner` | Provider-neutral plan composition. |
| `@renderyes/data-runtime` | The trusted capability executor — the only thing that touches your upstream. |
| `@renderyes/catalog-review` | The local review UI (`npx @renderyes/catalog-review`). Installed only while you build a catalog. |
| `@renderyes/generate` | Dev-time CLI that drafts a bespoke, host-styled component from your approved contract, verifies it, and emits a reviewable diff. Installed only when you use it — see §8. |

**What you install directly:**

- Frontend — `@renderyes/react` and `@renderyes/starter-catalog`.
- Backend — `@renderyes/server` and `@renderyes/starter-catalog`.

`core`, `planner`, `capability-catalog`, `data-runtime`, and `site-sdk` arrive
transitively, pinned to the same build. You never name them for resolution.

`starter-catalog` is the exception in both places. It is not a dependency of
`react` or of `server`, so **name it explicitly on the backend too** whenever
your service imports the starter components' `.definition` twins (it will —
see §7). A backend import requires the package to be a direct backend
dependency, even when the frontend already declares it.

> **pnpm and Yarn caveat.** If your service *directly imports*
> `@renderyes/site-sdk` or `@renderyes/capability-catalog/graphql` — the
> code-first catalog route does both — name those in your own
> `package.json` too. They resolve transitively under npm's flat
> `node_modules` (which is what a default npm install relies on), but pnpm and
> Yarn PnP refuse an import of a package you did not declare.

### Security and trust boundaries

| Item       | Model may see/select                                                                             | Server only                                                 |
| ---------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Capability | Planner-safe ID, purpose, input schema, output type/shape, advertised operations and safe limits | Runtime function, transport binding, private source details |
| Params     | Validated content params                                                                         | Credentials and injected identity                           |
| Session    | Nothing                                                                                          | Complete host session, cookie, token, permission collection |
| Identity   | Nothing in the plan                                                                              | Only required keys extracted and passed to the runtime      |
| Data       | No raw business rows                                                                             | Raw result, sensitive fields, validation/projection         |
| Components | Semantic ID, description, closed props, compatible data slots                                    | React implementation and registered renderer paths          |
| UI         | Approved composition intent                                                                      | Markup, CSS, responsive behavior, formatters                |
| A2UI       | Downstream trusted messages                                                                      | Compilation and immutable data bindings                     |

Additional enforced boundaries:

- Exact capability-catalog hash matching prevents executing a plan against a different catalog
  snapshot.
- Capability params and outputs are validated independently of model confidence.
- Query fields/operators/limits are constrained by the planner manifest.
- Registered binding paths cannot be model-authored.
- Failed runtime details are normalized into safe errors — never the upstream URL, response body,
  headers, or injected credential.
- Collection slots are cleared on execution failure, preventing stale rows.
- The reserved A2UI data-model envelope cannot be supplied by an untrusted caller.
- The browser receives no model, data, or indexing credentials; identity/authorization params
  never pass through the model.
- Loaders enforce the host's own authorization; the model cannot widen access.
- State-changing actions are unsupported; the current capability surface is read-only.
- Saved views are owner-scoped. Prompt retention and model-training policy are
  controlled by the host and its selected model provider.

---

## 2. Prerequisites

1. **Node.js 22+.** Any package manager: `npm`, `pnpm`, or `yarn`.
2. **Your own data source** — a host runtime registered in code, or an OpenAPI
   or GraphQL endpoint. RenderYes executes only the reads you approve.
3. **A model API key — required for planning.** OpenAI or Gemini, configured
   server-side by environment-variable *name*, never by value, in
   `planProviders`. To exercise the pipeline end to end (install → publish →
   compose → render) before spending a token, configure a plan you wrote
   yourself instead: `planProviders: [{ id: "rehearsal", plans: [myPlan] }]`.
   With nothing configured, compose refuses and reports what *is* wired up.
4. **An admin secret you mint yourself.** The publish and diagnostics routes sit
   behind a `requireAdmin` function you write. There is no default and no
   built-in credential. Decide what it is before §4.

> **Installing successfully does not validate deployment credentials.** The
> packages install from public npm with no registry credential. The **host admin
> token** authorizes catalog publishing and other admin routes on your host's
> `/api/*`; you mint it and decide how `requireAdmin` validates it. A bad or
> missing value returns 401 or 403 from your service. Model and upstream API
> credentials are separate server-side configuration.

---

## 3. Install

Run each side's install as **one command**. Two installs taken at different
times can pull two different builds of `@renderyes/core` into one tree.

### Frontend

```bash
npm install @renderyes/react @renderyes/starter-catalog
# or
pnpm add @renderyes/react @renderyes/starter-catalog
# or
yarn add @renderyes/react @renderyes/starter-catalog
```

`react` and `react-dom` `>=18` are peers — you already have them.

### Backend

```bash
npm install @renderyes/server @renderyes/starter-catalog
# or
pnpm add @renderyes/server @renderyes/starter-catalog
# or
yarn add @renderyes/server @renderyes/starter-catalog
```

`starter-catalog` is on the backend list because your service publishes the
starter components' **definition twins** (§7). Without it, the service cannot
import `createDataTable` / `createBarChartDefinition` and the planner has
nothing to draw the starter shapes with.

Under **pnpm or Yarn**, also declare anything your service imports directly:

```bash
pnpm add @renderyes/site-sdk @renderyes/capability-catalog   # code-first catalog route
```

### Charts

The chart *views* are the only thing in the suite that needs `recharts`. It is
an optional peer:

```bash
npm install recharts        # frontend only
```

Then import the rendering components from the charts entry:

```js
import { createBarChart, createDonutChart, createLineChart } from "@renderyes/starter-catalog/charts";
```

> **This trips people.** On the **server** you import the recharts-free
> contract factories from the main entry instead:
>
> ```js
> import {
>   createBarChartDefinition,
>   createDonutChartDefinition,
>   createLineChartDefinition,
> } from "@renderyes/starter-catalog";
> ```
>
> The server publishes contracts and never renders, so it must never need a
> recharts install. Importing `@renderyes/starter-catalog/charts` in a
> backend fails at boot. Import the server-safe
> `createBarChartDefinition()` factory there.

### The reference guides ship with the server package

After installing, the integration documents are on disk at
`node_modules/@renderyes/server/docs/`:

| File | Covers |
|---|---|
| `QUICKSTART.md` | Shortest path from empty `node_modules` to a composed view |
| `INTEGRATION.md` | Backend wiring, publishing, cost controls, and persistence |
| `AUTHORING_VIEWS.md` | The component contract, written to hand to whoever writes components |
| `CATALOG.md` | The code-first catalog recipe in full |
| `API.md` | Public behavior and defaults |
| `TROUBLESHOOTING.md` | Symptoms, causes, and fixes |
| `HOST_INTEGRATION_STEPS.md` | The integration sequence at a glance |
| `EXAMPLE_HOST.md` | The example domain used throughout the guides |

This guide is the on-ramp; those are the reference. Where this guide says "see
`INTEGRATION.md`", that is the file it means.

---

## 4. Backend: mount the service

`createViewServer` builds the pipeline. `createViewHttpHandler` puts it behind
the routes `@renderyes/react` expects, as one fetch-standard
`(Request) => Promise<Response>`. `toNodeHandler` adapts that to `node:http` and
framework adapters that expose raw Node request and response objects. A
Node-runtime framework that accepts web `Request` and `Response` objects can
forward its supported methods to the handler directly.

**Write the handler, not individual routes.** Their paths are a contract with
the client.

### The four fields with no default

These will not let you skip them quietly. Read this list before you write the
config.

| Field | Where | What happens if you get it wrong |
|---|---|---|
| `requireAdmin` | `createViewHttpHandler` | **Required, and required to be a function.** Every possible default is wrong: open ships a publish endpoint an anonymous caller can use to replace your capability catalog; closed breaks the review UI with a 403 that looks like our bug. A dev host with no admin concept can pass `() => true` — but it will be written down and greppable. |
| `allowedUpstreamOrigins` | `createViewServer` | **Fails closed.** An absent or empty list rejects *every* destination at execution time. Name your origins even when the only capability server is your own process (`["http://127.0.0.1:4000"]`). Compared by parsed origin — scheme, host, and port — never by string prefix. |
| `resolveViewOwner` | `createViewServer` | Required by every path that looks a plan up by id: **refine, revise, save, pin, and the panel rearrange**. Absence is a refusal, not a pass — without an owner key any caller holding a `planId` could act on another visitor's view. Only a host that composes statelessly can omit it. |
| `graphql.resolveProvenance` | `createViewServer` | Required to publish a GraphQL catalog at all: `publishReviewedCatalog` rejects a `bindingKind: "graphql"` payload without it. Every returned row is attributed to a source; without the resolver each request fails with `PROVENANCE_UNAVAILABLE` *after* it already has data. `resolveHeaders` is the sibling that attaches upstream credentials, and it receives `endpoint` and `destinationOrigin` so you can vary credentials by destination. |

### The service module

This example uses the fictional Bharat Times host: Payload CMS with a generated
GraphQL endpoint, no visitor authentication, and anonymous visitors keyed by a
cookie.

```js
// renderyes-service.mjs
import { timingSafeEqual } from "node:crypto";
import {
  createViewServer,
  createViewHttpHandler,
  createMemoryViewStore,
} from "@renderyes/server";
import { typeDefs } from "./schema.js";

const UPSTREAM_ORIGIN = `http://127.0.0.1:${process.env.PORT || 4000}`;

// Your app's own notion of "who is asking". This package never reads a
// request header itself — it hands `request` straight to you.
function readVisitorId(request) {
  const cookieHeader =
    typeof request?.headers?.get === "function"
      ? request.headers.get("cookie")
      : request?.headers?.cookie;
  if (!cookieHeader) return undefined;
  const match = /(?:^|;\s*)app_visitor=([^;]+)/.exec(cookieHeader);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export const viewServer = createViewServer({
  // Resolve your own session from the real request — a verified cookie, a
  // bearer token, whatever your app already does. Throw `UnauthenticatedError`
  // (exported from @renderyes/server) to return 401. A browser cannot offer a
  // login prompt on a 400.
  resolveSession: (request) => ({
    userId: "local-user",
    visitorId: readVisitorId(request),
  }),

  // The ONLY adapter allowed to inspect a session. Scopes exactly what a
  // capability runtime can see — never the whole session object.
  host: {
    isAuthenticated: (session) => Boolean(session?.userId),
    hasPermission: (session, permission) => session.permissions?.has(permission) ?? false,
    getSessionValue: (session, key) => session?.[key],
  },

  // Fails closed. An empty list rejects everything.
  allowedUpstreamOrigins: [UPSTREAM_ORIGIN],

  // Required for a GraphQL publish.
  graphql: {
    resolveHeaders: () => ({}),
    resolveProvenance: ({ sourceId }) => ({
      sources: [{ sourceId }],
      freshness: { asOf: new Date().toISOString() },
    }),
  },

  // Required for planning. `apiKeyEnv` is an environment variable NAME, never
  // the credential. An entry may instead be `{id, plans}` — a plan you supply,
  // for running the pipeline without a model.
  planProviders: [
    { id: "openai", apiKeyEnv: "OPENAI_API_KEY", model: process.env.OPENAI_MODEL || "gpt-4o" },
  ],

  // Saved views. In-memory and therefore per-process: views vanish on
  // restart and are not shared between instances. This example assumes the
  // host creates a unique app_visitor cookie before RenderYes requests run.
  viewStore: createMemoryViewStore(),
  resolveViewOwner: (session) => {
    if (!session?.visitorId) throw new Error("Missing app_visitor cookie");
    return session.visitorId;
  },

  // One compact line per compose. Wrapped by the server, so a logging
  // failure can never fail a compose. No prompt text, no fetched rows.
  onComposeMetrics: (metrics) => {
    console.log("[renderyes compose] " + JSON.stringify({
      outcome: metrics.outcome,
      totalMs: metrics.totalMs,
      planMs: metrics.planMs,      // model generation
      dataMs: metrics.dataMs,      // your upstream
      modelCalls: metrics.modelCalls,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cached: metrics.cached,
      capabilities: metrics.capabilityCount,
      failedRequests: metrics.failedRequestCount,
    }));
  },
});
```

### A timing-safe `requireAdmin`

Compare a shared secret with `timingSafeEqual`, length-checked first (it throws
on a length mismatch), and treat an unset secret as a decision you have not
made — refuse.

```js
const ADMIN_TOKEN = process.env.RENDERYES_ADMIN_TOKEN ?? "";

function matchesAdminToken(presented) {
  // Unset secret ⇒ every admin request is refused. Visitor routes
  // (compose, refine, views) are unaffected.
  if (!ADMIN_TOKEN || !presented) return false;
  const expected = Buffer.from(ADMIN_TOKEN, "utf8");
  const actual = Buffer.from(presented, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export const viewHttpHandler = createViewHttpHandler(viewServer, {
  requireAdmin: (request) =>
    matchesAdminToken(request.headers.get("x-renderyes-admin-token")?.trim() ?? ""),

  // Off unless supplied. Same-origin deployments need none. No wildcard:
  // reflecting the request's own Origin is worse than a wildcard once
  // Allow-Credentials is true.
  cors: {
    allowedOrigins: [
      "http://localhost:4000",
      "http://127.0.0.1:4000",
      "http://localhost:5173",   // Vite dev server
    ],
  },

  onError: (error) => console.error("[renderyes] handler error:", error),
});
```

`requireAdmin` is **not** a user role. Even where `hasPermission` is real, "may
use the product" and "may redirect the server's outbound requests" are
different authorities.

`onError` is the handler's. Its companion `onEvent` is **not** — it observes one
compose as it runs, so it belongs on the call, not on the server:

```js
const result = await viewServer.composeAgainstPublishedCatalogs({
  catalogId,
  prompt,
  request,
  onEvent: (event) => log(event),
});
```

Passing `onEvent` to `createViewServer` does nothing: the factory takes no such
option, and a scaffolded `server.mjs` is plain JavaScript, so nothing type-checks
the mistake. The streaming HTTP route sets it up itself; supply it directly only
when you call `compose` yourself.

### Route the RenderYes API paths through it

```js
// server.js
import { createServer } from "node:http";
import { VIEW_HTTP_ROUTES } from "@renderyes/server";
import { toNodeHandler } from "@renderyes/server/node";
import { viewServer, viewHttpHandler } from "./renderyes-service.mjs";

const renderYesApi = toNodeHandler(viewHttpHandler);
const renderYesPaths = new Set(VIEW_HTTP_ROUTES.map((route) => route.path));

// Catalogs are in-memory because a published capability holds a live executor
// closure. This replays the recorded publish inputs. Call it ONCE, before
// listen(), and only when you configured `catalogStore`.
const restored = await viewServer.restorePublishedCatalogs();
for (const failure of restored.failures) {
  console.error(`Could not restore ${failure.kind} catalog "${failure.id}": ${failure.reason}`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  const pathname =
    url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;

  // Only the fixed RenderYes paths. Other /api routes remain owned by the host.
  if (renderYesPaths.has(pathname)) {
    return renderYesApi(req, res);
  }

  // ... your existing routing
});

server.listen(process.env.PORT || 4000);
```

In a fetch-native Node framework, forward each method on the paths in
`VIEW_HTTP_ROUTES` to `viewHttpHandler`; the exact route-adapter syntax is
framework-specific.

### Surviving a restart

Both registries are in-memory and have to be. What *is* persistable is the
publish input, and replaying it at boot is the same function with the same
argument. Set `catalogStore` and the package does the write-through:

```js
import { createFileCatalogStore } from "@renderyes/server/node";

createViewServer({
  catalogStore: createFileCatalogStore(new URL("./data", import.meta.url)),
  // ...
});
```

`createFileCatalogStore` writes one JSON file per catalog, which an operator
can list, diff, and delete by hand. Then `await restorePublishedCatalogs()` at
boot, as above. If restoration is omitted, the "no published catalog" error
says so explicitly when a store is configured and no
restore has run. A record that no longer validates is reported, not thrown —
one stale catalog does not stop the process serving the others.

### Limits worth knowing

| Limit | Default | Why |
|---|---|---|
| `ModelProviderConfig.timeoutMs` | 60s | Per model call. |
| `ViewServerConfig.composeDeadlineMs` | 45s | Wall clock across the whole request — planning *and* execution. Reported on the envelope and on `RUN_STARTED` so a client can derive its timeout. Refine and reopen draw from it too. |
| `ViewServerConfig.planDeadlineMs` | 40s | Wall clock across the planning phase, every repair attempt included. Clamped to sit inside `composeDeadlineMs`. |
| Prompt length | 2000 chars | Rejected before the provider is called, so an oversized prompt costs nothing. |
| `maxConcurrentRequests` | 6 | A twelve-capability plan otherwise opened twelve simultaneous connections to your own API. |
| `contractTokenBudget` | 25,000 | Approximate tokens of planning contract past which a publish reports itself over budget, with the levers named. A warning; nothing is refused. |
| `contractTokenCeiling` | none | Set it to refuse such a publish outright, before anything is persisted. No default, because a publish that starts refusing a catalog you have been serving is worse than the cost you already have. |
| `maxBodyBytes` | 4 MB | Checked before the body is buffered and *after* `requireAdmin`, so a refused caller cannot make the process allocate. |

---

## 5. Publish a catalog

**Nothing composes until a capability catalog is published.** Publishing is
what turns an approved catalog into an executable runtime plus a planner-safe
manifest.

### What the decisions file actually is

You decide, field by field, what a visitor may read. Not "connect the API" —
each capability names its approved output fields, which arguments a *plan* may
set, and which arguments *you* inject from the session:

- `approvedVisitorArguments` — the plan may set these.
- `approvedInputFields` — *which parts* of those arguments a plan may set,
  keyed by dotted input path (`"where.publishedAt"`). Optional; omit it and the
  whole argument is approved.

  Use it on broad filter inputs. Approving Payload's `where` without it puts
  every filterable column and operator into the planning contract, recursively
  through `AND`/`OR`. `contractCost` reports the actual size; approve only the
  paths a visitor needs.

  Two things to know. Combinators are transparent to these paths, so
  `where.publishedAt` reaches the column through any `AND`/`OR` grouping rather
  than making you enumerate every route to one decision. And an approved path
  carries its field's whole shape: real filter APIs wrap each column in an
  operator object, so approving the column approves the operators on it —
  declare a deeper path (`where.publishedAt.greater_than`) to narrow within one.

  An allowlist, not a denylist: a denylist over a self-nesting input type cannot
  be written completely. A path that matches nothing, or that prunes a required
  field, refuses the compile; an unpruned argument over 8KB compiles with a
  warning naming its candidates.
- `orderingArgument` — how *your* API spells a sort, when its schema cannot say.
  Optional, and only needed for one specific shape: an ordering argument typed
  as a bare string.

  Everything else in a request vocabulary arrives typed. A filter argument
  publishes its fields, operators, and value types through introspection, so the
  plan contract offers the model a closed menu and it has nothing to invent. An
  argument typed `sort: String` publishes none of its grammar — which prefix
  means descending, whether several fields may be combined — because that lives
  in your API's parser and its docs. A model handed a bare string guesses, its
  guesses are plausible, and an upstream that cannot parse an ordering
  expression may ignore it without failing. "The three newest" then comes
  back as three arbitrary rows in a convincing order.

  Declaring the grammar moves the writing from the model to us. The plan keeps
  asking for ordering the way it always has — typed `query.sort` terms — and the
  runtime renders your string:

  ```jsonc
  // The JSON:API convention most REST-derived CMS schemas inherited
  "orderingArgument": {
    "name": "sort", "ascending": "{field}", "descending": "-{field}",
    "separator": ","
  }
  // The other popular spelling; `separator` is omitted because this argument
  // takes a list, so each term is already its own element
  "orderingArgument": {
    "name": "sort", "ascending": "{field}:asc", "descending": "{field}:desc"
  }
  ```

  No spelling is built in. Two widely-used CMSes disagree about this one, so a
  default would be silently wrong for one of them — and guessing from an
  argument's *name* is the same class of false advertisement the rest of this
  file exists to avoid.

  Declaring an argument means the plan may no longer set it, so drop it from
  `approvedVisitorArguments` — the compile refuses the overlap and says so.
  Ordering that the schema *does* type (an enum, an input object) needs nothing
  here: approve that argument normally and the model is offered its real values.

  Two things follow at run time. A sort that reaches the source lets your plan's
  limit go with it, so a top-N covers the full collection. The rows are also
  checked against the ordering that was sent: if they
  come back in some other order the request is refused with
  `ORDERING_NOT_APPLIED`, because a grammar your upstream silently dropped would
  otherwise hand back the wrong rows with no sign of it.

  Without a declaration, nothing changes: sorting applies to the fetched page,
  the result is marked `narrowedAfterFetch`, and a capability that can be sorted
  with no way to send the sort compiles with a warning that names this field.
- `identityArguments` — you inject these from the session; the model never
  sees or sets them.
- `approvedOutputFields` — the generated operation selects **only** these. An
  unapproved field is not filtered out of a result; it is never requested. A
  prompt that needs it gets a refusal, and the fix is a decisions change — a
  reviewed diff — not a prompt change.
- The same argument cannot be both visitor-owned and identity-owned. A required
  argument owned by neither fails compilation.

**Field paths are row-relative.** `match.score`, not `edges.node.match.score`:
discovery unwraps Relay connections and describes the row, because the row is
what you review and what a component binds to. The transport wrapper never
appears in a decisions file.

You publish **two** catalogs, and compose needs both under the same
`catalogId`: the **capability catalog** (what data may be read) and the **UI
catalog** (which components may render it).

### Route A — the review UI

Interactive exploration of a schema you don't yet know. Right for a first look
at what discovery finds.

```bash
export RENDERYES_HOST_URL=http://127.0.0.1:4000   # YOUR host, the one mounting /api
export RENDERYES_ADMIN_TOKEN=...                  # whatever your requireAdmin accepts
npx @renderyes/catalog-review
```

- `--host-url` works as a flag if you prefer it to the environment variable.
- The token is sent as **`x-renderyes-admin-token`** by default. If your
  `requireAdmin` reads a different header, set `RENDERYES_ADMIN_HEADER` to
  its name.
- The UI binds `127.0.0.1` only (`http://127.0.0.1:4173`) and has no login. It
  proxies an allowlist of `/api` calls **server-side**,
  attaching your admin token there — so the browser never holds the
  credential.
- Publishing posts to `POST /api/catalog` on *your* host, behind *your*
  `requireAdmin`. If the review UI cannot reach your host, it is a proxy in
  front of nothing: "connection refused" means your host is not running.

The detailed GraphQL flow can export its decisions file. **That file is the
durable review artifact** — keep it in your repository. Two CLI helpers keep it
valid across package upgrades and schema changes:

```bash
npx --package @renderyes/capability-catalog renderyes-catalog migrate --decisions decisions.json --write
npx --package @renderyes/capability-catalog renderyes-catalog diff --inventory inventory.json --decisions decisions.json
```

`migrate` performs the mechanical upgrades between formats and prints
every rewrite. `diff` reports what needs a decision and exits non-zero when
something does, so a pipeline can gate a republish on it.

### Route B — code-first

The catalog as source in your own repository, published on boot,
deterministically, with no browser. Every decision goes through code review
like any other change. A schema change that invalidates a decisions file fails
the boot. Use this route when the catalog must be
reproducible in production.

Currently GraphQL-specific. Four steps: inventory → decide → compile → publish.

> **A note on names.** *Inventory* is the machine's reading of your schema:
> what could be offered, hash-locked, not yours to edit. *Decisions* is yours:
> what a visitor may actually read. The CLI, the flags, the file names and the
> library symbols all use those two words. The JSON field names inside the files
> (`reviewSourceHash`, `approvedOutputFields`) still say "approved", because
> those are the format — and they are accurate: those are the fields you
> approved.

```js
// renderyes-service.mjs, continued
import {
  createGraphQlCatalogInventory,
  compileApprovedGraphQlCatalog,
} from "@renderyes/capability-catalog/graphql";

// ── 1. DRAFT: what the schema offers ────────────────────────────────
// Throws immediately on a fieldName the schema lacks, so a schema rename
// fails here — with the field's name — not at compose time as a refusal.
const draft = createGraphQlCatalogInventory({
  schema: typeDefs,                       // SDL text or introspection JSON
  catalog: {
    id: "bharat-times",                      // THE catalogId everything keys on
    version: "1.0.0",
    description: "Published content of The Bharat Times.",
  },
  source: {
    id: "bharat-times-cms",
    label: "The Bharat Times",
    description: "The newsroom's own Payload CMS.",
  },
  queries: [
    {
      fieldName: "Posts",                 // the schema's root field
      capabilityId: "bharat-times.posts.list",  // your stable name for it
      // Planner-facing prose. The model reads this to choose a capability —
      // write it like documentation, not like a variable name.
      purpose:
        "Published news articles from The Bharat Times, with headline, summary, " +
        "publication time, hero image, and the sections they appear in. Rows " +
        "arrive in no meaningful order unless sorted: whenever recency matters, " +
        "sort by publishedAt.",
      dataTypeId: "Article",
      dataTypeDescription: "One published news article.",
      resultShape: "collection",          // collection | entity | metric | …
      // Payload wraps every list in { docs, totalDocs, hasNextPage }. Declare it
      // once and every path below is row-relative: "title", not "docs.title".
      listEnvelope: {
        rowsField: "docs",
        totalCountField: "totalDocs",
        hasNextPageField: "hasNextPage",
        pageSizeArgument: "limit",
        pageArguments: ["page"],
      },
      // Payload emits DateTime, its enums and its filter inputs as custom
      // scalars, and discovery refuses to compile while a reachable one has no
      // mapping. The full table for this schema is longer; the compile error
      // names each one it still needs.
      scalarMappings: {
        DateTime: { schema: { type: "string" }, semanticType: "date-time" },
        JSON: { schema: {} },
        Post__status: { schema: { type: "string" }, semanticType: "status" },
        Post_where: { schema: { type: "object" } },
      },
      fields: {
        id: { label: "Id", semanticType: "identifier" },
        title: { label: "Headline", semanticType: "text" },
        slug: { label: "Slug", semanticType: "identifier" },
        publishedAt: { label: "Published", semanticType: "date-time" },
        "meta.description": { label: "Summary", semanticType: "text" },
        "heroImage.url": { label: "Image", semanticType: "image-url" },
        "categories.title": { label: "Section", semanticType: "text" },
      },
      // Never defaulted. You opt in to filter/sort/group/aggregate here, in
      // the capability's shape — not in the approval, which is authorization.
      supports: {
        filterFields: ["title", "publishedAt", "categories.title"],
        sortFields: ["publishedAt", "title"],
        groupFields: ["categories.title"],
        aggregates: ["count"],
      },
    },
  ],
});
```

> **`groupBy` and `aggregates` are computed in memory, over the rows actually
> fetched.** So is `sort`, unless the capability declares an `orderingArgument`
> your upstream can order by; `filter` pushes down through the arguments you
> approved, and falls back to the fetched page for anything they cannot express.
> An aggregate over a result the upstream cut short is refused with
> `TRUNCATED_AGGREGATION`. "How many per status" over the
> one page a capped upstream returned would report that page's counts as the
> dataset's, which is a clean number that looks exactly like the answer and is
> wrong. Narrow the question with a filter, or raise the capability's page
> allowance. An aggregate over rows a plan asked for outright — the top 10 —
> is legitimate and still works.

```js

// ── 2 + 3. APPROVE and COMPILE: what you accept ─────────────────────
// The compile re-hashes the schema and the draft and refuses on any drift.
// In a boot-time publish all three hashes are seconds apart, so drift here
// almost always means a typo — and the error names it.
const compiled = compileApprovedGraphQlCatalog(typeDefs, draft, {
  schemaVersion: "1.0",
  reviewSourceHash: draft.reviewSourceHash,
  queries: [
    {
      capabilityId: "bharat-times.posts.list",
      // Paging is steering the plan may do. `sort` is declared below rather
      // than approved; `where`, `draft` and `trash` are not approved at all.
      approvedVisitorArguments: ["limit", "page"],
      // How Payload spells an ordering — "-publishedAt" is newest first.
      orderingArgument: { name: "sort", ascending: "{field}", descending: "-{field}", separator: "," },
      identityArguments: {},              // e.g. { subscriberId: "userId" }
      approvedOutputFields: [
        "id", "title", "slug", "publishedAt", "meta.description", "heroImage.url", "categories.title",
      ],
      requiredOutputFields: ["id", "title"],           // always selected
      policy: {
        authentication: "public",         // or "session"
        requiredPermissions: [],
        maximumRows: 25,
        timeoutMs: 10_000,
      },
      limits: { maximumSelectionDepth: 4, maximumSelectedFields: 20 },
    },
  ],
});

// ── 4. PUBLISH the capability catalog ───────────────────────────────
// ASYNC. It persists the publish input through catalogStore so a restart can
// replay it. A publish that isn't awaited can report a boot as complete while
// the only durable trace of the catalog failed to write.
const published = await viewServer.publishReviewedCatalog({
  bindingKind: "graphql",
  catalog: compiled.catalog,
  bindings: Object.fromEntries(compiled.bindings),   // wire shape is a record, not a Map
  schema: typeDefs,
  endpoint: `${UPSTREAM_ORIGIN}/graphql`,            // must be in allowedUpstreamOrigins
});
console.log(`catalog published: ${published.catalogId} (${published.capabilityCount} capabilities)`);
```

Log that summary at boot. `capabilityCount` and `executableCapabilityCount`
should match. `uiCatalogRegistered` and `unrenderableDataTypes` tell you
whether the other half is in place. `contractBytes` / `approximateTokens` is
the planner contract you pay for on every plan attempt.

`contractCost` and `contractBudget` are the same number made actionable.
`contractCost.capabilities` ranks every capability by what its contract entry
costs, and `contractCost.facets` says what each `supports` facet contributes if
you stop advertising it. Synthetic catalog measurements show these approximate
effects:

| lever | what it returns |
|---|---|
| stop advertising `filterFields` where it isn't needed | ~73% of the contract |
| halve the capability count | ~50% (the cost is linear, ~4,800 bytes each) |
| cut a projection from 12 fields to 4 | ~17% |

The filter vocabulary dominates because its operator grammar is carried once per
nesting level the model may author, per capability. Projected field count has a
smaller effect than filter support or capability count in these measurements.

`contractBudget` compares the cost against `contractTokenBudget` (default
25,000 approximate tokens) and, when over, carries the advice with your own
heaviest capabilities named. It is a warning: nothing is refused. Set
`contractTokenCeiling` to make it a refusal, checked before anything is
published or persisted. Worth knowing why the ceiling exists at all: a provider
handed a structured schema it won't accept does **not** fail the compose — it
retries in unconstrained JSON mode, which costs an extra model call per attempt
and decodes worse. So going too far shows up as a quality regression, not an
error, and this is the last place that can say so.

Then the UI catalog (§7 covers what goes in `componentDefinitions`):

```js
import { defineSite, defineSurface, toSiteManifest } from "@renderyes/site-sdk";

// ALSO ASYNC, for the same persistence reason. Await it.
const uiPublished = await viewServer.publishUiCatalog({
  manifest: toSiteManifest(
    defineSite({
      id: "bharat-times",
      name: "The Bharat Times",
      version: "1.0.0",
      catalogId: "https://localhost/renderyes/bharat-times.json",
      components: componentDefinitions,
      surfaces: [
        defineSurface({
          id: "main",
          description: "Answers composed from published Bharat Times content.",
          componentIds: componentDefinitions.map((c) => c.id),
        }),
      ],
    }),
  ),
  // Optional; defaults to the site's own id. Compose looks the UI catalog up
  // by the CAPABILITY catalog id, so name it whenever the two differ — a site
  // called "<catalog>-ui" publishes fine and then finds nothing at compose time.
  catalogId: "bharat-times",
});
```

Log this summary too. It answers the same question from the other side:
`capabilityCatalogRegistered` says whether a capability catalog is filed under
the id this UI catalog just claimed, and `unrenderableDataTypes` names the
approved data types none of these components accepts. That is what makes the
`"<catalog>-ui"` mistake above visible from the side that makes it.

Run all of this at boot, in the same module that mounts
`createViewHttpHandler`, **before serving requests**.

### Verify before you trust it

Publishing validates the *shape* of a catalog, not whether your upstream will
serve it. A schema can declare an argument optional and require it in the
resolver, and that field then fails every row at compose time. One call
settles it:

```bash
curl -s -X POST "http://127.0.0.1:4000/api/catalog/probe" \
  -H 'content-type: application/json' \
  -H "x-renderyes-admin-token: $RENDERYES_ADMIN_TOKEN" \
  -H "$YOUR_OWN_SESSION_HEADER" \
  -d '{"catalogId":"bharat-times"}'
```

**Both credentials, not just the admin one.** The route is admin-gated, and
that is not the whole story: the probe *executes* your capabilities, and any
that declare `authentication: "session"` need the request to also carry whatever
your own `resolveSession` reads — a signed cookie, a bearer token, a header
your app already uses. RenderYes never inspects it and has no opinion on its
shape, so there is no header to copy from here; send what a visitor request
sends. Admin authorizes the probe; the session is what it probes *with*, and
what your upstream actually sees. Add `"checkUpstreamCredential": false` to the
body to check shape without executing — useful in CI, where you have an admin
token and no visitor.

Each capability comes back `ok`, `failed` with the upstream's own reason, or
`skipped` when it needs parameters the probe will not invent. A capability
whose parameters are *all* optional is never skipped — there is nothing to
refuse to invent — so if such a capability fails, the entry says it probed
without them and names which. Worth wiring into the same boot script, after
the publishes.

### Credentials for the upstream

Never name an environment variable in a publish payload. Declare an opaque id
up front and reference only that:

```js
createViewServer({
  upstreamCredentials: { "support-api": "SUPPORT_API_TOKEN" },
  allowedUpstreamOrigins: ["https://api.internal.example"],
});
```

The publish call may reference `"support-api"` and nothing else, so it cannot
reach any other secret in the process; an unrecognised id is rejected rather
than resolved. The token is read from `process.env` per request, so rotating it
takes effect without republishing.

`allowedUpstreamOrigins` is checked in three places, not just `baseUrl`: a
binding's `serverUrl` (which replaces the base outright) and a binding's
`path` (because `new URL(path, base)` discards `base` when `path` is absolute
or protocol-relative). A GraphQL `endpoint` is re-checked at execution time,
immediately before credentials are attached. Narrowing the list immediately
revokes matching requests from an already-published catalog.

---

## 6. Frontend: mount the provider

```jsx
import { ViewProvider, ViewWorkspace, ViewLauncher } from "@renderyes/react";
import { components } from "./renderyes/components";

// Dev: your bundler proxies /iv → backend. Prod (same origin): "".
const serviceUrl = import.meta.env.DEV ? "/iv" : "";

function Root() {
  const [showWorkspace, setShowWorkspace] = useState(false);

  return (
    <ViewProvider
      config={{
        serviceUrl,
        catalogId: "bharat-times",    // must equal the published capability catalog id
        components,
        renderMode: "host",
      }}
    >
      {showWorkspace ? (
        <ViewWorkspace
          suggestions={[
            "Show me the latest stories as cards",
            "How many articles have you published?",
            "Show me the politics coverage",
            "Tell me some facts",
          ]}
          placeholder="Ask about what we've published…"
          exitLabel="Back to the front page"
          onExit={() => setShowWorkspace(false)}
        />
      ) : (
        <>
          <App />
          <ViewLauncher label="Ask" onOpen={() => setShowWorkspace(true)} />
        </>
      )}
    </ViewProvider>
  );
}
```

### `catalogId` must match

`catalogId` must equal the `id` of the capability catalog you published. A
value that merely *looks* right — the site's own id, a slug — resolves no
components and composes nothing, with no error to say why.

### `renderMode`: where views render

| Mode | Where views render | When |
|---|---|---|
| `"isolated"` (default) | Inside a Shadow DOM boundary | A third-party or embedded widget, or any host that has not registered first-party components sharing its design system. Host CSS cannot break it and its styles cannot leak onto the page. |
| `"host"` | Directly in the host page's DOM | Your registered components are trusted first-party code meant to look native to the site. |

In `"host"` mode a registered component renders with **your own** Tailwind
classes, design tokens, dark mode, and responsive rules applying exactly as they
would anywhere else on the page. If your components are your own and share your
stylesheet, `"host"` is the mode you want.

**Both modes get the chrome stylesheet** — in the shadow root or in
`document.head`. This preserves focus rings, dark-mode media queries, and host
overrides in either mode. Every rule is namespaced under `.renderyes-scope`, so
injecting it cannot touch the rest of the page.

That has two consequences worth knowing:

- **The chrome follows the visitor's colour scheme** in both modes, and honours
  ten custom properties you can set anywhere that inherits into the view —
  `--iv-accent`, `--iv-fg`, `--iv-muted`, `--iv-surface`,
  `--iv-surface-subtle`, `--iv-border`, `--iv-danger`, `--iv-radius`,
  `--iv-font`, `--iv-accent-fg`. Custom properties cross a shadow boundary and
  form the theming API.
- **Plain CSS on `.renderyes-*` class names works** in host mode.

`--iv-font` and the starter components' `--iv-starter-font` default to
`inherit`, so composed views use your typeface.

### `ViewWorkspace` vs `ViewLauncher`

- **`ViewLauncher`** is a floating button plus a fixed-size overlay panel. A
  long or multi-panel result gets clipped to whatever fits in that box. Pass
  `onOpen` and the component owns only the button — no panel renders — which
  is how you keep the floating entry point while routing to a real page.
- **`ViewWorkspace`** is a full-page block sized by your own page layout. Same
  compose lifecycle, same registered components, same `renderMode`. You own
  the surrounding page; it owns the prompt bar and the result beneath it.

In both, once a view exists what the visitor types is read as a **change** to
it, with an explicit "start over" escape hatch. The UI control supplies the
intent because prompt text alone does not reliably distinguish the two cases.

### Suggestions chips

`suggestions` is host-written prose rendered as one-click chips on the empty
workspace **and inside refusals** as "what you can ask instead". Nothing here
is model-generated or catalog-derived, so a chip can never promise something
you did not choose to promise. Write them from what you actually approved.

### `savedViews` and `rearrange`

Both default to **on**. Turn them off when your server cannot back them:

```jsx
<ViewWorkspace savedViews={false} rearrange={false} />
```

- **`savedViews={false}`** if your server has no `viewStore`. The client cannot
  detect that on its own — the saved-view routes answer with the same
  `400 {ok, error}` envelope as any rejected request, with no
  machine-readable kind. Left on, the controls render and every use surfaces
  the hook's normal error copy.
- **`rearrange={false}`** if your server has no `resolveViewOwner`. `/api/refine`
  is plan-addressed, so a server with no owner to check a `planId` against
  refuses it with `kind: "visitor-identity-required"`. Setting the prop avoids
  offering a control that cannot persist.

Want different saved-view UI entirely? Pass `savedViews={false}` and build from
`useViewCompose()` — `save`, `pin`, `listSaved`, `reopen` and `deleteSaved` are
all on the hook. That, not more props, is the customisation path.

### Attaching the visitor's credential

`credentials: "include"` is always sent, so a host using an httpOnly session
cookie needs nothing. A host that reads a token out of `localStorage` or an
in-memory auth store wires it here — and **refreshes it inside the hook**:

```js
// Wrong whenever the token expires: sends whatever was last written.
getAuthHeaders: () => ({ authorization: `Bearer ${localStorage.getItem("access_token")}` })

// Right: the same refresh your own transport performs.
getAuthHeaders: async () => ({ authorization: `Bearer ${await auth.getValidToken()}` })
```

An SPA that renews its token inside an Apollo link or axios interceptor renews
it only for requests through that layer. RenderYes's requests do not go
through it, so a page left open long enough sends a token that expired while it
sat there — and the visitor is told they lack a permission they hold, three
hops from the cause.

---

## 7. Registering components

### Starter components first

The starter catalog accepts data by **shape** (`collection`, `entity`,
`metric`, `search-results`, `time-series`, `media-collection`), never by your
type names, so it works against any approved catalog on day one.

Two of them take `entity`, and both are worth registering: `createDetailPanel`
shows scalars as rows and each nested object as its own titled group, while
`createRecordWithLines` additionally renders arrays *inside* the record as
tables — an order with line items, an invoice with charges. Register both and
let the planner choose.

```jsx
import {
  createMetricCard,
  createDataTable,
  createCardGrid,
  createItemList,
  createMediaGallery,
  createDetailPanel,
  createRecordWithLines,
} from "@renderyes/starter-catalog";
import { createBarChart, createDonutChart, createLineChart } from "@renderyes/starter-catalog/charts";

// Host-owned links: the model never sees or influences these URLs. A row with
// a slug is an article and clicks through to it; rows without one stay inert.
const articleHref = (record) =>
  typeof record.slug === "string" && record.slug ? `/posts/${record.slug}` : undefined;

export const components = [
  createMetricCard(),
  createDataTable({ searchable: true, sortable: true, getRowHref: articleHref }),
  createCardGrid({ titleKey: "title", getCardHref: articleHref }),
  createItemList({ titleKey: "title", getItemHref: articleHref }),
  createMediaGallery(),
  createDetailPanel(),
  createRecordWithLines(),
  createBarChart(),
  createDonutChart(),
  createLineChart(),
];
```

Every option passed here — `searchable`, `getRowHref`, `titleKey` — is
**rendering-only**. It changes how a component renders, never its published
contract, so the server-side definitions stay untouched when you tune them.
Each factory also handles loading, empty, and error states itself and shows
provenance (source and as-of) by default. They theme through
`--iv-starter-*` custom properties and `iv-starter-*` class names, or go fully
host-styled with `unstyled` + `classNames`.

They are also identifier-aware: a field whose name ends in `id`, `uuid`, or
`key` is pushed to the end of a table's columns and a detail panel's rows,
rendered with muted styling, and skipped when picking a card title
or a chart's category axis — a field ending in `name`, `title`, or `label` wins
instead. So an approved catalog whose first field happens to be `id` does not
produce a grid of opaque identifiers.

### Bespoke components

Two ways, both fine:

**`defineHostComponent`** — the lower-level call, for a component built by a
factory or registered inline:

```jsx
import { defineHostComponent, defineProps, field } from "@renderyes/react";
import { BharatTimesStoryListView } from "./components/BharatTimesStoryList.jsx";

const storyList = defineHostComponent({
  id: "BharatTimesStoryList",
  version: "1.0.0",
  // The planner reads this to decide when to prefer this component. Say when.
  description:
    "Editorial story list for published Bharat Times articles. Prefer it when the " +
    "visitor asks to browse, scan, or compare several news stories; it presents " +
    "headlines, sections, summaries, and publication dates in the paper's house style.",
  props: defineProps({ heading: field.string({ default: "From The Bharat Times" }) }),
  dataSlots: {
    stories: { accepts: [{ dataTypeId: "Article", shapes: ["collection"] }] },
  },
  component: BharatTimesStoryListView,
});
```

**The folder convention** — one file per component, each a `defineView` plus a
default export, ingested as a folder. Nothing lists the components, so adding
one is adding a file:

```jsx
// src/renderyes/views/puzzles.view.jsx
import { defineView } from "@renderyes/react";

export const spec = defineView({
  id: "BharatTimesPuzzleList",
  version: "1.0.0",
  description:
    "Puzzle index showing published crossword, sudoku, and quiz entries with " +
    "difficulty and date. Prefer it when the visitor asks which puzzles are available.",
  props: { heading: { type: "string", default: "Puzzles & Pastimes" } },
  dataSlots: {
    puzzles: { accepts: [{ dataTypeId: "Puzzle", shapes: ["collection"] }] },
  },
  accessibility: {
    label: "Puzzles",
    description: "Published puzzles with their type, difficulty, and publication date.",
  },
});

export default function PuzzleList({ heading, puzzles, state, errorMessage, sources, completeness }) {
  if (state === "error") return <p role="alert">{errorMessage ?? "Could not load the puzzles."}</p>;
  if (!Array.isArray(puzzles)) return <p role="status">Loading…</p>;
  // …
}
```

```js
// src/renderyes/views/index.js
import { ingestViews } from "@renderyes/react";

export const components = ingestViews(import.meta.glob("./*.view.jsx", { eager: true }));
```

`ingestViews` takes the record produced by a bundler's glob. It performs no
filesystem globbing because the syntax is bundler-specific. Every problem either call
finds is a thrown error naming the file — a missing `spec`, a missing default
export, two files claiming one id. None of them skip the file, because a
component silently absent from the catalog is indistinguishable from a planner
that chose not to use it.

Your component receives, alongside its data slots: `state`
(`pending`/`ready`/`empty`/`error`), `errorMessage`, `sources`, `asOf`,
`staleAt`, and `completeness`. Handle all four states — the visitor sees
whichever one the data lands in.

> A view file needs a **default export**, which conflicts with the
> no-default-exports rule many TypeScript codebases enforce. Exempt the views
> folder: `"import/no-default-export": "off"`
> scoped to `**/*.view.tsx`.

### ⚠️ The twin discipline

**Every bespoke component exists twice, under the same `id`.**

| Half | Package | Purpose |
|---|---|---|
| **Browser** | `defineHostComponent` / `defineView` from `@renderyes/react`, with a real React `component` | This is what **renders** |
| **Server** | `defineComponent` from `@renderyes/site-sdk` — definition only, no React | This is what the **planner reads** |

The planner only ever sees what `publishUiCatalog` published. **A React
component registered in the browser with no server-side twin is simply never
chosen** — no error, no refusal, the planner just always picks something else.
That can look like a planning failure even though the missing server-side
registration is the cause.

The same `id`, `version`, `description`, `props`, and `dataSlots`, plus a
`renderer` mapping the slots to plan paths:

```js
// renderyes-service.mjs — the server half of the browser's BharatTimesStoryList
import { defineComponent, defineProps, field } from "@renderyes/site-sdk";

const storyListDefinition = defineComponent({
  id: "BharatTimesStoryList",   // ← identical to the browser's id
  version: "1.0.0",
  description:
    "Editorial story list for published Bharat Times articles. Prefer it when the " +
    "visitor asks to browse, scan, or compare several news stories; it presents " +
    "headlines, sections, summaries, and publication dates in the paper's house style.",
  props: defineProps({ heading: field.string({ default: "From The Bharat Times" }) }),
  renderer: { component: "BharatTimesStoryList", props: { stories: { path: "/stories" } } },
  dataSlots: {
    stories: { accepts: [{ dataTypeId: "Article", shapes: ["collection"] }] },
  },
});
```

**The starter catalog keeps the discipline for you.** Register
`createDataTable()` in the browser and publish `createDataTable().definition`
on the server. Charts split one step further — see the recharts callout in §3.

```js
// renderyes-service.mjs
import {
  createMetricCard, createDataTable, createCardGrid, createItemList, createDetailPanel,
  createRecordWithLines, createMediaGallery,
  createBarChartDefinition, createDonutChartDefinition, createLineChartDefinition,
} from "@renderyes/starter-catalog";

const componentDefinitions = [
  createMetricCard().definition,
  createDataTable().definition,
  createCardGrid().definition,
  createItemList().definition,
  createMediaGallery().definition,
  createDetailPanel().definition,
  createRecordWithLines().definition,
  createBarChartDefinition(),          // recharts-free
  createDonutChartDefinition(),
  createLineChartDefinition(),
  bookCardsDefinition,               // your bespoke twins
  ordersViewDefinition,
];
```

That array is what goes into `defineSite({ components })` and a surface's
`componentIds` in §5. The publish summary's `componentIds` list settles in one
log line whether a component made it in.

### Check coverage

After publishing:

```bash
curl -s "http://127.0.0.1:4000/api/coverage?catalogId=bharat-times" \
  -H "x-renderyes-admin-token: $RENDERYES_ADMIN_TOKEN"
```

Anything marked `unrenderable: true` is a capability the planner can select and
then have nothing to draw with. That report is the fastest way to find the next
component worth writing.

### Refining from inside your own component

`useViewCompose()` is safe to call from your **own registered components**, not
just from whatever renders the surface. The session lives in `ViewProvider`, so
a table that wants to sort by a column header reaches the same session the
visible surface came from:

```jsx
function TransactionTable({ rows }) {
  const { refine } = useViewCompose();
  return (
    <th onClick={() => refine([
      { kind: "setSort", requestId: "r1", sort: [{ field: "amount", direction: "desc" }] },
    ])}>
      Amount
    </th>
  );
}
```

No model call, instant, repeatable. A rejected refinement leaves the current
view on screen and reports the failure — the catalog refusing a sort field is a
reason to say the sort did not apply, not to take someone's table away.

---

## 8. Generating a bespoke component

Optional, and nothing in §1–§7 depends on it. Install it as a dev dependency
**in your frontend project** — it declares `react`/`react-dom` peers and reads
your style corpus and existing components from `--host-dir`:

```bash
npm install --save-dev @renderyes/generate
```

A dev-time CLI that has a model draft a bespoke, host-styled component from
your approved data contract, verifies it mechanically, and emits a reviewable
diff. It **never registers anything** — you review the diff and register it
yourself, like hand-written code. The model is never re-called at build.

```bash
npx --package @renderyes/generate renderyes-generate component \
  --capability bharat-times.posts.list \
  --schema ./schema.graphql \
  --decisions ./decisions.json \
  --inventory ./inventory.json \
  --host-dir . \
  --provider openai \
  --timeout 480 \
  --out ./gen
```

`--capability` alone is not enough: the CLI needs the data contract, which
means **either** `--export <review-export.json>` **or** `--schema` with
`--decisions`. Without one of those it exits 2 with the usage string.

| Flag | Notes |
|---|---|
| `--capability <id>` | Required. The approved capability the component will render. |
| `--export <file>` | A review export bundle — the simplest contract input. |
| `--schema <f> --decisions <f>` | The alternative. Add `--inventory <f>` (strongly recommended, see the gotcha below), or `--catalog-id <id>` with optional `--source-label`, `--queries a,b`, `--depth <n>`, `--scalars <file>` to reconstruct an inventory. |
| `--host-dir <dir>` | Root of your project (default: cwd). What it reads your style corpus and existing components from. |
| `--style <file>` | Explicit style-corpus files, repeatable. Replaces detection. |
| `--convention auto\|folder\|listed` | Default `auto`: `folder` if it finds `*.view.*` files, `listed` if it finds inline `defineHostComponent` blocks. |
| `--id <ComponentId>` | Default: derived from the data type. Refuses outright if a component with that id is already registered — regenerating would silently shadow the reviewed one. |
| `--provider openai\|gemini\|mock` | Default `openai`. `--mock-file <f>` (a JSON array of scripted envelopes) is required with `mock`. |
| `--model`, `--api-key-env`, `--base-url` | Provider overrides. |
| `--timeout <seconds>` | Default **480**. Not a typo: the provider's own 60s default was sized for planner calls, and drafting a whole component takes minutes. |
| `--rounds <n>` | Repair rounds after the first draft. Default 2. |
| `--out <dir>` | Write artifacts to this directory. Without it, output goes to stdout. |
| `--write` | Allow `--out` to overwrite existing files. |

Exit codes: **0** generated and every check passed · **1** artifacts emitted
but verification is failing (read the report) · **2** usage error or refusal,
nothing generated.

### What it reads

- The **approved contract** for that capability — the data type, its fields and
  semantic types, and any approved relationships. It cannot invent a field you
  did not approve.
- **Your stylesheet**, detected from `--host-dir` (or named with `--style`), so
  the draft uses your class names and tokens.
- **Your existing components**, so it matches your conventions and refuses an
  id that already exists.

### What it emits

| Artifact | Notes |
|---|---|
| `<ComponentId>.view.tsx` / `.jsx` | The component file. |
| `verification-report.md` | Each mechanical check, pass or fail, with detail. |
| `preview.html` | The **ready / empty / error / truncated** states rendered under your own stylesheet, self-contained. Open it in a browser; reviewing states must never require building a page. |
| `sample-rows.json` | The synthesized rows the preview used. |
| `<ComponentId>.component.mjs` | The server-side twin — **`listed` convention only**. Derived from the client spec, never model-written, which is what makes twin drift structurally impossible. |
| `registration.patch` | Both registrations as a patch — **`listed` convention only, and only when it finds your `defineHostComponent` registration file.** Otherwise the report says so and no patch is emitted. |

Six mechanical checks gate the result: **esbuild-parse** (it compiles),
**define-host-component** (the spec registers), **twin-equality** (the derived
twin matches the client spec), **coverage-delta** (the new component actually
closes a coverage gap), **render-smoke** (all four states render without
throwing), and **authoring-lint** (no `fetch`, `XMLHttpRequest`, `WebSocket`,
`window`, `document`, `localStorage`, `sessionStorage`, `import.meta`,
`process.env`, or `require()` — views take data through props, full stop).

### ⚠️ The data-type id must match

If the contract's `dataTypeId` does not match the one in your **live published
catalog**, the component is generated, verified, registered — and the planner
silently never picks it.

The mechanism: when you pass `--schema` and `--decisions` **without `--inventory`**,
the CLI reconstructs a draft from schema discovery alone. It derives
`capabilityId` as `graphql.<rootFieldName>` and `dataTypeId` as the Relay
connection's node type name, **falling back to the root field name** when the
field is a plain list. The reconstructed draft for `Posts` derives its data type
name from the schema, while your hand-written code-first
catalog declared `Article`. Nothing errors. The `dataSlots.accepts` entry names a
data type no published capability produces, so no plan can ever bind it.

Two fixes, in order of preference:

1. **Pass `--inventory <inventory.json>`** — the same inventory your live catalog compiles
   from. Then the ids are by construction the ones you published.
2. **Check the emitted twin's `dataTypeId` against your published catalog**
   before registering, and correct it in both halves if it differs.

Note the same reconstruction also renames the capability, so
`--capability bharat-times.posts.list` will not be found in a reconstructed
contract — it would be `graphql.Posts`. The error lists the approved
capability ids it *did* find, which is the tell.

---

## 9. Updating and rolling back

```bash
# 1. Move to the newest build — one command per side, so the tree stays coherent
npm update @renderyes/react @renderyes/starter-catalog          # frontend
npm update @renderyes/server @renderyes/starter-catalog         # backend

# 2. Restart your dev server AND clear the bundler's dependency cache
rm -rf node_modules/.vite
npm run dev
```

Vite pre-bundles dependencies and will happily keep serving the previous
version otherwise. For Next.js, `rm -rf .next`.

Check what is published:

```bash
npm view @renderyes/server version
npm view @renderyes/server versions --json    # every build ever published
```

### Rolling back

Published versions are immutable, so a rollback is an exact pin:

```bash
# Frontend
npm install @renderyes/react@0.1.0 @renderyes/starter-catalog@0.1.0

# Backend
npm install @renderyes/server@0.1.0 @renderyes/starter-catalog@0.1.0
```

Pin **both sides to the same version**. A frontend on one release and a backend
on another is a plan schema mismatch waiting to happen. `npm view
@renderyes/server versions --json` lists what you can go back to.

All eleven packages are released together at one version, so matching the
number across them is the whole of it.

Pin an exact version — not a caret range and not `latest` — for anything that
must not move. A range floats to the newest release silently, including across
breaking catalog changes.

---

## 10. Quick reference

```bash
# Install
npm install @renderyes/react @renderyes/starter-catalog     # frontend
npm install @renderyes/server @renderyes/starter-catalog    # backend
npm install recharts                                            # frontend, charts only

# Build a catalog interactively
RENDERYES_HOST_URL=http://127.0.0.1:4000 \
RENDERYES_ADMIN_TOKEN=... \
  npx @renderyes/catalog-review

# Check the catalog against the real upstream
# (admin token AND a session credential — the probe executes capabilities)
curl -s -X POST http://127.0.0.1:4000/api/catalog/probe \
  -H 'content-type: application/json' \
  -H "x-renderyes-admin-token: $RENDERYES_ADMIN_TOKEN" \
  -H "$YOUR_OWN_SESSION_HEADER" \
  -d '{"catalogId":"bharat-times"}'

# Find the next component worth writing
curl -s "http://127.0.0.1:4000/api/coverage?catalogId=bharat-times" \
  -H "x-renderyes-admin-token: $RENDERYES_ADMIN_TOKEN"

# Update / check / roll back
npm update @renderyes/react @renderyes/starter-catalog
npm view @renderyes/server version
npm view @renderyes/server versions --json
npm install @renderyes/react@0.1.0
```

```js
// Backend — the whole mount
import { createServer } from "node:http";
import { createViewServer, createViewHttpHandler } from "@renderyes/server";
import { toNodeHandler } from "@renderyes/server/node";

const viewServer = createViewServer({
  resolveSession: (request) => yourOwnSession(request),
  host: {
    isAuthenticated: (s) => Boolean(s?.userId),
    hasPermission: (s, p) => s.permissions?.has(p) ?? false,
    getSessionValue: (s, k) => s?.[k],
  },
  allowedUpstreamOrigins: ["http://127.0.0.1:4000"],   // fails closed
  resolveViewOwner: (s) => s.userId,                   // refine/save/pin need it
  graphql: {                                           // GraphQL catalogs only
    resolveHeaders: () => ({}),
    resolveProvenance: ({ sourceId }) => ({ sources: [{ sourceId }] }),
  },
});

const handler = createViewHttpHandler(viewServer, {
  requireAdmin: (request) => yourTimingSafeCheck(request),   // no default
});

await viewServer.publishReviewedCatalog(/* … */);   // async — await it
await viewServer.publishUiCatalog(/* … */);         // async — await it
await viewServer.restorePublishedCatalogs();        // before listen()

const api = toNodeHandler(handler);
createServer((req, res) =>
  req.url.startsWith("/api") ? api(req, res) : yourApp(req, res),
).listen(4000);
```

```jsx
// Frontend — the whole mount
import { ViewProvider, ViewWorkspace } from "@renderyes/react";
import { createDataTable, createMetricCard } from "@renderyes/starter-catalog";

const components = [createDataTable({ searchable: true }), createMetricCard()];

<ViewProvider config={{ serviceUrl: "", catalogId: "bharat-times", components, renderMode: "host" }}>
  <ViewWorkspace suggestions={["Show me the latest stories"]} />
</ViewProvider>
```

---

## Where to go next

- **Every config field and route** — [`INTEGRATION.md`](INTEGRATION.md)
- **Signatures** — [`API.md`](API.md)
- **Something is not working** — [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)
- **Approving data** — [`CATALOG.md`](CATALOG.md)
- **Writing components** — [`AUTHORING_VIEWS.md`](AUTHORING_VIEWS.md)
- **A question or a bug** — open an issue at
  <https://github.com/mozilor-technologies/RenderYes/issues>
