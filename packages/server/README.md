# @renderyes/server

The backend a host runs alongside `@renderyes/react`: the capability and UI
registries, the `/compose` pipeline, and the HTTP routes that expose them.

```ts
import { createViewServer, createViewHttpHandler } from "@renderyes/server";
import { toNodeHandler, createFileCatalogStore } from "@renderyes/server/node";

const server = createViewServer({
  host,
  resolveSession,
  allowedUpstreamOrigins: ["https://api.example.com"],
  catalogStore: createFileCatalogStore(new URL("./data", import.meta.url)),
  // Required to publish a GraphQL capability catalog, which is most hosts:
  // GraphQL carries no notion of where a row came from, so the host says. A
  // publish without it throws and names the field, but the mount is where you
  // would rather find out. See @renderyes/capability-catalog's GRAPHQL.md.
  graphql: { resolveProvenance },
});

await server.restorePublishedCatalogs();

const handler = createViewHttpHandler(server, {
  requireAdmin: (request) => isAdmin(request),
  // Omit entirely when the app and this handler are same-origin. Nested under
  // `cors` — a top-level `allowedOrigins` is not a config field, and in plain
  // ESM nothing rejects it: the handler sends no CORS headers and answers
  // every preflight with 405.
  cors: { allowedOrigins: ["https://your-site.example"] },
});
```

`createViewHttpHandler` returns a fetch-standard `(Request) => Promise<Response>`
and owns its route paths; `toNodeHandler` adapts it to `node:http`. Published
catalogs are held in memory because a capability carries a live executor
closure, so they survive a restart only through a `catalogStore` plus
`restorePublishedCatalogs()` at boot. `requireAdmin` is required and has no
default. CORS is off unless `cors` is supplied; there is no wildcard, and no
default.

The full guides ship with this package, in `docs/`:

- `docs/QUICKSTART.md` — the order to do things in, from install to a composed view.
- `docs/INTEGRATION.md` — backend wiring, publishing, cost controls, and persistence.
- `docs/AUTHORING_VIEWS.md` — written to be handed to whoever writes the components.
- `docs/CATALOG.md` — discovery, review, approval, and publishing.
- `docs/BUILD_A_HOST.md` — an end-to-end host implementation.
- `docs/API.md` — public behavior and defaults.
- `docs/TROUBLESHOOTING.md` — symptom, cause, fix.
- `docs/HOST_INTEGRATION_STEPS.md` — the integration sequence at a glance.
- `docs/EXAMPLE_HOST.md` — the example domain used throughout the guides.

They also live at
<https://github.com/mozilor-technologies/RenderYes/tree/main/docs>.

The shipped `.d.ts` files document each config field in context.
