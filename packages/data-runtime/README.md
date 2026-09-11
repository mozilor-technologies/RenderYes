# @renderyes/data-runtime

`@renderyes/data-runtime` is the deterministic bridge between a validated
plan data request and a trusted capability runtime.

It owns:

- A model-facing data-request schema derived only from `PlannerManifest`
- Semantic validation of selected query fields and limits
- Exact capability-catalog ID, version, and hash matching
- Capability and runtime lookup
- Host authentication and permission enforcement
- Extraction of only the capability's `requiredSessionKeys`
- Capability preflight and parameter validation
- Host rate-limit hooks
- Timeout and cancellation
- Runtime execution
- Complete data, provenance, freshness, source, and row-limit validation
- Safe normalized failures and metadata-only audit events

It never passes the complete host session, permissions, cookies, credentials,
request parameters, identity values, or result rows to its audit hook. The
runtime receives only validated content parameters, restricted `identity`, and
an `AbortSignal`.

Components do not participate in execution policy. Supported filter, sort,
aggregate, pagination, union, intersection, difference, and other operations
remain capability-catalog declarations.

`createDataPlanningContract(manifest)` gives the LLM a closed schema for
approved capability parameters plus declarative `filter`, `sort`, `project`,
and `limit` selections. `validateDataRequestQuery(manifest, request)` rejects
fields or limits not advertised by that manifest.

After the capability runtime returns and its complete result passes the catalog
output, provenance, and freshness checks, the executor applies the query in a
fixed order: filter; grouping and aggregation; stable multi-field sort;
offset/limit; then projection. Missing sort values remain last in either
direction. Projection can only copy catalog-declared fields from already
validated rows. Provenance and freshness are preserved unchanged. Unsupported,
malformed, or result-incompatible queries return the safe `INVALID_QUERY`
failure.

Text filter operators (`eq`, `not-eq`, `in`, `not-in`, `contains`,
`starts-with`, and `ends-with`) compare Unicode-normalized, trimmed,
case-insensitive values. This normalization is limited to filtering: non-string
values, JSON equality, relationship keys, and sorting retain exact semantics.

Trusted result projection is implemented downstream by
`@renderyes/site-sdk`. The executor remains renderer-independent and never
imports A2UI or React.
