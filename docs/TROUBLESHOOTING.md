# Troubleshooting

Symptoms, their causes, and the fix. Each entry is written from what you
actually see, not from what went wrong underneath.

### ⚠️ The review UI or `curl` gets 401/403 from `/api/*` — but install worked fine

**Installing proved nothing about this credential.** The packages install from
public npm with no token at all; the admin token is yours and separate.

- Is `RENDERYES_ADMIN_TOKEN` set, and does it equal what your `requireAdmin`
  compares against?
- Does your `requireAdmin` read the header the client actually sends? The
  default is **`x-renderyes-admin-token`**; set `RENDERYES_ADMIN_HEADER` if
  yours differs.
- Is your admin secret set at all in the server's environment? The
  timing-safe pattern in [`BUILD_A_HOST.md` §4](BUILD_A_HOST.md#4-backend-mount-the-service)
  refuses every request when the secret is unset. That reads as a 403 with no
  explanation.

### 404 on `/api/*`

Either the handler is not mounted or its path is being rewritten incorrectly.
Use `VIEW_HTTP_ROUTES` from `@renderyes/server` to forward the exact RenderYes
paths without taking over unrelated host APIs. If a framework mounts the
handler behind a prefix, it must strip that prefix before the handler sees the
request; the frontend's `serviceUrl` and the review UI's
`RENDERYES_HOST_URL` must include the same prefix.

"Connection refused" means your host is not running; the review UI is only a
proxy in front of it. A 404 means the host answered but did not expose that route.

### "No recently composed plan …" on refine, save, or pin

The plan is remembered **in process**, in a bounded map (200 most recent
plans), keyed by `planId` and filtered by the owner key from
`resolveViewOwner`. Three causes, in order of likelihood:

1. **More than one instance.** The compose landed on instance A and the refine
   on instance B, which never saw that plan. Run a single instance, or use
   sticky sessions.
2. **`resolveViewOwner` is not configured.** Absence is a refusal, not a pass:
   the error is explicit — "`resolveViewOwner` is required to refine a composed
   plan" — because without an owner key any caller holding a `planId` could act
   on another visitor's view.
3. **It happens after a `reopen`, too**, or after 200 later composes evicted
   the entry, or after a restart. In each case the plan behind the view on
   screen is not the plan the process remembers. Compose again.

### The planner refuses something the data can obviously answer

- **Is the capability approved?** An unapproved field is absent from the
  planner contract entirely, so a prompt needing it gets a refusal. Fix the
  decisions file, not the prompt.
- **Can any component accept that data type and shape?** Run
  `GET /api/coverage?catalogId=<id>`: anything `unrenderable: true` is data the
  planner can fetch and never show, which surfaces as it avoiding a capability
  for no visible reason.
- **Is the capability's `purpose` prose actually descriptive?** The model reads
  it to choose. "graphql.books" tells it nothing.

### A component is never chosen

Four causes, all silent:

1. **No definition twin.** The React component renders fine in your own tests
   and the planner never selects it. Check the ids match **exactly** between
   the browser registration and the published `defineComponent`. The publish
   summary's `componentIds` list settles it in one log line.
2. **The component is not in the published site**, or not in a surface's
   `componentIds`.
3. **`dataTypeId` mismatch.** The slot's `accepts` names a data type no
   published capability produces. See the gotcha in
   [`BUILD_A_HOST.md` §8](BUILD_A_HOST.md#8-generating-a-bespoke-component) for how a generated
   component acquires one.
4. **Its `description` does not say when to prefer it.** The description is the
   planner's only basis for choosing between two components that both accept
   the shape. "Prefer this for any question about the catalogue or what is in
   stock" is doing real work in a registration.

### Charts render blank

- **Frontend:** `recharts` is an optional peer and is not installed. `npm
  install recharts`.
- **Wrong factory on the server:** publish `createBarChartDefinition()`. The
  client factory `createBarChart()` or an import from
  `@renderyes/starter-catalog/charts` in the backend. The server publishes
  contracts and never renders — it must never need recharts.

### Saved views vanish on restart

`createMemoryViewStore()` is process-local. It is fine for a pilot
and wrong for anything a visitor is expected to come back to. For a
single-process Node deployment, use `createFileViewStore()` from
`@renderyes/server/node`. Multi-instance deployments should supply a
`ViewStore` backed by shared storage.

### The catalog is empty after a restart

Both registries are in-memory, because a published capability holds a live
executor closure and those are not serializable. Either:

- publish at boot from code ([`BUILD_A_HOST.md` §5](BUILD_A_HOST.md#5-publish-a-catalog), Route B), which is what makes this a
  non-issue; **or**
- configure `catalogStore` **and** `await viewServer.restorePublishedCatalogs()`
  once before `listen()`.

If restoration is omitted, the "no published catalog" error says so explicitly
when a store is configured and no restore has
run.

### A capability is rejected at execution time

Its destination is not in `allowedUpstreamOrigins`. The list **fails closed** —
absent or empty rejects everything, including your own process. Name your
origins explicitly, e.g. `["http://127.0.0.1:4000"]`. Comparison is by parsed
origin (scheme + host + port), never by string prefix, so
`https://api.internal.example` does **not** allow
`https://api.internal.example.attacker.com`. A GraphQL `endpoint` is re-checked
at execution time, so narrowing the list revokes an already-published catalog.

The same list is checked at publish time for `baseUrl`, a binding's
`serverUrl`, and a binding's `path` — an absolute or protocol-relative `path`
discards the base, so it is rejected.

### "structured schema was rejected; retrying with validated JSON mode"

**Benign.** The built-in OpenAI and Gemini adapters ask for structured output
on every call. If a provider rejects the schema they retry once in validated
JSON mode. The rejection is not cached, so a transient provider response cannot
change later composes. A provider that never accepts the schema therefore costs
one extra HTTP call per attempt. `modelCalls: 2` in `ComposeMetrics` records it.

### Compose latency varies widely

Use `onComposeMetrics` to compare **`planMs` and `dataMs`** — model generation
versus your own upstream fetching. If it is
`planMs`, `planDeadlineMs` (40s default) bounds it; if it is `dataMs`, or the
total, `composeDeadlineMs` (45s default) is the ceiling that covers both. The
server reports its effective deadline and the client adds a transit grace when
arming its timeout. Set `composeTimeoutMs` only to override that behavior.

### After updating, nothing changed

Vite and Next both cache dependencies aggressively.

```bash
rm -rf node_modules/.vite && npm run dev    # Vite
rm -rf .next && npm run dev                 # Next.js
```

If `npm update` reports "already up to date" against a newer published build,
package managers are conservative with prerelease versions across caret ranges.
Pin the exact stamped version instead.

### `uiCatalogRegistered: false` in the capability publish summary

Legitimate ordering if the UI publish comes next in the same boot script; a bug
if it stays that way. `unrenderableDataTypes` in the same summary names any
data type no published component accepts.

The UI publish reports the mirror of both — `capabilityCatalogRegistered: false`
and its own `unrenderableDataTypes` — so whichever half you publish second
tells you whether the two found each other. A permanent `false` on either side
is almost always the ids not matching (see the `catalogId` note in
[`BUILD_A_HOST.md` §5](BUILD_A_HOST.md#5-publish-a-catalog)), not a
missing publish.

### "GraphQL review drift: …"

The message distinguishes three faults:

**"…these decisions were made against a different inventory."** The schema is
byte-identical; the *inventory* was taken with different options. Supplying a
scalar mapping does this, as do `--queries` and `--depth`, because
`reviewSourceHash` covers the inventory's options and not just the schema. Ask
`diff` which case you are in:

```bash
renderyes-catalog diff --inventory shop.inventory.json --decisions shop.decisions.json
```

If nothing you decided is affected it says so, and re-binding is one command —
your review is preserved:

```bash
renderyes-catalog migrate --decisions shop.decisions.json --inventory shop.inventory.json --write
```

`migrate --inventory` refuses whenever an approved capability or field is no
longer offered. Re-stamping there would record a review that never happened,
which is exactly what hand-editing `reviewSourceHash` to the value in the error
does — don't.

**"…the inventory file has been edited since it was written."** Its hash covers
the selections, so the file no longer matches itself. Take the inventory again.
To correct a result shape, set `resultShape` on the capability in your decisions
file — that is the one meant to be edited.

**"…this schema is not the one the inventory was taken from."** Either
`--schema` points at a different file, or the upstream really moved. That is the
expected case, and there is a loop for it — you do not repeat the review:

```bash
renderyes-catalog inventory --schema new-schema.graphql --catalog-id shop --out shop.inventory.json
renderyes-catalog diff      --inventory shop.inventory.json --decisions shop.decisions.json
```

`diff` names exactly what needs a human: approved fields the schema has since
dropped, fields still needing a semantic type, and capabilities that are new
since you last looked. Edit those, then `compile` and `publish`. It exits 1
while anything is undecided, so CI can gate a republish on it. Your decisions
file survives every schema change — that is why it belongs in your repository.

In a same-process boot-time publish every hash is computed seconds apart, so a
drift failure there is almost always a local mistake, such as an
`approvedOutputFields` entry misspelling a path. The error names which
of the three it is.
