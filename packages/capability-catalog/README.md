# Capability Catalog

This folder is the self-contained handoff unit for RenderYes's capability/data catalog.
It describes approved data capabilities in a transport-neutral form and compiles them into:

- a trusted catalog plus capability-owned runtime map for server-side execution; and
- a smaller `PlannerManifest` containing only information safe and useful for planning.

It contains no A2UI, React components, HTTP executor, authentication, or
model-provider code. Those live in `@renderyes/server`,
`@renderyes/site-sdk`, and `@renderyes/react`; a host integrating without
them owns those concerns itself.

## Entry points

| Import                                    | Contents                                                    | Intended location     |
| ----------------------------------------- | ----------------------------------------------------------- | --------------------- |
| `@renderyes/capability-catalog`         | Portable catalog schemas, types and compilation             | Shared                |
| `@renderyes/capability-catalog/planner` | Planner-safe manifest projection                            | Planner boundary      |
| `@renderyes/capability-catalog/server`  | Manual registration, runtimes and validation                | Server only           |
| `@renderyes/capability-catalog/openapi` | OpenAPI review/import and private bindings                  | Build/admin or server |
| `@renderyes/capability-catalog/graphql` | GraphQL discovery, approval, compilation and server adapter | Build/admin or server |
| `@renderyes/capability-catalog/review`  | Deterministic review helpers                                | Build/admin           |

## Core boundary

The planner may choose a registered `capabilityId` and provide parameters accepted by that
capability's input schema. It never receives runtime functions, endpoint bindings, session-key
names, permission names, or source URLs.

The host's deterministic executor validates those parameters, injects trusted session identity,
enforces host authorization, calls the capability runtime, and validates the complete result
before any data reaches rendering.

For GraphQL, the host can additionally approve leaf field paths that a model may request. The
model proposes a structured request, never credentials or an executable network call. The package
compiles that request into a validated GraphQL operation and delegates transport and provenance
resolution to trusted host callbacks.

See [DIRECT_WIRING.md](DIRECT_WIRING.md) and [GRAPHQL.md](GRAPHQL.md) — both ship
with this package. Worked integrations also ship under `examples/`.

## The whole catalog lifecycle, from a terminal

Two artifacts, and the names say which is which. The **inventory** is the
machine's reading of your schema — what could be offered, hash-locked, not
yours to edit. The **decisions** file is yours: what a visitor may actually
read, which arguments they may steer, how many rows, how long a result lives.

The `renderyes-catalog` binary ships with this package:

```bash
renderyes-catalog inventory --schema schema.graphql --catalog-id shop \
                              --out shop.inventory.json
renderyes-catalog candidate --inventory shop.inventory.json \
                              --approve-all-discovered --out shop.decisions.json
# edit shop.decisions.json — this is the file that is yours
renderyes-catalog compile   --schema schema.graphql \
                              --inventory shop.inventory.json \
                              --decisions shop.decisions.json \
                              --endpoint https://api.example/graphql \
                              --out shop.catalog.json
renderyes-catalog publish   --service-url http://127.0.0.1:3000 \
                              --file shop.catalog.json
```

`inventory` discovers a schema without a browser. `candidate` produces a first
decisions file that compiles — explicitly opt-in, since it approves visitor
access to every discovered field. `compile` turns the pair into a publishable
catalog, and `publish` registers it on a running mount (the admin token comes
from `RENDERYES_ADMIN_TOKEN`, never a flag).

Pass `--ui-manifest <file>` to `compile` and it emits a review-export bundle
instead — both halves under one id, in one publish call. The scaffolded
`npx tsx scripts/publish-ui-catalog.mjs --emit <file>` writes that manifest from
your own components. Under a loader, not bare `node`: it imports your JSX.

`curated` skips the review entirely, compiling straight from a schema. It
requires `--confirm-visitor-safe` spelled out, and `--yes` does not satisfy it.

If your API wraps its rows — Payload's `{docs, totalDocs}`, and most
REST-shaped facades — say where they live:

```bash
renderyes-catalog inventory --schema schema.graphql --catalog-id shop \
  --list-envelopes '{"Articles": {"rowsField": "docs", "totalCountField": "totalDocs"}}'
```

It is never detected: an entity that is scalars plus one nested list has the
same structural signature, and only you know which it is. Without a
declaration the compile refuses a `collection` over a wrapper and names the
candidate rows field. Declaring one makes approved paths row-relative —
`title`, not `docs.title`.

`diff` and `migrate` keep a committed decisions file alive across schema and
format changes:

```bash
renderyes-catalog diff    --inventory shop.inventory.json --decisions shop.decisions.json
renderyes-catalog migrate --decisions shop.decisions.json --write
```

`diff` also reports whether the two files are still bound to each other.
`reviewSourceHash` covers the inventory's *options*, not only the schema, so
supplying a scalar mapping re-hashes an inventory whose schema never moved and
the pair stops compiling. When nothing you decided is affected,
`migrate --decisions <file> --inventory <file> --write` re-binds and keeps the
review; it refuses when an approved capability or field is gone.

The decisions file is the durable artifact — keep it in your repository.

### Every flag, by command

`--help` on any command is the authority; this is the same set, written down so
it can be found without running the tool.

**`inventory`** — read a schema, propose what it offers.

| Flag | |
|---|---|
| `--schema <file>` `--catalog-id <id>` | required: the SDL or introspection JSON, and the id both catalog halves are filed under |
| `--queries a,b` | only these root fields. A generated CMS schema offers far more than a catalog should |
| `--purposes <file>` | JSON keyed by root field, giving the prose the planner selects a capability by. Required when schema fields have no descriptions; `compile` refuses unresolved placeholders |
| `--shapes <file>` | correct a result shape discovery could only guess — `hierarchy`, `search-results`, `comparison` |
| `--scalars <file>` | map custom scalars onto types this package understands |
| `--list-envelopes <file>` | name the rows and total fields of a `{ items, total }` envelope, and the arguments that page it |
| `--source-label <label>` `--depth <n>` `--out <file>` | how the source is named, how deep discovery walks, where the inventory is written |

**`candidate`** — turn an inventory into a starting-point decisions file.

| Flag | |
|---|---|
| `--inventory <file>` `--out <file>` | in and out |
| `--approve-all-discovered` | required, spelled out: the emitted file approves visitor access to every discovered field and must still be reviewed |
| `--semantic-types <file>` | seed the semantic types discovery could not place, keyed `"Query.books.total"` |
| `--rows <n>` | the row ceiling written into each capability's policy |

**`compile`** — turn schema plus decisions into a publishable catalog.

| Flag | |
|---|---|
| `--schema` `--inventory` `--decisions` `--endpoint` `--out` | the four inputs and the artifact |
| `--credential-id <id>` | names a credential the host declared out-of-band; the caller can never name an environment variable directly |
| `--ui-manifest <file>` | emit a review-export bundle carrying both catalog halves under one id |

**`curated`** — compile straight from a live endpoint, skipping the review file.

| Flag | |
|---|---|
| `--endpoint <url>` `--catalog-id <id>` `--out <file>` | source, id, artifact |
| `--confirm-visitor-safe` `--yes` | the first is required and the second does not satisfy it: this approves visitor access to everything discovered |
| `--auth <header>` `--timeout <seconds>` | how the introspection request is made |
| `--depth <n>` `--max-fields <n>` `--page-size <n>` `--rows <n>` | the discovery and policy ceilings |
| `--scalars <file>` `--semantic-types <file>` `--ui-manifest <file>` | as for `inventory` and `compile` |

**`diff`** and **`migrate`** — keep a decisions file valid as the schema moves.

| Flag | |
|---|---|
| `--inventory <file>` `--decisions <file>` | the pair being compared |
| `--write` | `migrate` only: apply the re-bind; the default prints it |
| `--queries a,b` `--depth <n>` | `migrate` only: re-take the inventory with these before re-binding |

**`publish`** — send a compiled catalog to a running service.

| Flag | |
|---|---|
| `--service-url <url>` `--file <file>` | where, and what |
| `--admin-token-env <NAME>` | the environment variable holding the admin token. The token is never passed as an argument, where it would reach shell history and process listings |

### Validating the artifacts

The contracts ship as JSON Schema, generated from the same Zod definitions the
package validates with, so they cannot drift:

| File | Describes |
|---|---|
| `schemas/graphql-decisions.schema.json` | the decisions file |
| `schemas/capability-catalog.schema.json` | a compiled catalog, as `POST /api/catalog` takes it |
| `schemas/review-export.schema.json` | a bundle, as `POST /api/review-export` takes it |

`candidate` writes a `$schema` pointer into the decisions file, so an editor
completes and validates it as you type. In CI, or from a language that is not
TypeScript:

```js
import Ajv2020 from "ajv/dist/2020.js";           // draft 2020-12, not the default entry point
import schema from "@renderyes/capability-catalog/schemas/graphql-decisions.schema.json" with { type: "json" };

const validate = new Ajv2020().compile(schema);
if (!validate(decisions)) console.error(validate.errors);
```

These are **strict** objects. An extra key is a validation failure, so validate
hand-written files against the shipped schema. Examples are illustrative only.

There is no inventory schema because nothing parses an inventory from untrusted
input: this package produces it and
this package consumes it. A hand-written schema for it would be the drift the
generated ones exist to avoid.
