# GraphQL onboarding

Import from `@renderyes/capability-catalog/graphql`.

```text
SDL or introspection JSON
  -> listGraphQlQueries
  -> createGraphQlCatalogInventory
  -> host approval
  -> compileApprovedGraphQlCatalog
  -> CapabilityCatalog + PlannerManifest + server-only bindings
```

The approval is the authority for query eligibility, visitor arguments, trusted-identity argument
mappings, output fields, semantic types, custom scalars, authentication, required permissions,
maximum rows, timeout, cache TTL, query depth, selected-field count, source, provenance and
freshness age. Discovery approves nothing.

Two narrowings exist, and only one reaches the data source. Approved visitor arguments (a
`filter`, a `search`, a sort input) are applied by the upstream over the whole dataset; the
compile records them as `supports.sourceNarrowingArguments` so the planner prefers them.
`supports.filterFields` are the projected row paths the query engine accepts. Where the schema
publishes a filter argument that can carry one of them, the plan's condition is compiled into it
and the source narrows the whole dataset; where it cannot, the same condition runs on this server
over only the rows one fetch returned, and the result is reported `narrowedAfterFetch`. Nothing in
the plan chooses between those — the compile decides per field, from what the schema declares.

A path through a relation (`categories.title`) compiles wherever the dialect nests. Hasura nests the
related type's own `bool_exp`, and Prisma's list-relation filter gets the `some`/`none` quantifier
it requires; both are executed against dialect-enforcing fixtures. Strapi's `filters` follows the
same nesting rule but is not covered by the fixture set. Payload's relationship
operator takes ids only, so there the path does not compile at all. On a
to-many relation only `eq`/`in`/`not-eq`/`not-in` are compiled, because those are the four the
post-fetch engine also reads existentially. Pushing a range or substring through a relation would
change which rows qualify, so those filters remain post-fetch.

When a capability's filter argument reaches some advertised fields and not others, the compile
publishes the reachable subset as `supports.sourceFilterFields` and warns. The planner is offered
that subset only — given `categories.title` and a stored `sectionSlug` side by side it cannot tell
from the names which one answers over the collection — while `filterFields` stays the runtime's
permission list, so a refinement the host triggers itself still reaches the rest. Approving no
filter argument at all leaves every visitor constraint as a page-bounded fallback. The compiler
warns about that incomplete scope.

Ordering is the one narrowing whose grammar introspection may not carry. An argument typed
`orderBy: PostOrder` or `order_by: [posts_order_by!]` publishes its legal values, so it compiles
into the contract like any other and the planner is offered them directly. An argument typed
`sort: String` publishes nothing: the spelling that means descending, and whether terms may be
combined, live in the upstream's parser. A planner handed a bare string guesses, and an upstream
that cannot parse an ordering expression may drop it without failing, so a top-N answer
comes back as arbitrary rows in a convincing order.

The approval's per-query `orderingArgument` supplies what the schema cannot: `{name, ascending,
descending, separator?}`, where the templates substitute `{field}`. The planner keeps expressing
ordering as typed `query.sort` terms and the runtime renders the upstream's value from them, so the
argument is withheld from the planner and must not appear in `approvedVisitorArguments`. Whether
the value is a joined string or a list of terms is read off the argument's own type, not declared.
No grammar is built in — two widely-used CMSes spell this differently, and deriving one from an
argument's *name* would be the same name-guessing the OpenAPI path refuses. Undeclared, ordering
stays a post-fetch operation over the fetched page and the compile warns once per capability that
advertises `supports.sortFields` with no way to send them.

An enum value the API only accepts under a runtime precondition (a sort key valid only while a
search argument is present, for example) can be withheld from the planner with the approval's
per-query `excludeEnumValues`, keyed by dotted input path (`"sortBy.field": ["RANK"]`). Excluded
values are stripped from the compiled input schema, so a plan naming one fails validation instead
of execution.

## Declarations a schema cannot publish

Four things a host states because introspection cannot determine them. An
incorrect inferred value could silently change results.

They do not all live in the same file, and putting one in the wrong place is a
declaration that does nothing:

| Declaration | Belongs on |
|---|---|
| `listEnvelope` | the **inventory's** query selection |
| `pagingArguments` | the **decisions** entry for that capability |
| `orderingArgument` | the **decisions** entry |
| `approvedInputFields` | the **decisions** entry |

**`listEnvelope`** — where the rows are, when the field does not return a plain
list or a Relay connection. A `{ items, total }` wrapper is a shape, not a
convention: nothing in the schema says which field holds rows and which holds
the count. Declare `rowsField`, and `totalCountField` when there is one, plus
`pageSizeArgument`/`pageArguments` if paging is nested inside an input object.

```jsonc
"listEnvelope": {
  "rowsField": "items",
  "totalCountField": "total",
  "pageSizeArgument": "limit",
  "pageArguments": ["page"]
}
```

**`pagingArguments`** — which arguments choose *how much* rather than *which
records*. Relay's `first`/`after` are recognised structurally; `limit`/`page`,
Prisma's `take`/`skip`, and a nested `pagination: { page, pageSize }` are one
host's naming and are not. Declaring them keeps them out of the narrowing facts
the planner is given — a paging argument advertised as narrowing is a claim that
the source filtered when it only truncated.

```jsonc
"pagingArguments": { "pageSize": "limit", "pageArguments": ["page"] }
```

**`orderingArgument`** — covered above: the grammar of a `sort: String` lives in
the upstream's parser, not its schema.

**`approvedInputFields`** — which fields of a recursive input type a visitor may
reach. A `where` input that contains itself is unbounded, and approving it whole
both publishes an enormous contract and grants more than most hosts intend.
Naming the fields narrows both at once.

```jsonc
"approvedInputFields": ["where.title", "where.sectionSlug", "where.stockCount"]
```

Dotted paths are rooted at an approved argument's name. A path rooted at an
argument that is not approved is refused.

Two arguments that could both carry the filter — Saleor's connections declare
`filter` and `where` side by side — are a tie the schema cannot break. Sending a
filter to the wrong one may be silently ignored. The compile
does not refuse the capability over it. While the tie stands, nothing is pushed
and planned filters run post-fetch over one page, flagged incomplete, with a
warning naming both arguments. Approving the one that filters in
`approvedVisitorArguments` breaks the tie — the planner writes it directly —
and `approvedInputFields` rooted at it keeps the contract small.

The compile refuses a declaration that names something absent from the schema.
This prevents the host from relying on a control that does nothing.

The planner can propose a structured `GraphQlDataRequest` containing `capabilityId`, `params`, and
an optional approved leaf-field `selection`. `compileGraphQlOperation` checks schema drift and
allowlists, injects trusted identity variables, and generates a validated operation.

`executeApprovedGraphQlRequest` delegates network access to a host `GraphQlTransport`. The host
owns endpoint URLs, credentials, headers, authorization, network policy, timeouts and auditing.
The host must also provide `resolveProvenance`; GraphQL does not establish source provenance or
source freshness on its own.

The compatibility `createGraphQlCapabilityRuntime` requests the complete approved field envelope.
A host whose plan contract supports per-request field selection can call
`executeApprovedGraphQlRequest` directly instead.

A worked example ships at `examples/graphql-integration.ts`.
