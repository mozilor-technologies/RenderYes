# @renderyes/init

Sets up and diagnoses a RenderYes integration.

```bash
npx @renderyes/init                 # set up, resuming from wherever you are
npx @renderyes/init doctor          # report what is true, change nothing
```

**Never install this.** It writes files into a project and it is invoked, not
imported — the same reason `@renderyes/catalog-review` is run with `npx`. A
scaffolder in a dependency tree ends up in a deployed application.

## What it does

Five levels, each either reached or not:

| | |
| --- | --- |
| **access** | the `@renderyes` scope is routed to a registry |
| **installed** | the right packages for this half, and nothing from the tools tier |
| **mounted** | a mount with the no-default decisions answered, and the boot step in place |
| **published** | both catalogs registered, under ids that agree |
| **verified** | one real compose through your own mount, rendering something |

**access** checks the routing, not the credential. A token is exercised only by
something that installs, so a project already installed — from tarballs, or from
a registry it can still reach — passes this level with an expired one, and the
install step is where that surfaces.

`doctor` reports the level. The walk acts on the first one not reached. Both run
the same checks — nothing is asserted in one mode and assumed in the other.

There is no state file. Every level re-derives whether it is satisfied, so
interrupting the walk and re-running it continues from the first thing that is
still not true.

## The two topologies

**Coexist** — your backend is Node, so RenderYes mounts into it. Next.js and
Express have complete mount templates. Other detected frameworks receive the
fetch-standard handler plus examples for fetch-native and raw Node request/
response adapters; attaching it to that framework remains a manual step.

**Standalone** — when your backend is not Node, the tool writes a small Node
service: plain `node:http`, no framework, its own manifest. The frontend runs
on another origin, so this topology requires CORS.

When the halves live in separate repositories, the backend run emits
`renderyes.handoff.json` and the frontend run consumes it with `--handoff`.
Four facts cross that boundary — the catalog id, the service URL, the auth
*shape*, and the registered frontend origin — and they travel as data so the
catalog id is never typed twice. No secrets: the name of the variable holding
your admin token, never its value.

## What it will not do

- **Grant registry access.** It diagnoses a missing scope mapping and an expired
  token, and tells you which script to re-run. It never writes an `.npmrc` and
  never touches a tracked `.gitignore`.
- **Approve fields.** `--schema` runs the headless `candidate`, which approves
  everything discovery found and says so verbatim. That is a starting point, not
  a review.
- **Handle secrets.** Values come from environment variables you name. Nothing
  is prompted for, stored, or written.
- **Overwrite anything.** A file that exists is yours. On collision it reports
  and writes none of the plan, so a conflict on the last file cannot leave the
  first four behind.

## Verification, and what it proves

The last step composes a real prompt through your own mount, so it needs a plan
provider. Either a model key in the environment variable your `planProviders`
entry names, or a provider carrying a plan you wrote yourself —
`planProviders: [{ id: "rehearsal", plans: [myPlan] }]` — which needs no key and
gives the same answer twice.

There is no built-in mock planner. With nothing configured, compose refuses and
names what is missing. For deterministic verification, provide a scripted plan
that exercises the capability and component you intend to test.

What it proves is the wiring: the mount, session resolution, both catalogs,
component registration, and a rendered node. What it does **not** prove is that
every capability works — a plan you wrote exercises the capability you wrote it
for. The probe is what covers the rest, which is why both run.

## Options

```
--service-url <url>        where createViewHttpHandler is mounted; enables live checks
--admin-token-env <NAME>   variable holding your admin token
--schema <file>            GraphQL SDL, for the headless candidate route
--handoff <file>           consume the other repository's handoff
--role frontend|backend|both   override detection
--catalog-id <id>          override the id derived from package.json
--prompt <text>            a question in your own words; also the placeholder
--out <dir>                where a standalone service is written
--port <n>                 standalone service port, or the review proxy's
--yes                      take every derived default, ask nothing
--dry-run                  print the file plan, install nothing, write nothing
--skip-install             scaffold only; install the packages yourself
```

The headless route, which needs no questions answered:

```
--schema <file>            GraphQL SDL — takes the inventory and a candidate
--queries a,b              inventory only these root fields. Without it the
                           whole schema is taken: on a large API that is dozens
                           of capabilities and tens of megabytes, each one
                           needing a decision before anything compiles
--decisions <file>         your reviewed decisions, to compile and publish
--inventory <file>         the inventory those decisions were made against
--endpoint <url>           your GraphQL endpoint; its origin becomes the
                           upstream allowlist
--semantic-types <file>    fields discovery could not place, keyed as the
                           compile error names them
--shapes <file>            corrects a capability's result shape, keyed by root
                           field name — discovery proposes four of the nine
--ui-manifest <file>       your components as a site manifest, to publish both
                           halves in one call. The publish script writes one
                           with --emit <file>
--rows <n>                 sample rows to read when proposing a candidate
```

Answers you can provide up front:

```
--session cookie|bearer|anonymous|custom   how the app authenticates a visitor
--owner single-user|tenant|nested|anonymous|custom
                           what identifies a visitor for saved views
--topology coexist|standalone              where the service runs
--frontend-origin <url>    the origin allowed to call the mount
--env-file <file>          where the scaffolding writes its variable names
```

Reporting:

```
--page-url <url>           the RenderYes page, checked for whether it renders
--json                     doctor: emit the checks as JSON instead of a report
```

Every flag `--help` offers is listed here, and a test fails the build when the
README omits one. `--queries` is the way to inventory only part of a large
schema.

## Environment variables the scaffolding reads

Two, and neither is set for you — `init` never reads or writes a `.env` file.

| Variable | Read by | What happens without it |
|---|---|---|
| `RENDERYES_DEV_SESSION` | the scaffolded `resolveSession` | The resolver throws until this is set for local verification. This prevents a permissive session default from reaching production. |
| `RENDERYES_SERVICE_URL` | the scaffolded publish script | Falls back to the service URL you answered with. Node has no page origin to resolve a relative URL against, so this must be absolute, mount prefix included. |

Set them wherever your app already reads environment variables. You will also
need whatever you named for the admin token and the model provider's API key —
`init` prints both names at the end of a run.

## GraphQL only, for now

The approval CLI imports only GraphQL builders and the review-export bundle is
GraphQL-shaped, so there is no headless route and no bundle for an OpenAPI
catalog. An OpenAPI host publishes from the review app against a running mount —
which `review` makes possible by proxying to it.

Reviewing a schema against a running host is \`npx @renderyes/catalog-review
--host-url <url>\`, which serves the review UI and forwards the routes it calls,
pinned to an allowlist. This tool connects to that existing proxy.
