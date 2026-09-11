# Integrating RenderYes into a host application

This is the practical guide for wiring RenderYes into a real frontend and
backend. It documents exactly what exists today — every function, route
contract, and config shape named below is real code in this workspace, not
aspirational API.

Three packages, three responsibilities:

- **`@renderyes/react`** — the frontend. Installed into the host's existing
  React app. Registers the host's own components, renders the floating
  launcher, calls the host's RenderYes service.
- **`@renderyes/server`** — the backend. A small Node service the host runs
  alongside their existing backend (or as a route group inside it). Holds the
  published catalogs and executes the compose pipeline. Model keys and API
  credentials live here, never in the browser.
- **`@renderyes/site-sdk`** — the catalog builder. Installed alongside
  `@renderyes/react` (only `defineProps`/`field` are re-exported from
  `@renderyes/react`; everything else here is a separate install). It assembles
  the host's registered components into a site and produces the
  `toSiteManifest(site)` payload that gets published to `/api/ui-catalog` in
  step 4.

Both `@renderyes/react` and `@renderyes/server` talk to each other over
one HTTP contract: `POST {serviceUrl}/api/compose`. Everything else (catalog
publishing, provider wiring) is host-side plumbing around
`@renderyes/server`'s exported functions, some of it built with
`@renderyes/site-sdk`.

## 0. Why two packages, not one

The frontend never sees a model key or an upstream API credential. If it did,
shipping the bundle would ship the credential. So identity injection,
provider calls, and catalog execution have to run somewhere the browser can't
  reach — that's `@renderyes/server`. Public contracts enforce the boundary:
  the model emits a `Plan` and never receives identity.

## 1. Install

```bash
npm install @renderyes/react
npm install @renderyes/site-sdk # alongside @renderyes/react, to build the UI catalog
npm install @renderyes/server   # in your backend project/workspace
```

These resolve from the public npm registry. Inside this monorepo the packages
resolve through the pnpm workspace as `workspace:*` instead. Local tarballs
remain an option only when you are developing the packages themselves; they
install differently under npm than under pnpm or Yarn — see `CONTRIBUTING.md`
in the repository for the recipes and the override table pnpm and Yarn
require.

## 2. Backend: run the RenderYes service

`createViewServer` builds the whole pipeline — capability catalog registry, UI
catalog registry, publish/compose. `createViewHttpHandler` puts it behind the
routes `@renderyes/react` expects, as one fetch-standard
`(Request) => Promise<Response>`. The server package requires Node.js 22+.
`toNodeHandler` adapts the handler to `node:http`, which also covers Node-based
frameworks such as Express, Fastify, and Koa. A Node-runtime framework that
accepts web `Request` and `Response` objects can mount the fetch handler
directly.

Write the handler, not the routes. Their paths are a fixed contract with the
client.

```ts
import { createViewServer, createViewHttpHandler } from "@renderyes/server";

const renderYesServer = createViewServer({
  // The only adapter allowed to inspect a session. Scopes exactly what a
  // capability runtime can see — never the whole session object.
  host: {
    isAuthenticated: (session) => Boolean(session.userId),
    hasPermission: (session, permission) => session.permissions.has(permission),
    getSessionValue: (session, key) => session[key],
  },
  // Resolve your own session from the real request (verified cookie, bearer
  // token, whatever your app already does). Never read by this package.
  resolveSession: (request) => verifyYourOwnSessionCookie(request),
  // Optional. These are server-side model configurations. apiKeyEnv is an
  // environment variable NAME, never the credential itself.
  planProviders: [{ id: "openai", apiKeyEnv: "OPENAI_API_KEY", model: "gpt-5-mini" }],
  // Optional, and strongly recommended: without it the registries are purely
  // in-memory, so a restart leaves every visitor's compose failing with "no
  // published catalog" until someone republishes by hand. See §2.2.
  catalogStore: createFileCatalogStore(new URL("./data", import.meta.url)),
  // Required to publish a GraphQL capability catalog — which is every host
  // onboarding from a GraphQL API, so read "optional" narrowly. GraphQL
  // establishes no provenance of its own: nothing in a response says which
  // system a row came from or how old it is, and this library will not invent
  // it. Publishing without this throws and names the field.
  graphql: { resolveProvenance: (context) => yourProvenanceFor(context) },
});

const handler = createViewHttpHandler(renderYesServer, {
  // Required. See below; there is no default.
  requireAdmin: (request) => yourOwnAdminCheck(request),
  // Omit entirely when the app and this handler are same-origin.
  cors: { allowedOrigins: ["https://app.example.com"] },
});
```

Then mount it. On `node:http`:

```ts
import { createServer } from "node:http";
import { toNodeHandler } from "@renderyes/server/node";

await renderYesServer.restorePublishedCatalogs(); // before listen(), see §2.2
createServer(toNodeHandler(handler)).listen(4200);
```

In a Node-runtime framework that accepts web requests, the handler can be
mounted directly.

### The routes it serves

Do not define these routes manually. Import `VIEW_HTTP_ROUTES` when an adapter
needs to identify the handler's complete visitor and admin route set.

**`requireAdmin` is required, and required to be a function.** Every possible
default is wrong: defaulting open ships a publish endpoint that lets an
anonymous caller replace your capability catalog; defaulting closed breaks the
review app with a 403 that looks like our bug. Making it a parameter means you
cannot reach a running server without having answered the question. A
development host with no admin concept can pass `() => true` — but it will be
written down, and greppable.

The admin set is not "the mutating routes". `GET /api/coverage` maps every data
type to the components that can render it, which describes your internal data
model; `/api/plan` and `/api/classify-operations` each spend model calls, so an
open route is also your bill.

### Reading a compose response: `ok` is about delivery

`ok` reports whether the view carries data. Three outcomes:

| envelope | meaning |
|---|---|
| `ok: true` | every bound slot delivered |
| `ok: true, partial: true` | some delivered, some did not — `requests[]` says which, each with its own `error` |
| `ok: false, kind: "data-unavailable"` | nothing delivered; `messages` still travels, because the per-slot errors are what the visitor should see |

A partial view stays successful. Three panels that answered and one that could
not are more useful than refusing the whole screen, and flattening it into a failure
would lose the difference between that and a blank page. GraphQL returns `data`
and `errors` together for the same reason.

Checking `ok` tells you whether *anything* arrived. It does not tell you
everything did — that is what `partial` and `requests[]` are for:

- **Using `@renderyes/react`:** `useViewCompose` returns `errorKind`,
  `issues`, and `failedRequests`, the last mapping a request id to the reason it
  failed. Surface those and a partial view explains itself.
- **Calling `/api/compose` directly:** branch on `ok`, then on `partial`, then
  read `requests[]` for the specifics.

Slot state is `"pending" | "ready" | "empty" | "error"` — `pending` because a
streamed compose emits the surface before its requests settle, so every slot
starts there and a host component sees it on the first frame of every run.

### What the handler decides for you

- **401 vs 400.** Throw `UnauthenticatedError` from `resolveSession` and the
  caller gets a 401. Other request and domain validation failures use their
  mapped 4xx status.
- **CORS is off unless you pass `cors`,** and it takes an allowlist with no
  wildcard. Reflecting the request's own `Origin` is worse than a wildcard when
  combined with `Allow-Credentials: true`: it lets any site a visitor has open
  call your server as that visitor and read the replies.
- **`content-type: application/json` is required on POST.** This is a CSRF
  control: a cross-origin `<form>` cannot send that header without a preflight,
  which CORS then gates.
- **A 4 MB body cap** (`maxBodyBytes`), checked before the body is buffered and
  after `requireAdmin` — so a refused caller cannot make the process allocate.
- **Error bodies carry `error.message`, never a stack.** The message is
  forwarded because for an `unsupported` compose it is the only explanation of
  why the approved data cannot answer the question.

`planProviders` is required for planning, and `providerId` is optional: when
omitted, the server uses the first configured provider. An entry may be a model
(`{id, apiKeyEnv, model}`) or a script you supply (`{id, plans}`), which is how
to exercise the pipeline without a model — the plans are the host's, and
`GET /api/providers` reports the entry as `model: "scripted"` so it can never be
mistaken for one.

With nothing configured, compose throws `PlanProviderNotConfiguredError`,
carrying a `wiring` report — published catalogs, capability count, components,
unrenderable capabilities, which providers hold credentials — also available on
its own as `describePlanningWiring(catalogId)` and `GET /api/planning-wiring`.
Construction permits incomplete planning wiring. Compose then refuses with a
report of what is missing, so a host can start while setup is in progress.

The browser must never supply a credential. `createProvider` is an advanced
escape hatch for a host that needs its own per-tenant provider routing; ordinary
integrations should not need it. The built-in OpenAI and Gemini adapters ask for
structured output on every call. If a provider rejects the schema they retry
once in plain JSON mode and do **not** remember the rejection, so one bad
response cannot flip every later compose in the process into unconstrained
planning. The cost is one extra HTTP call per attempt against a provider that
genuinely cannot take the schema; `ComposeMetrics` records which mode each plan
actually ran under.

`request` is passed straight to your `resolveSession`. When you use the handler
that is the fetch `Request` — so read headers with
`request.headers.get("authorization")`, not `request.headers.authorization`.
This package still never inspects a credential itself; it only passes the
request through to you.

### 2.2 Surviving a restart

The registries are in-memory and have to be: a published capability holds a live
executor closure, and those are not serializable. What *is* persistable is the
publish input, and replaying it at boot calls the same function with the same
argument. There is no separate restoration implementation.

Set `catalogStore` and the package does the write-through. `createFileCatalogStore`
(from `@renderyes/server/node`) stores one JSON file per catalog, which an
operator can list, diff, and delete by hand.

Then call `restorePublishedCatalogs()` **once at boot, before you start
serving**. A store's `list` is async, so restoration cannot happen inside the
synchronous `createViewServer` factory. If restoration is omitted, the "no
published catalog" error says so explicitly while a store is configured
and no restore has run.

```ts
const restored = await renderYesServer.restorePublishedCatalogs();
for (const failure of restored.failures) {
  console.error(`Could not restore ${failure.kind} catalog "${failure.id}": ${failure.reason}`);
}
```

A record that no longer validates is reported, not thrown: one stale catalog
should not stop the process from starting and serving the others.

## 3. Approve catalogs (one-time, per host, per catalog change)

The review UI — `npx @renderyes/catalog-review`, or `apps/catalog-review` in
this repository — is the tool a host runs locally to turn their OpenAPI or
GraphQL schema into an approved capability catalog, then publish it to
`POST /api/catalog`. This step is required before `/api/compose` has anything
to execute — publishing is what turns an approved catalog into an executable
runtime + a planner-safe manifest.

For an OpenAPI-bound catalog, the publish payload accepts:

```ts
{
  catalog: CapabilityCatalog,       // from the review UI's "Download catalog"
  bindings: Record<string, Binding>, // from the review UI's "Download server bindings"
  baseUrl?: string,                  // where the approved operations actually live
  credentialId?: string,             // an id YOU declared in upstreamCredentials
}
```

`credentialId` is an opaque key the host declares up front when constructing
the server:

```ts
createViewServer({
  upstreamCredentials: { "support-api": "SUPPORT_API_TOKEN" },
  allowedUpstreamOrigins: ["https://api.internal.example"],
  // ...
});
```

The publish call may only reference `"support-api"`. It cannot name an
environment variable, so it cannot reach any other secret in the process.
Unrecognised ids are rejected. The token is read from
`process.env` per request, so rotating it takes effect without republishing.

`allowedUpstreamOrigins` bounds where a capability may live. Comparison uses
the parsed scheme, host, and port together; string prefixes are not used.

**It fails closed.** An absent or empty list rejects every destination, so a
host must name its origins even when the only capability server is its own
process (`["http://127.0.0.1:4173"]`). This is required configuration, not an
optional hardening step: a catalog names _where_ a capability lives, so
without the list whoever can publish also chooses where this process makes
authenticated outbound requests.

The gate covers three places a destination can be named, not just `baseUrl`:

| Named in                | Why it needs checking                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `baseUrl`               | the obvious one                                                                                           |
| a binding's `serverUrl` | `serverUrl ?? baseUrl` — it replaces the base outright                                                    |
| a binding's `path`      | `new URL(path, base)` discards `base` when `path` is absolute or protocol-relative, so those are rejected |

A GraphQL `endpoint` is re-checked again at execution time, immediately before
credentials are attached. Narrowing the list immediately revokes matching
requests from an already-published catalog.

`resolveHeaders` receives `endpoint` and `destinationOrigin` so a host can
vary credentials by destination. Use it: "allowed to call" and "trusted with
the visitor's own credential" are different questions, and only the host can
answer the second. Forwarding a caller's token to every destination a catalog
can name hands the publisher a say in where that token goes.

### Authenticate the publish routes

Publication decides where this process sends credentials, so the routes that
accept it need a deployment credential of their own. That is what
`requireAdmin` is (§2) — the handler will not compile without it, and the one
check covers every admin route.

This is not a user role. Even where `hasPermission` is real, "may use the
product" and "may redirect the server's outbound requests" are different
authorities. Compare a shared secret with `timingSafeEqual`, length-checked
first (it throws on a length mismatch), and treat an unset secret as a decision
you have not made — refuse, or accept only from loopback, but do it knowingly.

> The payload names a credential by `credentialId`; it never accepts an
> environment variable name. Resolving one by name would let anyone who could
> reach the route have any secret in the process sent as a bearer token to a URL
> they also chose.

For a GraphQL-bound catalog, the payload shape is different: `bindingKind`
must be set explicitly. The binding map contains keyed GraphQL operations.

```ts
{
  bindingKind: "graphql",
  catalog: CapabilityCatalog,
  bindings: Record<string, GraphQlOperationBinding>,
  endpoint: string,                  // the GraphQL endpoint; validated as an http(s) URL
  schema: string | object,           // SDL text, or an introspection JSON result
}
```

GraphQL publication also requires the host to have configured `graphql` (with
`resolveProvenance`, and optionally `resolveHeaders`/`fetchImpl`) on
`createViewServer` — without it, `publishReviewedCatalog` rejects a
`bindingKind: "graphql"` payload outright.

The UI catalog is published the same way, from `toSiteManifest(site)` — see
step 4.

## 4. Frontend: write components in a folder and mount the provider

One file per component, each declaring its own contract next to the component
it describes. [`AUTHORING_VIEWS.md`](AUTHORING_VIEWS.md) is the full contract —
hand that to whoever is writing the components. The short version:

```tsx
// src/renderyes/views/report-card.view.tsx
import { defineView, type ViewProps } from "@renderyes/react";

export const spec = defineView({
  id: "ReportCard",
  description: "Shows one agent report with its status and total count.",
  dataSlots: {
    report: { accepts: [{ dataTypeId: "AgentReport", shapes: ["entity"] }] },
  },
});

export default function ReportCard({ report, state, sources }: ViewProps<typeof spec>) {
  // …
}
```

The folder is registered in one call. Nothing lists the components, so adding
one is adding a file:

```tsx
// src/renderyes/views/index.ts
import { ingestViews } from "@renderyes/react";

export const components = ingestViews(import.meta.glob("./*.view.tsx", { eager: true }));
```

```tsx
import { ViewProvider, ViewLauncher } from "@renderyes/react";
import { components } from "./renderyes/views";

function App() {
  return (
    <ViewProvider
      config={{
        serviceUrl: "https://your-renderyes-service.example.com",
        catalogId: "bharat-times", // must match what you published in step 3
        components,
      }}
    >
      {/* the rest of your existing app, unchanged */}
      <ViewLauncher label="Ask" />
    </ViewProvider>
  );
}
```

`ingestViews` takes the record produced by a bundler's glob; it performs no
filesystem globbing because the syntax is bundler-specific. `defineHostComponent` is the
lower-level call it's built on, for a component that can't be one file with one
default export — a component built by a factory, or one whose contract is
computed at startup.

That's the entire frontend integration. `ViewLauncher` renders a
floating button inside a Shadow DOM boundary (`IsolatedView`) so host CSS
can't break it and its styles can't leak onto the host page; clicking it
POSTs `{ catalogId, prompt }` to `${serviceUrl}/api/compose` and renders
whatever components come back through `ViewSurface`.

To publish the matching UI catalog, assemble a site from the same components and
export its manifest, using `defineSite`/`defineSurface`/`toSiteManifest` from
`@renderyes/site-sdk` directly (install it alongside `@renderyes/react` — it
is not re-exported beyond `defineProps`/`field`).

This runs as a build script, which has no bundler to glob with, so it reads the
same folder from the filesystem. Run it under a loader that handles TSX, e.g.
`tsx scripts/emit-ui-catalog.ts`:

```ts
import { ingestViewDirectory } from "@renderyes/react/ingest-fs";
import { defineSite, defineSurface, toSiteManifest } from "@renderyes/site-sdk";

const components = await ingestViewDirectory(
  new URL("../src/renderyes/views/", import.meta.url),
);

const site = defineSite({
  id: "bharat-times",
  name: "The Bharat Times",
  version: "1.0.0",
  catalogId: "https://your-host.example.com/renderyes/catalog.json",
  components: components.map((registered) => registered.definition),
  surfaces: [
    defineSurface({
      id: "main",
      description: "Main surface.",
      componentIds: components.map((registered) => registered.definition.id),
      maxComponents: 6,
    }),
  ],
});

// POST { manifest: toSiteManifest(site) } to /api/ui-catalog once, whenever
// the component set changes.
```

Both sides enumerate the same folder, so the published catalog cannot claim a
component the app can't render, or omit one it can. Getting that wrong is
unpleasant to debug: the symptom is a planner that appears to ignore a
component, when the component was never in the catalog it was choosing from.

After publishing, `GET /api/coverage?catalogId=<id>` reports every data type in
the capability catalog and which components can render it. Anything with
`unrenderable: true` is a capability the planner can select and then have nothing
to draw with — that report is the fastest way to find the next component worth
writing.

## 5. Verify end to end

`packages/server/test/server.test.mjs`, in the source repository, is a runnable
from-scratch example:
publish a capability catalog against a real local HTTP server, publish a UI
catalog, call `composeAgainstPublishedCatalogs`, assert the resulting A2UI
messages contain the real executed data. Use it as a template for a host's
own integration test — swap the fixture catalog/component for the host's
real one.

```bash
pnpm --filter @renderyes/server test   # from a checkout of this repository
```

## 6. Cost and accuracy controls

Two things reduce per-prompt cost without the host configuring anything, and one
the host opts into.

**Automatic: surface-scoped capabilities.** A capability no component on the
surface can accept could never be bound, so it is dropped from the contract
before the model sees it. This is derived from your registrations by
`scopeManifestToSurface` (site-sdk), reusing the same acceptance matcher that
validates plans afterwards — it can never exclude something validation would
have accepted. On a synthetic catalog of 40 approved operations against a
2-component surface, this narrows the advertised set to 6, the prompt by ~84%,
and the enforced JSON Schema from ~159 KB to ~25 KB. The schema shrinking is the
more important half: a large `oneOf` is where smaller, cheaper models fail.

Pass `scopeCapabilitiesToSurface: false` to `createPlanContract` to advertise
everything — useful only to check whether a "no plan found" result is a scoping
problem, and `getCoverageReport` is usually the better answer to that question.

**Automatic: compiled contract reuse.** `composeDataPlan` caches the built
contract and its compiled Ajv validator per (manifest, site, surface), keyed on
object identity. Nothing to configure — but note the consequence: a host that
rebuilds its planner manifest object on every request gets no reuse. Hold one
registered object per published catalog, which is what `publishReviewedCatalog`
already does.

**Opt in: the plan cache.** Supply `planCache` to `createViewServer` to
skip the model call when the same prompt arrives again for the same surface:

```js
import { createViewServer, createMemoryPlanCache } from "@renderyes/server";

const renderYes = createViewServer({
  host,
  resolveSession,
  planCache: createMemoryPlanCache({ maxEntries: 500, ttlMs: 15 * 60 * 1000 }),
});
```

It caches a **plan**, not a response. A plan names a capability, its params, and
a component; every row is still fetched on the request, so a hit can never serve
stale data. And because the planner never sees identity, a plan is
visitor-independent — which is what makes the hit rate worth having, since two
visitors asking the same question legitimately share one plan. A hit still gets
a fresh `planId`, so saved views are never conflated.

Plan caching is off unless you supply it because cached plans can be shared
across visitors. The compose response reports
`cached: true | false` so you can instrument the hit rate. Pass your own object
implementing `PlanCache` (`get`/`set`) to back it with Redis or similar.

**Prompt shape examples.** The system prompt includes worked examples of the
required output shape by default. Their ids are placeholders, not catalog ids.
Pass `includeShapeExamples: false` to `createPlanContract` to omit
them, for example in a controlled evaluation. Their effect on first-attempt
validity has not been established.

## 7. Keeping a view: save, reopen, refine, revise

Everything so far produces a view and forgets it. These four capabilities let a
visitor keep one, adjust it, and come back to it.

### Saved views

Two config options, both required together:

```ts
createViewServer({
  // Process-local and lost on restart. A host whose visitors expect to come
  // back to a view needs a durable implementation of the same interface.
  viewStore: createMemoryViewStore(),
  // Derives the opaque key a view is filed under. No default is provided on
  // purpose: guessing an identity here would be guessing who may read a saved
  // view, and a wrong guess (a shared constant for anonymous visitors, say)
  // makes every saved view world-readable.
  resolveViewOwner: (session) => session.userId,
  // ...
});
```

| Method                                                     | Purpose                                                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `saveComposedView({ catalogId, planId, label?, request })` | Persists an already-composed plan. Takes a `planId` from a prior compose, never a plan body — a caller cannot store a plan this server never validated. |
| `reopenSavedView({ viewId, request })`                     | Re-executes the saved plan and returns fresh A2UI messages.                                                                                             |
| `listSavedViews({ request })`                              | This owner's views, newest first. Carries no plan bodies.                                                                                               |
| `deleteSavedView({ viewId, request })`                     | `{ ok: false }` when the view is not this owner's.                                                                                                      |

**A view id is not an authorization.** Every read is filtered by owner key. An
owner mismatch returns "absent" to avoid disclosing that the id exists.

**Reopening replays the saved plan.** Rendered output is not stored, so a
reopened view shows current data. Two consequences worth knowing:
no fetched customer data sits in your view store, and a catalog that changed
since saving can make a stored plan unreplayable. `listSavedViews` reports
`stale: true` so the UI can explain the condition.

### Refinement — direct manipulation without a model call

`@renderyes/react` drives this for you. `useViewCompose()` keeps the
`planId` and exposes the lifecycle:

```tsx
const { submit, refine, planId, reset } = useViewCompose();

submit(); // compose a fresh view
submit({ revise: true }); // the prompt is a change to the current view
refine([
  { kind: "setSort", requestId: "r1", sort: [{ field: "amount", direction: "desc" }] },
]);
```

The UI opts into revision by passing `previousPlanId`. The hook cannot infer
the visitor's intent: after "show my
accounts", a visitor typing "show my holdings" usually means a new question,
while "only the ones over 500" means a change to what they are looking at.
Your UI knows which control they used.

`useViewCompose()` is safe to call from **your own registered components**, not
just from whatever renders the surface. The session lives in `ViewProvider`,
so a table that wants to sort by a column header reaches the same session the
visible surface came from:

```tsx
function TransactionTable({ rows }: { rows?: Row[] }) {
  const { refine } = useViewCompose();
  return (
    <table>
      <thead>
        <tr>
          <th
            onClick={() =>
              refine([
                {
                  kind: "setSort",
                  requestId: "r1",
                  sort: [{ field: "amount", direction: "desc" }],
                },
              ])
            }
          >
            Amount
          </th>
        </tr>
      </thead>
      {/* ... */}
    </table>
  );
}
```

A rejected refinement leaves the current view on screen and reports the
failure — the catalog refusing a sort field is a reason to say the sort did
not apply, not to take someone's table away.

Every successful `composeAgainstPublishedCatalogs`, `refineComposedView`, and
`reopenSavedView` returns the `planId` of the view it produced. That id is what
every follow-up takes, so a client keeps the one from its last successful
response and passes it back:

```ts
const composed = await composeAgainstPublishedCatalogs({ catalogId, prompt, request });
// composed.planId — hold this; refine, save, and revise all need it.
```

```ts
refineComposedView({
  catalogId,
  planId,
  operations: [
    {
      kind: "setSort",
      requestId: "r1",
      sort: [{ field: "createdAt", direction: "desc" }],
    },
  ],
  request,
});
```

Supported: `setSort`, `setFilter`, `clearFilter`, `setLimit`, `removeNode`,
`reorderNodes`.

Sorting a table or moving a card is an ordinary interface action. Routing it
through the model would add a full composition and could return a different
arrangement. These actions are applied as plan edits instead.

The operation set is closed, and the refined plan is re-validated against the
approved catalog before executing, so a refinement can never introduce a
capability, component, or field the catalog did not already approve. Each
refinement returns a new `planId`, so it can be refined again or saved.

`ViewWorkspace` ships one refinement affordance of its own: on a multi-panel
view, each panel grows a grip — drag it, or focus it and press an arrow key —
that rearranges the panels. The move applies on screen immediately; a single
`reorderNodes` refinement then persists it in the background (rapid moves
coalesce into one write), so the arrangement survives a save and reopen. The
write re-executes the plan's data, so panels may refresh moments after a drop.
Like every plan-addressed call, this requires `resolveViewOwner` on the
server. A host that has not configured one should still mount
`<ViewWorkspace rearrange={false} />` to hide the unavailable control. These
calls fail with `kind: "visitor-identity-required"`, so a client
can tell "this site composes statelessly" from "that request failed".
`savedViews` and `rearrange` remain explicit feature switches so an unavailable
control does not have to fail once before disappearing. A revision resets the
arrangement because nodeIds are model-chosen labels with no
stability across re-plans. Building your own UI instead? The same behaviour is
`reorderPanels(nodeIds)` on `useViewCompose()`.

### Revision — a follow-up that changes the current view

Pass `previousPlanId` to compose and the prompt is interpreted in the context
of what is already on screen ("only the open ones"):

```ts
composeAgainstPublishedCatalogs({ catalogId, prompt, previousPlanId, request });
```

**Revisions bypass `planCache`.** The cache is keyed on prompt
text, but a revision's meaning depends on the plan it revises — the same words
against two different views are two different results, and serving one for the
other would hand a visitor someone else's layout.

Undo is left to the host: every compose and refinement returns a new `planId`
and the previous messages remain in hand. The client owns navigation history.

### Clarification

A compose can come back with a question. It happens when the approved
capabilities could answer the prompt in two or more materially different ways
and picking wrong would show the visitor something they did not ask for:

```ts
const { clarification, answerClarification, errorKind } = useViewCompose();

if (clarification) {
  // clarification.question, and clarification.options when the answer set is closed
}
```

`errorKind` is `"needs-clarification"` and `error` carries the question as
text, so a host that renders neither field still shows something true. **Do not
render it as an error.** A question means the catalog *can* answer — reporting
it as a failure trains people to rephrase a prompt that was fine.

`answerClarification(answer)` sends the original prompt together with the
question and the answer, because the answer alone is not a request. It also
sets `answersClarification` on the compose, which removes the question branch
from the planner's contract for that call, making a second question impossible.

Server-side the same thing is `{ kind: "needs-clarification", question,
options }` on the compose result, and `RUN_ERROR` with those fields when
streaming. It rides `RUN_ERROR` because `parseComposeEvent` drops frames whose
type it does not recognise: a third terminal event type would be invisible to
every existing client, which would then wait for a terminal event that never
arrived.

`ComposeMetrics.outcome` counts it separately from both success and failure. A
system that asks a question every time would otherwise look like one that never
fails.

## 8. Observability and limits

```ts
createViewServer({
  onComposeMetrics: (metrics) => log.write(JSON.stringify(metrics) + "\n"),
  // ...
});
```

Called once per compose, on success and failure alike. Reports `planMs` and
`dataMs` **separately** — model generation versus upstream fetching — plus
`inputTokens`, `outputTokens`, `modelCalls`, `capabilityCount`, `cached`,
`outcome`, `promptLength`, and `totalMs`.

The split identifies whether compose latency comes from model generation or
from the host's upstream API.

`modelCalls` is 2 when a provider rejected the structured schema and the call
retried in plain JSON mode — a real cost that is otherwise invisible.

**No prompt text and no fetched rows are included**, only shapes and durations,
so this can be piped to ordinary telemetry without routing visitor content or
customer data into it. A sink that throws is caught and logged; broken
telemetry cannot fail a working compose.

### Model-call tracing (Langfuse, or anything else)

`onComposeMetrics` answers "how long did that compose take". It does not show
you the individual model calls inside it, which is where the time actually
goes — a compose is one to three full-contract calls depending on how many
repair attempts the planner needed.

`onModelCall` fires once per model call:

```ts
createViewServer({
  onModelCall: (event) => log.write(JSON.stringify(event) + "\n"),
  // ...
});
```

Every call is covered — each planner repair attempt, the plan-only route, and
any provider you supply yourself through `createProvider`. Instrumentation
sits at the single point all of those pass through, not inside the built-in
adapters, so a provider you wrote is traced exactly like the ones we ship.
Each event carries `traceId` (shared across a compose, so a repair loop reads
as one trace), `attempt`, `providerId`, `modelId`, `durationMs`, token counts,
and `httpCalls` — 2 when a structured-schema rejection forced a plain-JSON
retry inside one logical call.

**Sending traces to Langfuse.** There is no Langfuse SDK in this package, and
no OpenTelemetry dependency either. `createOtlpModelObserver` emits
OpenTelemetry GenAI-convention spans over OTLP/HTTP with JSON encoding, which
Langfuse ingests natively:

```ts
import { createViewServer, createOtlpModelObserver } from "@renderyes/server";

const tracing = createOtlpModelObserver({
  endpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
  headers: {
    authorization:
      "Basic " +
      Buffer.from(
        `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`,
      ).toString("base64"),
    "x-langfuse-ingestion-version": "4",
  },
});

createViewServer({ onModelCall: tracing.observe /* ... */ });

// Spans are batched; flush before the process exits.
process.on("beforeExit", () => void tracing.flush());
```

Use `us.`, `jp.`, or `hipaa.cloud.langfuse.com` for other regions, or your own
origin when self-hosting.

**Nothing here is Langfuse-specific.** The spans follow the OpenTelemetry
GenAI semantic conventions (`gen_ai.system`, `gen_ai.request.model`,
`gen_ai.usage.input_tokens`, …), so pointing `endpoint` at an OpenTelemetry
Collector routes the same bytes to Datadog, Honeycomb, Grafana, or several at
once, with no change to this package or your code. Two non-standard
attributes are added — `renderyes.attempt` and `renderyes.http_calls` —
because the conventions have no field for them and they are what explain this
system's latency and cost.

Export is fire-and-forget: a tracing backend that is down, slow, or
misconfigured cannot fail a compose or delay a visitor, and an observer that
throws is caught and logged.

**Prompts are withheld by default.** `ModelCallEvent` carries no prompt or
completion text unless you set `captureModelPrompts: true`. Turning on
tracing must not quietly start shipping content to a third party: the user
prompt is the visitor's own words, and the system prompt contains your entire
catalog — capability descriptions, field names, component inventory. If you
have told anyone that data stays in your infrastructure, that flag is the
decision point. Enabling tracing does not enable content capture.

Five limits, all overridable:

| Limit                                       | Default    | Why                                                                                                                                                   |
| ------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ModelProviderConfig.timeoutMs`             | 60s        | Per model call. A stalled provider otherwise holds the request open indefinitely while tokens are still spent.                                        |
| `ViewServerConfig.composeDeadlineMs`        | 45s        | Wall clock across the *whole* request — planning and execution. This is the ceiling that actually bounds a compose; it is reported back on the envelope and on `RUN_STARTED`, allowing the client to derive its timeout. Refine and reopen draw from it too. |
| `ViewServerConfig.planDeadlineMs`           | 40s        | Wall clock across the planning phase, every repair attempt included. Clamped to sit inside `composeDeadlineMs`: the two cannot sum past the request. |
| `MAX_PROMPT_LENGTH`                         | 2000 chars | A visitor-facing route forwards prompts to a model that bills by token. Rejected before the provider is called, so an oversized prompt costs nothing. |
| `DataExecutorOptions.maxConcurrentRequests` | 6          | Without a cap, a twelve-capability plan opens twelve simultaneous connections to your own API. The visitor waits for the slowest either way.             |

## Current scope

- **Actions / mutations.** Everything above is read-only composition. Anything
  that changes state is a separate, later integration, and the bar it will have
  to meet is explicit registration, server-side authorization, validation,
  confirmation and auditing — not a capability that happens to write.
- **Multi-tenant catalog namespaces.** `createCapabilityCatalogStore` and
  `createSiteCatalogStore` are in-memory because a published capability holds a
  live executor closure. Durability is
  handled — configure `catalogStore` and call `restorePublishedCatalogs()` at
  boot, §2.2. History, rollback, and deletion are built in; a host that needs
  tenant-specific catalog namespaces must enforce that policy around the store.
- **Distributed persistence.** `createFileCatalogStore` and
  `createFileViewStore` provide durable single-process storage. Multi-replica
  deployments should implement `CatalogStore` and `ViewStore` over their own
  database.
