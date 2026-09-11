import { z } from "zod";

/**
 * JSON Schema is the portable wire format shared by manual registrations, OpenAPI imports, and
 * the planner manifest. Runtime schemas remain outside this serializable definition.
 */
export const JsonSchemaSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchemaSchema>;

export const ResultShapeSchema = z.enum([
  "entity",
  "collection",
  "search-results",
  "metric",
  "time-series",
  "hierarchy",
  "document",
  "media-collection",
  "comparison",
]);
export type ResultShape = z.infer<typeof ResultShapeSchema>;

export const SemanticTypeSchema = z.enum([
  "unknown",
  "identifier",
  "text",
  "rich-text",
  "image-url",
  "url",
  "money",
  "quantity",
  "percentage",
  "date",
  "date-time",
  "status",
  "boolean",
  "location",
]);
export type SemanticType = z.infer<typeof SemanticTypeSchema>;

export const FieldDescriptorSchema = z
  .object({
    label: z.string().min(1),
    description: z.string().min(1).optional(),
    semanticType: SemanticTypeSchema,
    unit: z.string().min(1).optional(),
    currency: z.string().min(1).optional(),
  })
  .strict();
export type FieldDescriptor = z.infer<typeof FieldDescriptorSchema>;

export const DataTypeDescriptorSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    description: z.string().min(1),
    schema: JsonSchemaSchema,
    fields: z.record(z.string(), FieldDescriptorSchema),
    /**
     * Stable approved field used for deterministic union/intersection/difference matching.
     * It is data identity, not visitor/session identity.
     */
    matchKey: z.string().min(1).optional(),
  })
  .strict();
export type DataTypeDescriptor = z.infer<typeof DataTypeDescriptorSchema>;

export const SourceDescriptorSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1).optional(),
    canonicalUrl: z.string().url().optional(),
  })
  .strict();
export type SourceDescriptor = z.infer<typeof SourceDescriptorSchema>;

export const CapabilitySupportSchema = z
  .object({
    /**
     * Projected row paths the post-fetch query engine may filter on. These
     * run on this server, over only the rows one fetch returned — a filter
     * here can narrow the fetched page and nothing beyond it, and the runtime
     * marks such a result `narrowedAfterFetch`. What the *source* accepts is
     * a different vocabulary; see `sourceNarrowingArguments`.
     */
    filterFields: z.array(z.string().min(1)).optional(),
    /**
     * The subset of `filterFields` the source itself can narrow on, when that
     * is only some of them.
     *
     * Present only where the distinction is actionable: a capability whose
     * filter argument reaches every advertised field states nothing here
     * (`filterFields` is already the answer), and one whose argument reaches
     * none states nothing either, because narrowing the planner's vocabulary to
     * the empty set would remove filtering rather than improve it — that case
     * is a compile warning instead.
     *
     * It exists because the two consumers of `filterFields` want different
     * answers. The runtime wants every field it is permitted to narrow on,
     * including post-fetch, so host-triggered refinement keeps working. The
     * planning contract wants the fields that produce a complete answer: given
     * `categories.title` and `sectionSlug` side by side, a model asked for "the
     * politics coverage" reaches for the one that reads like the visitor's
     * words, and on a dialect that cannot filter a relation by title that is
     * the one that answers over a page instead of a collection.
     */
    sourceFilterFields: z.array(z.string().min(1)).optional(),
    /**
     * Approved input arguments the source applies while producing the result
     * — narrowing at the origin, over the whole dataset, before any fetch.
     * Names params (not row paths), so it never overlaps `filterFields`
     * except by coincidence. Derived from the approval where the binding can
     * say (paging arguments excluded: `first`/`after` read a page, they do
     * not narrow which records qualify); absent when nothing narrows at the
     * source, which must never be papered over by advertising `filterFields`
     * as if they did.
     */
    sourceNarrowingArguments: z.array(z.string().min(1)).optional(),
    /**
     * Approved arguments the planner is required to set and cannot obtain: a
     * non-null `ID`/`Int`/`Float` with no default, which no approved path
     * returns a value for.
     *
     * The capability compiles, publishes and probes correctly and can still
     * never be selected from a prompt — nobody types an opaque base64 id. It is
     * recorded rather than merely warned about so a coverage report can stop
     * counting it as answerable; reaching it needs a component that carries the
     * value through from a row the visitor is already looking at.
     */
    unknowableArguments: z.array(z.string().min(1)).optional(),
    /**
     * Projected paths a plan's `project` may narrow *around* but never drop.
     *
     * The host's answer to "my component cannot render without this". The
     * GraphQL binding already forces these into the fetch; without them here
     * the fetch succeeds and the plan's own projection discards them one layer
     * later, which is how a component wrapping `next/image` lost the intrinsic
     * dimensions it throws without — approved, fetched, and gone before it
     * rendered.
     */
    requiredFields: z.array(z.string().min(1)).optional(),
    sortFields: z.array(z.string().min(1)).optional(),
    groupFields: z.array(z.string().min(1)).optional(),
    aggregates: z
      .array(z.enum(["count", "sum", "average", "minimum", "maximum"]))
      .optional(),
    pagination: z.boolean().optional(),
    /** Set operations this capability's result may participate in with compatible data types. */
    setOperations: z.array(z.enum(["union", "intersection", "difference"])).optional(),
  })
  .strict();
export type CapabilitySupport = z.infer<typeof CapabilitySupportSchema>;

export const CapabilityPolicySchema = z
  .object({
    authentication: z.enum(["public", "session"]),
    /** Server-enforced permissions; deliberately removed from the planner-safe manifest. */
    requiredPermissions: z.array(z.string().min(1)).optional(),
    maximumRows: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    cacheTtlSeconds: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CapabilityPolicy = z.infer<typeof CapabilityPolicySchema>;

export const CapabilityDescriptorSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    purpose: z.string().min(1),
    kind: z.literal("query"),
    inputSchema: JsonSchemaSchema,
    outputSchema: JsonSchemaSchema,
    output: z
      .object({
        dataTypeId: z.string().min(1),
        shape: ResultShapeSchema,
      })
      .strict(),
    /**
     * These keys are resolved exclusively from trusted session context. They are kept in the
     * server-side catalog and deliberately removed from the planner manifest.
     */
    requiredSessionKeys: z.array(z.string().min(1)),
    sourceIds: z.array(z.string().min(1)).min(1),
    supports: CapabilitySupportSchema.optional(),
    policy: CapabilityPolicySchema,
  })
  .strict();
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;

export const RelationshipDescriptorSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    from: z
      .object({
        dataTypeId: z.string().min(1),
        field: z.string().min(1),
      })
      .strict(),
    to: z
      .object({
        dataTypeId: z.string().min(1),
        field: z.string().min(1),
      })
      .strict(),
    cardinality: z.enum(["one-to-one", "one-to-many", "many-to-one", "many-to-many"]),
    resolverCapabilityId: z.string().min(1).optional(),
  })
  .strict();
export type RelationshipDescriptor = z.infer<typeof RelationshipDescriptorSchema>;

/**
 * What a catalog id may be, matching what the UI catalog has always enforced.
 *
 * The two halves of a published pair are joined by this id, and only one half
 * used to check it: `daily news 2808` was accepted here, accepted by
 * `POST /api/catalog`, rewritten to `daily_news_2808` by the file store's
 * traversal guard, and then rejected by `POST /api/ui-catalog` — three parts of
 * one package disagreeing about a value the interview calls a durable storage
 * key. An id that cannot carry the UI half is not usable for the capability
 * half either, so it is refused where it is first seen.
 */
export const CATALOG_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

export const CapabilityCatalogSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    id: z
      .string()
      .min(1)
      .regex(
        CATALOG_ID_PATTERN,
        `Catalog id must match ${CATALOG_ID_PATTERN.source} — it is the key the UI catalog is filed under, and that half refuses anything else.`,
      ),
    version: z.string().min(1),
    description: z.string().min(1),
    dataTypes: z.array(DataTypeDescriptorSchema),
    sources: z.array(SourceDescriptorSchema),
    capabilities: z.array(CapabilityDescriptorSchema),
    relationships: z.array(RelationshipDescriptorSchema),
  })
  .strict();
export type CapabilityCatalog = z.infer<typeof CapabilityCatalogSchema>;

export const SourceReferenceSchema = z
  .object({
    sourceId: z.string().min(1),
    recordUrl: z.string().url().optional(),
  })
  .strict();

export const FreshnessSchema = z
  .object({
    asOf: z.string().datetime(),
    staleAt: z.string().datetime().optional(),
  })
  .strict();

export const ProvenanceSchema = z
  .object({
    sources: z.array(SourceReferenceSchema).min(1),
    freshness: FreshnessSchema,
    /**
     * True when this result was cut short *relative to what the plan asked
     * for* — the row budget sliced it, or an upstream page cap returned fewer
     * rows than the plan's limit (or than "everything", when it named none).
     *
     * Carried in provenance rather than alongside the data because it changes
     * what the data *means*: a truncated collection presented as a whole one is
     * a wrong answer, not a smaller one. A component can render "showing the
     * first N" only if it is told.
     *
     * Not set merely because more rows exist upstream. A plan that asked for 10
     * and received 10 got its answer in full; that used to set this flag, which
     * made it fire on nearly every bounded question and turned the one case
     * that matters into noise. "More exist" is `moreAvailable`.
     */
    truncated: z.boolean().optional(),
    /**
     * The dataset extends beyond the rows returned. Routine for any bounded
     * question over a large collection, and deliberately separate from
     * `truncated`: one describes the dataset, the other the answer.
     */
    moreAvailable: z.boolean().optional(),
    /** Rows the upstream reports in total, present only when truncated. */
    totalRowsBeforeTruncation: z.number().int().nonnegative().optional(),
    /**
     * A plan-level narrowing or ordering operation (filter, sort, aggregation,
     * or an offset/limit window the fetch could not fill) ran over a fetch that
     * was provably not the whole collection (`moreAvailable` or `truncated`).
     *
     * Its own flag because neither existing one covers it: the fetch may have
     * satisfied its ask exactly (`truncated` absent), and `moreAvailable` alone
     * means "answer complete, dataset goes on" — but a filter applied to one
     * page of a larger dataset can miss every matching row, so the narrowed
     * result must not be presented as the whole answer.
     */
    narrowedAfterFetch: z.boolean().optional(),
    /**
     * How many fetched rows the post-fetch narrowing ran over. Present only
     * alongside `narrowedAfterFetch`, so "4 rows shown" can be qualified as
     * "matched within the 100 fetched" rather than within the dataset.
     */
    rowsBeforeNarrowing: z.number().int().nonnegative().optional(),
    /**
     * Which fields the *source* narrowed on, when the plan's filter compiled
     * into the upstream's own filter argument.
     *
     * Post-fetch narrowing announces itself: `narrowedAfterFetch` says matches
     * may exist beyond the page that was searched. Source-side narrowing has no
     * such tell, and needs one for a different reason — not "was this the whole
     * archive" but "which column did it look in". A catalog approving nine
     * filterable fields answers the same question three ways: on a live
     * newspaper "what has the paper published about the rural water
     * directorate" matched 8 rows on `title`, 5 on `storySlug`, and 0 on
     * `tagSlugs` — the last a genuine database zero for a subject the paper had
     * covered eight times, and indistinguishable from no coverage at all.
     *
     * Field and operator only, never the value: the value is the visitor's own
     * words, and provenance is carried into logs and rendered surfaces.
     */
    narrowedAtSource: z
      .array(
        z
          .object({ field: z.string().min(1), operator: z.string().min(1) })
          .strict(),
      )
      .optional(),
    /**
     * Approved fields the upstream reported an error for, row-relative, while
     * still answering everything else. Present only when there was one.
     *
     * Carried here for the same reason `truncated` is: it changes what the data
     * means. A row whose `revenue` is null because the resolver errored is not
     * a row with no revenue, and a component that cannot tell those apart will
     * render "0" or "—" as though it were the answer.
     *
     * Never carries the upstream's error text. These are field paths the host
     * approved and already knows; the upstream's message is written for an
     * operator, and this value reaches a rendered component.
     */
    degradedFields: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * A capability execution failure.
 *
 * `message` is **host-facing**, not visitor-facing. It is written by whatever
 * `runtime.execute` produced the failure — including a host's own runtime, which
 * `INTEGRATION.md` expects hosts to supply — so it may carry upstream detail,
 * an endpoint, or a stack fragment. Nothing redacts it here.
 *
 * The rendering path deliberately does not show it: `site-sdk` writes
 * `DEFAULT_VISITOR_ERROR_MESSAGE` to the component's error path unless the host
 * supplies `formatVisitorError`. Read this field for logs and observability, and
 * do not assume it is safe to display.
 */
export const CapabilityExecutionErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

export const CapabilitySuccessResultSchema = z
  .object({
    ok: z.literal(true),
    data: z.unknown(),
    provenance: ProvenanceSchema,
  })
  .strict();

export const CapabilityFailureResultSchema = z
  .object({
    ok: z.literal(false),
    error: CapabilityExecutionErrorSchema,
  })
  .strict();

export type SourceReference = z.infer<typeof SourceReferenceSchema>;
export type Freshness = z.infer<typeof FreshnessSchema>;
export type DataProvenance = z.infer<typeof ProvenanceSchema>;
export type CapabilityExecutionError = z.infer<typeof CapabilityExecutionErrorSchema>;
export type CapabilityFailureResult = z.infer<typeof CapabilityFailureResultSchema>;

export interface CapabilitySuccessResult<Data> {
  ok: true;
  data: Data;
  provenance: DataProvenance;
}

export type CapabilityExecutionResult<Data> =
  CapabilitySuccessResult<Data> | CapabilityFailureResult;

/** @deprecated Use CapabilityExecutionResult. Kept as a migration alias for early consumers. */
export type CapabilityResult<Data> = CapabilityExecutionResult<Data>;
