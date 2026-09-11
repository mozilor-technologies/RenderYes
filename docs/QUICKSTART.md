# Quickstart

RenderYes is a library suite, not an application. There is no site to start
and look at: you install two packages into an app you already have, approve what
the planner may read, and mount a provider.

This page is the shortest path from an empty `node_modules` to a composed view.
[`INTEGRATION.md`](INTEGRATION.md) is the reference; this is the order to do
things in.

Requires Node.js 22+.

## The credential you need

The deployment credential most often confused with package access is the
**host admin token**, and installing successfully tells you nothing about it.
The packages come from public npm with no registry credential. The host admin
token authorizes catalog publishing and other admin routes on **your** host's
`/api/*`; you mint it and decide how `requireAdmin` validates it. A bad or
missing value returns 401 or 403 from your service.

## 1. Install

Requires Node.js 22+. Any package manager.

```bash
npm install @renderyes/react @renderyes/starter-catalog   # frontend
npm install @renderyes/server @renderyes/capability-catalog  # backend
npm install @renderyes/site-sdk                             # wherever you build the UI catalog
```

Every other `@renderyes/*` package arrives transitively, pinned to the same
build. Four are yours to import or run:

| Package                         | Where         | What for                                             |
| ------------------------------- | ------------- | ---------------------------------------------------- |
| `@renderyes/react`              | your frontend | `ViewProvider`, `useViewCompose`, `defineView`       |
| `@renderyes/server`             | your backend  | `createViewServer`, `createViewHttpHandler`          |
| `@renderyes/capability-catalog` | your backend  | compiling a catalog, and the `renderyes-catalog` CLI |
| `@renderyes/site-sdk`           | your build    | `toSiteManifest`, when you publish a UI catalog      |

`site-sdk` is listed because step 4 needs it: `@renderyes/react` re-exports
only `defineProps` and `field` from it, so `toSiteManifest` has to be imported
directly.

Nothing renders until **both** catalog halves are published under one id — the
capability catalog (what may be read) and the UI catalog (what may render it).
Steps 4 and 5 do each half; if the ids disagree, compose refuses and the server
log names which half is missing.

For guided setup, `npx @renderyes/init` follows the same sequence and writes the
scaffolding for you.

The examples on this page use The Bharat Times — see `EXAMPLE_HOST.md`.

If you are developing the `@renderyes/*` packages, work from a clone — see
[the tarball alternative](https://github.com/mozilor-technologies/RenderYes/blob/main/CONTRIBUTING.md#developing-the-packages-themselves)
at the end of this page.

## 2. What you have to supply

- **A data source** — an OpenAPI or GraphQL endpoint. This is the one thing
  RenderYes cannot provide: the entire model is that a host approves reads
  against data they already own.
- **A model API key** — required for planning. Set `planProviders`. With none
  configured, compose refuses and names what is missing, alongside a report of
  everything that _is_ wired up: published catalogs, capability count,
  components, which providers hold credentials.

  To run the pipeline without a model, configure a plan you wrote yourself:

  ```ts
  planProviders: [{ id: "rehearsal", plans: [myPlan] }];
  ```

  Supply plans that exercise your integration. `GET /api/providers` reports
  this provider as `model: "scripted"`.

## 3. Three things you write

1. **A backend mount.** `createViewServer` for configuration,
   `createViewHttpHandler` for the routes, and `restorePublishedCatalogs()` once
   at boot. Roughly forty lines — see [INTEGRATION.md §2](INTEGRATION.md).

   `host` and `resolveSession` are required, so TypeScript catches those.
   Three more have no default and it will not:
   `createViewHttpHandler`'s `requireAdmin`; `allowedUpstreamOrigins`, which
   fails closed, so an absent or empty list rejects every capability at
   execution time; and `resolveViewOwner`, required by every path that looks a
   plan up by id — refine, revise, and save — because such a lookup is an
   authorization decision, and without an owner key any caller holding a
   `planId` could act on another visitor's view. Only a host that composes
   statelessly can omit it.

2. **A views folder.** One file per component, each a `defineView` default
   export, ingested as a folder. See
   [`AUTHORING_VIEWS.md`](AUTHORING_VIEWS.md) — that document is written to be
   handed to whoever writes the components, on its own.

   **This is what makes a composed view look like your site**, and there is no
   substitute for it: your components are your own markup and your own CSS. The
   starter set is a bootstrap: it inherits your typeface and text size, and
   takes colours through the `--iv-starter-*` custom
   properties, which cross the isolation boundary. Enough to demo; not enough to
   ship as yours.

   `npx @renderyes/generate component` will draft one against your own
   stylesheet and existing components, and refuses a draft that invents values
   already defined by your design system.
   Treat it as a first draft you read, not output you keep unread.

3. **A provider mount.** `ViewProvider` with your `serviceUrl` and `catalogId`,
   then either `ViewLauncher` or your own page built on `useViewCompose` and
   `ViewSurface`. Give the collection components a link
   (`getCardHref`/`getItemHref`/`getRowHref`, or the `on*Activate` variants for
   an SPA router): a card a visitor cannot click through to the real page is a
   dead end, and the library will never invent the URL — where a record lives
   on your site is yours to say, and the model never sees or influences it.

## 4. Approve a catalog

Nothing composes until a capability catalog is published. There are two routes
to one:

- **The review UI**, below — interactive exploration of a schema in a browser,
  right for a first look at what discovery finds.
- **Code-first** — the catalog as source in your own repository, published on
  boot; right for anything you want reproducible and code-reviewed, and the
  only route that needs no browser. See
  [`CATALOG.md`](CATALOG.md).

The review UI installs like anything else, and it publishes _through your
host_: it serves the built app locally and proxies its `/api` calls to
wherever your host actually listens, attaching your admin token. So it needs
to be told both things:

```bash
export RENDERYES_HOST_URL=http://127.0.0.1:8787   # your host, the one mounting /api
export RENDERYES_ADMIN_TOKEN=...                  # whatever your requireAdmin accepts
npx @renderyes/catalog-review
```

`--host-url` works as a flag if you prefer it to the environment variable. The
token is sent as `x-renderyes-admin-token` by default (`ADMIN_TOKEN_HEADER`
in `@renderyes/server`); if your `requireAdmin` reads a different header, set
`RENDERYES_ADMIN_HEADER` to its name. The UI
itself stays local-only (`http://127.0.0.1:4173`) and unauthenticated: the
credential lives in the proxy, server-side, never in the browser.

Publishing posts to `POST /api/catalog` on your host, which sits behind your
`requireAdmin`.

### Or start from a schema file, without a browser

The same catalog is reachable from a terminal, which is what makes onboarding
scriptable and reproducible.

Name the queries you want. `inventory` with no `--queries` takes every supported
root field, and a generated CMS schema has far more of them than a catalog
should: a Payload instance offers 86, among them `Users`,
`PayloadPreferences`, `PayloadLockedDocuments`, `FormSubmissions`, and the
whole `docAccess*`/`version*` family — one of them, `Access`, discovers 167
fields and excludes 629. `candidate` then approves visitor access to all of
it, and "cut it down" becomes a review of thousands of fields nobody chose.
Narrowing first is the cheaper order, and the reviewable one:

```bash
npx --package @renderyes/capability-catalog renderyes-catalog inventory --schema schema.graphql --catalog-id bharat-times --queries Posts,Categories --purposes purposes.json --out inventory.json
```

`inventory` names every query it skipped and whether it was unsupported or simply
not found, so a typo in the list does not read as a schema limitation.

`--purposes` is not optional on a generated schema. The purpose is the prose the
planner selects a capability by, and a schema whose fields carry no description
leaves it as a placeholder. `compile` refuses that unfinished review. The file
is a JSON object keyed by root
field:

```json
{
  "Posts": "Published news articles with headline, summary, publication time and section. Sort by publishedAt when recency matters.",
  "Categories": "The newspaper's sections — Politics, Business, World, Opinion, Culture, Sport — for browsing coverage by section."
}
```

The alternative is writing descriptions into the schema itself and taking the
inventory again — which works, and is not available to you if your upstream
generates that schema.

```bash
npx --package @renderyes/capability-catalog renderyes-catalog candidate --inventory inventory.json --approve-all-discovered --out decisions.json
```

`inventory` discovers every root query, reports the fields it could not offer
and why, and names any custom scalar you still owe a mapping for. It is the
machine's reading of your schema: hash-locked, and not yours to edit.
`candidate` turns it into a decisions file that compiles — a _starting point_,
not a review: it approves visitor access to every field discovery found, which
is why it refuses to run without `--approve-all-discovered` spelled out. That
file **is** yours. Cut it down, decide the visitor and identity arguments, and
keep `authentication` at `session` until the probe (below) shows you what your
upstream actually enforces.

Then compile and publish it, still without a browser:

```bash
npx --package @renderyes/capability-catalog renderyes-catalog compile --schema schema.graphql --inventory inventory.json --decisions decisions.json --endpoint https://bharat-times.example/api/graphql --out bharat-times.catalog.json
```

```bash
RENDERYES_ADMIN_TOKEN=… npx --package @renderyes/capability-catalog renderyes-catalog publish --service-url http://127.0.0.1:3000 --file bharat-times.catalog.json
```

That publishes the capability half. Nothing renders until a UI catalog is
published under the same id. `npx @renderyes/init` writes a
`scripts/publish-ui-catalog.mjs` into your repo that does this from your own
components; on the manual path it is yours to write, and
[`AUTHORING_VIEWS.md`](AUTHORING_VIEWS.md) shows its shape. Either way it runs
under `tsx`. To do both in one call, have that script write its
manifest (`--emit ui.json`) and pass `--ui-manifest ui.json` to `compile`: the
id is then threaded through both halves by construction.

Relay paging arguments (`first`, `after`) are the one exception it approves
for you, and only where the root field returns a Relay connection. They are
not visitor steering, and without them a connection capability compiles and is
then rejected by any API that requires a page size.

An API that pages by offset — `limit`/`page`, as Payload CMS does — gets no
exception, because nothing outside Relay makes the distinction checkable:
those names are one host's convention, and approving them by name would be the
same guess `resultShape` refuses to make. Add them to the decisions file by
hand — it is not covered by the review hash, so unlike the inventory it is yours
to edit — and declare them in the query selection's `listEnvelope`
(`pageSizeArgument`, `pageArguments`; see
[`CATALOG.md`](CATALOG.md)) so the planner is not told a
page size narrows which records qualify. While you are there: a Payload-style
schema also offers `draft` and `trash` booleans on every list, and those
expose unpublished and soft-deleted content — approving them is a decision
about what a visitor may read, not a paging convenience.

### When the schema changes

Your decisions file survives it. The review happens once, not once per schema
change — which is the whole reason the two artifacts are separate files:

```bash
# 1. Take the inventory again, over the new schema
npx --package @renderyes/capability-catalog renderyes-catalog inventory --schema new-schema.graphql --catalog-id bharat-times --out inventory.json
```

```bash
# 2. Ask what that makes you decide
npx --package @renderyes/capability-catalog renderyes-catalog diff --inventory inventory.json --decisions decisions.json
```

`diff` reports approved fields the schema has since dropped, fields needing a
semantic type, capabilities that are new since you last looked, and fields
available but never approved. Edit those in your decisions file, then `compile`
and `publish` as above.

It exits non-zero while something needs deciding, so a pipeline can gate a
republish on it. Fields left unapproved are reported without failing because a
narrower approval remains valid.

`diff` also checks whether these decisions were made against this inventory at
all, and exits non-zero when they were not — the pair does not compile in that
state, so a green report would be a false one. That happens without any schema
change: `reviewSourceHash` covers the inventory's _options_, so supplying a
scalar mapping is enough. When nothing you decided is affected, re-bind rather
than re-review:

```bash
npx --package @renderyes/capability-catalog renderyes-catalog migrate --decisions decisions.json --inventory inventory.json --write
```

It refuses when an approved capability or field is no longer offered — that is a
review, and no tool should stamp past it.

The same loop is in `renderyes-catalog --help` and `diff --help`, and the
compile-time drift error points at it.

### Keeping your decisions when this package changes

The review UI exports the same decisions file. It is the durable artifact — keep
it in your repository, and you never repeat the review by hand:

```bash
npx --package @renderyes/capability-catalog renderyes-catalog migrate --decisions decisions.json --write
```

`migrate` performs the mechanical upgrades between formats and prints every
rewrite it made.

From a repository checkout, the development server reads the same variable:

```bash
pnpm review:dev
```

Set `RENDERYES_HOST_URL` to wherever your host actually listens; the `/api`
proxy follows it.

Then publish your UI catalog. The body is an envelope, not the manifest itself:

```ts
import { toSiteManifest } from "@renderyes/site-sdk";

await fetch(`${gateway}/api/ui-catalog`, {
  method: "POST",
  headers: { "content-type": "application/json", ...adminHeaders },
  // `catalogId` is what compose looks this up by. It defaults to the site's own
  // id, so a site named `<catalog>-ui` publishes fine and then finds nothing at
  // compose time unless you name the catalog here.
  body: JSON.stringify({ manifest: toSiteManifest(site), catalogId: "your-catalog" }),
});
```

Both registries are in-memory, because a published capability holds a live
executor closure. They survive a restart only if you configured `catalogStore`
and call `restorePublishedCatalogs()` — see [INTEGRATION.md §2.2](INTEGRATION.md).

## Before you publish, check the catalog answers

Publishing validates the shape of a catalog, not whether the upstream will serve
it. A schema can declare an argument optional and require it in the resolver,
and that field then fails every row at compose time. One call settles it:

```bash
curl -s -X POST "${gateway}/api/catalog/probe" \
  -H 'content-type: application/json' \
  -H "${adminHeader}" -H "${yourOwnSessionHeader}" \
  -d '{"catalogId":"your-catalog"}'
```

**Both credentials, not just the admin one.** The route is admin-gated, and that
is not the whole story: the probe _executes_ capabilities, and those declare
`authentication: "session"`, so the request also has to carry whatever your own
`resolveSession` reads — a signed cookie, a bearer token, a header your app
already uses. This library never inspects it and has no opinion on its shape, so
there is no header to copy from here; send what a visitor request sends.

Admin authorizes the probe; the session is what it probes with, and what your
upstream actually sees. Add `"checkUpstreamCredential": false` to the body to
check shape without executing — useful in CI, where you have an admin token and
no visitor.

Each capability comes back `ok`, `failed` with the upstream's own reason, or
`skipped` when it needs parameters the probe will not invent.

## When something 401s, 404s, or refuses to connect

Every failure at this stage looks generic where it happens; the cause is almost
always which of the two credentials — or which of the two servers — is
involved. [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) diagnoses each symptom,
starting with the 401/403 that install did not prove anything about.

## Known rough edges

- **A headless first decisions file approves everything discovery found.** The review
  UI makes the decisions clickable and
  [`CATALOG.md`](CATALOG.md) makes them writable in code,
  where a human decides every field. `candidate` (§4) is the third route and the
  blunt one: it approves visitor access to every field discovery offered, and
  refuses to run without `--approve-all-discovered` spelled out for exactly that
  reason. Narrow the inventory with `--queries` first, so the approved set is the
  reviewed set — or use one of the other two routes.
- **Managing saved views has no UI beyond the workspace's own.**
  `ViewWorkspace` offers Save view and an inline saved list, and its panels
  carry the pin and rearrange affordances; `ViewLauncher` and any host chrome
  built directly on `useViewCompose` do not, so a visitor there can neither keep
  a view nor browse what they kept.
- **The shipped refinement UI covers panel reordering only.** `ViewWorkspace`
  persists panel moves through deterministic `reorderNodes`. Sort, filter,
  limit, and remove operations are available through `useViewCompose`, but the
  host supplies their controls. The starter table's column sorting is local to
  the fetched rows and does not refine the plan.

The issue tracker carries the full list. It is
not shipped in this package.
