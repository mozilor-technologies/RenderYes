# Host integration steps (any website)

RenderYes is **host-agnostic**: it adds a surface to a site you already run,
against an API you already own. These are the steps in order, and what belongs
to you at each one. The examples use The Bharat Times — see `EXAMPLE_HOST.md`.

```text
Real website UI (unchanged)
   + Ask launcher (@renderyes/react)
         │
         ▼
your backend  POST /api/compose   (@renderyes/server)
         │
         ▼
Approved capability catalog → your APIs
```

## Steps every host follows

### 1. Keep running your real website
Whatever you already ship. Visitors use that UI first, and it does not change.

### 2. Mount the service in your own backend

`createViewHttpHandler` routes the fixed `/api/*` paths RenderYes uses — compose,
refine, catalog publishing, saved views, and diagnostics. Mount those exact
paths behind your own authentication, with `toNodeHandler` from
`@renderyes/server/node` if you run Node's HTTP server directly.

The full wiring, including the fields that have no safe default,
is in `INTEGRATION.md` §2, which ships in `@renderyes/server`.

Publishing is gated by your own `requireAdmin`. There is no default or built-in
credential; every publish is refused until you supply one.

### 3. Approve data (capability catalog)

- Run the review UI: `npx @renderyes/catalog-review`
- Point it at your service, origin only: `RENDERYES_HOST_URL=https://your-app.example`
- Load your GraphQL SDL or OpenAPI document
- Approve queries, fields and policy — this is the security decision, and
  nothing composes against data you did not approve here
- Publish the catalog and bindings to `{your service}/api/catalog`

Or do the same from a terminal with `renderyes-catalog`, which needs no
browser: see `CATALOG.md`.

### 4. Register UI components on the real site

In your React app:

```tsx
import {
  defineHostComponent,
  ViewProvider,
  ViewLauncher,
} from "@renderyes/react";

const StoryList = defineHostComponent({ /* your component + dataSlots */ });

<ViewProvider
  config={{
    serviceUrl: "",              // base URL immediately before /api/compose;
                                 // use "" for a direct same-origin mount
    catalogId: "bharat-times",
    components: [StoryList],
    // If your token refreshes, refresh it here — see below.
    getAuthHeaders: async () => ({
      authorization: `Bearer ${await auth.getValidToken()}`,
    }),
  }}
>
  {/* existing app unchanged */}
  <ViewLauncher label="Ask" />
</ViewProvider>
```

**`getAuthHeaders` must produce a *currently valid* token, not the last stored
one.** If your app refreshes its token inside its own transport — an Apollo
link, an axios interceptor, a fetch wrapper — that refresh applies only to
requests passing through that layer, and RenderYes's do not. A page left open
long enough then sends a token that expired while it sat there. The hook may
return a promise for exactly this reason: `await` the same refresh your
transport performs.

The failure is worth recognising because it does not look like an auth failure.
The upstream rejects the stale token, permissions resolve empty, and the visitor
is told they are missing a permission they actually hold.

### 5. Publish the matching UI catalog

**Nothing renders until both halves exist under one id.** The capability catalog
says what may be read; the UI catalog says what may render it. Publish the
second with `POST {your service}/api/ui-catalog` and a body of
`{ manifest: toSiteManifest(site), catalogId }` — an envelope, not the bare
manifest, and `catalogId` is what compose looks the UI catalog up by.

`toSiteManifest` comes from `@renderyes/site-sdk`; `@renderyes/react`
re-exports only `defineProps` and `field` from it.

If the two ids disagree, compose refuses and the server log names which half is
missing and under what key it is actually filed.

### 6. Ask from the real site

The visitor stays on your pages. Ask opens as an overlay, and compose returns
your registered components — never generated markup.

## What must stay host-specific

| Host owns | RenderYes owns |
|-----------|------------------|
| Website pages & styling | Compose pipeline |
| Auth / session headers | Catalog validation |
| Registered React components | Planner constraints |
| Which APIs are approved | Execution + A2UI messages |
