# RenderYes

[![CI](https://github.com/mozilor-technologies/RenderYes/actions/workflows/ci.yml/badge.svg)](https://github.com/mozilor-technologies/RenderYes/actions/workflows/ci.yml)

**Your website, rearranged around one sentence.** A visitor types what they
actually came for; a constrained planner turns it into a validated `Plan`; then
deterministic code fetches the data _you_ approved and renders it with
your React components.

No model key in the browser. No data leaving your infrastructure to be
rendered. Nothing composed that you did not approve field by field.

```
"Show me the politics coverage, and how many stories we've published"

   ▼  planner (AI, constrained)                     ▼  executor (plain code)
   Plan { posts.list · filter · posts.count }   →   your <StoryList />, your styles,
                                                    your auth, your rows
```

The model chooses _what to show_. It never sees a row, never holds a
credential, and never sets an identity parameter — those are declared in your
catalog and injected server-side. The blast radius of a bad generation is a
layout you can undo, not data you can't un-leak.

## Demo


https://github.com/user-attachments/assets/c33e7b3d-8883-4e70-9a17-16ac15c5fe8e



## Install

Two packages — one for your backend, one for your frontend:

```bash
npm install @renderyes/server        # your API
npm install @renderyes/react         # your app
```

## Minimal usage

**Backend** — mount one handler; it owns its own routes:

```ts
import { createServer } from "node:http";
import {
  createViewServer,
  createViewHttpHandler,
  VIEW_HTTP_ROUTES,
} from "@renderyes/server";
import { toNodeHandler } from "@renderyes/server/node";

const server = createViewServer({
  resolveSession: (request) => verifyYourOwnSessionCookie(request),
  host: {
    isAuthenticated: (session) => Boolean(session.userId),
    hasPermission: (session, permission) => session.permissions.has(permission),
    getSessionValue: (session, key) => session[key],
  },
  allowedUpstreamOrigins: ["https://api.example.com"],
});

const handler = createViewHttpHandler(server, {
  requireAdmin: (request) => yourOwnAdminCheck(request), // required, no default
});

// Serve the handler's exact paths alongside your app. The handler expects
// /api/* internally; a framework prefix is valid only when the adapter strips
// that prefix before forwarding the request.
const renderYes = toNodeHandler(handler);
const renderYesPaths = new Set(VIEW_HTTP_ROUTES.map((route) => route.path));
createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (renderYesPaths.has(normalizedPath)) return renderYes(req, res);
  yourExistingApp(req, res);
}).listen(3000);
```

**Frontend** — wrap your app; it stays exactly as it was:

```tsx
import { ViewProvider, ViewLauncher } from "@renderyes/react";

{
  /* serviceUrl is the base immediately before RenderYes's /api paths. Use ""
    for a direct same-origin mount. A stripped framework prefix may be included. */
}
<ViewProvider config={{ serviceUrl: "", catalogId: "your-site", components }}>
  {/* your existing app, untouched */}
  <ViewLauncher label="Ask" />
</ViewProvider>;
```

Between those two you approve your data once — through a local review UI or
from your own source in code. [`docs/QUICKSTART.md`](docs/QUICKSTART.md) walks
the whole path in one sitting.

## What stays yours

| You own                                 | RenderYes owns          |
| --------------------------------------- | ----------------------- |
| Your pages, styling, and components     | The compose pipeline    |
| Auth, sessions, and permissions         | Catalog validation      |
| Which APIs are approved, field by field | Planner constraints     |
| Your model provider, budget, and limits | Execution and rendering |

Your site stays reachable and unchanged. A composed view is an addition to it,
and if RenderYes is unavailable your site carries on without it.

## Documentation map

Each page has one job; where two could cover something, the more specific one
owns it and the other links.

**Using RenderYes**

- [`docs/QUICKSTART.md`](docs/QUICKSTART.md) — install to a composed view, one
  path, no branches. **Start here.**
- [`docs/HOST_INTEGRATION_STEPS.md`](docs/HOST_INTEGRATION_STEPS.md) — the same
  sequence at a glance, six steps, host-agnostic.
- [`docs/BUILD_A_HOST.md`](docs/BUILD_A_HOST.md) — one host built end to end,
  every decision shown. The long way round.
- [`docs/INTEGRATION.md`](docs/INTEGRATION.md) — the full integration guide:
  backend wiring, publishing, cost controls, saved views, and observability.
- [`docs/CATALOG.md`](docs/CATALOG.md) — approving data: the review UI, the
  code-first recipe, the twin discipline, and the review export artifact.
- [`docs/AUTHORING_VIEWS.md`](docs/AUTHORING_VIEWS.md) — the component
  contract. Hand this to whoever writes the components.
- [`docs/API.md`](docs/API.md) — public API behavior, defaults, and deployment
  rules.
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — symptom, cause, fix.
- [`docs/EXAMPLE_HOST.md`](docs/EXAMPLE_HOST.md) — The Bharat Times, the
  fictional newsroom every example in these guides runs against.

**Understanding it**

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the system works: the
  two catalogs, the `Plan`, runtime stages, query semantics, transport
  adapters, and the trust boundary.

**Contributing**

- [`AGENTS.md`](AGENTS.md) — operating rules for contributors and coding
  agents: principles, guardrails, dependency constraints, definition of done.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to propose a change, and the
  workflow for developing the packages themselves.
- [`CHANGELOG.md`](CHANGELOG.md) — what shipped in each release. Per-package
  changelogs are generated by Changesets alongside it.

## Workspace

**Installed by a host**

- `packages/react` — the only package a host frontend _imports_: provider,
  floating launcher, isolated render boundary, host-component registration.
- `packages/server` — the backend that runs alongside it: catalog and UI
  registries, and the `/compose` pipeline.
- `packages/starter-catalog` — generic components for an initial integration:
  data table, metric card, card grid, item list,
  detail panel, media gallery, record-with-lines, and charts.

**Tools you run**

- `apps/init` — `npx @renderyes/init`, the guided scaffolder.
- `apps/catalog-review` — local review and approval UI for OpenAPI and GraphQL
  sources. It can publish through an allowlisted proxy to your host; optional
  suggestion actions use whatever model provider that host configures.
- `packages/capability-catalog` — manual, OpenAPI and GraphQL discovery,
  approval, planner manifests, server bindings, validation. Ships a CLI.
- `packages/site-sdk` — component, surface, theme and data-slot registration.
- `packages/generate` — drafts a bespoke, host-styled component from an
  approved contract.

**Arrive as dependencies**

- `packages/core` — `Plan` contracts, validation, migration, A2UI interop.
- `packages/planner` — provider-neutral constrained plan generation and repair.
- `packages/data-runtime` — trusted capability execution, querying,
  composition, and approved relationship joins.

**Not published**

- `packages/planner-eval` — quality harness: which capability and component a
  real model actually selects, and how often the first attempt is valid.
- `eval/` — a synthetic finance catalog, a case corpus, and recorded baselines.

## Development

Node.js 22+ and pnpm 10.

```bash
pnpm install
pnpm check          # typecheck + lint + test + build
pnpm review:dev     # the catalog review UI, bound to 127.0.0.1
pnpm eval           # planner quality against the eval/ fixture
pnpm eval:catalog   # rebuild the fixture catalog JSON
pnpm smoke:install  # pack, install into scratch npm and pnpm apps, serve a request
```

This is the canonical copy of that block; `AGENTS.md` and `CONTRIBUTING.md`
link here.

Turbo owns build ordering, so a package's `test` does not build first —
`turbo.json` declares `test: { dependsOn: ["build"] }` and that is the only
place the order is expressed. Run tests through turbo, not around it:

```bash
pnpm test                                            # all packages, builds first
pnpm exec turbo test --filter=@renderyes/server    # one package, builds first
cd packages/server && pnpm test                      # no build — needs a prior pnpm build
```

To try local changes inside a real app, `pnpm sync:local --install ../my-app`
packs stable, version-less tarballs into `dist-packages/` and installs them the
way that app's package manager needs. See
[`CONTRIBUTING.md`](CONTRIBUTING.md#developing-the-packages-themselves) for why
the npm and pnpm recipes differ.

CI runs the same stages on every pull request
(`.github/workflows/ci.yml`), plus `pnpm smoke:install` as a separate job, so a
green local run means a green CI run. Formatting is not gated. Dependency
constraints that are not obvious from the manifests — notably the Zod v3/v4
split — are in [`AGENTS.md`](AGENTS.md#dependency-constraints).

## License

MIT — see [LICENSE](LICENSE).
