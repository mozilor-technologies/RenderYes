# @renderyes/server — notes for a coding agent

This is a **security boundary installed into someone else's backend**. A
visitor's words never become a query; a planner picks from capabilities a human
approved, and this package executes only those. Most of what follows is about
not accidentally widening that.

## Two catalogs, and the failure of publishing one

- **Capability catalog** (`POST /api/catalog`) — what data may be read.
- **UI catalog** (`POST /api/ui-catalog`) — what components may render it.

`scopeManifestToSurface` filters capabilities down to those *some registered
component accepts*. A capability no component can render is invisible to the
planner. Publishing only the capability half makes compose refuse with a
missing-UI-catalog error.

Publish both under **the same id** or nothing resolves. `POST /api/review-export`
takes both halves in one call with the id threaded through by construction; it
is the safer path, and it pre-checks `allowedUpstreamOrigins` so a misconfigured
host gets an actionable checklist.

## The two artifacts, and which one is yours

`renderyes-catalog` (ships with `@renderyes/capability-catalog`):

| file | whose |
|---|---|
| **inventory** | the machine's — hash-locked, editing it is refused at compile |
| **decisions** | yours — approved fields, arguments, row and time limits |

Full route: `inventory` → `candidate` → *edit* → `compile` → `publish`.
`renderyes-catalog --help` prints it per command. The inventory is generated and
hash-locked; it has no public JSON Schema. Strict schemas
for decisions and review exports ship in
`@renderyes/capability-catalog/schemas/`.

When a schema changes: `inventory` again, then `diff`. It exits 1 while
something needs deciding. Your decisions file survives — the review happens
once, not once per schema change.

A list wrapped in an object (`{docs, totalDocs}` — Payload, Strapi, most
REST-shaped facades) needs `inventory --list-envelopes` naming the rows field.
It is declared, never detected, and declaring it makes approved paths
row-relative. Without it a `collection` capability refuses to compile.

## Narrowing: where a visitor's constraint actually lands

| | reaches |
|---|---|
| `sourceNarrowingArguments` | planner-set arguments sent to the upstream |
| `supports.sourceFilterFields` | filter fields compiled into an upstream filter argument |
| `supports.filterFields` | the full filter allowlist; fields outside `sourceFilterFields` run post-fetch over one fetched page |

Until the source's own filter/search arguments are approved, every visitor
constraint narrows a page and the result is reported incomplete. A candidate
approves only paging arguments (`first`, `after`).

## Runtime behavior to account for

- **`complete: true` describes the request, not the answer.** A slot whose
  capability refused sits at `state: "error"` under an `ok: true` envelope.
  Check `requests[].ok` and `failedRequests`, never the envelope alone.
- **A schema does not prove endpoint behavior.** `POST /api/catalog/probe`
  executes each capability once and reports which ones the upstream actually
  answers. It also verifies that the upstream enforces the declared credential.
- **`allowedUpstreamOrigins` fails closed.** Unset means nothing publishes, not
  everything. Origins are compared parsed — scheme, host and port — never by
  prefix.
- **`restorePublishedCatalogs()` must run at startup** if you configure a
  `catalogStore`. Without it the first request after a restart finds an empty
  registry, and it reads as a publish that never happened.

## Undoing a publish

Catalog lifecycle routes include:

- `POST /api/catalog/history` — retained publishes, newest first
- `POST /api/catalog/rollback` — republish one, itself retained, so reversible
- `POST /api/catalog/delete` — unregister and forget; snapshots survive

All admin-gated, like every publish route. Import the exported
`ADMIN_TOKEN_HEADER` constant.

## Verifying without a model key

Configure the plan yourself:

```ts
planProviders: [{ id: "rehearsal", plans: [myPlan] }]
```

No key, no cost, identical answer every run — and the plan is yours, so what
passes says something about the install. `GET /api/providers` reports it as
`model: "scripted"`.

With nothing configured, compose throws `PlanProviderNotConfiguredError`,
carrying the same wiring report as
`describePlanningWiring(catalogId)` / `GET /api/planning-wiring`.

## Mechanics

- **ESM only**, but resolvable from either loader. Every subpath export carries a `default` condition alongside `import`, so a CommonJS resolver reaches the same ESM build. Node >= 22.
- Node adapters (`toNodeHandler`, `createFileCatalogStore`) live under
  `@renderyes/server/node`, not the root export.
