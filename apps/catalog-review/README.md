# @renderyes/catalog-review

The review UI a host uses to turn their own GraphQL or OpenAPI schema into an
approved RenderYes capability catalog.

**This is an onboarding tool, not part of a deployed site.** Install it as a dev
dependency, run it locally, export the catalog, and publish that catalog from
your own server with `@renderyes/server`. Nothing here belongs in production:
the UI has no authentication and reads your schema.

```bash
npx @renderyes/catalog-review
```

Then open <http://127.0.0.1:4173>. Connect a schema, approve the operations and
fields you want exposed, and compile the review. The GraphQL flows can download
the reviewed decisions, capability catalog, planner manifest, server bindings,
or a review-export bundle, depending on the selected flow. Keep decisions in
source control. Keep server bindings server-side: they contain operation and
endpoint detail and must never reach a browser or planner.

To publish from the UI, connect it to a running RenderYes host:

```bash
RENDERYES_ADMIN_TOKEN=... \
  npx @renderyes/catalog-review --host-url http://127.0.0.1:3000
```

`--host-url` also accepts a mount prefix. `RENDERYES_HOST_URL` is the environment
variable equivalent. The local server forwards only an allowlisted set of
review and publication routes; the admin token stays in the local Node process.

Set `PORT` to serve on a different port. The interface is always bound to
`127.0.0.1`.

## Approving without the UI

For **GraphQL** sources the same flow is available headless, which is what you
want in CI or for a catalog you regenerate as a schema changes:

```bash
npx --package @renderyes/capability-catalog renderyes-catalog inventory --help
```

`inventory`, `candidate`, `diff` and `migrate` cover the GraphQL ground. `candidate`
refuses to approve everything it discovered unless you pass
`--approve-all-discovered`, because approving a whole schema by default is how a
capability nobody reviewed ends up exposed.

**OpenAPI has no headless equivalent** — this UI is currently the only way to
produce an OpenAPI approval. The artifact it exports is plain JSON validated by
`OpenApiCatalogDecisionsSchema`, so a host can generate one programmatically, but
there is no packaged CLI for it.

## What it does not do

It does not talk to your upstream at runtime, hold credentials, or decide
authorization. An approved catalog is a description of what a host has
*permitted*; the host's own server still applies authentication, permissions,
rate limits and auditing on every request. See the repository's
[catalog guide](https://github.com/mozilor-technologies/RenderYes/blob/main/docs/CATALOG.md).
