import {
  buildClientSchema,
  buildSchema,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  lexicographicSortSchema,
  parse,
  printSchema,
  validate,
  validateSchema,
  type GraphQLArgument,
  type GraphQLEnumType,
  type GraphQLField,
  type GraphQLInputType,
  type GraphQLInputObjectType,
  type GraphQLInterfaceType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type GraphQLUnionType,
} from "graphql";
import { z } from "zod";
import {
  assertCapabilityCatalog,
  createPlannerManifest,
  defaultSupportsForApprovedFields,
  isListResultShape,
  listCrossingSegments,
  sourceNarrowingArgumentNames,
  withSourceNarrowingArguments,
  type PlannerManifest,
} from "./compile.js";
import { canonicalize, fnv1a, hashContent } from "./hash.js";
import type { CapabilityExecutionContext, CapabilityRuntime } from "./manual.js";
import {
  COMBINATOR_CANDIDATES,
  NULL_TEST_CANDIDATES,
  OPERATOR_CANDIDATES,
  filterConditionSummary,
  renderFilterValue,
  type FilterFieldPushdown,
  type FilterPathSegment,
  type FilterPushdown,
} from "./filter-pushdown.js";
import {
  ORDERING_FIELD_TOKEN,
  canPushOrdering,
  renderOrderingValue,
  type OrderingPushdown,
} from "./ordering.js";
import {
  type CapabilityCatalog,
  type CapabilityExecutionResult,
  type CapabilityPolicy,
  type CapabilitySupport,
  type DataProvenance,
  type DataTypeDescriptor,
  type FieldDescriptor,
  type JsonSchema,
  ProvenanceSchema,
  type RelationshipDescriptor,
  ResultShapeSchema,
  type ResultShape,
  type SourceDescriptor,
} from "./schema.js";
import {
  inferSemanticType as inferSharedSemanticType,
  type SemanticValueKind,
} from "./semantic-type.js";
import {
  validateCapabilityPreflight,
  validateCapabilityResult,
} from "./validate-data.js";

type UnknownRecord = Record<string, unknown>;

export type GraphQlSchemaInput = string | UnknownRecord;

export interface GraphQlDiscoveryIssue {
  severity: "warning" | "error";
  path: string;
  message: string;
}

export interface GraphQlArgumentCandidate {
  name: string;
  description?: string;
  type: string;
  required: boolean;
  hasDefaultValue: boolean;
}

/**
 * Why one field of the schema is not on offer for decisions.
 *
 * Discovery drops fields for four honest reasons, and reported them as prose
 * warnings addressed to the *place* the drop happened rather than to the fields
 * lost: "Output discovery stopped at the configured depth 4" at path
 * `total.gross` does not tell a host that `amount` and `currency` exist and are
 * unreachable. A field that is absent for a reason and a field that is absent
 * because nobody looked read identically, which is how a host approves a
 * currency with no amount and finds out from a rendered view.
 *
 * The ledger is the other half of the field list, and `discoveryLedgerIsTotal`
 * in the test suite holds them to summing: every field the schema declares
 * within the depth budget is either discovered or has an entry here.
 */
export interface GraphQlFieldExclusion {
  /** Row-relative path of the excluded field, addressed as a host would. */
  path: string;
  reason:
    | "union"
    | "depth"
    | "recursion"
    | "required-argument"
    /** Declared by an implementation of an interface, not by the interface. */
    | "interface-implementation";
  /** The field's type as the schema writes it, e.g. `TaxedMoney` or `[Order!]!`. */
  type: string;
  /** The same fact as a sentence, for a reviewer reading it in the UI. */
  detail: string;
}

export interface GraphQlOutputFieldCandidate {
  path: string;
  label: string;
  description?: string;
  type: string;
  depth: number;
  semanticType: FieldDescriptor["semanticType"];
  deprecated: boolean;
  deprecationReason?: string;
}

export interface GraphQlQueryCandidate {
  coordinate: string;
  fieldName: string;
  description?: string;
  returnType: string;
  /**
   * Discovery's proposal, not a verdict. Only the four shapes in
   * `DISCOVERABLE_RESULT_SHAPES` are ever produced here — the other five
   * (`hierarchy`, `media-collection`, `document`, `comparison`,
   * `search-results`) are real, accepted at compile, and impossible to read off
   * a schema. Overriding this in the inventory is expected.
   */
  suggestedResultShape: ResultShape;
  /**
   * Present when the root field returns a Relay connection. Every path in
   * `outputFields` is then relative to the node, and the `edges { node }`
   * wrapper is re-applied when the query is built.
   */
  connection?: GraphQlConnectionInfo;
  /**
   * Echo of the host's declaration, when one was threaded into discovery.
   * Every path in `outputFields` is then relative to the row, and the wrapper
   * is re-applied when the query is built — same contract as `connection`.
   */
  listEnvelope?: GraphQlListEnvelopeInfo;
  arguments: GraphQlArgumentCandidate[];
  outputFields: GraphQlOutputFieldCandidate[];
  /**
   * Every field the schema declares that this query cannot offer, and why.
   * See `GraphQlFieldExclusion`. `issues` is derived from this.
   */
  exclusions: GraphQlFieldExclusion[];
  support: {
    status: "supported" | "unsupported";
    reason?: string;
  };
  issues: GraphQlDiscoveryIssue[];
}

export interface GraphQlScalarMapping {
  schema: JsonSchema;
  semanticType?: FieldDescriptor["semanticType"];
}

export interface GraphQlQueryReviewSelection {
  fieldName: string;
  capabilityId: string;
  purpose?: string;
  version?: string;
  dataTypeId: string;
  dataTypeVersion?: string;
  dataTypeDescription?: string;
  resultShape: ResultShape;
  matchKey?: string;
  fields?: Record<string, FieldDescriptor>;
  supports?: CapabilitySupport;
  scalarMappings?: Record<string, GraphQlScalarMapping>;
  /**
   * Declares that this root field returns an object wrapping a list of rows
   * (a `{docs: [...], totalDocs}`-style envelope). Approved field paths are
   * then row-relative, and execution unwraps to an array — the non-Relay
   * counterpart of connection handling. Host-declared, never detected; see
   * `GraphQlListEnvelopeInfo`.
   */
  listEnvelope?: GraphQlListEnvelopeInfo;
}

export interface GraphQlCatalogReviewOptions {
  schema: GraphQlSchemaInput;
  catalog: {
    id: string;
    version: string;
    description: string;
  };
  source: SourceDescriptor;
  queries: readonly GraphQlQueryReviewSelection[];
  relationships?: readonly RelationshipDescriptor[];
  discoveryMaxDepth?: number;
}

/**
 * One host-level policy for a GraphQL API deliberately curated for Intent
 * View. Unlike detailed review, query fields and ordinary content arguments
 * are approved by exposing them from that dedicated API in the first place.
 */
export interface CuratedGraphQlCatalogPolicy {
  authentication: "public" | "session";
  requiredPermissions?: readonly string[];
  maximumRows: number;
  /**
   * The largest `first` this API accepts on a connection, if it caps them.
   *
   * Distinct from `maximumRows`, which is how many rows RenderYes is willing
   * to hold. A Relay API commonly caps a page well below that — Saleor and
   * GitHub at 100, Shopify at 250 — and rejects the whole request when asked
   * for more, so the two cannot be the same number.
   *
   * Be clear about what a `maximumRows` above this cap buys today: nothing.
   * Execution fetches one page and does not walk cursors, so the page cap is
   * the effective row ceiling, and a result the cap cut short is reported as
   * `truncated` rather than silently completed. The two numbers are kept
   * separate so that multi-page fetching, when it exists, needs no decisions-format
   * change — not because more than one page is fetched now.
   *
   * Defaults to `DEFAULT_CONNECTION_PAGE_CAP`, which is low enough for the
   * common caps. Raise it when the API allows more.
   */
  maximumPageSize?: number;
  timeoutMs: number;
  cacheTtlSeconds?: number;
  freshnessMaximumAgeSeconds?: number;
  maximumSelectionDepth?: number;
  maximumSelectedFields?: number;
}

export interface CuratedGraphQlCatalogOptions {
  schema: GraphQlSchemaInput;
  catalog: GraphQlCatalogReviewOptions["catalog"];
  source: SourceDescriptor;
  policy: CuratedGraphQlCatalogPolicy;
  scalarMappings?: Readonly<Record<string, GraphQlScalarMapping>>;
  discoveryMaxDepth?: number;
  /**
   * Host decisions for fields whose semantic type could not be inferred,
   * keyed by full coordinate path (e.g. `"Query.recipes.match.score"`, the
   * same key `needsSemanticType` reports). Without a decision such a field
   * is omitted from the catalog — never guessed. `"unknown"` is not a
   * decision; a key that matches no discovered field is an error, so a typo
   * cannot silently approve nothing.
   */
  semanticTypeOverrides?: Readonly<Record<string, FieldDescriptor["semanticType"]>>;
}

/** One field the curated compiler needs a human decision for. */
export interface CuratedSemanticTypeGap {
  /** Override key: `coordinate + "." + path`. */
  key: string;
  coordinate: string;
  fieldName: string;
  path: string;
  label: string;
  /** GraphQL type, e.g. "Int!" — the reason the meaning is ambiguous. */
  type: string;
  description?: string;
}

/**
 * Every approved field whose semantic type is still undecided, raised once
 * instead of one per recompile.
 *
 * Carries the gaps as data so a review UI can render the same list the curated
 * flow already renders, rather than parsing a sentence. `semanticTypeOverrides`
 * on the decisions file resolves them, keyed by `gap.key`.
 */
export class GraphQlSemanticTypeError extends Error {
  readonly gaps: readonly CuratedSemanticTypeGap[];

  constructor(gaps: readonly CuratedSemanticTypeGap[]) {
    super(
      `${gaps.length} approved GraphQL field(s) need a host-approved semantic type. ` +
        `Add "semanticTypeOverrides" at the top level of the decisions file, ` +
        `beside "queries" — not on a query entry, where it is refused as an ` +
        `unrecognized key. Keyed exactly as: ${gaps
          .map((gap) => `"${gap.key}" (${gap.type})`)
          .join(", ")}.`,
    );
    this.name = "GraphQlSemanticTypeError";
    this.gaps = gaps;
  }
}

/**
 * A custom scalar with no host-approved JSON Schema mapping, located.
 *
 * Structured like `GraphQlSemanticTypeError` and for the same reason: the bare
 * sentence ("Custom scalar 'Decimal' requires…") named the scalar and nothing
 * else, so a host resolved a 62-scalar schema one compile-read-add loop at a
 * time, guessing which query and which input object each name came from. The
 * fields carry where it was found and the message carries the fix.
 */
export class GraphQlScalarMappingError extends Error {
  readonly scalarName: string;
  /** Dotted path to the value, rooted at the argument or output field name. */
  readonly path?: string;
  readonly capabilityId?: string;
  /** Schema coordinate of the query, e.g. `Query.orders`. */
  readonly coordinate?: string;

  constructor(details: {
    scalarName: string;
    path?: string;
    capabilityId?: string;
    coordinate?: string;
  }) {
    const where = [
      details.path !== undefined ? `at "${details.path}"` : undefined,
      details.capabilityId !== undefined
        ? `in capability "${details.capabilityId}"${
            details.coordinate ? ` (${details.coordinate})` : ""
          }`
        : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    super(
      `Custom scalar "${details.scalarName}" requires a host-approved JSON Schema mapping` +
        `${where ? `, found ${where}` : ""}. ` +
        `Add scalarMappings["${details.scalarName}"] = { "schema": … } to the query ` +
        `selection (CLI: the --scalars file) and recompile.`,
    );
    this.name = "GraphQlScalarMappingError";
    this.scalarName = details.scalarName;
    if (details.path !== undefined) this.path = details.path;
    if (details.capabilityId !== undefined) this.capabilityId = details.capabilityId;
    if (details.coordinate !== undefined) this.coordinate = details.coordinate;
  }
}

/** Re-raises a scalar-mapping error with the location the catch site knows. */
function locateScalarMappingError(
  error: unknown,
  details: { path?: string; capabilityId?: string; coordinate?: string },
): unknown {
  if (!(error instanceof GraphQlScalarMappingError)) return error;
  const path = error.path ?? details.path;
  const capabilityId = error.capabilityId ?? details.capabilityId;
  const coordinate = error.coordinate ?? details.coordinate;
  return new GraphQlScalarMappingError({
    scalarName: error.scalarName,
    ...(path !== undefined ? { path } : {}),
    ...(capabilityId !== undefined ? { capabilityId } : {}),
    ...(coordinate !== undefined ? { coordinate } : {}),
  });
}

export interface CuratedGraphQlCatalogResult extends CompiledGraphQlCatalog {
  /**
   * Fields exposed by the curated API but omitted because their semantic
   * type is unclear. Resolve each via `semanticTypeOverrides` and recompile;
   * an empty array means every exposed field made it into the catalog.
   */
  needsSemanticType: CuratedSemanticTypeGap[];
}

export interface GraphQlQueryInventory {
  capabilityId: string;
  purpose: string;
  coordinate: string;
  fieldName: string;
  returnType: string;
  availableVisitorArguments: GraphQlArgumentCandidate[];
  availableOutputFields: GraphQlOutputFieldCandidate[];
  /**
   * The fields this query cannot offer, and why. See `GraphQlFieldExclusion`.
   *
   * On the inventory rather than only on the discovery candidate because the inventory
   * is what a host stores, diffs, and reviews months later — and "what did I
   * not get a chance to approve" is a question about that artifact.
   */
  exclusions: GraphQlFieldExclusion[];
  issues: GraphQlDiscoveryIssue[];
}

export interface GraphQlCatalogInventory {
  schemaVersion: "1.0";
  schemaHash: string;
  reviewSourceHash: string;
  discoveryMaxDepth?: number;
  catalog: GraphQlCatalogReviewOptions["catalog"];
  source: SourceDescriptor;
  relationships: readonly RelationshipDescriptor[];
  querySelections: readonly GraphQlQueryReviewSelection[];
  queries: GraphQlQueryInventory[];
  issues: GraphQlDiscoveryIssue[];
}

/**
 * The hard ceilings a single capability's decisions may declare, exported so a
 * tool building a decisions file can stay inside them rather than mirror them.
 *
 * `renderyes-catalog candidate` set `maximumSelectedFields` to whatever
 * discovery found, and on one commerce schema 26 of 86 queries exceed 500
 * fields (one of them 1904) — so the documented headless route produced a file
 * this very schema then rejected, as a raw validation dump that read as the
 * operator's mistake.
 */
export const GRAPHQL_APPROVAL_LIMITS = Object.freeze({
  maximumSelectedFields: 500,
  maximumSelectionDepth: 12,
});

const GraphQlCapabilityPolicyApprovalSchema = z.strictObject({
  authentication: z.enum(["public", "session"]),
  requiredPermissions: z.array(z.string().min(1)).optional(),
  maximumRows: z.number().int().positive(),
  /** See `CuratedGraphQlCatalogPolicy.maximumPageSize`. */
  maximumPageSize: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive(),
  cacheTtlSeconds: z.number().int().nonnegative().optional(),
});

const GraphQlQueryDecisionsSchema = z.strictObject({
  capabilityId: z.string().min(1),
  approvedVisitorArguments: z.array(z.string().min(1)),
  identityArguments: z.record(z.string().min(1), z.string().min(1)),
  /**
   * Enum values to withhold from the planner, keyed by dotted input path
   * rooted at an approved argument name (e.g. `"sortBy.field"`). The values
   * are stripped from the compiled input schema, so a plan naming one fails
   * validation instead of execution.
   *
   * The remedy for enum values with runtime preconditions the schema cannot
   * express — a sort key an API only accepts when a search argument is
   * present is schema-valid and execution-fatal without this. A key matching
   * no enum, a value the enum does not declare, or an exclusion that empties
   * the enum all refuse the compile.
   */
  excludeEnumValues: z
    .record(z.string().min(1), z.array(z.string().min(1)).min(1))
    .optional(),
  /**
   * Input fields a plan may set, as dotted paths rooted at an approved
   * argument name (e.g. `"where.sectionSlug"`). An argument named by no path
   * keeps its whole input tree; one named by any path keeps only what the
   * paths reach.
   *
   * An allowlist rather than exclusions, unlike `excludeEnumValues` above,
   * because the tree this prunes is recursive: a denylist over a type that
   * contains itself cannot be written completely, and "what a visitor may
   * set" wants the deny-by-default posture `approvedVisitorArguments` already
   * takes one level up.
   *
   * The measured cost of not having it: a Payload `where` argument compiled to
   * 324,698 of a capability's 324,930 input bytes — 28 filterable columns
   * carried to project 12, every one of them duplicated down both recursive
   * branches. Approving five fields of that argument is the difference between
   * a contract a host can send and one they cannot.
   *
   * Self-referential fields — `AND`, `OR`, `NOT`, and whatever else an API
   * names its combinators — are transparent to these paths: they nest the same
   * type, so `"where.sectionSlug"` reaches the column wherever it appears, and
   * the existing input recursion depth is what bounds the nesting. Declaring
   * `"where.AND"` is neither needed nor accepted; drop the argument from
   * `approvedVisitorArguments` to refuse combining outright.
   *
   * A path matching no input field refuses the compile, and so does one that
   * prunes away a required field — an object whose required field is gone
   * accepts nothing the upstream will take.
   */
  approvedInputFields: z.array(z.string().min(1)).min(1).optional(),
  /**
   * How this query's ordering argument spells a sort — the one piece of a
   * host's request vocabulary GraphQL introspection cannot carry.
   *
   * A filter argument declares its own grammar as types: field names, operator
   * names, and value types are all in the schema, so the plan contract can
   * offer the planner a closed menu and it has nothing left to invent. An
   * ordering argument typed `sort: String` declares none of it. The grammar —
   * which spelling means descending, whether several fields may be combined —
   * lives in the upstream's parser and its documentation, and a planner handed
   * a bare string has to guess. The guesses are plausible and wrong, and an
   * upstream that ignores a sort it cannot parse answers "the newest ten" with
   * ten arbitrary rows in a convincing order.
   *
   * Declaring the grammar here moves the writing from the planner to us. The
   * planner keeps expressing ordering the way it always has, as typed
   * `query.sort` entries, and the runtime renders the upstream's string from
   * these templates. `{field}` is substituted with the approved field name;
   * `separator` joins the terms of a multi-field ordering, and is not needed
   * when the argument takes a list, since each term is then its own element.
   *
   * Common grammars, for copying: `{ ascending: "{field}", descending:
   * "-{field}", separator: "," }` covers the JSON:API convention that most
   * REST-derived CMS schemas inherited; `{ ascending: "{field}:asc",
   * descending: "{field}:desc" }` covers the other popular spelling. No
   * spelling is built in, because two widely-used CMSes disagree about it and
   * a default would be silently wrong for one of them.
   *
   * Declaring an argument here means the planner may no longer set it, so it
   * must not also appear in `approvedVisitorArguments`. A schema that types
   * ordering properly — an enum, or an input object — needs nothing here:
   * approve it as a visitor argument and the planner gets the real values.
   */
  /**
   * Which approved argument sets the page size, when it is not a Relay `first`
   * and not the `pageSizeArgument` of a declared list envelope.
   *
   * Two shapes of API had no way to say this. A plain list paged by `take`/
   * `skip` (Prisma, Keystone) carries no envelope to hang the declaration on,
   * and an API that nests its paging — Strapi's `pagination: { page, pageSize }`
   * — could not be named at all, because the envelope's own field takes a
   * top-level argument name. On both, nothing set the page size and nothing
   * excluded the argument from the "narrows at the source" facts: the upstream
   * returned whatever page it liked, `maximumRows` became a truncation after
   * the fetch, and the planner was told an argument that chooses *how much*
   * chooses *which records qualify*.
   *
   * `pageSize` may be a dotted path into an approved argument
   * ("pagination.pageSize"); its first segment must be an approved visitor
   * argument. `pageArguments` names the ones that select WHICH page — never
   * injected, since continuing is a decision this package does not make — and
   * takes dotted paths too.
   */
  pagingArguments: z
    .strictObject({
      pageSize: z.string().min(1).optional(),
      pageArguments: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  orderingArgument: z
    .strictObject({
      name: z.string().min(1),
      ascending: z.string().min(1),
      descending: z.string().min(1),
      separator: z.string().min(1).optional(),
    })
    .optional(),
  /**
   * Corrects the shape discovery inferred for this capability's output.
   *
   * The other corrections a reviewer makes — semantic types, withheld enum
   * values — already live here, where editing is expected. (Scalar mappings do
   * not: they sit on the inventory's selections, so correcting one means taking
   * the inventory again. That is a real gap, not a design.) The
   * shape did not: it was an input to the inventory, so it sat inside
   * `reviewSourceHash`, and correcting it by hand was reported as review
   * drift. That message named the schema as having moved when what had moved
   * was the reviewer's own mind, which are opposite problems with opposite
   * remedies.
   */
  resultShape: ResultShapeSchema.optional(),
  approvedOutputFields: z.array(z.string().min(1)).min(1),
  requiredOutputFields: z.array(z.string().min(1)).default([]),
  policy: GraphQlCapabilityPolicyApprovalSchema,
  limits: z.strictObject({
    maximumSelectionDepth: z
      .number()
      .int()
      .min(1)
      .max(GRAPHQL_APPROVAL_LIMITS.maximumSelectionDepth),
    maximumSelectedFields: z
      .number()
      .int()
      .min(1)
      .max(GRAPHQL_APPROVAL_LIMITS.maximumSelectedFields),
    freshnessMaximumAgeSeconds: z.number().int().nonnegative().optional(),
  }),
});

export const GraphQlCatalogDecisionsSchema = z.strictObject({
  /**
   * Where the JSON Schema for this file lives, so an editor can complete and
   * validate it as you type.
   *
   * Accepted rather than required, and ignored by everything here. It exists
   * because this is a `strictObject`: without somewhere for the key to land, a
   * host who pointed their editor at the shipped schema — the whole reason it
   * is shipped — would have their file refused for containing the pointer.
   */
  $schema: z.string().min(1).optional(),
  schemaVersion: z.literal("1.0"),
  reviewSourceHash: z.string().min(1),
  queries: z.array(GraphQlQueryDecisionsSchema),
  /**
   * Semantic types the host decided for fields discovery could not place, keyed
   * `${coordinate}.${path}` — the same key shape `compileCuratedGraphQlCatalog`
   * uses, and the same key `needsSemanticType` reports back.
   *
   * The curated path has always had this. This path threw on the first
   * undecided field with no override and no list of the others, so a field a
   * host could see in the review UI was a field they could not approve — the
   * stricter-looking path was the unusable one.
   */
  semanticTypeOverrides: z
    .record(z.string().min(1), z.string().min(1))
    .optional(),
});

export type GraphQlQueryDecisions = z.infer<typeof GraphQlQueryDecisionsSchema>;
export type GraphQlCatalogDecisions = z.infer<typeof GraphQlCatalogDecisionsSchema>;

export interface GraphQlOperationBinding {
  capabilityId: string;
  schemaHash: string;
  fieldName: string;
  operationName: string;
  visitorArguments: readonly string[];
  identityArguments: Readonly<Record<string, string>>;
  approvedOutputFields: readonly string[];
  requiredOutputFields: readonly string[];
  scalarMappings: Readonly<Record<string, GraphQlScalarMapping>>;
  maximumSelectionDepth: number;
  maximumSelectedFields: number;
  freshnessMaximumAgeSeconds?: number;
  sourceId: string;
  /** Set when the upstream field is a Relay connection. See `relayConnectionInfo`. */
  connection?: GraphQlConnectionInfo;
  /** Set when the host declared a list envelope. See `GraphQlListEnvelopeInfo`. */
  listEnvelope?: GraphQlListEnvelopeInfo;
  /**
   * Largest page this API accepts — applied to `first` on a connection, or to
   * the declared `pageSizeArgument` on a list envelope. See
   * `CuratedGraphQlCatalogPolicy.maximumPageSize`.
   */
  maximumPageSize?: number;
  /**
   * The host's ordering grammar, resolved from `orderingArgument`. Lives on the
   * binding rather than on the capability for the same reason `maximumPageSize`
   * does: it is a fact about one endpoint's transport, meaningless to a manual
   * or OpenAPI capability, and nothing the planner should read — the planner
   * asks for ordering in typed `query.sort` entries and this is how the request
   * gets written.
   */
  ordering?: OrderingPushdown;
  /**
   * The upstream's filter vocabulary, resolved from its own input types.
   *
   * Here for the same reason `ordering` is: a fact about one endpoint's
   * transport that the planner must not read. The planner asks for narrowing in
   * typed `query.filter` conditions and this is how that becomes the argument
   * the upstream accepts.
   */
  filter?: FilterPushdown;
  /**
   * The host's paging role, resolved from `pagingArguments`, for an API whose
   * page size is neither a Relay `first` nor a list envelope's own top-level
   * argument. Paths are dotted: Strapi's page size is
   * `pagination.pageSize`, and Prisma's is a plain `take` on a field with no
   * envelope at all.
   */
  paging?: { pageSize?: readonly string[]; arguments: readonly string[] };
}

export interface CompiledGraphQlCatalog {
  catalog: CapabilityCatalog;
  plannerManifest: PlannerManifest;
  bindings: ReadonlyMap<string, GraphQlOperationBinding>;
  issues: GraphQlDiscoveryIssue[];
}

export interface GraphQlDataRequest {
  capabilityId: string;
  params: Record<string, unknown>;
  /** Dot-separated approved leaf fields. Omit to request the complete approved field envelope. */
  selection?: readonly string[];
}

export interface CompiledGraphQlOperation {
  capabilityId: string;
  operationName: string;
  document: string;
  variables: Readonly<Record<string, unknown>>;
  responseKey: string;
  selection: readonly string[];
  outputSchema: JsonSchema;
}

export interface GraphQlTransportResponse {
  data?: unknown;
  errors?: readonly {
    message: string;
    path?: readonly (string | number)[];
    extensions?: Readonly<Record<string, unknown>>;
  }[];
}

export interface GraphQlTransportRequest {
  document: string;
  operationName: string;
  variables: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}

/**
 * A transport failure the host can describe, rather than only report.
 *
 * A transport signals failure by throwing, and every throw used to be recorded
 * identically: one message, `retryable: true`, regardless of what happened. So
 * everything the host knew at the moment of failure — the HTTP status, whether
 * retrying could conceivably help — was destroyed at this boundary, and the
 * message string became the only channel. Hosts then wrote a human sentence
 * into it and dropped the status, which is how a 400 (your request is malformed,
 * retrying is pointless) and a 500 (the upstream is broken, retrying may work)
 * arrived indistinguishable and both marked retryable.
 *
 * The cost is not cosmetic. `retryable` decides whether the runtime tries again,
 * so a mislabelled 400 buys nothing but latency, and the operator debugging it
 * sees "rejected" — which reads as an authorization decision — for what was
 * actually the upstream failing to start correctly.
 *
 * A host that throws a plain `Error` still gets the old behaviour, so nothing
 * existing changes.
 */
export class GraphQlTransportError extends Error {
  /** The upstream HTTP status, when the failure had one. Included in the reported message. */
  readonly httpStatus?: number;
  /** Whether the runtime should treat this as worth retrying. */
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { httpStatus?: number; retryable: boolean; cause?: unknown } = {
      retryable: true,
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "GraphQlTransportError";
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    this.retryable = options.retryable;
  }
}

/**
 * The host owns endpoint selection, credentials, headers, cookies, tenant routing and network
 * policy. The catalog package only supplies an already-approved document and variables.
 *
 * Throw `GraphQlTransportError` to say what went wrong; a plain `Error` is
 * reported as a retryable transport failure with no status.
 */
export type GraphQlTransport = (
  request: GraphQlTransportRequest,
) => Promise<GraphQlTransportResponse>;

export interface ExecuteApprovedGraphQlRequestOptions {
  catalog: CapabilityCatalog;
  schema: GraphQlSchemaInput;
  binding: GraphQlOperationBinding;
  request: GraphQlDataRequest;
  context: CapabilityExecutionContext & {
    permissions?: ReadonlySet<string>;
  };
  transport: GraphQlTransport;
  /**
   * Required host callback. GraphQL itself does not prove source provenance or source freshness.
   * The returned value is validated against the approved catalog before it reaches rendering.
   */
  resolveProvenance: (input: {
    capabilityId: string;
    data: unknown;
  }) => DataProvenance | Promise<DataProvenance>;
  now?: () => Date;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}



function introspectionPayload(input: UnknownRecord): UnknownRecord | undefined {
  if (isRecord(input.__schema)) return input;
  if (isRecord(input.data) && isRecord(input.data.__schema)) return input.data;
  return undefined;
}

export function loadGraphQlSchema(input: GraphQlSchemaInput): GraphQLSchema {
  let schema: GraphQLSchema;
  if (typeof input === "string") {
    schema = buildSchema(input);
  } else {
    const payload = introspectionPayload(input);
    if (!payload) {
      throw new Error(
        "GraphQL schema input must be SDL text, introspection JSON, or an object with data.__schema",
      );
    }
    schema = buildClientSchema(payload as never);
  }

  const errors = validateSchema(schema);
  if (errors.length > 0) {
    throw new Error(
      `Invalid GraphQL schema: ${errors.map((error) => error.message).join("; ")}`,
    );
  }
  return schema;
}

export function hashGraphQlSchema(input: GraphQlSchemaInput): string {
  const schema = loadGraphQlSchema(input);
  return fnv1a(printSchema(lexicographicSortSchema(schema)));
}

function titleForField(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function unwrapList(type: GraphQLOutputType): boolean {
  if (isNonNullType(type)) return unwrapList(type.ofType);
  return isListType(type);
}

/**
 * The scalar leaf type of a field declared as a list of (possibly non-null)
 * scalars/enums — `undefined` for anything else, including a list of objects
 * (already `collection` shape at the root, not what this is for) and a plain
 * scalar field (no axis to plot).
 */
function listItemLeafType(type: GraphQLOutputType): GraphQLNamedType | undefined {
  const outer = isNonNullType(type) ? type.ofType : type;
  if (!isListType(outer)) return undefined;
  const item = outer.ofType;
  const namedItem = getNamedType(isNonNullType(item) ? item.ofType : item);
  return isLeafType(namedItem) ? namedItem : undefined;
}

/**
 * True for an object whose OWN fields (not nested) are all parallel arrays of
 * scalars, with at least one reading as a time axis and at least one carrying
 * real numbers to plot — `VolumeTrendData { dates: [String], created: [Int],
 * solved: [Int] }`, the parallel-arrays idiom REST trend APIs commonly use
 * instead of `[{date, value}]` (which is already `collection` shape via the
 * plain list check above, and never reaches this function).
 *
 * Deliberately conservative, not a general time-series detector:
 * - Every field must be a scalar list; one non-list or object field bails out
 *   to `entity` rather than guessing. A REST API doing this right would
 *   return `[{date, value}]` in the first place; this only exists for the
 *   ones that don't.
 * - Requires BOTH a date-like field AND a numeric one, so a plain pair of
 *   unrelated string arrays, or a `timestamps`/`errorCodes` event log with no
 *   values to plot, does not false-positive into a chart shape.
 * - Only looks at this type's own fields — cannot misfire on something nested
 *   several levels into an unrelated object.
 * - A time axis expressed as dict keys (`{"2026-07-01": 12}`) rather than a
 *   parallel array is a different, harder problem — the same
 *   unrepresentable-runtime-key issue as any other dict, needing a manual
 *   per-operation override, not a generic heuristic. Not attempted here.
 */
const TIME_AXIS_FIELD_NAME = /^(date|dates|day|days|timestamp|timestamps|time|times)$/i;

function looksLikeTimeSeries(
  namedType: GraphQLObjectType | GraphQLInterfaceType,
): boolean {
  const fields = Object.values(namedType.getFields());
  if (fields.length < 2) return false;

  let hasDateAxis = false;
  let hasNumericSeries = false;
  for (const field of fields) {
    const itemType = listItemLeafType(field.type);
    if (!itemType) return false; // one non-scalar-list field breaks the pattern

    if (
      TIME_AXIS_FIELD_NAME.test(field.name) ||
      ["date", "date-time"].includes(
        inferSemanticType(field.name, itemType, {}, field.description ?? undefined),
      )
    ) {
      hasDateAxis = true;
    }
    if (itemType.name === "Int" || itemType.name === "Float") {
      hasNumericSeries = true;
    }
  }
  return hasDateAxis && hasNumericSeries;
}

/**
 * How a Relay connection is unwrapped into a collection.
 *
 * Recorded on the candidate and carried into the binding so discovery,
 * compilation and execution all agree about one thing: the capability's field
 * paths are relative to the **node** type, not to the connection wrapper.
 */
export interface GraphQlConnectionInfo {
  /** Field on the connection holding the edge list, conventionally "edges". */
  edgesField: string;
  /** Field on the edge holding the row, conventionally "node". */
  nodeField: string;
  /** Named type of one row. */
  nodeTypeName: string;
  /** Whether the connection exposes `pageInfo`, and so cursor continuation. */
  hasPageInfo: boolean;
  /**
   * The `pageInfo` fields this schema actually declares, of the four cursor
   * fields we read.
   *
   * Selecting all four unconditionally is invalid against a schema that
   * declares fewer — the Relay spec fixes the names but not that every field is
   * present, and a reduced `PageInfo` is common. Asking for a field that is not
   * there fails the whole query, so the capability breaks on a detail nobody
   * chose.
   */
  pageInfoFields: readonly string[];
  /** Field on the edge carrying the row's cursor, when it exposes one. */
  cursorField?: string;
  /**
   * The connection's own total-size field, when the schema declares one.
   *
   * Connection metadata, in the same class as `pageInfo` and selected the same
   * way — not a row field, so not part of the per-field decisions. It exists here
   * because `pageInfo` alone cannot answer "how many are there": an upstream
   * that caps `first` at 100 returns exactly the 100 it was asked for, so the
   * row count never exceeds the budget and `totalRowsBeforeTruncation` stayed
   * unset. The visitor then saw "showing 100 of many" against 2,500 rows —
   * honest, and less than the schema was willing to say.
   */
  totalCountField?: string;
}

/**
 * Recognises a Relay Connection.
 *
 * Structural, not name-based: an object type with a list-valued `edges` whose
 * element type has a `node`. The Relay spec fixes those names, and every API
 * that follows it — Shopify, GitHub, Hasura, Saleor — produces the same shape,
 * so matching the shape rather than a type-name suffix covers schemas whose
 * connection types are not called `*Connection`.
 *
 * Why this matters more than it looks: without it, a "collection" capability
 * over 2,500 rows delivers one object and zero rows. The wrapper also eats two
 * levels of the discovery depth budget, so at the default depth a money field
 * one hop inside a row reaches `total.currency` and never `total.gross.amount`
 * — a currency with no amount, which is worse than nothing.
 */
export function relayConnectionInfo(
  type: GraphQLOutputType,
): GraphQlConnectionInfo | undefined {
  const namedType = getNamedType(type);
  if (!isObjectType(namedType) && !isInterfaceType(namedType)) return undefined;
  const fields = namedType.getFields();
  const edges = fields["edges"];
  if (!edges) return undefined;
  const edgeType = getNamedType(edges.type);
  if (!unwrapList(edges.type)) return undefined;
  if (!isObjectType(edgeType) && !isInterfaceType(edgeType)) return undefined;
  const edgeFields = edgeType.getFields();
  const node = edgeFields["node"];
  if (!node) return undefined;
  const nodeType = getNamedType(node.type);
  if (!isObjectType(nodeType) && !isInterfaceType(nodeType)) return undefined;
  const pageInfoType = fields["pageInfo"]
    ? getNamedType(fields["pageInfo"].type)
    : undefined;
  const pageInfoFields =
    pageInfoType && (isObjectType(pageInfoType) || isInterfaceType(pageInfoType))
      ? ["hasNextPage", "hasPreviousPage", "startCursor", "endCursor"].filter(
          (name) => name in pageInfoType.getFields(),
        )
      : [];
  const totalCountType = fields["totalCount"]
    ? getNamedType(fields["totalCount"].type)
    : undefined;
  return {
    edgesField: "edges",
    nodeField: "node",
    nodeTypeName: nodeType.name,
    hasPageInfo: pageInfoFields.length > 0,
    pageInfoFields,
    ...(edgeFields["cursor"] ? { cursorField: "cursor" } : {}),
    // Only when the schema declares it and it is numeric. Selecting a field the
    // schema lacks fails the entire query, which is why `pageInfoFields` is
    // filtered the same way rather than assumed from the Relay spec.
    ...(totalCountType && isNumericScalar(totalCountType, {})
      ? { totalCountField: "totalCount" }
      : {}),
  };
}

/**
 * Host-declared: a root field returning an object that WRAPS a list of rows,
 * rather than a Relay connection or a bare list. Payload CMS 3, Strapi, and
 * most REST-shaped GraphQL facades page this way:
 * `{ docs: [Post], totalDocs, hasNextPage, page, limit }`.
 *
 * Declared, never detected. The structural signature of an envelope — an
 * object with one list-of-objects field and some scalars — is also the
 * signature of an entity with a nested list (an Order and its lines), and the
 * two cannot be told apart from a schema. Detecting it would put a whole
 * capability's row semantics on a guess; see `DISCOVERABLE_RESULT_SHAPES` for
 * the same argument about shapes. Discovery reports the candidate as an issue
 * so the host knows the declaration exists; the host makes it.
 */
export interface GraphQlListEnvelopeInfo {
  /** Field on the envelope holding the rows, e.g. "docs". Must be a list of objects. */
  rowsField: string;
  /** Envelope field carrying "more pages exist", e.g. "hasNextPage". Must be Boolean. */
  hasNextPageField?: string;
  /** Envelope field carrying the whole set's size, e.g. "totalDocs". Must be numeric. */
  totalCountField?: string;
  /**
   * Argument that sets the page size, e.g. "limit". Excluded from
   * source-narrowing facts, and injected with a bounded default the same way a
   * connection's `first` is — an API that pages by offset may still reject or
   * default a request that names no size.
   */
  pageSizeArgument?: string;
  /**
   * Further paging arguments that select WHICH page, e.g. ["page", "offset"].
   * Excluded from source-narrowing facts, never injected: selecting a page is
   * a continuation decision this package does not make.
   */
  pageArguments?: readonly string[];
}

/**
 * The one shape every unwrap/generate/error-mapping site reads. Derived by
 * `rowEnvelopeOf`, never persisted: a Relay connection is the two-hop case
 * (`edges` then `node`), a declared list envelope the one-hop case, of the
 * same idea — where the rows are and how to reach them. Deriving it in one
 * place is what keeps the two cases from growing parallel branches that agree
 * only by luck; `nodeField` can be absent only because the normalizer decided
 * so, never because a persisted key was dropped.
 */
interface RowEnvelope {
  /** "edges" for Relay, the declared rows field otherwise. */
  rowsField: string;
  /** "node" for Relay; absent for a direct list of rows. */
  nodeField?: string;
  /** Relay only. */
  cursorField?: string;
  /**
   * Where the paging booleans live: "pageInfo" for Relay, absent for an
   * envelope, whose paging fields sit on the envelope root itself.
   */
  pageInfoContainer?: string;
  /** Field names selected inside the container (Relay) or as siblings (envelope). */
  pageInfoFields: readonly string[];
  /** The "more pages exist" boolean's name, wherever it lives. */
  hasNextPageField?: string;
  totalCountField?: string;
  /** Argument this package may inject a bounded page size into. */
  pageSizeArgumentName?: string;
  /** Every paging argument name — excluded from source-narrowing facts. */
  pagingArgumentNames: readonly string[];
  /** "connection" | "list envelope" — so every error message says which. */
  label: string;
}

/** A dotted declaration as path segments. `"pagination.pageSize"` -> two. */
function pagingPath(declared: string): readonly string[] {
  return declared.split(".").filter((segment) => segment.length > 0);
}

function rowEnvelopeOf(binding: {
  connection?: GraphQlConnectionInfo | undefined;
  listEnvelope?: GraphQlListEnvelopeInfo | undefined;
}): RowEnvelope | undefined {
  if (binding.connection && binding.listEnvelope) {
    throw new Error(
      "A capability cannot carry both a Relay connection and a declared list envelope",
    );
  }
  if (binding.connection) {
    const connection = binding.connection;
    return {
      rowsField: connection.edgesField,
      nodeField: connection.nodeField,
      ...(connection.cursorField ? { cursorField: connection.cursorField } : {}),
      ...(connection.hasPageInfo ? { pageInfoContainer: "pageInfo" } : {}),
      pageInfoFields: connection.pageInfoFields,
      ...(connection.hasPageInfo ? { hasNextPageField: "hasNextPage" } : {}),
      ...(connection.totalCountField
        ? { totalCountField: connection.totalCountField }
        : {}),
      pageSizeArgumentName: "first",
      pagingArgumentNames: ["first", "last", "after", "before"],
      label: "connection",
    };
  }
  if (binding.listEnvelope) {
    const envelope = binding.listEnvelope;
    return {
      rowsField: envelope.rowsField,
      pageInfoFields: envelope.hasNextPageField ? [envelope.hasNextPageField] : [],
      ...(envelope.hasNextPageField
        ? { hasNextPageField: envelope.hasNextPageField }
        : {}),
      ...(envelope.totalCountField
        ? { totalCountField: envelope.totalCountField }
        : {}),
      ...(envelope.pageSizeArgument
        ? { pageSizeArgumentName: envelope.pageSizeArgument }
        : {}),
      pagingArgumentNames: [
        ...(envelope.pageSizeArgument ? [envelope.pageSizeArgument] : []),
        ...(envelope.pageArguments ?? []),
      ],
      label: "list envelope",
    };
  }
  return undefined;
}

/**
 * Validates a host's list-envelope declaration against the schema, at inventory
 * and again at compile — both fail with the fix named, so a bad declaration
 * never survives to `validate(document)`'s raw GraphQL string.
 */
function assertListEnvelopeDeclaration(
  fieldName: string,
  field: GraphQLField<unknown, unknown>,
  declaration: GraphQlListEnvelopeInfo,
  mappings: Readonly<Record<string, GraphQlScalarMapping>>,
): void {
  if (relayConnectionInfo(field.type)) {
    throw new Error(
      `"${fieldName}" returns a Relay connection; remove its listEnvelope declaration — connections unwrap on their own`,
    );
  }
  const namedType = getNamedType(field.type);
  if (!isObjectType(namedType) && !isInterfaceType(namedType)) {
    throw new Error(
      `"${fieldName}" returns "${namedType.name}", which is not an object, so it cannot be a list envelope`,
    );
  }
  const fields = namedType.getFields();
  const rows = fields[declaration.rowsField];
  if (!rows) {
    throw new Error(
      `listEnvelope.rowsField "${declaration.rowsField}" is not a field of "${namedType.name}". ` +
        `Its fields: ${Object.keys(fields).join(", ")}`,
    );
  }
  if (!unwrapList(rows.type)) {
    throw new Error(
      `listEnvelope.rowsField "${namedType.name}.${declaration.rowsField}" is ${rows.type.toString()}, not a list`,
    );
  }
  const rowType = getNamedType(rows.type);
  if (!isObjectType(rowType) && !isInterfaceType(rowType)) {
    throw new Error(
      `listEnvelope.rowsField "${namedType.name}.${declaration.rowsField}" is a list of "${rowType.name}", not of objects — a list of scalars is not rows`,
    );
  }
  if (declaration.totalCountField) {
    const total = fields[declaration.totalCountField];
    if (!total) {
      throw new Error(
        `listEnvelope.totalCountField "${declaration.totalCountField}" is not a field of "${namedType.name}"`,
      );
    }
    if (!isNumericScalar(getNamedType(total.type), mappings)) {
      throw new Error(
        `listEnvelope.totalCountField "${namedType.name}.${declaration.totalCountField}" is ${total.type.toString()}, not numeric — ` +
          `a non-numeric total would serialise fine and then be reported as a row count. ` +
          `For a custom numeric scalar, add a scalarMappings entry with {"type": "integer"}`,
      );
    }
  }
  if (declaration.hasNextPageField) {
    const flag = fields[declaration.hasNextPageField];
    if (!flag) {
      throw new Error(
        `listEnvelope.hasNextPageField "${declaration.hasNextPageField}" is not a field of "${namedType.name}"`,
      );
    }
    if (getNamedType(flag.type).name !== "Boolean") {
      throw new Error(
        `listEnvelope.hasNextPageField "${namedType.name}.${declaration.hasNextPageField}" is ${flag.type.toString()}, not Boolean`,
      );
    }
  }
  const argumentNames = new Set(field.args.map((argument) => argument.name));
  for (const name of [
    ...(declaration.pageSizeArgument ? [declaration.pageSizeArgument] : []),
    ...(declaration.pageArguments ?? []),
  ]) {
    if (!argumentNames.has(name)) {
      throw new Error(
        `listEnvelope names paging argument "${name}", which "${fieldName}" does not declare. ` +
          `Its arguments: ${[...argumentNames].join(", ")}`,
      );
    }
  }
}

/**
 * The one field of this type that is a list of objects, when every OTHER field
 * is a leaf or a list of leaves — the structural signature of a paginated list
 * envelope. Returns undefined on any ambiguity: two list-of-object fields, or
 * a sibling object field, and the shape stops looking like an envelope.
 *
 * Known false-positive class, deliberately tolerated: an entity that is
 * scalars plus one nested list (an Order and its lines) matches too. That is
 * why this feeds a *warning phrased as a question*, never a declaration.
 */
function soleListOfObjectsField(
  namedType: GraphQLObjectType | GraphQLInterfaceType,
): string | undefined {
  let rowsField: string | undefined;
  for (const field of Object.values(namedType.getFields())) {
    const named = getNamedType(field.type);
    if (unwrapList(field.type) && (isObjectType(named) || isInterfaceType(named))) {
      if (rowsField) return undefined;
      rowsField = field.name;
      continue;
    }
    if (!isLeafType(named)) return undefined;
  }
  return rowsField;
}

/**
 * The type of one row: a connection's node, an envelope's list element, or the
 * type itself when there is no envelope.
 */
function rowTypeOf(
  type: GraphQLOutputType,
  envelope: RowEnvelope | undefined,
): GraphQLOutputType {
  if (!envelope) return type;
  const namedType = getNamedType(type);
  if (!isObjectType(namedType) && !isInterfaceType(namedType)) return type;
  const rows = namedType.getFields()[envelope.rowsField];
  if (!rows) return type;
  // The element type, not the list: consumers describe ONE row, and the
  // array-ness is restored by the unwrap schema, exactly as for a connection.
  if (!envelope.nodeField) return getNamedType(rows.type);
  const edgeType = getNamedType(rows.type);
  if (!isObjectType(edgeType) && !isInterfaceType(edgeType)) return type;
  return edgeType.getFields()[envelope.nodeField]!.type;
}

/**
 * Whether a root field returning this scalar is reporting a number.
 *
 * `Int` and `Float` are numeric by definition. A custom scalar is numeric only
 * if the host's own mapping says so — this never guesses from the scalar's name,
 * because `Money` and `Weight` are numeric while `PhoneNumber` is not, and the
 * name cannot tell them apart.
 */
function isNumericScalar(
  namedType: GraphQLNamedType,
  mappings: Readonly<Record<string, GraphQlScalarMapping>>,
): boolean {
  if (!isScalarType(namedType)) return false;
  const mapped = mappings[namedType.name]?.schema as { type?: string } | undefined;
  if (mapped?.type) return mapped.type === "integer" || mapped.type === "number";
  return namedType.name === "Int" || namedType.name === "Float";
}

/**
 * The shapes discovery can propose, out of the nine a catalog may declare.
 *
 * Exported because the gap is the point: a shape absent from this list is not
 * unsupported, it is *unguessable from a schema*. Product images are a
 * `media-collection` and a category tree is a `hierarchy`, but nothing in
 * GraphQL's type system says so — inferring either would mean keying off field
 * names, and a confident wrong suggestion is worse than a visibly partial one
 * (that is the same reasoning that keeps `metric` numeric-only).
 *
 * So the suggestion stops here and says so, in the inventory and in the CLI. A host
 * declaring one of the other five is doing the expected thing, not working
 * around a limitation.
 */
export const DISCOVERABLE_RESULT_SHAPES: readonly ResultShape[] = Object.freeze([
  "collection",
  "entity",
  "metric",
  "time-series",
]);

function inferResultShape(
  type: GraphQLOutputType,
  mappings: Readonly<Record<string, GraphQlScalarMapping>> = {},
): ResultShape {
  // A connection is a collection of its nodes, whatever the wrapper's own
  // shape looks like.
  if (relayConnectionInfo(type)) return "collection";
  if (unwrapList(type)) return "collection";
  const namedType = getNamedType(type);
  // A single number is a metric, and nothing used to say so: this returned
  // `entity` for every scalar root, so `metric` was never produced by discovery
  // and a component accepting only `metric` — the starter catalog's metric card
  // — could not be selected for anything a GraphQL schema offers.
  //
  // Numeric specifically, not scalar. Classifying every scalar as a metric puts
  // `apiVersion: String` under a KPI renderer, which is worse than leaving the
  // component unreachable: wrong output looks like a working feature.
  if (isNumericScalar(namedType, mappings)) return "metric";
  if (
    (isObjectType(namedType) || isInterfaceType(namedType)) &&
    looksLikeTimeSeries(namedType)
  ) {
    return "time-series";
  }
  return "entity";
}

/**
 * Adapts a GraphQL named type into the shared classifier's normalized signal.
 * The classification rules live in `semantic-type.ts` so this path and the
 * OpenAPI path cannot disagree about the same field. A host-supplied scalar
 * mapping still wins outright.
 */
function inferSemanticType(
  name: string,
  namedType: GraphQLNamedType,
  mappings: Readonly<Record<string, GraphQlScalarMapping>> = {},
  fieldDescription?: string,
): FieldDescriptor["semanticType"] {
  const mapped = mappings[namedType.name]?.semanticType;
  if (mapped) return mapped;

  const kind: SemanticValueKind = isEnumType(namedType)
    ? "enum"
    : namedType.name === "Boolean"
      ? "boolean"
      : namedType.name === "Int"
        ? "integer"
        : namedType.name === "Float"
          ? "number"
          : namedType.name === "String" || namedType.name === "ID"
            ? "string"
            : "unknown";

  // The field's own description ("Total number of open tickets") is the
  // useful signal for `describesACount` and friends. `namedType.description`
  // is the *scalar's* description (e.g. Int's own built-in blurb) — for every
  // built-in scalar that carries no information about this particular field,
  // so relying on it alone silently discards every hint a schema author wrote.
  // Prefer the field's, fall back to the type's only when the field has none
  // (a named object/enum's own description can still be relevant there).
  return inferSharedSemanticType({
    name,
    kind,
    typeName: namedType.name,
    ...(fieldDescription
      ? { description: fieldDescription }
      : namedType.description
        ? { description: namedType.description }
        : {}),
  });
}

/**
 * A rejected union isn't actionable to a host who has never talked to us —
 * they read one error and either guess or give up. Naming the concrete
 * member types turns the message into the actual fix: register the members
 * that already exist as their own concrete queries (they usually do — a
 * union return is normally built from types that already have their own
 * root query too) as separate capabilities instead of the polymorphic one.
 */
function unionMemberSummary(union: GraphQLUnionType): string {
  const names = union.getTypes().map((member) => member.name);
  const shown = names.slice(0, 6);
  const suffix =
    names.length > shown.length ? `, +${names.length - shown.length} more` : "";
  return `${shown.join(", ")}${suffix}`;
}

function argumentCandidate(argument: GraphQLArgument): GraphQlArgumentCandidate {
  return {
    name: argument.name,
    ...(argument.description ? { description: argument.description } : {}),
    type: argument.type.toString(),
    required: isNonNullType(argument.type) && argument.defaultValue === undefined,
    hasDefaultValue: argument.defaultValue !== undefined,
  };
}

/**
 * Names the fields of `namedType` that were never walked, so a stop reports
 * what was lost rather than only where the walk halted.
 *
 * One level, not the whole subtree: the subtree below an unwalked field is
 * unbounded and its contents are not actionable anyway. What a host needs is
 * "these named fields exist here and you cannot have them", which is enough to
 * decide whether to raise the depth.
 */
function excludeFieldsOf(
  namedType: GraphQLObjectType | GraphQLInterfaceType,
  prefix: string,
  reason: GraphQlFieldExclusion["reason"],
  detail: string,
): GraphQlFieldExclusion[] {
  return Object.values(namedType.getFields()).map((field) => ({
    path: prefix ? `${prefix}.${field.name}` : field.name,
    reason,
    type: field.type.toString(),
    detail,
  }));
}

function discoverOutputFields(
  schema: GraphQLSchema,
  type: GraphQLOutputType,
  maxDepth: number,
  mappings: Readonly<Record<string, GraphQlScalarMapping>>,
  exclusions: GraphQlFieldExclusion[],
  prefix = "",
  ancestors: readonly string[] = [],
  fieldDescription?: string,
): GraphQlOutputFieldCandidate[] {
  const namedType = getNamedType(type);
  const depth = prefix ? prefix.split(".").length : 0;

  if (isLeafType(namedType)) {
    if (!prefix) return [];
    const fieldName = prefix.split(".").at(-1) ?? prefix;
    return [
      {
        path: prefix,
        label: titleForField(fieldName),
        type: type.toString(),
        depth,
        semanticType: inferSemanticType(fieldName, namedType, mappings, fieldDescription),
        deprecated: false,
      },
    ];
  }

  if (isUnionType(namedType)) {
    exclusions.push({
      path: prefix || namedType.name,
      reason: "union",
      type: type.toString(),
      detail: `Union output "${namedType.name}" (${unionMemberSummary(namedType)}) requires fragment selection and is not supported in GraphQL 0.2; this field is excluded, the rest of the query is not`,
    });
    return [];
  }

  // No guard for "some other kind of type" here, and none is reachable: the
  // named type of an output is a scalar, enum, object, interface or union, and
  // the first two are `isLeafType` and the last was just handled. There was one,
  // returning `[]` silently — the only exclusion path that recorded nothing at
  // all. Writing the ledger is what proved it could never fire.
  if (depth >= maxDepth) {
    exclusions.push(
      ...excludeFieldsOf(
        namedType,
        prefix,
        "depth",
        `Output discovery stopped at the configured depth ${maxDepth}; raise it to reach these`,
      ),
    );
    return [];
  }
  if (ancestors.includes(namedType.name)) {
    exclusions.push(
      ...excludeFieldsOf(
        namedType,
        prefix,
        "recursion",
        `Recursive relationship through "${namedType.name}" was stopped for safe discovery`,
      ),
    );
    return [];
  }

  // An interface is walked as itself, which works — `Content` with `id` and
  // `title` compiles and executes exactly like an object type. What does not
  // work is `Article.wordCount`: a field only one implementation declares needs
  // `... on Article { wordCount }`, the same fragment machinery unions need and
  // GraphQL 0.2 does not have.
  //
  // Before this, those fields were absent with nothing said. A host reviewing a
  // `Content` connection saw three fields, approved them, and had no way to
  // learn that the article rows carry a word count and the video rows a
  // duration — the interface looked like the whole story because interfaces
  // usually are. Recorded here so the ledger stays total and the reviewer gets
  // the same advice the union case already gives: register the concrete type as
  // its own capability.
  if (isInterfaceType(namedType)) {
    const own = new Set(Object.keys(namedType.getFields()));
    const byPath = new Map<string, { type: string; declaredBy: string[] }>();
    for (const implementation of schema.getPossibleTypes(namedType)) {
      for (const field of Object.values(implementation.getFields())) {
        if (own.has(field.name)) continue;
        const path = prefix ? `${prefix}.${field.name}` : field.name;
        const entry = byPath.get(path);
        if (entry) entry.declaredBy.push(implementation.name);
        else byPath.set(path, { type: field.type.toString(), declaredBy: [implementation.name] });
      }
    }
    for (const [path, entry] of byPath) {
      exclusions.push({
        path,
        reason: "interface-implementation",
        type: entry.type,
        detail:
          `Only ${entry.declaredBy.join(", ")} declare${entry.declaredBy.length === 1 ? "s" : ""} this, ` +
          `not the "${namedType.name}" interface itself; selecting it requires a fragment, ` +
          "which GraphQL 0.2 does not support. Register a query returning that type " +
          "directly as a separate capability to reach it.",
      });
    }
  }

  return Object.values(namedType.getFields()).flatMap((field) => {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    const requiredArguments = field.args.filter(
      (argument) => isNonNullType(argument.type) && argument.defaultValue === undefined,
    );
    if (requiredArguments.length > 0) {
      exclusions.push({
        path,
        reason: "required-argument",
        type: field.type.toString(),
        detail: `Nested field requires argument(s) ${requiredArguments.map((argument) => argument.name).join(", ")} and was excluded`,
      });
      return [];
    }

    const nested = discoverOutputFields(
      schema,
      field.type,
      maxDepth,
      mappings,
      exclusions,
      path,
      [...ancestors, namedType.name],
      field.description ?? undefined,
    );
    return nested.map((candidate) =>
      candidate.path === path
        ? {
            ...candidate,
            ...(field.description ? { description: field.description } : {}),
            deprecated: Boolean(field.deprecationReason),
            ...(field.deprecationReason
              ? { deprecationReason: field.deprecationReason }
              : {}),
          }
        : candidate,
    );
  });
}

/** Scalars GraphQL defines itself, and so never need a host mapping. */
const BUILTIN_GRAPHQL_SCALARS = new Set(["String", "Int", "Float", "Boolean", "ID"]);

/**
 * The custom scalar type names a schema uses, which are exactly the ones
 * `scalarMappings` has to answer for.
 *
 * Compilation refuses a custom scalar it has no mapping for, so this is the
 * list a host needs before they can compile anything — and it lived inside the
 * review app, where a headless host could not reach it and had to rediscover
 * it by triggering failures one at a time. The answer is derivable from the
 * schema, so it should be answerable without a browser.
 *
 * Pass the schema to get the exact answer. The candidates alone carry type
 * names as strings, which misses every scalar reachable only *inside* an
 * input-object argument (a `Decimal` inside an `OrderWhereInput` — measured
 * live as 61 names reported, 62 needed) and over-reports input-object and
 * enum type names, which need no mapping. With the schema, input objects are
 * walked to their scalar leaves and only true custom scalars are returned.
 * The schemaless form is kept for callers that only hold candidates.
 */
export function customScalarNames(
  queries: readonly GraphQlQueryCandidate[],
  schemaInput?: GraphQlSchemaInput,
): string[] {
  const names = new Set<string>();
  if (schemaInput === undefined) {
    const named = (type: string): string => type.replace(/[[\]!]/g, "");
    for (const query of queries) {
      for (const field of query.outputFields) names.add(named(field.type));
      for (const argument of query.arguments) names.add(named(argument.type));
    }
    return [...names].filter((name) => !BUILTIN_GRAPHQL_SCALARS.has(name)).sort();
  }

  const schema = loadGraphQlSchema(schemaInput);
  const rootFields = schema.getQueryType()?.getFields() ?? {};
  for (const query of queries) {
    const field = rootFields[query.fieldName];
    if (!field) continue;
    for (const argument of field.args) {
      collectCustomInputScalars(argument.type, names, new Set());
    }
    for (const candidate of query.outputFields) {
      const namedType = schema.getType(candidate.type.replace(/[[\]!]/g, ""));
      if (
        namedType &&
        isScalarType(namedType) &&
        !BUILTIN_GRAPHQL_SCALARS.has(namedType.name)
      ) {
        names.add(namedType.name);
      }
    }
  }
  return [...names].sort();
}

/** Walks one input type to its scalar leaves, once per input object. */
function collectCustomInputScalars(
  type: GraphQLInputType,
  names: Set<string>,
  visited: Set<string>,
): void {
  const namedType = getNamedType(type);
  if (isScalarType(namedType)) {
    if (!BUILTIN_GRAPHQL_SCALARS.has(namedType.name)) names.add(namedType.name);
    return;
  }
  if (!isInputObjectType(namedType) || visited.has(namedType.name)) return;
  visited.add(namedType.name);
  for (const field of Object.values(namedType.getFields())) {
    collectCustomInputScalars(field.type, names, visited);
  }
}

/**
 * The reviewer-facing notes, derived from the ledger rather than written
 * alongside it — two lists assembled in parallel drift, and the drift shows up
 * as a warning about a field that is on offer anyway.
 *
 * A depth stop, a recursion stop, or an interface's implementation-only fields
 * put one entry in the ledger per field, and collapse back to one note here.
 * Per-field notes would be correct and unreadable: a stop at a fifty-field type
 * is one decision to make, not fifty warnings to scroll past.
 */
const GROUPED_EXCLUSION_REASONS: ReadonlySet<GraphQlFieldExclusion["reason"]> = new Set([
  "depth",
  "recursion",
  "interface-implementation",
]);

function discoveryIssuesFrom(
  exclusions: readonly GraphQlFieldExclusion[],
): GraphQlDiscoveryIssue[] {
  const grouped = new Map<string, { paths: string[]; exclusion: GraphQlFieldExclusion }>();
  const issues: GraphQlDiscoveryIssue[] = [];

  for (const exclusion of exclusions) {
    if (!GROUPED_EXCLUSION_REASONS.has(exclusion.reason)) {
      issues.push({
        severity: exclusion.reason === "union" ? "error" : "warning",
        path: exclusion.path,
        message: exclusion.detail,
      });
      continue;
    }
    const parent = exclusion.path.split(".").slice(0, -1).join(".");
    const key = `${exclusion.reason}:${parent}`;
    const entry = grouped.get(key);
    if (entry) entry.paths.push(exclusion.path);
    else grouped.set(key, { paths: [exclusion.path], exclusion });
  }

  for (const [key, { paths, exclusion }] of grouped) {
    const parent = key.slice(key.indexOf(":") + 1);
    issues.push({
      severity: "warning",
      path: parent || exclusion.path,
      // The interface case names different concrete types per field, so the
      // first entry's sentence would be wrong for the rest of the group. It
      // gets a message about the group instead; the ledger keeps the detail.
      message:
        exclusion.reason === "interface-implementation"
          ? `Declared by implementations rather than by the interface, so a fragment would be needed and GraphQL 0.2 has none: ${paths.join(", ")}. See the exclusion ledger for which type declares each.`
          : `${exclusion.detail}: ${paths.join(", ")}`,
    });
  }
  return issues;
}

export function listGraphQlQueries(
  input: GraphQlSchemaInput,
  options: {
    maximumDiscoveryDepth?: number;
    scalarMappings?: Readonly<Record<string, GraphQlScalarMapping>>;
    /** Host declarations of `{docs: [...]}`-style envelopes, keyed by root field name. */
    listEnvelopes?: Readonly<Record<string, GraphQlListEnvelopeInfo>>;
  } = {},
): GraphQlQueryCandidate[] {
  const schema = loadGraphQlSchema(input);
  const queryType = schema.getQueryType();
  if (!queryType) return [];
  const maximumDiscoveryDepth = options.maximumDiscoveryDepth ?? 4;
  if (
    !Number.isInteger(maximumDiscoveryDepth) ||
    maximumDiscoveryDepth < 1 ||
    maximumDiscoveryDepth > 12
  ) {
    throw new Error("maximumDiscoveryDepth must be an integer between 1 and 12");
  }

  return Object.values(queryType.getFields()).map((field) => {
    const exclusions: GraphQlFieldExclusion[] = [];
    const namedReturnType = getNamedType(field.type);
    const supportedRoot =
      isObjectType(namedReturnType) || isInterfaceType(namedReturnType);
    // Discovery walks the row, not the wrapper. Paths are what a host reviews
    // and what a component binds to, so `total.gross.amount` is both the
    // truthful description of a row and the path that survives unwrapping —
    // where `edges.node.total.gross.amount` described the transport and bound
    // to nothing. It also returns the two depth levels the wrapper was
    // spending, which is why a money field was previously out of reach at the
    // default depth.
    const connection = relayConnectionInfo(field.type);
    const declaredEnvelope = options.listEnvelopes?.[field.name];
    if (declaredEnvelope) {
      assertListEnvelopeDeclaration(
        field.name,
        field,
        declaredEnvelope,
        options.scalarMappings ?? {},
      );
    }
    const envelope = declaredEnvelope
      ? rowEnvelopeOf({ listEnvelope: declaredEnvelope })
      : connection
        ? rowEnvelopeOf({ connection })
        : undefined;
    const discoveredFrom = envelope ? rowTypeOf(field.type, envelope) : field.type;
    const outputFields = supportedRoot
      ? discoverOutputFields(
          schema,
          discoveredFrom,
          maximumDiscoveryDepth,
          options.scalarMappings ?? {},
          exclusions,
          "",
          [],
          field.description ?? undefined,
        )
      : [];
    const issues = discoveryIssuesFrom(exclusions);
    // An undeclared envelope is invisible until execution delivers one object
    // where rows were promised — so when the shape matches, say so here, as a
    // question rather than a claim: an entity with one nested list (an Order
    // and its lines) has the same signature, and only the host can tell them
    // apart. Report, never populate: the declaration is the host's.
    if (supportedRoot && !connection && !declaredEnvelope && !unwrapList(field.type)) {
      const candidateRowsField = soleListOfObjectsField(namedReturnType);
      if (candidateRowsField) {
        issues.push({
          severity: "warning",
          path: field.name,
          message:
            `"${field.name}" returns an object with one list-of-objects field ("${candidateRowsField}") ` +
            `and otherwise only scalars — the shape a paginated list envelope has (Payload, Strapi). ` +
            `If these are rows, declare listEnvelope: { rowsField: "${candidateRowsField}" } on the ` +
            `query selection and the paths become row-relative. If "${field.name}" is one record ` +
            `with a nested list, ignore this.`,
        });
      }
    }
    // An aggregate sibling, when the schema has one.
    //
    // A plan that asks for a count over a capped collection is refused, not
    // answered: an aggregate over one fetched page reports the page's numbers
    // as the dataset's, and that refusal (TRUNCATED_AGGREGATION) is correct.
    // What it does not say is that the schema may already hold the answer.
    // Hasura and its kin publish counting as a separate root field, and
    // declaring that field as its own `metric` capability gives a correct count
    // over the whole collection with no new mechanism — the filter argument
    // works on it exactly as it does here.
    //
    // Said as a question, like the envelope hint above: only the host knows
    // whether the sibling counts the same population this capability reads.
    if (supportedRoot) {
      const siblingNames = Object.keys(queryType.getFields());
      const aggregateSibling = siblingNames.find(
        (name) =>
          name === `${field.name}_aggregate` || name === `${field.name}Aggregate`,
      );
      if (aggregateSibling) {
        issues.push({
          severity: "warning",
          path: field.name,
          message:
            `"${aggregateSibling}" sits beside "${field.name}" and is not approved. A plan that ` +
            `asks this capability for a count or a sum is refused when the fetch was capped, ` +
            `because aggregating one page reports the page's numbers as the collection's. ` +
            `Declaring "${aggregateSibling}" as its own capability with resultShape: "metric" ` +
            `answers those questions correctly over the whole collection, and the same filter ` +
            `argument narrows it. Ignore this if it counts a different population.`,
        });
      }
    }
    // A union anywhere in the reachable graph is excluded at the field level
    // above (discoverOutputFields drops just that one field and records an
    // error issue) — it must not veto the whole root query. A real schema's
    // Order/Checkout/User-shaped objects routinely have a polymorphic field
    // a few hops down (e.g. "createdBy: UserOrApp"); rejecting the entire
    // query over that would make every non-trivial object type unsupported.
    // The query is only unsupported when nothing safe was left to approve.
    const support = !supportedRoot
      ? {
          status: "unsupported" as const,
          reason: isUnionType(namedReturnType)
            ? `Root query returns union "${namedReturnType.name}" (${unionMemberSummary(namedReturnType)}); GraphQL 0.2 requires one concrete object or list, not a polymorphic root. If this schema has its own query returning one of those member types directly, register that instead as a separate capability.`
            : `Root query returns "${namedReturnType.name}"; GraphQL 0.2 requires an object or list of objects`,
        }
      : outputFields.length === 0
        ? {
            status: "unsupported" as const,
            reason: issues.some((issue) => issue.severity === "error")
              ? "The output requires unsupported union fragments"
              : "No safely selectable leaf output fields were discovered",
          }
        : { status: "supported" as const };

    return {
      coordinate: `${queryType.name}.${field.name}`,
      fieldName: field.name,
      ...(field.description ? { description: field.description } : {}),
      returnType: field.type.toString(),
      // A declared envelope IS a collection of its rows — the declaration is
      // the host stating exactly that, so the suggestion follows it.
      suggestedResultShape: declaredEnvelope
        ? "collection"
        : inferResultShape(field.type, options.scalarMappings ?? {}),
      ...(connection ? { connection } : {}),
      ...(declaredEnvelope ? { listEnvelope: declaredEnvelope } : {}),
      arguments: field.args.map(argumentCandidate),
      outputFields,
      exclusions,
      support,
      issues,
    };
  });
}

function reviewSourceHash(
  schemaHash: string,
  options: Omit<GraphQlCatalogReviewOptions, "schema">,
): string {
  return hashContent({ schemaHash, ...options });
}

function queryByName(
  schema: GraphQLSchema,
  fieldName: string,
): GraphQLField<unknown, unknown> {
  const field = schema.getQueryType()?.getFields()[fieldName];
  if (!field) throw new Error(`GraphQL root query field "${fieldName}" was not found`);
  return field;
}

export function createGraphQlCatalogInventory(
  options: GraphQlCatalogReviewOptions,
): GraphQlCatalogInventory {
  const schemaHash = hashGraphQlSchema(options.schema);
  const discovery = listGraphQlQueries(options.schema, {
    ...(options.discoveryMaxDepth !== undefined
      ? { maximumDiscoveryDepth: options.discoveryMaxDepth }
      : {}),
    scalarMappings: Object.assign(
      {},
      ...options.queries.map((selection) => selection.scalarMappings ?? {}),
    ),
    // Same mechanism as scalarMappings: a per-selection fact discovery needs
    // before selections exist, keyed by the root field it applies to.
    listEnvelopes: Object.fromEntries(
      options.queries.flatMap((selection) =>
        selection.listEnvelope
          ? [[selection.fieldName, selection.listEnvelope] as const]
          : [],
      ),
    ),
  });
  const byName = new Map(discovery.map((query) => [query.fieldName, query]));
  const issues: GraphQlDiscoveryIssue[] = [];
  const seenCapabilities = new Set<string>();

  const queries = options.queries.map((selection) => {
    if (seenCapabilities.has(selection.capabilityId)) {
      throw new Error(`Duplicate GraphQL capability id "${selection.capabilityId}"`);
    }
    seenCapabilities.add(selection.capabilityId);
    const candidate = byName.get(selection.fieldName);
    if (!candidate) {
      throw new Error(
        `GraphQL root query field "${selection.fieldName}" was not discovered`,
      );
    }
    if (candidate.support.status !== "supported") {
      throw new Error(
        `GraphQL query "${selection.fieldName}" is unsupported: ${candidate.support.reason ?? "unknown reason"}`,
      );
    }
    const purpose = selection.purpose ?? candidate.description;
    if (!purpose) {
      issues.push({
        severity: "warning",
        path: `queries.${selection.capabilityId}.purpose`,
        message: "The host must add a planner-facing business purpose before approval",
      });
    }

    return {
      capabilityId: selection.capabilityId,
      purpose: purpose ?? `Review the purpose of ${selection.capabilityId}`,
      coordinate: candidate.coordinate,
      fieldName: candidate.fieldName,
      returnType: candidate.returnType,
      availableVisitorArguments: candidate.arguments,
      availableOutputFields: candidate.outputFields,
      exclusions: candidate.exclusions,
      issues: candidate.issues,
    };
  });

  const optionsWithoutSchema = {
    catalog: options.catalog,
    source: options.source,
    queries: options.queries,
    relationships: options.relationships ?? [],
    ...(options.discoveryMaxDepth !== undefined
      ? { discoveryMaxDepth: options.discoveryMaxDepth }
      : {}),
  };

  return {
    schemaVersion: "1.0",
    schemaHash,
    reviewSourceHash: reviewSourceHash(schemaHash, optionsWithoutSchema),
    ...(options.discoveryMaxDepth !== undefined
      ? { discoveryMaxDepth: options.discoveryMaxDepth }
      : {}),
    catalog: options.catalog,
    source: options.source,
    relationships: options.relationships ?? [],
    querySelections: options.queries,
    queries,
    issues: [...issues, ...queries.flatMap((query) => query.issues)],
  };
}

const CURATED_IDENTITY_ARGUMENT =
  /^(?:tenant|user|viewer|account|organization|workspace|session)(?:id|ids)?$/i;

/**
 * Compiles a deliberately scoped GraphQL Query API without making the host
 * repeat operation/argument/field decisions that its schema has already
 * expressed. This is an explicit whole-schema approval, fingerprinted through
 * the normal review artifacts — it never grants mutations, raw GraphQL, or
 * model-controlled identity.
 */
export function compileCuratedGraphQlCatalog(
  options: CuratedGraphQlCatalogOptions,
): CuratedGraphQlCatalogResult {
  const discoveryMaxDepth = options.discoveryMaxDepth ?? 4;
  const maximumSelectionDepth = options.policy.maximumSelectionDepth ?? discoveryMaxDepth;
  const maximumSelectedFields = options.policy.maximumSelectedFields ?? 100;
  const scalarMappings = { ...(options.scalarMappings ?? {}) };
  const semanticTypeOverrides = options.semanticTypeOverrides ?? {};
  const discovery = listGraphQlQueries(options.schema, {
    maximumDiscoveryDepth: discoveryMaxDepth,
    scalarMappings,
  });
  const supported = discovery.filter((query) => query.support.status === "supported");
  if (supported.length === 0) {
    throw new Error(
      "Curated GraphQL onboarding requires at least one supported root Query field",
    );
  }

  // Apply the host's semantic-type decisions before anything filters on
  // "unknown", so a decided field flows through selection, approval, and the
  // compiled data type exactly as if inference had understood it. Every key
  // must match a discovered field and every value must be a real decision —
  // a typo that silently decided nothing would defeat the review.
  const validOverrideKeys = new Set(
    supported.flatMap((query) =>
      query.outputFields.map((field) => `${query.coordinate}.${field.path}`),
    ),
  );
  for (const [key, value] of Object.entries(semanticTypeOverrides)) {
    if (!validOverrideKeys.has(key)) {
      throw new Error(
        `semanticTypeOverrides names "${key}", which matches no discovered field`,
      );
    }
    if (value === "unknown") {
      throw new Error(
        `semanticTypeOverrides maps "${key}" to "unknown" — omit the key instead`,
      );
    }
  }
  const decided = supported.map((query) => ({
    ...query,
    outputFields: query.outputFields.map((field) => {
      const override = semanticTypeOverrides[`${query.coordinate}.${field.path}`];
      return override ? { ...field, semanticType: override } : field;
    }),
  }));

  /**
   * Queries a shared limit put out of reach, with the reason.
   *
   * A limit is not a safety property, and treating it as one made the curated
   * path unusable at real schema size: one field-heavy type — a `stock` with
   * 221 fields, in an 86-query schema where nobody asked for it — aborted the
   * entire catalog and forced the host onto field-by-field review of
   * everything. Excluding that query and naming it keeps the other 85.
   *
   * Recorded, never silent: an exclusion nobody is told about is the failure
   * mode this whole path exists to avoid. Identity-like arguments and
   * unresolved semantic types stay hard failures, because those are claims
   * about what the data means and who may see it, not budgets.
   */
  const excluded: GraphQlDiscoveryIssue[] = [];
  const selections: GraphQlQueryReviewSelection[] = decided.flatMap((query) => {
    const identityArgument = query.arguments.find((argument) =>
      CURATED_IDENTITY_ARGUMENT.test(argument.name),
    );
    if (identityArgument) {
      throw new Error(
        `Curated GraphQL API query "${query.fieldName}" exposes identity-like argument "${identityArgument.name}". Enforce that scope in the resolver/session or use detailed review.`,
      );
    }
    const fields = query.outputFields.filter((field) => field.semanticType !== "unknown");
    if (fields.length === 0) {
      throw new Error(
        `Curated GraphQL API query "${query.fieldName}" has no semantically understood output fields. Add standard scalar types/descriptions or provide scalar mappings.`,
      );
    }
    if (fields.length > maximumSelectedFields) {
      excluded.push({
        severity: "error",
        path: query.coordinate,
        message: `Query "${query.fieldName}" exposes ${fields.length} fields, over the shared maximumSelectedFields of ${maximumSelectedFields}, and is excluded from this catalog. Raise the limit to include it, or register it through detailed review with a chosen subset of its fields.`,
      });
      return [];
    }
    const selectedDepth = Math.max(...fields.map((field) => field.depth));
    if (selectedDepth > maximumSelectionDepth) {
      excluded.push({
        severity: "error",
        path: query.coordinate,
        message: `Query "${query.fieldName}" selects fields ${selectedDepth} levels deep, over the shared maximumSelectionDepth of ${maximumSelectionDepth}, and is excluded from this catalog. Two separate limits reject a deep field and both must clear it: \`inventory --depth <n>\`, which decides what discovery records at all, and this capability's \`limits.maximumSelectionDepth\` in the decisions file. Raise whichever is lower, or register the query through detailed review.`,
      });
      return [];
    }
    return [{
      fieldName: query.fieldName,
      capabilityId: `graphql.${query.fieldName}`,
      purpose:
        query.description ?? `Retrieve ${query.fieldName} from the host GraphQL API.`,
      dataTypeId: query.fieldName,
      dataTypeDescription: `Data returned by the curated GraphQL query ${query.coordinate}.`,
      resultShape: query.suggestedResultShape,
      ...(fields.some((field) => field.path === "id") ? { matchKey: "id" } : {}),
      fields: Object.fromEntries(
        fields.map((field) => [
          field.path,
          {
            label: field.label,
            ...(field.description ? { description: field.description } : {}),
            semanticType: field.semanticType,
          },
        ]),
      ),
      scalarMappings,
    }];
  });

  if (selections.length === 0) {
    throw new Error(
      `No query in this curated GraphQL API fits the shared limits (maximumSelectedFields ${maximumSelectedFields}, maximumSelectionDepth ${maximumSelectionDepth}): ${excluded
        .map((issue) => issue.message)
        .join(" ")}`,
    );
  }

  const inventory = createGraphQlCatalogInventory({
    schema: options.schema,
    catalog: options.catalog,
    source: options.source,
    queries: selections,
    discoveryMaxDepth,
  });
  const decisions: GraphQlCatalogDecisions = {
    schemaVersion: "1.0",
    reviewSourceHash: inventory.reviewSourceHash,
    // Only the queries that survived the limits above. An excluded query has no
    // selection to approve, and approving one anyway would name a capability
    // the catalog does not contain.
    queries: decided.flatMap((query) => {
      const selection = selections.find((entry) => entry.fieldName === query.fieldName);
      if (!selection) return [];
      const approvedFields = query.outputFields
        .filter((field) => field.semanticType !== "unknown")
        .map((field) => field.path);
      return [{
        capabilityId: selection.capabilityId,
        approvedVisitorArguments: query.arguments.map((argument) => argument.name),
        identityArguments: {},
        approvedOutputFields: approvedFields,
        requiredOutputFields: approvedFields.includes("id") ? ["id"] : [],
        policy: {
          authentication: options.policy.authentication,
          ...(options.policy.requiredPermissions?.length
            ? { requiredPermissions: [...options.policy.requiredPermissions] }
            : {}),
          maximumRows: options.policy.maximumRows,
          ...(options.policy.maximumPageSize !== undefined
            ? { maximumPageSize: options.policy.maximumPageSize }
            : {}),
          timeoutMs: options.policy.timeoutMs,
          ...(options.policy.cacheTtlSeconds !== undefined
            ? { cacheTtlSeconds: options.policy.cacheTtlSeconds }
            : {}),
        },
        limits: {
          maximumSelectionDepth,
          maximumSelectedFields,
          ...(options.policy.freshnessMaximumAgeSeconds !== undefined
            ? { freshnessMaximumAgeSeconds: options.policy.freshnessMaximumAgeSeconds }
            : {}),
        },
      }];
    }),
  };
  const compiled = compileApprovedGraphQlCatalog(options.schema, inventory, decisions);
  const includedFieldNames = new Set(selections.map((entry) => entry.fieldName));
  const excludedUnknownFields = decided
    .filter((query) => includedFieldNames.has(query.fieldName))
    .flatMap((query) =>
    query.outputFields
      .filter((field) => field.semanticType === "unknown")
      .map((field) => ({ query, field })),
  );
  return {
    ...compiled,
    issues: [
      ...compiled.issues,
      ...excludedUnknownFields.map(({ query, field }) => ({
        severity: "warning" as const,
        path: `${query.coordinate}.${field.path}`,
        message:
          "Field is exposed by the curated API but omitted until its semantic type is clear.",
      })),
      // Whole queries the shared limits put out of reach. Errors rather than
      // warnings: a query the host expected to be there and is not is a
      // different order of surprise from a single omitted field.
      ...excluded,
    ],
    needsSemanticType: excludedUnknownFields.map(({ query, field }) => ({
      key: `${query.coordinate}.${field.path}`,
      coordinate: query.coordinate,
      fieldName: query.fieldName,
      path: field.path,
      label: field.label,
      type: field.type,
      ...(field.description ? { description: field.description } : {}),
    })),
  };
}

/**
 * Whether any approved path passes through a field whose type is the row's
 * own type — the structural signature of a parent (or child) reference.
 * Approving `parent.id` walks `parent: Category` on a `Category` row and
 * matches at the first segment; a flat projection of scalars never does.
 */
function projectionReferencesOwnType(
  rowType: GraphQLObjectType | GraphQLInterfaceType,
  approvedPaths: readonly string[],
): boolean {
  for (const path of approvedPaths) {
    let current: GraphQLNamedType = rowType;
    for (const segment of path.split(".")) {
      if (!isObjectType(current) && !isInterfaceType(current)) break;
      const fieldDefinition: GraphQLField<unknown, unknown> | undefined =
        current.getFields()[segment];
      if (!fieldDefinition) break;
      const named: GraphQLNamedType = getNamedType(fieldDefinition.type);
      if (named.name === rowType.name) return true;
      current = named;
    }
  }
  return false;
}

/**
 * Says exactly how two definitions of one data type disagree.
 *
 * The field-set difference is the overwhelmingly common cause — two decisions
 * of the same node type selecting different fields — and the fix is per-field,
 * so the fields are what the error must name. When the field sets match, the
 * differing field definitions (or, failing that, the non-field detail) are
 * named instead; "they differ" with no location is a pairwise manual diff.
 */
function dataTypeConflictDetail(
  ownerId: string,
  existing: DataTypeDescriptor,
  nextId: string,
  next: DataTypeDescriptor,
): string {
  const existingFields = Object.keys(existing.fields);
  const nextFields = Object.keys(next.fields);
  const onlyExisting = existingFields.filter((field) => !nextFields.includes(field));
  const onlyNext = nextFields.filter((field) => !existingFields.includes(field));
  if (onlyExisting.length > 0 || onlyNext.length > 0) {
    return [
      onlyExisting.length > 0
        ? `field(s) only in "${ownerId}": ${onlyExisting.join(", ")}`
        : undefined,
      onlyNext.length > 0
        ? `field(s) only in "${nextId}": ${onlyNext.join(", ")}`
        : undefined,
    ]
      .filter(Boolean)
      .join("; ");
  }
  const differing = existingFields.filter(
    (field) =>
      JSON.stringify(canonicalize(existing.fields[field])) !==
      JSON.stringify(canonicalize(next.fields[field])),
  );
  if (differing.length > 0) {
    return `the same fields are defined differently: ${differing.join(", ")}`;
  }
  return "the definitions differ outside the field set (schema, description, version, or matchKey)";
}

function assertUniqueSubset(
  values: readonly string[],
  allowed: readonly string[],
  label: string,
  capabilityId: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(
        `Decisions repeats ${label} "${value}" for capability "${capabilityId}"`,
      );
    }
    seen.add(value);
    if (!allowed.includes(value)) {
      throw new Error(
        `Decisions selects unknown ${label} "${value}" for capability "${capabilityId}"`,
      );
    }
  }
}

function scalarJsonSchema(
  namedType: GraphQLNamedType,
  mappings: Readonly<Record<string, GraphQlScalarMapping>>,
): JsonSchema {
  if (isEnumType(namedType)) {
    return { type: "string", enum: namedType.getValues().map((value) => value.name) };
  }
  if (!isScalarType(namedType)) {
    throw new Error(`GraphQL type "${namedType.name}" is not a scalar or enum`);
  }
  if (mappings[namedType.name]) return mappings[namedType.name]!.schema;

  switch (namedType.name) {
    case "ID":
    case "String":
      return { type: "string" };
    case "Boolean":
      return { type: "boolean" };
    case "Int":
      return { type: "integer" };
    case "Float":
      return { type: "number" };
    default:
      // Location is annotated by the walkers that know it — this function
      // sees only the type. See `GraphQlScalarMappingError`.
      throw new GraphQlScalarMappingError({ scalarName: namedType.name });
  }
}

function withNullability(schema: JsonSchema, nullable: boolean): JsonSchema {
  return nullable ? { anyOf: [schema, { type: "null" }] } : schema;
}

/**
 * How many times one input object may reappear inside itself.
 *
 * A modern filter API expresses "status is X and (total > Y or created after
 * Z)" with an input type that contains itself — `OrderWhereInput { AND:
 * [OrderWhereInput], OR: [OrderWhereInput], ... }`. Refusing recursion outright
 * made that whole class of API unusable, which is most current GraphQL servers:
 * Saleor's `where`, Hasura, Prisma.
 *
 * Two is a deliberate ceiling rather than a guess at what schemas need. Every
 * level multiplies the planner contract — the type's whole field set appears
 * again inside itself — and the contract is resent on every repair attempt, so
 * depth is paid for repeatedly. Two levels express one nested group, which
 * covers `A AND (B OR C)`; deeper nesting is rarer than the tokens are cheap.
 */
const DEFAULT_MAX_INPUT_RECURSION = 2;

/** See `unprunedInputNotices`. */
const UNPRUNED_INPUT_WARNING_BYTES = 8_192;

/**
 * State threaded through one argument's input walk.
 *
 * `path` exists so a failure can say where it happened: a scalar three levels
 * inside a filter input used to be reported by name alone, and an excluded
 * enum value has to be addressed to the exact location the decisions file keyed.
 */
interface InputWalkContext {
  /** Dotted location of the value being rendered, rooted at the argument name. */
  path: readonly string[];
  /**
   * The same location with self-referential combinator segments elided, which
   * is what `approvedInputFields` paths are written against.
   *
   * `where.AND.sectionSlug` and `where.OR.OR.sectionSlug` are the same column
   * reached through different groupings; a host approving a column means the
   * column, not one route to it. Keeping both walks the tree once while
   * letting errors keep saying where they really happened.
   */
  logicalPath: readonly string[];
  /** Records what the depth budget trimmed. A silent trim is the defect this avoids. */
  trimmed?: string[];
  /**
   * Recursive input types, emitted once and referenced wherever they recur.
   *
   * A filter type that contains itself used to be written out again at every
   * level until the depth budget stopped it — the same fields, the same
   * operator objects, duplicated down every combinator branch. Measured on a
   * real host's catalog that duplication was 93% of the whole planning
   * contract, and it never carried information: it was one type, typed out
   * repeatedly.
   *
   * Keyed by GraphQL type name plus the pruning that applies to it, because
   * `approvedInputFields` is a per-capability decision — two capabilities can
   * approve different fields of the same input type, and one shared definition
   * would be wrong for one of them.
   */
  definitions?: Map<string, JsonSchema>;
  /** Definition names something actually referenced, so unused ones are never emitted. */
  referenced?: Set<string>;
  /**
   * Enum values the decisions file excludes, keyed by dotted path. `used` records
   * which keys matched an enum, so a key that matched nothing can be refused
   * instead of silently excluding no value.
   */
  enumExclusions?: {
    byPath: ReadonlyMap<string, readonly string[]>;
    used: Set<string>;
  };
  /**
   * The decisions file's `approvedInputFields`, resolved for this walk.
   * `arguments` is which argument roots are pruned at all — an argument absent
   * from it keeps its whole tree — and `used` records which declared paths
   * matched, so one that matched nothing can be refused.
   */
  pruning?: {
    declared: ReadonlySet<string>;
    arguments: ReadonlySet<string>;
    used: Set<string>;
  };
}

/**
 * Builds the JSON Schema for one input type.
 *
 * Returns `undefined` when the value cannot be represented at this depth — the
 * caller then omits the field instead of failing. Dropping the recursive branch
 * costs a planner the ability to nest further; failing costs the host the whole
 * capability.
 */
/**
 * A definition's name: the GraphQL type, plus the argument whose pruning shaped
 * it when one applies.
 *
 * `approvedInputFields` is decided per capability, so two capabilities may
 * approve different fields of one input type. Naming a definition after the
 * type alone would let the second capability's schema silently adopt the
 * first's narrower shape, which is a security-shaped bug rather than a
 * cosmetic one — a host's approval is what the name has to carry.
 */
function definitionNameFor(typeName: string, context: InputWalkContext): string {
  const argument = context.logicalPath[0];
  return argument ? `${typeName}__${argument}` : typeName;
}

function inputTypeJsonSchema(
  type: GraphQLInputType,
  mappings: Readonly<Record<string, GraphQlScalarMapping>>,
  ancestors: readonly string[],
  nullable: boolean,
  maximumRecursion: number,
  context: InputWalkContext,
): JsonSchema | undefined {
  if (isNonNullType(type)) {
    return inputTypeJsonSchema(
      type.ofType,
      mappings,
      ancestors,
      false,
      maximumRecursion,
      context,
    );
  }
  if (isListType(type)) {
    const items = inputTypeJsonSchema(
      type.ofType,
      mappings,
      ancestors,
      true,
      maximumRecursion,
      context,
    );
    if (!items) return undefined;
    return withNullability({ type: "array", items }, nullable);
  }
  const namedType = getNamedType(type);
  if (isScalarType(namedType) || isEnumType(namedType)) {
    let schema: JsonSchema;
    try {
      schema = scalarJsonSchema(namedType, mappings);
    } catch (error) {
      throw locateScalarMappingError(error, { path: context.path.join(".") });
    }
    if (isEnumType(namedType)) {
      schema = withEnumExclusions(schema, namedType, context);
    }
    return withNullability(schema, nullable);
  }
  if (!isInputObjectType(namedType)) throw new Error("Unsupported GraphQL input type");
  const seen = ancestors.filter((name) => name === namedType.name).length;
  if (seen > 0 && context.definitions) {
    // The type contains itself. Point at the definition the outer frame is
    // building rather than expanding a second copy of it — that is the whole
    // saving, and it costs no expressiveness: a reference nests without limit
    // where the depth budget used to stop at two.
    const name = definitionNameFor(namedType.name, context);
    context.referenced?.add(name);
    return withNullability({ $ref: `#/$defs/${name}` } as JsonSchema, nullable);
  }
  if (seen >= maximumRecursion) {
    context.trimmed?.push(`${[...ancestors, namedType.name].join(" > ")}`);
    return undefined;
  }

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const nested = [...ancestors, namedType.name];
  const pruning = context.pruning;
  const prunedHere =
    pruning !== undefined &&
    context.logicalPath.length > 0 &&
    pruning.arguments.has(context.logicalPath[0]!);
  for (const field of Object.values(namedType.getFields())) {
    // A combinator nests the type it lives on. It carries no column of its
    // own, so it consumes no segment of the logical path and is never itself
    // approved or pruned: it survives exactly as long as something approved
    // survives beneath it, which the empty-object check below decides.
    const isCombinator = getNamedType(field.type) === namedType;
    const logicalPath = isCombinator
      ? context.logicalPath
      : [...context.logicalPath, field.name];
    const isRequired = isNonNullType(field.type) && field.defaultValue === undefined;
    let childPruning = context.pruning;
    if (prunedHere && !isCombinator) {
      const key = logicalPath.join(".");
      const reached = pruning!.declared.has(key);
      const deeper = [...pruning!.declared].some((declared) => declared.startsWith(`${key}.`));
      if (reached) pruning!.used.add(key);
      // An approved path names a field, and a field arrives with its shape.
      // Payload wraps every column in an operator object — `sectionSlug:
      // String_Operator { equals, in, exists, … }` — so a prune that kept
      // descending would find no approved path inside one, empty it, and drop
      // the column it was told to keep. Declaring a deeper path (`where.x.eq`)
      // is how a host narrows *within* a field; short of that, approving the
      // field approves the operators on it.
      if (reached && !deeper) childPruning = undefined;
      if (!reached && !deeper) {
        // Pruning a required field leaves an object that accepts nothing the
        // upstream will take, so it fails here rather than at execution — the
        // same rule the depth budget applies a few lines down, for the same
        // reason.
        if (isRequired) {
          throw new Error(
            `approvedInputFields prunes "${key}", which GraphQL input object ` +
              `"${namedType.name}" requires. Approve it, or drop ` +
              `"${context.logicalPath[0]}" from approvedVisitorArguments.`,
          );
        }
        continue;
      }
    }
    const schema = inputTypeJsonSchema(
      field.type,
      mappings,
      nested,
      true,
      maximumRecursion,
      (() => {
        const { pruning: _dropped, ...rest } = context;
        return {
          ...rest,
          path: [...context.path, field.name],
          logicalPath,
          ...(childPruning ? { pruning: childPruning } : {}),
        };
      })(),
    );
    if (!schema) {
      // A *required* field that cannot be represented makes the whole object
      // unusable — every value the planner could build would be rejected
      // upstream — so that is still a hard failure, named precisely.
      if (isRequired) {
        throw new Error(
          `GraphQL input object "${namedType.name}" requires field "${field.name}", whose type nests deeper than the supported input recursion depth of ${maximumRecursion}`,
        );
      }
      continue;
    }
    properties[field.name] = schema;
    if (isRequired) required.push(field.name);
  }

  // Every field dropped: the object would accept nothing but an empty value,
  // which is worse than saying so.
  if (Object.keys(properties).length === 0) return undefined;

  const built: JsonSchema = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };

  // Something below referenced this type, so it is recursive: store it once as
  // a definition and hand back a reference. A type nothing referenced is not
  // recursive and is returned inline exactly as before — a non-recursive schema
  // comes out byte-identical to what it was.
  const definitionName = definitionNameFor(namedType.name, context);
  if (context.definitions && context.referenced?.has(definitionName)) {
    context.definitions.set(definitionName, built);
    return withNullability({ $ref: `#/$defs/${definitionName}` } as JsonSchema, nullable);
  }

  return withNullability(built, nullable);
}

/**
 * Applies the decisions file's `excludeEnumValues` to one rendered enum.
 *
 * Stripping happens here — in the schema the planner reads and preflight
 * validates against — so an excluded value is not merely discouraged, it is
 * outside the contract. The general remedy for enum values with runtime
 * preconditions the schema cannot express (a sort key valid only when a
 * search argument is present, and its kin): a schema-legal plan naming one
 * used to fail only at execution.
 */
function withEnumExclusions(
  schema: JsonSchema,
  namedType: GraphQLEnumType,
  context: InputWalkContext,
): JsonSchema {
  const exclusions = context.enumExclusions;
  if (!exclusions) return schema;
  const key = context.path.join(".");
  const excluded = exclusions.byPath.get(key);
  if (excluded === undefined) return schema;
  exclusions.used.add(key);
  const declared = namedType.getValues().map((value) => value.name);
  const unknown = excluded.filter((value) => !declared.includes(value));
  if (unknown.length > 0) {
    throw new Error(
      `excludeEnumValues at "${key}" names ${unknown
        .map((value) => `"${value}"`)
        .join(", ")}, which enum ${namedType.name} does not declare. ` +
        `Declared values: ${declared.join(", ")}`,
    );
  }
  const kept = declared.filter((value) => !excluded.includes(value));
  if (kept.length === 0) {
    throw new Error(
      `excludeEnumValues at "${key}" removes every value of enum ${namedType.name}; ` +
        "drop the argument from approvedVisitorArguments instead",
    );
  }
  return { type: "string", enum: kept };
}

/** `inputTypeJsonSchema` for a top-level argument, where omission is not an option. */
/**
 * Says so when an argument takes an opaque identifier.
 *
 * The semantic type an output field carries was dropped on the way into the
 * input schema: an argument arrived at the planner as `{type: "string"}`, with
 * nothing to distinguish an opaque key from a number a visitor can say out
 * loud. So a plan answered "open order 2486" by putting `2486` where a global
 * id belongs, and the upstream rejected it — the same shape on every API with
 * opaque keys, which is most of them.
 *
 * `ID` is the signal, and it is the GraphQL specification's own: an ID is
 * "not intended to be human-readable". That makes this a fact about the schema
 * rather than a guess about one vendor's format — nothing here parses, decodes,
 * or constructs an identifier, it only labels the argument as one.
 */
function isOpaqueIdentifierArgument(type: GraphQLInputType): boolean {
  return getNamedType(type).name === "ID";
}

const OPAQUE_IDENTIFIER_NOTE =
  "Opaque identifier. Values come only from data already returned to this " +
  "visitor — never from their wording, which never contains one. To find a " +
  "record the visitor named, filter a collection capability instead.";

function argumentJsonSchema(
  argumentName: string,
  type: GraphQLInputType,
  mappings: Readonly<Record<string, GraphQlScalarMapping>>,
  trimmed?: string[],
  enumExclusions?: InputWalkContext["enumExclusions"],
  pruning?: InputWalkContext["pruning"],
  definitions?: Map<string, JsonSchema>,
): JsonSchema {
  const schema = inputTypeJsonSchema(type, mappings, [], true, DEFAULT_MAX_INPUT_RECURSION, {
    path: [argumentName],
    logicalPath: [argumentName],
    ...(trimmed ? { trimmed } : {}),
    ...(enumExclusions ? { enumExclusions } : {}),
    ...(pruning ? { pruning } : {}),
    ...(definitions ? { definitions, referenced: new Set<string>() } : {}),
  });
  if (!schema) {
    throw new Error(
      `GraphQL argument "${argumentName}" of type "${type.toString()}" cannot be expressed as an approved input: it nests deeper than the supported input recursion depth of ${DEFAULT_MAX_INPUT_RECURSION}`,
    );
  }
  // On the schema the planner reads, because that is the only place it can act
  // on. A host's own description, if the schema carried one, is kept ahead of
  // this rather than replaced.
  if (isOpaqueIdentifierArgument(type)) {
    const existing = typeof schema.description === "string" ? `${schema.description} ` : "";
    return { ...schema, description: `${existing}${OPAQUE_IDENTIFIER_NOTE}` };
  }
  return schema;
}

interface SelectionTree {
  selected: boolean;
  children: Map<string, SelectionTree>;
}

/** Re-indents an already-printed selection so nesting stays readable. */
function indentSelection(selection: string, extraSpaces: number): string {
  const pad = " ".repeat(extraSpaces);
  return selection
    .split("\n")
    .map((line) => (line.length > 0 ? `${pad}${line}` : line))
    .join("\n");
}

function buildSelectionTree(paths: readonly string[]): SelectionTree {
  const root: SelectionTree = { selected: false, children: new Map() };
  paths.forEach((path) => {
    let current = root;
    path.split(".").forEach((segment) => {
      const child = current.children.get(segment) ?? {
        selected: false,
        children: new Map<string, SelectionTree>(),
      };
      current.children.set(segment, child);
      current = child;
    });
    current.selected = true;
  });
  return root;
}

function outputTypeJsonSchema(
  type: GraphQLOutputType,
  selection: SelectionTree,
  mappings: Readonly<Record<string, GraphQlScalarMapping>>,
  nullable = true,
  /** Dotted location being rendered, so a scalar failure can say where. */
  path: readonly string[] = [],
): JsonSchema {
  if (isNonNullType(type)) {
    return outputTypeJsonSchema(type.ofType, selection, mappings, false, path);
  }
  if (isListType(type)) {
    return withNullability(
      {
        type: "array",
        items: outputTypeJsonSchema(type.ofType, selection, mappings, true, path),
      },
      nullable,
    );
  }
  const namedType = getNamedType(type);
  if (isScalarType(namedType) || isEnumType(namedType)) {
    try {
      return withNullability(scalarJsonSchema(namedType, mappings), nullable);
    } catch (error) {
      throw locateScalarMappingError(error, { path: path.join(".") });
    }
  }
  if (!isObjectType(namedType) && !isInterfaceType(namedType)) {
    throw new Error(`Unsupported GraphQL output type "${namedType.name}"`);
  }

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  selection.children.forEach((child, fieldName) => {
    const field = namedType.getFields()[fieldName];
    if (!field)
      throw new Error(`Unknown selected field "${namedType.name}.${fieldName}"`);
    properties[fieldName] = outputTypeJsonSchema(field.type, child, mappings, true, [
      ...path,
      fieldName,
    ]);
    if (isNonNullType(field.type)) required.push(fieldName);
  });
  return withNullability(
    {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    nullable,
  );
}

function stripRootNullable(schema: JsonSchema): JsonSchema {
  const variants = Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (!variants) return schema;
  const nonNull = variants.find(
    (candidate) => isRecord(candidate) && candidate.type !== "null",
  );
  return isRecord(nonNull) ? nonNull : schema;
}

function dataTypeSchemaForOutput(
  outputSchema: JsonSchema,
  shape: ResultShape,
): JsonSchema {
  if (
    (shape === "collection" ||
      shape === "media-collection" ||
      shape === "search-results") &&
    outputSchema.type === "array" &&
    isRecord(outputSchema.items)
  ) {
    return stripRootNullable(outputSchema.items);
  }
  return outputSchema;
}

function inputSchemaFor(
  field: GraphQLField<unknown, unknown>,
  visitorArguments: readonly string[],
  mappings: Readonly<Record<string, GraphQlScalarMapping>>,
  trimmed?: string[],
  pagingCap?: number,
  excludeEnumValues?: Readonly<Record<string, readonly string[]>>,
  pagingCapArguments: readonly string[] = ["first", "last"],
  approvedInputFields?: readonly string[],
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  // Recursive input types, collected across every argument of this field so a
  // type reached through two of them is written once.
  const definitions = new Map<string, JsonSchema>();
  const enumExclusions = excludeEnumValues
    ? {
        byPath: new Map(Object.entries(excludeEnumValues)),
        used: new Set<string>(),
      }
    : undefined;
  const pruning =
    approvedInputFields && approvedInputFields.length > 0
      ? {
          declared: new Set(approvedInputFields),
          // Only the arguments a host actually named are pruned. Deny-by-default
          // applies *within* an argument someone took a position on; silently
          // emptying the arguments they said nothing about would delete
          // approvals rather than narrow them.
          arguments: new Set(
            approvedInputFields.map((path) => path.split(".")[0]!),
          ),
          used: new Set<string>(),
        }
      : undefined;
  visitorArguments.forEach((argumentName) => {
    const argument = field.args.find((candidate) => candidate.name === argumentName);
    if (!argument)
      throw new Error(`Unknown GraphQL argument "${field.name}.${argumentName}"`);
    properties[argumentName] = argumentJsonSchema(
      argumentName,
      argument.type,
      mappings,
      trimmed,
      enumExclusions,
      pruning,
      definitions,
    );
    if (isNonNullType(argument.type) && argument.defaultValue === undefined) {
      required.push(argumentName);
    }
  });
  // A key that matched no enum excluded nothing, and the host who wrote it is
  // relying on the exclusion. A typo must fail the compile, not the runtime.
  if (enumExclusions) {
    const unused = [...enumExclusions.byPath.keys()].filter(
      (key) => !enumExclusions.used.has(key),
    );
    if (unused.length > 0) {
      throw new Error(
        `excludeEnumValues names ${unused
          .map((key) => `"${key}"`)
          .join(", ")}, which match${unused.length === 1 ? "es" : ""} no enum on ` +
          `the approved arguments of "${field.name}". Keys are dotted paths rooted ` +
          `at an approved argument name, e.g. "sortBy.field".`,
      );
    }
  }
  // Same rule as the unused enum key above: a path that matched no input field
  // pruned nothing, and the host who wrote it believes it did. A typo here
  // silently widens what a plan may set, which is the direction that matters.
  if (pruning) {
    const unmatched = [...pruning.declared].filter((path) => !pruning.used.has(path));
    if (unmatched.length > 0) {
      throw new Error(
        `approvedInputFields names ${unmatched
          .map((path) => `"${path}"`)
          .join(", ")}, which match${unmatched.length === 1 ? "es" : ""} no input field ` +
          `reachable from the approved arguments of "${field.name}". Paths are dotted, ` +
          `rooted at an approved argument name (e.g. "where.sectionSlug"), and skip ` +
          `self-nesting combinators like AND/OR.`,
      );
    }
  }
  // The page cap, stated where the planner can see it and the validator can
  // enforce it. `connectionPagingParams` clamps a `first` this package derives
  // itself, but deliberately never one the planner set — an approved argument
  // the planner filled is a decision. With the schema unbounded, that decision
  // could be `first: 1000` against an upstream that caps at 100: valid at plan
  // time, rejected outright at execution. Bounding it here means the contract
  // tells the model the ceiling up front, and an inventory that ignores it fails
  // validation into the repair loop instead of burning the visitor's request.
  if (pagingCap !== undefined) {
    for (const pageArgument of pagingCapArguments) {
      const existing = properties[pageArgument];
      if (existing && typeof existing === "object") {
        properties[pageArgument] = { ...existing, minimum: 1, maximum: pagingCap };
      }
    }
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
    // At the root of this capability's own params, so the schema stays a
    // document that resolves standalone — preflight validates it on its own,
    // with no contract around it.
    ...(definitions.size > 0
      ? { $defs: Object.fromEntries(definitions) as Record<string, JsonSchema> }
      : {}),
  };
}

/**
 * Names an approved argument whose compiled input tree is large and unpruned.
 *
 * A warning, and only ever a warning: which columns a visitor may filter on is
 * a decision about what the site exposes, and inferring it from what the
 * capability happens to project would quietly approve input the host never
 * looked at. So this names the argument, states the cost, and names the
 * candidates — the same posture discovery takes on a list envelope, where it
 * can see the shape and still refuses to choose.
 *
 * The threshold is in serialized bytes because that is what the contract
 * costs. 8KB is roughly 2,000 tokens, which is the size of a whole capability's
 * useful contract in the measured case — an argument alone reaching it is the
 * point where somebody should decide.
 */
function unprunedInputNotices(
  inputSchema: JsonSchema,
  approvedVisitorArguments: readonly string[],
  approvedInputFields: readonly string[] | undefined,
): string[] {
  const pruned = new Set(
    (approvedInputFields ?? []).map((path) => path.split(".")[0]!),
  );
  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : undefined;
  if (!properties) return [];
  const notices: string[] = [];
  for (const argumentName of approvedVisitorArguments) {
    if (pruned.has(argumentName)) continue;
    const rendered = properties[argumentName];
    if (!isRecord(rendered)) continue;
    const bytes = JSON.stringify(rendered).length;
    if (bytes < UNPRUNED_INPUT_WARNING_BYTES) continue;
    const candidates = Object.keys(
      (isRecord(stripRootNullable(rendered).properties)
        ? stripRootNullable(rendered).properties
        : {}) as Record<string, unknown>,
    );
    notices.push(
      `Approved argument "${argumentName}" compiles to ${bytes.toLocaleString()} bytes of ` +
        `input schema, which the planner is sent on every attempt. Narrow it with ` +
        `approvedInputFields — dotted paths rooted at the argument name — if a visitor ` +
        `does not need all of it` +
        (candidates.length > 0
          ? `. Its fields: ${candidates.slice(0, 12).join(", ")}` +
            (candidates.length > 12 ? `, and ${candidates.length - 12} more.` : ".")
          : ".") +
        ` Nothing is pruned until you say so.`,
    );
  }
  return notices;
}

function fieldDescriptorsFor(
  approvedPaths: readonly string[],
  candidates: readonly GraphQlOutputFieldCandidate[],
  configured: Readonly<Record<string, FieldDescriptor>>,
): Record<string, FieldDescriptor> {
  const result: Record<string, FieldDescriptor> = {};
  approvedPaths.forEach((path) => {
    const candidate = candidates.find((entry) => entry.path === path);
    if (!candidate) return;
    const descriptor = configured[path] ?? {
      label: candidate.label,
      ...(candidate.description ? { description: candidate.description } : {}),
      semanticType: candidate.semanticType,
    };
    result[path] = descriptor;
    const topLevel = path.split(".")[0]!;
    if (!result[topLevel]) {
      result[topLevel] =
        path === topLevel
          ? descriptor
          : {
              label: titleForField(topLevel),
              description: `Approved nested GraphQL field group for ${topLevel}.`,
              semanticType: "unknown",
            };
    }
  });
  return result;
}

function operationNameFor(capabilityId: string): string {
  const safe = capabilityId
    .replace(/[^_0-9A-Za-z]/g, "_")
    .replace(/^([^A-Za-z_])/, "_$1");
  return `View_${safe}`;
}

function decisionsFor(
  decisions: GraphQlCatalogDecisions,
  capabilityId: string,
): GraphQlQueryDecisions {
  const matches = decisions.queries.filter((entry) => entry.capabilityId === capabilityId);
  if (matches.length !== 1) {
    throw new Error(
      `Decisions must contain exactly one selection for capability "${capabilityId}"; ` +
        `found ${matches.length}. A capability is dropped where the inventory is ` +
        `produced, not here: re-run inventory with --queries naming the root fields ` +
        `you want, which is an allowlist rather than a drop list, then review the ` +
        `smaller inventory.`,
    );
  }
  return matches[0]!;
}

export function compileApprovedGraphQlCatalog(
  schemaInput: GraphQlSchemaInput,
  inventory: GraphQlCatalogInventory,
  decisionsInput: unknown,
): CompiledGraphQlCatalog {
  const decisions = GraphQlCatalogDecisionsSchema.parse(decisionsInput);
  const schemaHash = hashGraphQlSchema(schemaInput);
  const expectedReviewHash = reviewSourceHash(schemaHash, {
    catalog: inventory.catalog,
    source: inventory.source,
    queries: inventory.querySelections,
    relationships: inventory.relationships,
    ...(inventory.discoveryMaxDepth !== undefined
      ? { discoveryMaxDepth: inventory.discoveryMaxDepth }
      : {}),
  });
  // Three distinct faults, told apart. They were one message — "the decisions do
  // not match the reviewed schema" — which named the schema even when the schema
  // was byte-identical, and sent a host looking for an upstream change that had
  // not happened. Adding one custom scalar mapping produces the third case.
  if (schemaHash !== inventory.schemaHash) {
    throw new Error(
      "GraphQL review drift: this schema is not the one the inventory was taken " +
        `from (schema ${schemaHash}, inventory expects ${inventory.schemaHash}). ` +
        "Either --schema points at a different file, or the upstream changed. Take " +
        "the inventory again over the current schema, then `diff` it against these " +
        "decisions: it names what actually needs deciding.",
    );
  }
  if (expectedReviewHash !== inventory.reviewSourceHash) {
    throw new Error(
      "GraphQL review drift: the inventory file has been edited since it was " +
        "written. Its hash covers the selections, so the file no longer matches " +
        "itself. Take the inventory again — and to correct a result shape, set " +
        '"resultShape" on the capability in your decisions file, which is the one ' +
        "meant to be edited.",
    );
  }
  if (decisions.reviewSourceHash !== inventory.reviewSourceHash) {
    throw new Error(
      "GraphQL review drift: these decisions were made against a different " +
        `inventory (decisions ${decisions.reviewSourceHash}, inventory ` +
        `${inventory.reviewSourceHash}). The schema itself is unchanged, so this ` +
        "is usually an inventory taken with different options — a scalar mapping, " +
        "--queries, or --depth. Run `diff`: if nothing you decided is affected it " +
        "will say so, and `migrate --inventory` re-binds the file without " +
        "repeating the review.",
    );
  }
  if (
    new Set(decisions.queries.map((entry) => entry.capabilityId)).size !==
    decisions.queries.length
  ) {
    throw new Error("GraphQL decisions contain duplicate capability selections");
  }

  const schema = loadGraphQlSchema(schemaInput);
  const capabilities: CapabilityCatalog["capabilities"] = [];
  const dataTypes = new Map<string, DataTypeDescriptor>();
  // Which capability first defined each data type, so a conflict can name
  // both parties instead of leaving a 24-capability catalog to pairwise diff.
  const dataTypeOwners = new Map<string, string>();
  const bindings = new Map<string, GraphQlOperationBinding>();
  const issues: GraphQlDiscoveryIssue[] = [...inventory.issues];
  const semanticTypeOverrides = (decisions.semanticTypeOverrides ??
    {}) as Readonly<Record<string, FieldDescriptor["semanticType"]>>;
  // Collected rather than thrown on. Throwing reported one offender and hid the
  // rest, so a host resolved them one recompile at a time with no idea how many
  // were left.
  const semanticTypeGaps: CuratedSemanticTypeGap[] = [];
  const reviewedCapabilityIds = new Set(
    inventory.querySelections.map((selection) => selection.capabilityId),
  );
  decisions.queries.forEach((entry) => {
    if (!reviewedCapabilityIds.has(entry.capabilityId)) {
      throw new Error(`Decisions selects unknown capability "${entry.capabilityId}"`);
    }
  });

  inventory.querySelections.forEach((selection) => {
    const review = inventory.queries.find(
      (candidate) => candidate.capabilityId === selection.capabilityId,
    );
    if (!review)
      throw new Error(`Review inventory is missing capability "${selection.capabilityId}"`);
    const approved = decisionsFor(decisions, selection.capabilityId);
    // The decisions file wins when it states one: the inventory's value is discovery's
    // inference, and this is the reviewer overruling it.
    const resultShape = approved.resultShape ?? selection.resultShape;
    // Reported when the two disagree, because the losing answer is invisible
    // otherwise. `--shapes` writes the shape into the inventory and a reviewer
    // writes it here, so a host can set it in both places and watch the older
    // one win in silence — with no error, and a rendered view that is merely
    // the wrong kind of thing.
    if (approved.resultShape !== undefined && approved.resultShape !== selection.resultShape) {
      issues.push({
        severity: "warning",
        path: selection.capabilityId,
        message:
          `resultShape: the decisions file says "${approved.resultShape}", the inventory ` +
          `says "${selection.resultShape}". The decisions file wins. If the inventory's ` +
          "value came from --shapes, drop the flag or make the two agree.",
      });
    }
    const availableArguments = review.availableVisitorArguments.map(
      (argument) => argument.name,
    );
    const availableFields = review.availableOutputFields.map((field) => field.path);

    assertUniqueSubset(
      approved.approvedVisitorArguments,
      availableArguments,
      "visitor argument",
      selection.capabilityId,
    );
    assertUniqueSubset(
      Object.keys(approved.identityArguments),
      availableArguments,
      "identity argument",
      selection.capabilityId,
    );
    assertUniqueSubset(
      approved.approvedOutputFields,
      availableFields,
      "output field",
      selection.capabilityId,
    );
    assertUniqueSubset(
      approved.requiredOutputFields,
      approved.approvedOutputFields,
      "required output field",
      selection.capabilityId,
    );

    const overlap = approved.approvedVisitorArguments.filter(
      (argument) => approved.identityArguments[argument] !== undefined,
    );
    if (overlap.length > 0) {
      throw new Error(
        `GraphQL argument(s) cannot be visitor- and identity-controlled: ${overlap.join(", ")}`,
      );
    }

    const field = queryByName(schema, selection.fieldName);
    const approvedPurpose = selection.purpose?.trim() || field.description?.trim();
    if (!approvedPurpose) {
      throw new Error(
        `Capability "${selection.capabilityId}" requires a host-approved business purpose`,
      );
    }
    // The headless CLI writes this exact placeholder when the host supplied no
    // purpose, and nothing downstream ever read it critically — so six
    // capabilities shipped whose planner-facing prose was "Review the purpose
    // of…". That prose is the planner's selection basis: a placeholder does
    // not degrade gracefully, it actively misinforms the model about what the
    // capability is for. Refused here, where every other decisions contradiction
    // is refused, rather than warned about where nobody looks.
    if (approvedPurpose.startsWith("Review the purpose of")) {
      throw new Error(
        `Capability "${selection.capabilityId}" still carries the generated placeholder purpose ` +
          `("${approvedPurpose}"). The planner chooses capabilities by this prose, so publishing it ` +
          `would describe the capability to the model as an unfinished review. Supply the real ` +
          `purposes and take the inventory again: \`inventory --purposes <file>\` with a JSON ` +
          `object keyed by root field, or write them as descriptions in the schema itself. The ` +
          `inventory's hash covers the purpose, so it cannot be patched into an emitted ` +
          `inventory by hand.`,
      );
    }
    const coveredArguments = new Set([
      ...approved.approvedVisitorArguments,
      ...Object.keys(approved.identityArguments),
    ]);
    const missingRequiredArguments = field.args
      .filter(
        (argument) =>
          isNonNullType(argument.type) &&
          argument.defaultValue === undefined &&
          !coveredArguments.has(argument.name),
      )
      .map((argument) => argument.name);
    if (missingRequiredArguments.length > 0) {
      throw new Error(
        `Required GraphQL argument(s) need visitor or identity ownership for "${selection.capabilityId}": ${missingRequiredArguments.join(", ")}`,
      );
    }

    // A required argument the planner may set but cannot know.
    //
    // The check above refuses a required argument nobody owns. This is the
    // case that passes it and still cannot work: `id` approved as a visitor
    // argument, so the planner is invited to set it, with no way to obtain a
    // value. Nothing threads one request's rows into another's params — that
    // mechanism does not exist — so a planner-settable argument can only be
    // filled from the visitor's own words.
    //
    // Numeric and ID arguments are the line, and it is a judgement rather than
    // a rule the schema states. A required `String` is plausibly a search
    // phrase a visitor typed. A required `ID`, `Int` or `Float` is a key: on a
    // live newspaper five such capabilities were published, the planner reached
    // for them, and 6 of 54 composes died after two repair attempts and a
    // 40-second timeout.
    //
    // A warning rather than a refusal, because the legitimate case is real —
    // a visitor does say "order 12345" — and only the host knows whether their
    // identifier is one a reader would ever utter.
    const unknowableArguments = field.args
      .filter((argument) => {
        if (!isNonNullType(argument.type) || argument.defaultValue !== undefined) return false;
        if (!approved.approvedVisitorArguments.includes(argument.name)) return false;
        const named = getNamedType(argument.type);
        return isScalarType(named) && ["ID", "Int", "Float"].includes(named.name);
      })
      .map((argument) => argument.name);
    if (unknowableArguments.length > 0) {
      issues.push({
        path: `${selection.capabilityId}.arguments`,
        severity: "warning",
        message:
          `"${selection.capabilityId}" requires ${unknowableArguments.join(", ")}, approved for ` +
          `the planner to set and impossible for it to obtain: no approved path returns a value ` +
          `it could thread into these, so it can only be filled from what a visitor typed. If a ` +
          `reader would say this value, keep it. If it is a database key, either map it to an ` +
          `identity argument or leave it out of the inventory: re-run inventory with --queries ` +
          `naming the fields you want, which is an allowlist rather than a drop list. Removing ` +
          `it from the decisions file instead fails, because decisions must hold exactly one ` +
          `entry per inventoried capability. Advertised as it stands, the planner will ` +
          `reach for it and fail validation after burning the planning budget. If it ` +
          `is a key a visitor is already looking at, the way through is a component ` +
          `that links from that row and supplies it — not a prompt.`,
      });
    }

    const selectedDepth = Math.max(
      ...approved.approvedOutputFields.map((path) => path.split(".").length),
    );
    if (selectedDepth > approved.limits.maximumSelectionDepth) {
      throw new Error(
        `Approved fields exceed maximum selection depth ${approved.limits.maximumSelectionDepth} for "${selection.capabilityId}". That number is this capability's \`limits.maximumSelectionDepth\` in the decisions file. A field missing from the inventory entirely is the other limit — \`inventory --depth <n>\` — and raising this one alone will not bring it back.`,
      );
    }
    if (approved.approvedOutputFields.length > approved.limits.maximumSelectedFields) {
      throw new Error(
        `Approved fields exceed maximum selected fields ${approved.limits.maximumSelectedFields} for "${selection.capabilityId}"`,
      );
    }

    if (
      (Object.keys(approved.identityArguments).length > 0 ||
        (approved.policy.requiredPermissions?.length ?? 0) > 0) &&
      approved.policy.authentication !== "session"
    ) {
      throw new Error(
        `Capability "${selection.capabilityId}" must use session authentication when identity arguments or permissions are configured`,
      );
    }

    const mappings = selection.scalarMappings ?? {};
    // For a connection or a declared list envelope, the validated shape is an
    // array of rows: that is what the executor delivers once the wrapper is
    // removed, and a schema describing the wrapper would reject every real
    // response.
    const connection = relayConnectionInfo(field.type);
    if (selection.listEnvelope) {
      assertListEnvelopeDeclaration(
        selection.fieldName,
        field,
        selection.listEnvelope,
        mappings,
      );
    }
    const envelope = selection.listEnvelope
      ? rowEnvelopeOf({ listEnvelope: selection.listEnvelope })
      : connection
        ? rowEnvelopeOf({ connection })
        : undefined;
    // The inverse, and the one a real install hit: an envelope declared and a
    // non-list shape kept. Declaring `rowsField` *is* the statement that this
    // returns rows, so the two contradict — and the contradiction is silent
    // until a component refuses to bind, which on a live newspaper was three
    // steps from the cause: 401 articles published as one record, discovered
    // at doctor's verified step as "Component ArticleGrid.rows does not accept
    // Posts as entity".
    // Narrow to the shapes that deliver one record. `time-series`, `metric`,
    // `comparison` and `hierarchy` are legitimate reinterpretations of rows —
    // a reviewer correcting a connection to `time-series` is doing exactly what
    // `--shapes` exists for, and an existing test says so.
    if (envelope && (resultShape === "entity" || resultShape === "document")) {
      throw new Error(
        `Capability "${selection.capabilityId}" declares a listEnvelope on ` +
          `${review.coordinate}, naming "${envelope.rowsField}" as the field holding its rows, ` +
          `but its resultShape is "${resultShape}". An envelope is a collection of those rows: ` +
          `published as "${resultShape}" the whole page becomes one record, and nothing fails ` +
          `until a component declines to bind it. Set resultShape to "collection" on this ` +
          `capability's entry in the decisions file, or drop the listEnvelope if the field ` +
          `really does return a single object.`,
      );
    }

    // A list shape over a root that provably cannot deliver rows compiled
    // before this check and then delivered one object where the runtime counts
    // rows — an invisible dead end three stages from its cause. Refuse here,
    // with the declaration that fixes it.
    if (isListResultShape(selection.resultShape) && !envelope && !unwrapList(field.type)) {
      const namedReturnType = getNamedType(field.type);
      const candidates =
        isObjectType(namedReturnType) || isInterfaceType(namedReturnType)
          ? Object.values(namedReturnType.getFields())
              .filter((candidate) => {
                const named = getNamedType(candidate.type);
                return (
                  unwrapList(candidate.type) &&
                  (isObjectType(named) || isInterfaceType(named))
                );
              })
              .map((candidate) => candidate.name)
          : [];
      throw new Error(
        `Capability "${selection.capabilityId}" declares resultShape "${selection.resultShape}", but ` +
          `${review.coordinate} returns "${namedReturnType.name}", which is neither a list nor a Relay ` +
          `connection — one object would be delivered where the runtime counts rows. If ` +
          `"${namedReturnType.name}" wraps the rows, declare which field holds them on the query ` +
          `selection: listEnvelope: { rowsField: "${candidates[0] ?? "<rows>"}" }. ` +
          (candidates.length > 0
            ? `Candidate list-of-object fields on "${namedReturnType.name}": ${candidates.join(", ")}. `
            : `No list-of-object field was found on "${namedReturnType.name}", so this may simply not be a list. `) +
          `Note a declaration changes approved field paths to row-relative ("title", not "${candidates[0] ?? "rows"}.title").`,
      );
    }
    // Nothing dropped without a record: a filter that quietly nests one level
    // less than the schema allows looks like a planner limitation to whoever
    // debugs it next, and the reason lives here.
    const trimmedInputPaths: string[] = [];
    let rowSchema: JsonSchema;
    let inputSchema: JsonSchema;
    try {
      rowSchema = stripRootNullable(
        outputTypeJsonSchema(
          envelope ? rowTypeOf(field.type, envelope) : field.type,
          buildSelectionTree(approved.approvedOutputFields),
          mappings,
        ),
      );
      inputSchema = inputSchemaFor(
        field,
        approved.approvedVisitorArguments,
        mappings,
        trimmedInputPaths,
        envelope && envelope.pageSizeArgumentName
          ? positivePageSize(approved.policy.maximumPageSize) ??
              DEFAULT_CONNECTION_PAGE_CAP
          : undefined,
        approved.excludeEnumValues,
        envelope?.pageSizeArgumentName
          ? envelope.nodeField
            ? ["first", "last"]
            : [envelope.pageSizeArgumentName]
          : undefined,
        approved.approvedInputFields,
      );
    } catch (error) {
      // The walkers know the path; only this frame knows which capability was
      // being compiled. Both belong in the one error a host acts on.
      throw locateScalarMappingError(error, {
        capabilityId: selection.capabilityId,
        coordinate: review.coordinate,
      });
    }
    const outputSchema = envelope
      ? { type: "array" as const, items: rowSchema }
      : rowSchema;
    for (const notice of unprunedInputNotices(
      inputSchema,
      approved.approvedVisitorArguments,
      approved.approvedInputFields,
    )) {
      issues.push({
        severity: "warning",
        path: `${selection.capabilityId}.input`,
        message: notice,
      });
    }
    for (const path of new Set(trimmedInputPaths)) {
      issues.push({
        severity: "warning",
        path: `${selection.capabilityId}.input`,
        message: `Nested input "${path}" was trimmed at the supported input recursion depth of ${DEFAULT_MAX_INPUT_RECURSION}. A visitor can still express one level of grouping (A AND (B OR C)); a deeper predicate will come back unsupported rather than being sent to the upstream in a narrowed form.`,
      });
    }
    const fieldDescriptors = fieldDescriptorsFor(
      approved.approvedOutputFields,
      // A host decision about a field's meaning is applied here rather than
      // being second-guessed: discovery could not place the scalar, and the host
      // can. Keyed by coordinate so the same field name on two queries can be
      // decided separately.
      review.availableOutputFields.map((field) => {
        const decided = semanticTypeOverrides[`${review.coordinate}.${field.path}`];
        return decided ? { ...field, semanticType: decided } : field;
      }),
      selection.fields ?? {},
    );
    approved.approvedOutputFields.forEach((path) => {
      if (fieldDescriptors[path]?.semanticType === "unknown") {
        const candidate = review.availableOutputFields.find((entry) => entry.path === path);
        semanticTypeGaps.push({
          key: `${review.coordinate}.${path}`,
          coordinate: review.coordinate,
          fieldName: review.fieldName,
          path,
          label: candidate?.label ?? path,
          type: candidate?.type ?? "",
          ...(candidate?.description ? { description: candidate.description } : {}),
        });
      }
    });
    const dataType: DataTypeDescriptor = {
      id: selection.dataTypeId,
      version: selection.dataTypeVersion ?? "1.0.0",
      description:
        selection.dataTypeDescription ??
        `Approved GraphQL output returned by ${review.coordinate}.`,
      schema: dataTypeSchemaForOutput(outputSchema, resultShape),
      fields: fieldDescriptors,
      ...(selection.matchKey ? { matchKey: selection.matchKey } : {}),
    };
    // A hierarchy is a claim about parentage. A projection can carry depth and
    // no parent reference at all, and the renderer then draws indistinguishable
    // siblings under a heading asserting "what sits under what". The check is
    // structural — a projected field whose type is the row's own type is the
    // schema's way of expressing a parent — never a name guess.
    if (resultShape === "hierarchy") {
      const rowType = getNamedType(
        envelope ? rowTypeOf(field.type, envelope) : field.type,
      );
      if (
        (isObjectType(rowType) || isInterfaceType(rowType)) &&
        !projectionReferencesOwnType(rowType, approved.approvedOutputFields)
      ) {
        issues.push({
          severity: "warning",
          path: selection.capabilityId,
          message:
            `Capability "${selection.capabilityId}" declares resultShape "hierarchy" but its ` +
            `approved projection carries no parent reference: no approved field's type is ` +
            `${rowType.name} itself, so a rendered tree cannot express what sits under what. ` +
            `Approve a ${rowType.name}-typed field's subfields where discovery offers them — ` +
            `note discovery's recursion stop excludes self-nested fields (see the exclusion ` +
            `ledger), in which case parentage cannot be projected and "collection" is the ` +
            `honest shape.`,
        });
      }
    }

    const existingDataType = dataTypes.get(dataType.id);
    if (
      existingDataType &&
      JSON.stringify(canonicalize(existingDataType)) !==
        JSON.stringify(canonicalize(dataType))
    ) {
      const owner = dataTypeOwners.get(dataType.id) ?? "an earlier capability";
      throw new Error(
        `Capabilities "${owner}" and "${selection.capabilityId}" produce conflicting ` +
          `definitions for data type "${dataType.id}": ` +
          `${dataTypeConflictDetail(owner, existingDataType, selection.capabilityId, dataType)}. ` +
          `Give one of them its own dataTypeId, or approve identical fields for both.`,
      );
    }
    dataTypes.set(dataType.id, dataType);
    if (!dataTypeOwners.has(dataType.id)) {
      dataTypeOwners.set(dataType.id, selection.capabilityId);
    }

    // `maximumPageSize` is approved alongside the rest of the policy but is not
    // part of it: a page cap is a fact about one GraphQL endpoint's transport,
    // meaningless to a manual or OpenAPI capability, and nothing outside the
    // binding needs it. It travels to the binding below instead.
    const { maximumPageSize: _maximumPageSize, ...capabilityPolicy } = approved.policy;
    const policy: CapabilityPolicy = capabilityPolicy;
    const ordering = orderingPushdownFor(selection.capabilityId, field, approved);
    const paging = pagingRoleFor(selection.capabilityId, field, approved);
    // The derived narrowing facts ride on whichever supports applies: the
    // reviewer's explicit one or the projection-derived default. Without
    // them the planner sees a filter vocabulary that runs after the fetch
    // and nothing saying which approved params narrow at the source.
    const declaredSupports =
      selection.supports ??
      defaultSupportsForApprovedFields(
        resultShape,
        Object.keys(fieldDescriptors),
        outputSchema,
      );
    // One filtering vocabulary per capability, wherever one can do the job.
    //
    // `filterFields` defaults on for every list-shaped capability, so a host
    // who also approves the upstream's filter argument publishes both: the
    // argument in `params`, narrowed by the database, and `query.filter` in
    // this package's own grammar, narrowed here over one fetched page. Nothing
    // reconciled them, the system prompt asked the planner to prefer the first,
    // and the planner picked the second six times on a live newspaper.
    //
    // Where the argument covers every filter field, it wins and the derived
    // default is dropped: it is the capability the host actually granted,
    // reaching nested relation filters and every operator its dialect declares
    // against this package's fourteen. Where it covers only some of them —
    // a `where` with two of the three projected columns, which is ordinary —
    // neither vocabulary dominates, so both stay and the gap is named. Dropping
    // a vocabulary that can express what the other cannot would lose the host
    // real capability to buy a tidier contract.
    const { pushdown: resolvedFilter, ambiguousArguments } = filterPushdownFor(
      field,
      declaredSupports?.filterFields ?? [],
      outputSchema,
      approved,
    );
    const approvedFilterArgument =
      resolvedFilter && approved.approvedVisitorArguments.includes(resolvedFilter.argument)
        ? resolvedFilter.argument
        : undefined;
    const uncoveredFilterFields = (declaredSupports?.filterFields ?? []).filter(
      (name) => !resolvedFilter || !(name in resolvedFilter.fields),
    );
    const argumentCoversFilterFields =
      approvedFilterArgument !== undefined && uncoveredFilterFields.length === 0;
    const reconciledSupports =
      argumentCoversFilterFields && !selection.supports && declaredSupports?.filterFields
        ? (({ filterFields: _dropped, ...rest }) =>
            Object.keys(rest).length > 0 ? rest : undefined)(declaredSupports)
        : declaredSupports;
    // Only for the argument the planner is not given: where the host approved
    // it, the plan writes that dialect itself and there is nothing to compile.
    const filterPushdown = approvedFilterArgument ? undefined : resolvedFilter;
    // The reachable subset, published only when it is a genuine choice: some of
    // the advertised fields narrow at the source and some do not. Covering
    // everything makes `filterFields` the answer already; covering nothing
    // would leave the planner no filter at all, which is a worse contract than
    // a disclosed one and is warned about below instead.
    const sourceFilterFields =
      filterPushdown && uncoveredFilterFields.length > 0
        ? // `declaredSupports` rather than the reconciled one: the reconciliation
          // above only drops `filterFields` when the approved argument covers
          // every one of them, which is the branch this cannot be in.
          (declaredSupports?.filterFields ?? []).filter(
            (name: string) => name in filterPushdown.fields,
          )
        : undefined;
    // What the host declared as never-droppable travels with the capability, so
    // the projection honours it too. The binding already forces these into the
    // fetch selection; nothing downstream could see them, so a plan's own
    // `project` dropped them one layer later.
    const requiredFields =
      approved.requiredOutputFields.length > 0
        ? [...approved.requiredOutputFields]
        : undefined;
    const supports = withSourceNarrowingArguments(
      sourceFilterFields?.length || requiredFields || unknowableArguments.length > 0
        ? {
            ...reconciledSupports,
            ...(sourceFilterFields?.length ? { sourceFilterFields } : {}),
            ...(requiredFields ? { requiredFields } : {}),
            // Carried onto the capability, not just warned about at compile
            // time: a report reading the published catalog cannot otherwise
            // tell a capability no prompt can reach from one that simply has
            // not been asked for, and counts it as covered forever.
            ...(unknowableArguments.length > 0 ? { unknowableArguments } : {}),
          }
        : reconciledSupports,
      sourceNarrowingArgumentNames(
        approved.approvedVisitorArguments,
        // A declared paging role's roots join the envelope's own: `take` and
        // `pagination` choose how much, not which records qualify, and telling
        // the planner otherwise is the exact false claim that list exists to
        // prevent.
        [...(envelope?.pagingArgumentNames ?? []), ...(paging?.arguments ?? [])],
      ),
    );
    if (approvedFilterArgument && !argumentCoversFilterFields) {
      issues.push({
        path: `${selection.capabilityId}.filter`,
        severity: "warning",
        message:
          `Approves "${approvedFilterArgument}" as a visitor argument, but it cannot reach ` +
          `${uncoveredFilterFields.join(", ")} — so the planner keeps both vocabularies and ` +
          `chooses between them, and what it narrows through query.filter runs over one ` +
          `fetched page. Either extend the approved argument to cover those fields, or state ` +
          `filterFields explicitly as the ones it does cover.`,
      });
    } else if (approvedFilterArgument && selection.supports?.filterFields?.length) {
      issues.push({
        path: `${selection.capabilityId}.filter`,
        severity: "warning",
        message:
          `Approves "${approvedFilterArgument}" as a visitor argument and also declares ` +
          `filterFields (${selection.supports.filterFields.join(", ")}) covering the same ` +
          `fields, so the planner is offered two ways to narrow the same data and picks ` +
          `between them. The argument is the fuller one. Drop the explicit filterFields to ` +
          `leave one vocabulary, or drop "${approvedFilterArgument}" from ` +
          `approvedVisitorArguments to keep the cheaper contract and let the runtime compile ` +
          `the plan's conditions into it.`,
      });
    }
    // Said once per capability that advertises a filter vocabulary that cannot
    // reach the source. The planner is told it may filter these fields; the
    // runtime then filters the one page a capped upstream returned, so "the
    // articles about the bill" is those among that page — which on the install
    // that found this was zero of seven, reported as a success.
    if (ambiguousArguments) {
      issues.push({
        path: `${selection.capabilityId}.filter`,
        severity: "warning",
        message:
          `"${selection.fieldName}" has ${ambiguousArguments.length} arguments that could carry ` +
          `the plan's filter (${ambiguousArguments.map((name) => `"${name}"`).join(", ")}), and ` +
          `choosing between them would be a guess about which one the upstream narrows by — a ` +
          `filter sent to the wrong argument is ignored rather than refused. Nothing is pushed: ` +
          `planned filters run here over one fetched page and are reported incomplete. To break ` +
          `the tie, approve the one that filters in approvedVisitorArguments — the planner then ` +
          `writes it directly — and narrow it with approvedInputFields (paths rooted at the ` +
          `argument, e.g. "${ambiguousArguments[0]}.someField") to keep the contract small.`,
      });
    }
    if (supports?.filterFields?.length && !filterPushdown && !ambiguousArguments) {
      issues.push({
        path: `${selection.capabilityId}.filter`,
        severity: "warning",
        message:
          `Advertises filterFields (${supports.filterFields.join(", ")}) but no argument of ` +
          `"${selection.fieldName}" can carry them, so a planned filter runs here over one ` +
          `fetched page rather than at the source. A result narrowed that way is reported ` +
          `incomplete, and an empty one is refused rather than presented as an answer.`,
      });
    } else if (supports?.filterFields?.length && filterPushdown && sourceFilterFields) {
      // Said once per capability whose filter argument reaches some of the
      // advertised fields and not others. The gap was computed before this
      // existed and used only when the host had approved the argument itself,
      // so the ordinary case — a derived push-down with one unreachable path —
      // compiled clean while the planner was offered both and could not tell
      // them apart. The ordering path has warned about its own version of this
      // since sortFields existed.
      issues.push({
        path: `${selection.capabilityId}.filter`,
        severity: "warning",
        message:
          `"${filterPushdown.argument}" on "${selection.fieldName}" cannot reach ` +
          `${uncoveredFilterFields.join(", ")}, so a filter on ${
            uncoveredFilterFields.length === 1 ? "that field" : "those fields"
          } runs here over one fetched page while ${sourceFilterFields.join(", ")} ` +
          `narrow${sourceFilterFields.length === 1 ? "s" : ""} at the source. The planner is ` +
          `offered only the reachable ones; the rest stay available to refinement the host ` +
          `triggers. If a reachable column already answers the same question — a stored ` +
          `projection of a relation is the usual shape — nothing more is needed. If not, ` +
          `either extend the filter argument's approval or drop the unreachable paths from ` +
          `filterFields.`,
      });
    }
    // Said once per capability that can be ordered but cannot push the order
    // upstream, because the consequence is invisible from either side. The
    // planner is told it may sort these fields; the runtime then sorts the one
    // page a capped upstream returned, so "the three most recent" is the three
    // most recent *of that page*. Correct while the page holds everything, and
    // silently not once the collection outgrows it — which is exactly when
    // nobody is re-reading their catalog.
    if (
      supports?.sortFields?.length &&
      !ordering &&
      !hasTypedOrderingPath(field, approved.approvedVisitorArguments)
    ) {
      issues.push({
        severity: "warning",
        path: `${selection.capabilityId}.ordering`,
        message:
          `Capability "${selection.capabilityId}" may be sorted on ` +
          `${supports.sortFields.length} field(s) but nothing can send an ordering to the ` +
          `source, so a sort applies to the fetched page only: a top-N answer is right while ` +
          `the page holds the whole collection and silently wrong once it does not. If ` +
          `${review.fieldName} takes an ordering argument whose grammar its schema cannot ` +
          `express — a bare String is the usual shape — declare it as orderingArgument on this ` +
          `capability's decisions entry. If it takes no ordering argument at all, drop ` +
          `sortFields from supports so the planner stops being offered an ordering nothing can ` +
          `honour.`,
      });
    }
    capabilities.push({
      id: selection.capabilityId,
      version: selection.version ?? "1.0.0",
      purpose: approvedPurpose,
      kind: "query",
      inputSchema,
      outputSchema,
      output: { dataTypeId: selection.dataTypeId, shape: resultShape },
      requiredSessionKeys: [...new Set(Object.values(approved.identityArguments))],
      sourceIds: [inventory.source.id],
      supports,
      policy,
    });

    bindings.set(selection.capabilityId, {
      capabilityId: selection.capabilityId,
      schemaHash,
      fieldName: selection.fieldName,
      operationName: operationNameFor(selection.capabilityId),
      visitorArguments: approved.approvedVisitorArguments,
      identityArguments: approved.identityArguments,
      approvedOutputFields: approved.approvedOutputFields,
      requiredOutputFields: approved.requiredOutputFields,
      scalarMappings: mappings,
      maximumSelectionDepth: approved.limits.maximumSelectionDepth,
      maximumSelectedFields: approved.limits.maximumSelectedFields,
      ...(approved.limits.freshnessMaximumAgeSeconds !== undefined
        ? { freshnessMaximumAgeSeconds: approved.limits.freshnessMaximumAgeSeconds }
        : {}),
      ...(connection ? { connection } : {}),
      ...(selection.listEnvelope ? { listEnvelope: selection.listEnvelope } : {}),
      ...(approved.policy.maximumPageSize !== undefined
        ? { maximumPageSize: approved.policy.maximumPageSize }
        : {}),
      ...(ordering ? { ordering } : {}),
      ...(filterPushdown ? { filter: filterPushdown } : {}),
      ...(paging ? { paging } : {}),
      sourceId: inventory.source.id,
    });
  });

  const catalog = assertCapabilityCatalog({
    schemaVersion: "1.0",
    id: inventory.catalog.id,
    version: inventory.catalog.version,
    description: inventory.catalog.description,
    dataTypes: [...dataTypes.values()],
    sources: [inventory.source],
    capabilities,
    relationships: inventory.relationships,
  });

  if (semanticTypeGaps.length > 0) {
    // A catalog cannot ship with a field whose meaning is undecided — nothing
    // downstream could bind it. The difference from throwing on the first one is
    // that the host now gets every gap at once, with the key to resolve each.
    throw new GraphQlSemanticTypeError(semanticTypeGaps);
  }

  return {
    catalog,
    plannerManifest: createPlannerManifest(catalog),
    bindings,
    issues,
  };
}

function selectedPaths(
  binding: GraphQlOperationBinding,
  requested: readonly string[] | undefined,
): string[] {
  const selected = requested ?? binding.approvedOutputFields;
  assertUniqueSubset(
    selected,
    binding.approvedOutputFields,
    "requested output field",
    binding.capabilityId,
  );
  const merged = [...new Set([...selected, ...binding.requiredOutputFields])];
  if (merged.length === 0) {
    throw new Error(
      `GraphQL request for "${binding.capabilityId}" selects no output fields`,
    );
  }
  if (merged.length > binding.maximumSelectedFields) {
    throw new Error(
      `GraphQL request exceeds maximum selected fields ${binding.maximumSelectedFields}`,
    );
  }
  const depth = Math.max(...merged.map((path) => path.split(".").length));
  if (depth > binding.maximumSelectionDepth) {
    throw new Error(
      `GraphQL request exceeds maximum selection depth ${binding.maximumSelectionDepth}`,
    );
  }
  return merged;
}

function selectionDocument(tree: SelectionTree, indentation = "    "): string {
  return [...tree.children.entries()]
    .map(([field, child]) => {
      if (child.children.size === 0) return `${indentation}${field}`;
      return `${indentation}${field} {\n${selectionDocument(child, `${indentation}  `)}\n${indentation}}`;
    })
    .join("\n");
}

function variableType(
  schema: GraphQLSchema,
  fieldName: string,
  argumentName: string,
): string {
  const argument = queryByName(schema, fieldName).args.find(
    (candidate) => candidate.name === argumentName,
  );
  if (!argument)
    throw new Error(`Unknown GraphQL argument "${fieldName}.${argumentName}"`);
  return argument.type.toString();
}

export function compileGraphQlOperation(
  schemaInput: GraphQlSchemaInput,
  binding: GraphQlOperationBinding,
  request: GraphQlDataRequest,
  identity: Readonly<Record<string, unknown>>,
): CompiledGraphQlOperation {
  if (request.capabilityId !== binding.capabilityId) {
    throw new Error(
      `GraphQL binding "${binding.capabilityId}" cannot compile request "${request.capabilityId}"`,
    );
  }
  if (hashGraphQlSchema(schemaInput) !== binding.schemaHash) {
    throw new Error(
      `GraphQL schema drift detected for capability "${binding.capabilityId}"`,
    );
  }

  const schema = loadGraphQlSchema(schemaInput);
  const selected = selectedPaths(binding, request.selection);
  // The ordering argument is deliberately not a visitor argument — the runtime
  // writes it, not the planner — so it has to be added here, and only when a
  // value is actually present: a request that asks for no ordering produces the
  // document it always did rather than one declaring an unused variable.
  const orderingArgument =
    binding.ordering &&
    Object.prototype.hasOwnProperty.call(request.params, binding.ordering.argument) &&
    request.params[binding.ordering.argument] !== undefined
      ? binding.ordering.argument
      : undefined;
  // The filter argument is here for the same reason as ordering: the planner
  // states its conditions in `query.filter` and the runtime compiles them, so
  // the argument is not a visitor argument and would otherwise never appear in
  // the document. Only when a value is present, so a request that asks for no
  // narrowing produces the document it always did.
  const filterArgument =
    binding.filter &&
    Object.prototype.hasOwnProperty.call(request.params, binding.filter.argument) &&
    request.params[binding.filter.argument] !== undefined
      ? binding.filter.argument
      : undefined;
  const argumentNames = [
    ...binding.visitorArguments,
    ...(orderingArgument ? [orderingArgument] : []),
    ...(filterArgument && !binding.visitorArguments.includes(filterArgument)
      ? [filterArgument]
      : []),
    ...Object.keys(binding.identityArguments),
  ];
  const definitions = argumentNames.map(
    (argument) => `$${argument}: ${variableType(schema, binding.fieldName, argument)}`,
  );
  const argumentApplications = argumentNames.map(
    (argument) => `${argument}: $${argument}`,
  );
  const tree = buildSelectionTree(selected);
  const envelope = rowEnvelopeOf(binding);
  // The approved paths are row-relative, so an enveloped query has to put the
  // wrapper back: `edges { node { ...approved } }` for a connection, plus
  // `pageInfo` when the upstream exposes it; `docs { ...approved }` for a
  // declared list envelope, whose paging fields are siblings of the rows
  // rather than living in a container.
  const selectionBody = envelope
    ? [
        `    ${envelope.rowsField} {`,
        ...(envelope.nodeField
          ? [
              envelope.cursorField ? `      ${envelope.cursorField}` : undefined,
              `      ${envelope.nodeField} {`,
              indentSelection(selectionDocument(tree), 4),
              "      }",
            ]
          : [indentSelection(selectionDocument(tree), 2)]),
        "    }",
        envelope.pageInfoContainer && envelope.pageInfoFields.length > 0
          ? `    ${envelope.pageInfoContainer} { ${envelope.pageInfoFields.join(" ")} }`
          : undefined,
        ...(!envelope.pageInfoContainer
          ? envelope.pageInfoFields.map((name) => `    ${name}`)
          : []),
        envelope.totalCountField ? `    ${envelope.totalCountField}` : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n")
    : selectionDocument(tree);
  const document = [
    `query ${binding.operationName}${definitions.length ? `(${definitions.join(", ")})` : ""} {`,
    `  ${binding.fieldName}${argumentApplications.length ? `(${argumentApplications.join(", ")})` : ""} {`,
    selectionBody,
    "  }",
    "}",
  ].join("\n");

  const variables: Record<string, unknown> = {};
  binding.visitorArguments.forEach((argument) => {
    if (Object.prototype.hasOwnProperty.call(request.params, argument)) {
      variables[argument] = request.params[argument];
    }
  });
  if (orderingArgument) {
    variables[orderingArgument] = request.params[orderingArgument];
  }
  if (filterArgument) {
    variables[filterArgument] = request.params[filterArgument];
  }
  Object.entries(binding.identityArguments).forEach(([argument, identityKey]) => {
    if (
      !Object.prototype.hasOwnProperty.call(identity, identityKey) ||
      identity[identityKey] === undefined
    ) {
      throw new Error(`Missing trusted identity key "${identityKey}"`);
    }
    variables[argument] = identity[identityKey];
  });

  const validationErrors = validate(schema, parse(document));
  if (validationErrors.length > 0) {
    throw new Error(
      `Compiled GraphQL operation is invalid: ${validationErrors.map((error) => error.message).join("; ")}`,
    );
  }

  return {
    capabilityId: binding.capabilityId,
    operationName: binding.operationName,
    document,
    variables,
    responseKey: binding.fieldName,
    selection: selected,
    // Validated against a row, then array-wrapped: the response the executor
    // hands on has had the connection wrapper removed, so a schema describing
    // the wrapper would reject every successful call.
    outputSchema: wrapForRowEnvelope(
      envelope,
      stripRootNullable(
        outputTypeJsonSchema(
          rowTypeOf(queryByName(schema, binding.fieldName).type, envelope),
          tree,
          binding.scalarMappings,
        ),
      ),
    ),
  };
}

/** An unwrapped envelope delivers an array of rows; anything else is itself. */
function wrapForRowEnvelope(
  envelope: RowEnvelope | undefined,
  rowSchema: JsonSchema,
): JsonSchema {
  return envelope ? { type: "array", items: rowSchema } : rowSchema;
}

function failure(
  code: string,
  message: string,
  retryable: boolean,
): CapabilityExecutionResult<never> {
  return { ok: false, error: { code, message, retryable } };
}

function freshnessIsWithinLimit(
  provenance: DataProvenance,
  maximumAgeSeconds: number,
  now: Date,
): boolean {
  const asOf = Date.parse(provenance.freshness.asOf);
  return Number.isFinite(asOf) && now.getTime() - asOf <= maximumAgeSeconds * 1000;
}

/**
 * Cursor state for a connection response, as reported to the caller.
 *
 * `hasNextPage` with `endCursor` is what makes a second page requestable: the
 * planner passes the cursor back as the connection's `after` argument, so
 * continuation needs no new approval beyond the argument the host already
 * approved.
 */
export interface GraphQlPageInfo {
  hasNextPage: boolean;
  hasPreviousPage?: boolean;
  startCursor?: string;
  endCursor?: string;
}

/**
 * Turns `{edges: [{node}], pageInfo}` into rows plus cursor state.
 *
 * An edge whose `node` is null is dropped rather than surfaced as a null row:
 * Relay permits it (an edge whose node the viewer may not read), and a null in
 * a collection fails output validation for a reason that has nothing to do
 * with the host's schema.
 */
function unwrapRowEnvelope(
  value: unknown,
  envelope: RowEnvelope,
): { rows: unknown[]; pageInfo?: GraphQlPageInfo; totalCount?: number } | undefined {
  if (!isRecord(value)) return undefined;
  const rawRows = value[envelope.rowsField];
  if (!Array.isArray(rawRows)) return undefined;
  const rows = envelope.nodeField
    ? rawRows
        .map((edge) => (isRecord(edge) ? edge[envelope.nodeField!] : undefined))
        .filter((node) => node !== undefined && node !== null)
    : // A null element in a direct row list is dropped for the same reason a
      // null node is: a null in a collection fails output validation for a
      // reason that has nothing to do with the host's schema.
      rawRows.filter((row) => row !== undefined && row !== null);
  // A non-integer or negative total is treated as absent rather than reported:
  // "showing 100 of many" is worse than a number, and better than a wrong one.
  const rawTotal = envelope.totalCountField
    ? value[envelope.totalCountField]
    : undefined;
  const totalCount =
    typeof rawTotal === "number" && Number.isInteger(rawTotal) && rawTotal >= 0
      ? { totalCount: rawTotal }
      : {};
  // Where the paging booleans live: a connection's `pageInfo` container, or —
  // for a declared envelope with a hasNextPageField — the envelope root
  // itself. An envelope that declared no such field claims nothing about
  // continuation, so no pageInfo is synthesized for it.
  const rawPageInfo = envelope.pageInfoContainer
    ? value[envelope.pageInfoContainer]
    : envelope.hasNextPageField
      ? value
      : undefined;
  if (!isRecord(rawPageInfo)) return { rows, ...totalCount };
  const asString = (key: string): string | undefined =>
    typeof rawPageInfo[key] === "string" ? (rawPageInfo[key] as string) : undefined;
  return {
    rows,
    ...totalCount,
    pageInfo: {
      hasNextPage: rawPageInfo[envelope.hasNextPageField ?? "hasNextPage"] === true,
      ...(typeof rawPageInfo["hasPreviousPage"] === "boolean" && envelope.pageInfoContainer
        ? { hasPreviousPage: rawPageInfo["hasPreviousPage"] }
        : {}),
      ...(envelope.pageInfoContainer && asString("startCursor")
        ? { startCursor: asString("startCursor")! }
        : {}),
      ...(envelope.pageInfoContainer && asString("endCursor")
        ? { endCursor: asString("endCursor")! }
        : {}),
    },
  };
}

/** How `classifyGraphQlErrors` split an `errors` array. */
interface GraphQlErrorClassification {
  /**
   * Row-relative paths of approved fields the upstream failed on while
   * answering everything else. Empty when nothing is salvageable.
   */
  degradedFields: string[];
  /** Errors that make the whole response untrustworthy, already formatted. */
  fatal: string[];
}

/**
 * Separates "one field failed" from "the request failed".
 *
 * GraphQL is explicitly partial: a resolver error nulls its own field and the
 * response carries both `data` and `errors`. This package treated any `errors`
 * entry as total failure, so one broken field on one row discarded every row
 * and every other field — the whole view, over a column. Saleor produces this
 * routinely: `ProductVariant.revenue` declares its `period` argument optional
 * and the resolver requires it, so an approved, published, correctly-selected
 * field errors on every row forever.
 *
 * An error is only degradable when it names a path *into* this operation's
 * result and that path reaches a field the host did not mark required. Anything
 * else stays fatal:
 *
 *  - no `path`: a request-level error (parse, validation, auth). Nothing about
 *    the response can be trusted, and there is no field to attribute it to.
 *  - a path that stops at the root or at a row: the row itself failed, so the
 *    collection is missing entries rather than missing a column.
 *  - a required field: the host said a row without it is not a row. Dropping it
 *    silently would hand a component an identity-less record.
 *
 * List indices are stripped, so an error on row 3's `revenue` and row 40's
 * report as the same degraded field — which is what a host acts on. Losing
 * *which rows* is deliberate: the alternative is a per-row report that grows
 * with the page and says nothing more.
 */
function classifyGraphQlErrors(
  errors: NonNullable<GraphQlTransportResponse["errors"]>,
  operation: CompiledGraphQlOperation,
  binding: GraphQlOperationBinding,
): GraphQlErrorClassification {
  const required = new Set(binding.requiredOutputFields);
  const degradedFields = new Set<string>();
  const fatal: string[] = [];

  const formatted = (error: (typeof errors)[number]): string =>
    error.path?.length
      ? // The path is the difference between "products failed" and "the
        // `revenue` field failed": a schema can declare an argument optional
        // while the resolver requires it, and then one approved field takes the
        // whole capability down with an error that never names it.
        `${error.message} (at ${error.path.join(".")})`
      : error.message;

  for (const error of errors) {
    const path = error.path ?? [];
    if (path.length === 0 || path[0] !== operation.responseKey) {
      fatal.push(formatted(error));
      continue;
    }

    let rest = path.slice(1);
    // Unwrap the envelope the same way the data is unwrapped, so the reported
    // path is the one the host approved and a component binds to, not the
    // transport's `edges.0.node.` (or `docs.0.`) spelling of it.
    const errorEnvelope = rowEnvelopeOf(binding);
    if (errorEnvelope) {
      if (rest[0] === errorEnvelope.rowsField) {
        rest = rest.slice(1);
        if (typeof rest[0] === "number") rest = rest.slice(1);
        if (errorEnvelope.nodeField && rest[0] === errorEnvelope.nodeField) {
          rest = rest.slice(1);
        }
      } else {
        // An error inside `pageInfo`, on a paging sibling, or on the wrapper
        // itself. Nothing row-shaped to attribute it to.
        fatal.push(formatted(error));
        continue;
      }
    }

    const fieldPath = rest.filter((segment) => typeof segment === "string").join(".");
    if (fieldPath.length === 0) {
      fatal.push(formatted(error));
      continue;
    }
    if (required.has(fieldPath)) {
      fatal.push(
        `${formatted(error)} — "${fieldPath}" is a required output field, so the result cannot be served without it`,
      );
      continue;
    }
    degradedFields.add(fieldPath);
  }

  return { degradedFields: [...degradedFields].sort(), fatal };
}

/**
 * The request with the host's ordering argument written into it, from the
 * ordering the plan asked for.
 *
 * Never over a value already present: the same discipline paging takes, for the
 * same reason — this supplies what the planner is not offered, and supplying it
 * twice would mean one of the two is being silently overwritten.
 */
function orderingRequest(
  binding: GraphQlOperationBinding,
  request: GraphQlDataRequest,
  sort: CapabilityExecutionContext["sort"],
): GraphQlDataRequest {
  const value = renderOrderingValue(binding.ordering, sort);
  if (value === undefined || !binding.ordering) return request;
  if (request.params[binding.ordering.argument] !== undefined) return request;
  return {
    ...request,
    params: { ...request.params, [binding.ordering.argument]: value },
  };
}

/**
 * Writes the plan's filter into the upstream's own argument, after preflight.
 *
 * After, for the same reason ordering is: the argument is deliberately not
 * offered to the planner, so the capability's inputSchema does not declare it
 * and a preflight over `additionalProperties: false` would refuse the very
 * value this exists to supply. The control keeping the planner out was locking
 * the runtime out with it.
 *
 * Never over a value already present. Refusal is the caller's to handle — a
 * filter that cannot be compiled must not quietly become no filter at all,
 * which is the difference between fetching the right rows and fetching the
 * first fifty.
 */
function filterRequest(
  binding: GraphQlOperationBinding,
  request: GraphQlDataRequest,
  filter: CapabilityExecutionContext["filter"],
): {
  request: GraphQlDataRequest;
  pushed: boolean;
  /** Field and operator per condition, for provenance. Only when it pushed. */
  narrowedAtSource?: { field: string; operator: string }[];
} {
  if (!binding.filter || !filter) return { request, pushed: false };
  if (request.params[binding.filter.argument] !== undefined) {
    return { request, pushed: false };
  }
  const compiled = renderFilterValue(binding.filter, filter);
  if (!compiled.ok) return { request, pushed: false };
  return {
    request: {
      ...request,
      params: { ...request.params, [binding.filter.argument]: compiled.value },
    },
    pushed: true,
    narrowedAtSource: filterConditionSummary(filter),
  };
}

export async function executeApprovedGraphQlRequest(
  options: ExecuteApprovedGraphQlRequestOptions,
): Promise<CapabilityExecutionResult<unknown>> {
  const preflight = validateCapabilityPreflight(
    options.catalog,
    options.request.capabilityId,
    options.request.params,
    {
      identity: options.context.identity,
      ...(options.context.permissions
        ? { permissions: options.context.permissions }
        : {}),
    },
  );
  if (!preflight.ok) {
    return failure(
      "PREFLIGHT_FAILED",
      preflight.issues.map((issue) => issue.message).join("; "),
      false,
    );
  }

  // Written after preflight, never before: the params a plan sends are checked
  // against the capability's approved input schema, which does not carry the
  // ordering argument because the planner is not offered it. Rendering into
  // params any earlier would have the request refused for setting a param it is
  // not allowed to set — by the very control that keeps the planner out of it.
  const ordered = orderingRequest(options.binding, options.request, options.context.sort);
  const {
    request,
    pushed: filterPushed,
    narrowedAtSource,
  } = filterRequest(options.binding, ordered, options.context.filter);

  let operation: CompiledGraphQlOperation;
  try {
    operation = compileGraphQlOperation(
      options.schema,
      options.binding,
      request,
      options.context.identity,
    );
  } catch (error) {
    return failure(
      "GRAPHQL_REQUEST_REJECTED",
      error instanceof Error ? error.message : "GraphQL request was rejected",
      false,
    );
  }

  let response: GraphQlTransportResponse;
  try {
    response = await options.transport({
      document: operation.document,
      operationName: operation.operationName,
      variables: operation.variables,
      ...(options.context.signal ? { signal: options.context.signal } : {}),
    });
  } catch (error) {
    if (error instanceof GraphQlTransportError) {
      return failure(
        "GRAPHQL_TRANSPORT_ERROR",
        // The status goes in the message because it is the one detail that tells
        // an operator which side of the boundary to look at, and it is a status
        // code, not a response body — nothing about the upstream's internals.
        error.httpStatus !== undefined
          ? `${error.message} (HTTP ${error.httpStatus})`
          : error.message,
        error.retryable,
      );
    }
    return failure(
      "GRAPHQL_TRANSPORT_ERROR",
      error instanceof Error ? error.message : "GraphQL transport failed",
      // Unknown cause: assume retryable, since an undescribed throw here is
      // usually a network fault. A host that knows better says so with
      // `GraphQlTransportError`.
      true,
    );
  }

  if (!isRecord(response.data) || !(operation.responseKey in response.data)) {
    // Checked before the errors are classified: with no data there is nothing
    // to degrade *to*, and the errors — if any — explain why.
    return failure(
      response.errors?.length ? "GRAPHQL_EXECUTION_ERROR" : "GRAPHQL_INVALID_RESPONSE",
      response.errors?.length
        ? response
            .errors.map((error) =>
              error.path?.length
                ? `${error.message} (at ${error.path.join(".")})`
                : error.message,
            )
            .join("; ")
        : `GraphQL response is missing data.${operation.responseKey}`,
      false,
    );
  }

  let degradedFields: readonly string[] = [];
  if (response.errors?.length) {
    const classified = classifyGraphQlErrors(response.errors, operation, options.binding);
    if (classified.fatal.length > 0) {
      return failure("GRAPHQL_EXECUTION_ERROR", classified.fatal.join("; "), false);
    }
    if (response.data[operation.responseKey] === null) {
      // Every error was field-shaped and yet the whole result is null: a
      // non-null field error bubbled to the root. Nothing survived to serve.
      return failure(
        "GRAPHQL_EXECUTION_ERROR",
        `GraphQL errors nulled the whole result for "${options.request.capabilityId}": ${classified.degradedFields.join(", ")}`,
        false,
      );
    }
    degradedFields = classified.degradedFields;
  }

  // Unwrap a connection into the collection the capability declares. Without
  // this the runtime receives `{pageInfo, edges}` where it expects rows: the
  // row budget passes it through untouched, filter and sort have nothing to
  // apply to, and a capability over thousands of records delivers one object
  // and no data.
  const raw = response.data[operation.responseKey];
  // `null` where a *connection* was promised is broken, and only that case.
  //
  // For an entity, null is the answer: "no such record" is part of the entity
  // contract, `validateCapabilityResult` admits it, and the renderer maps it to
  // the empty state. Failing there would turn a legitimate empty result into an
  // error — which is what this guard did when it was written against the
  // connection symptom and applied to every shape.
  //
  // A connection is different. The response undertook to return
  // `{ edges, pageInfo }` and returned nothing, so there are no rows and no
  // "no such record" to report. Left to fall through it surfaced as "is not a
  // connection" from the unwrap — three hops from a cause that was usually a
  // parameter matching no records. Named here instead, with the parameters the
  // request actually carried, because the person debugging it typed one of them.
  const executionEnvelope = rowEnvelopeOf(options.binding);
  if (executionEnvelope && (raw === null || raw === undefined)) {
    const params = options.request.params;
    const supplied =
      isRecord(params) && Object.keys(params).length > 0
        ? ` with ${JSON.stringify(params)}`
        : "";
    return failure(
      "GRAPHQL_NULL_RESULT",
      `Upstream returned no "${operation.responseKey}" result for "${options.request.capabilityId}"${supplied}. ` +
        "Usually a parameter that matched nothing — a wrong id or slug — rather than a broken capability.",
      false,
    );
  }
  let data = raw;
  let pageInfo: GraphQlPageInfo | undefined;
  let totalCount: number | undefined;
  if (executionEnvelope) {
    const unwrapped = unwrapRowEnvelope(raw, executionEnvelope);
    if (!unwrapped) {
      return failure(
        "GRAPHQL_INVALID_RESPONSE",
        `GraphQL response for "${options.request.capabilityId}" is not a ${executionEnvelope.label}: ` +
          `expected "${executionEnvelope.rowsField}" to be a list${
            executionEnvelope.nodeField
              ? ` of objects with "${executionEnvelope.nodeField}"`
              : ""
          }`,
        false,
      );
    }
    data = unwrapped.rows;
    pageInfo = unwrapped.pageInfo;
    totalCount = unwrapped.totalCount;
  }
  // The plan said how many rows it wanted and this page delivered them. With no
  // stated limit the ask is "everything", which one page cannot satisfy while
  // another exists.
  const askSatisfied =
    options.context.limit !== undefined &&
    Array.isArray(data) &&
    data.length >= options.context.limit;
  let provenance: DataProvenance;
  try {
    provenance = await options.resolveProvenance({
      capabilityId: options.request.capabilityId,
      data,
    });
  } catch (error) {
    return failure(
      "PROVENANCE_UNAVAILABLE",
      error instanceof Error ? error.message : "Host provenance resolution failed",
      false,
    );
  }
  // Checked where it enters rather than several layers downstream. A resolver
  // returning `sources` with no `freshness` used to reach
  // `freshnessIsWithinLimit`, which reads `provenance.freshness.asOf` and threw
  // a bare TypeError out of the executor — no capability id, no field, no
  // indication the host's own callback was the cause. The same value reaching
  // the result validator instead was reported as the *data source* returning
  // the wrong shape, which is a different wrong answer to the same question.
  const shape = ProvenanceSchema.safeParse(provenance);
  if (!shape.success) {
    return failure(
      "PROVENANCE_UNAVAILABLE",
      `This host's resolveProvenance returned a value the capability contract refuses — ` +
        `the data source answered correctly. ` +
        shape.error.issues
          .map((issue) => `/provenance/${issue.path.join("/")}: ${issue.message}`)
          .join("; "),
      false,
    );
  }

  if (
    options.binding.freshnessMaximumAgeSeconds !== undefined &&
    !freshnessIsWithinLimit(
      provenance,
      options.binding.freshnessMaximumAgeSeconds,
      (options.now ?? (() => new Date()))(),
    )
  ) {
    return failure(
      "STALE_GRAPHQL_RESULT",
      `GraphQL result exceeds the host-approved freshness limit of ${options.binding.freshnessMaximumAgeSeconds} seconds`,
      false,
    );
  }

  // An entity lookup that matched nothing comes back as `null` — a successful
  // "no such record", not a malformed result. Validating null against the
  // entity's object schema used to fail with a bare "must be object" that
  // reached visitors as an error state; a null entity is instead returned as
  // data, and the renderer maps it to the same "empty" state an empty
  // collection gets.
  const capabilityShape = options.catalog.capabilities.find(
    (capability) => capability.id === options.request.capabilityId,
  )?.output.shape;
  if (data === null && capabilityShape === "entity") {
    return { ok: true, data: null, provenance };
  }

  const result: CapabilityExecutionResult<unknown> = {
    ok: true,
    data,
    provenance: {
      ...provenance,
      // Two different facts, and conflating them was the defect: `hasNextPage`
      // alone used to set `truncated`, so a plan that asked for 10 and got 10
      // reported its answer as cut short. That fired on nearly every bounded
      // question, which made it noise — and made the case that matters (a page
      // cap silently swallowing rows the plan wanted) indistinguishable from
      // the routine one.
      //
      // `moreAvailable`: the dataset extends past what was fetched. Routine.
      // `truncated`: the *answer* was cut short relative to the ask — the plan
      // named no limit (asked for everything) or named one this page did not
      // reach. A host whose API caps `first` at 100 still sees the exact wrong
      // answer `truncated` exists to prevent; it just stops being blamed on
      // requests that got precisely what they asked for.
      ...(pageInfo?.hasNextPage === true ? { moreAvailable: true } : {}),
      ...(pageInfo?.hasNextPage === true && !askSatisfied ? { truncated: true } : {}),
      // How many exist beyond them is not knowable from `pageInfo` — but it is
      // knowable when the connection declares `totalCount`, and then the
      // visitor can be told "100 of 2,500" instead of "100 of many". Only set
      // alongside `truncated`: a complete result's total is its row count, and
      // writing it there would claim a truncation that did not happen.
      ...(pageInfo?.hasNextPage === true && !askSatisfied && totalCount !== undefined
        ? { totalRowsBeforeTruncation: totalCount }
        : {}),
      ...(degradedFields.length > 0 ? { degradedFields: [...degradedFields] } : {}),
      // Which column answered. Without it a source-side zero and "no such
      // coverage" are the same result — see `narrowedAtSource` on the schema.
      ...(narrowedAtSource?.length ? { narrowedAtSource } : {}),
    },
  };
  const requestCatalog: CapabilityCatalog = {
    ...options.catalog,
    capabilities: options.catalog.capabilities.map((capability) =>
      capability.id === options.request.capabilityId
        ? { ...capability, outputSchema: operation.outputSchema }
        : capability,
    ),
  };
  const validation = validateCapabilityResult(
    requestCatalog,
    options.request.capabilityId,
    result,
  );
  if (validation.ok) return result;
  // Which side is wrong decides what the message may say. Everything under
  // `/provenance` is built here from the host's own `resolveProvenance`, not
  // received from the upstream — so blaming the data source for it sends
  // whoever reads this to inspect an API that answered correctly. Measured the
  // slow way: a resolver returning `sources` without `freshness` reported
  // "the data source returned something other than the approved result shape",
  // and the rows it was describing were sitting right there, valid.
  const hostIssues = validation.issues.filter((issue) =>
    issue.path.startsWith("/provenance"),
  );
  const detail = validation.issues
    // The path was computed and then dropped, which is what made this
    // unactionable: "expected object, received undefined" names no field.
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");
  return failure(
    "INVALID_GRAPHQL_RESULT",
    // Contextualized because this message can reach a visitor's screen as
    // an errorMessage: a bare ajv fragment like "must be object" reads as
    // gibberish there, while this at least names what went wrong.
    hostIssues.length === validation.issues.length
      ? `This host's resolveProvenance returned a value the capability contract refuses — ` +
          `the data source answered correctly. ${detail}`
      : `The data source returned something other than the approved result shape: ${detail}`,
    false,
  );
}

/**
 * Compatibility adapter for RenderYes's current capability-owned runtime contract. It requests
 * the complete host-approved field envelope. A Plan adapter may instead call
 * executeApprovedGraphQlRequest directly when it supports per-request approved selections.
 */
/**
 * Page size for a connection whose plan named none and whose capability
 * declares no `maximumRows`. Matches `DEFAULT_MAX_ROWS` in the data runtime,
 * which is the ceiling those rows would meet immediately afterwards.
 */
const DEFAULT_CONNECTION_PAGE_SIZE = 1_000;

/**
 * Largest `first` sent when the host declared no `maximumPageSize`.
 *
 * A Relay API commonly caps a page and rejects the request outright when asked
 * for more — Saleor and GitHub at 100, Shopify at 250 — and the cap is not
 * discoverable from the schema, so an undeclared one has to be assumed. 100 is
 * under every cap we have seen. A host whose API allows more says so and gets
 * it; a host who says nothing gets a first page instead of a rejection.
 */
const DEFAULT_CONNECTION_PAGE_CAP = 100;

/**
 * Supplies `first` on every connection request.
 *
 * A Relay API pages by `first`/`after`, not by offset. This originally ran only
 * when the plan set a limit, on the assumption that a limitless request would
 * fetch the upstream's default page — but the Relay spec defines no default
 * page, and an API is free to reject a connection that names neither `first`
 * nor `last`. Saleor does. So a limitless plan was not merely unbounded, it was
 * invalid: the whole request failed, including the ones this package's own
 * offline planner produces.
 *
 * The size is the plan's limit when it set one, then the capability's own
 * `maximumRows`, then a default — and then clamped to the API's page cap, which
 * is a different quantity from the row budget and usually much smaller. Sending
 * a row budget as a page size gets the request rejected outright rather than
 * truncated: `Requesting 1000 records on the "orders" connection exceeds the
 * "first" limit of 100 records`.
 *
 * Still conservative in the ways that matter. Only `first`, only when the host
 * approved it as a visitor argument, and never over a value the planner set
 * itself: an approved argument the planner filled is a decision, and this is a
 * default. `offset` is not translated at all — a cursor is a bookmark, not a
 * position, and faking one by walking pages would issue N requests to answer a
 * question the plan did not ask.
 */
/** Reads a dotted paging path, so an already-set nested page size is respected. */
function readPath(params: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = params;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Sets a dotted paging path, copying each level rather than mutating.
 *
 * A nested page size means writing inside an object the planner may already
 * have set other keys on — Strapi's `pagination` carries `page` beside
 * `pageSize` — so the intermediate levels are merged, never replaced.
 */
function writePath(
  params: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) return params;
  if (rest.length === 0) return { ...params, [head]: value };
  const existing = params[head];
  return {
    ...params,
    [head]: writePath(isRecord(existing) ? existing : {}, rest, value),
  };
}

function connectionPagingParams(
  binding: GraphQlOperationBinding,
  input: unknown,
  limit: number | undefined,
  maximumRows: number | undefined,
): Record<string, unknown> {
  const params = isRecord(input) ? { ...input } : {};
  const envelope = rowEnvelopeOf(binding);
  // "first" for a connection, the declared pageSizeArgument for a list
  // envelope, or a `pagingArguments` path for an API that is neither — a plain
  // list paged by `take`, or one that nests its page size. Same discipline in
  // every case: only when the host approved the argument, and never over a
  // value the planner set itself.
  const path = binding.paging?.pageSize ?? (
    envelope?.pageSizeArgumentName ? [envelope.pageSizeArgumentName] : undefined
  );
  if (!path || path.length === 0) return params;
  if (!binding.visitorArguments.includes(path[0]!)) return params;
  if (readPath(params, path) !== undefined) return params;

  const wanted =
    positivePageSize(limit) ??
    positivePageSize(maximumRows) ??
    DEFAULT_CONNECTION_PAGE_SIZE;
  const cap = positivePageSize(binding.maximumPageSize) ?? DEFAULT_CONNECTION_PAGE_CAP;
  return writePath(params, path, Math.min(wanted, cap));
}

/**
 * Whether any approved argument is typed richly enough to carry an ordering on
 * its own — an enum or an input object, whose legal values introspection
 * publishes and the plan contract therefore offers the planner directly.
 *
 * Used only to keep the missing-ordering warning quiet for schemas that need no
 * declaration. It is a structural test, not a name test: nothing here asks
 * whether an argument is *called* something ordering-shaped, because that
 * question has no general answer and guessing it wrong is how a filter argument
 * ends up treated as a sort. A host whose only rich argument is a filter is
 * warned anyway — over-warning is the direction this should fail in, and the
 * warning names dropping sortFields as the answer when there is nothing to
 * declare.
 */
function hasTypedOrderingPath(
  field: GraphQLField<unknown, unknown>,
  approvedVisitorArguments: readonly string[],
): boolean {
  return field.args.some((argument) => {
    if (!approvedVisitorArguments.includes(argument.name)) return false;
    const named = getNamedType(argument.type);
    return isEnumType(named) || isInputObjectType(named);
  });
}

/**
 * Resolves a declared ordering grammar against the argument it names, or
 * refuses. Every refusal below is a declaration that would compile and then
 * send something the upstream reads differently than the host meant.
 */
/**
 * One approved filter argument's vocabulary, read off the schema.
 *
 * Structural, not declared, and the difference from ordering is the schema's
 * own doing: an ordering argument typed `sort: String` publishes nothing about
 * its spelling, so a host has to state it. A filter argument publishes all of
 * it — the field names, the operator names and the value types are input
 * fields. This reads what is there and records nothing that is not.
 *
 * The argument is found the same way: an input object whose fields include
 * approved filter fields, each carrying at least one operator this package
 * recognises. Where exactly one argument qualifies it is used; where several
 * do, choosing would be a guess and the compile says so.
 */
/** Strips a NonNull wrapper so a list can be recognised through one. */
function unwrapNonNull(type: GraphQLInputType): GraphQLInputType {
  return isNonNullType(type) ? type.ofType : type;
}

/**
 * Quantifier field names a to-many relation's filter input publishes, in
 * preference order.
 *
 * Prisma and Keystone publish `some`/`every`/`none` and reject a nested
 * condition that omits them. `every` is absent on purpose: no IR operator means
 * "all related rows match", and offering one would be inventing a condition the
 * planner never stated.
 *
 * Deliberately short lists, and `not` is deliberately not among them. Strapi
 * and Hasura publish a `not`/`_not` *inside* the related type's own filter,
 * which negates the condition and leaves the relation existential — `EXISTS(NOT
 * p)`, true for an article filed under two desks when only one of them is the
 * one excluded. The negation this needs is `NOT EXISTS(p)`, so where a relation
 * publishes no quantifier the negation goes on the filter's root instead, and a
 * name that merely looks like one is worse than no match at all.
 */
const RELATION_QUANTIFIERS: Readonly<Record<"some" | "none", readonly string[]>> = {
  some: ["some"],
  none: ["none"],
};

/**
 * Resolves each approved filter path against the filter input type.
 *
 * A path with dots is walked hop by hop: each segment must be an input field
 * whose type is an input object, and the last one must be an input object
 * declaring operators. A hop the schema does not publish means the path does
 * not compile — `categories.title` on Payload, whose relationship operator
 * takes ids — and the caller narrows after the fetch instead.
 *
 * `listCrossings` comes from the output schema because the input cannot say it:
 * Hasura spells a to-one and a to-many relation filter identically.
 */
function resolveFilterFields(
  inputType: GraphQLInputObjectType,
  approvedFilterFields: readonly string[],
  listCrossings: (path: string) => boolean[] | undefined,
): Record<string, FilterFieldPushdown> {
  const resolved: Record<string, FilterFieldPushdown> = {};
  for (const fieldName of approvedFilterFields) {
    const entry = resolveFilterPath(inputType, fieldName, listCrossings);
    if (entry) resolved[fieldName] = entry;
  }
  return resolved;
}

function resolveFilterPath(
  inputType: GraphQLInputObjectType,
  path: string,
  listCrossings: (path: string) => boolean[] | undefined,
): FilterFieldPushdown | undefined {
  const segments = path.split(".");
  const relations = segments.slice(0, -1);
  // A nested path whose row shape cannot be resolved gets no push-down: the
  // meaning of a condition through a relation depends on whether that relation
  // is to-many, and guessing it either drops rows or invents them.
  const crossings = relations.length === 0 ? [] : listCrossings(path);
  if (!crossings || crossings.length !== relations.length) return undefined;

  let current = inputType;
  const through: FilterPathSegment[] = [];
  for (const [index, segment] of relations.entries()) {
    const relationField = current.getFields()[segment];
    if (!relationField) return undefined;
    const relationType = getNamedType(relationField.type);
    if (!isInputObjectType(relationType)) return undefined;
    const relationFields = relationType.getFields();
    const list = crossings[index] === true;
    const some = list
      ? RELATION_QUANTIFIERS.some.find((candidate) => candidate in relationFields)
      : undefined;
    const none = list
      ? RELATION_QUANTIFIERS.none.find((candidate) => candidate in relationFields)
      : undefined;
    through.push({ name: segment, list, ...(some ? { some } : {}), ...(none ? { none } : {}) });
    // A quantifier-bearing relation input holds the leaf inside the quantifier,
    // not beside it, so the walk continues through `some` rather than through
    // the relation type itself.
    const inner = some ? getNamedType(relationFields[some]!.type) : relationType;
    if (!isInputObjectType(inner)) return undefined;
    current = inner;
  }

  const leafName = segments[segments.length - 1]!;
  const inputField = current.getFields()[leafName];
  if (!inputField) return undefined;
  const fieldType = getNamedType(inputField.type);
  if (!isInputObjectType(fieldType)) return undefined;
  const operatorFields = fieldType.getFields();
  const operators: Record<string, string> = {};
  for (const [operator, candidates] of Object.entries(OPERATOR_CANDIDATES)) {
    const match = candidates.find((candidate) => candidate in operatorFields);
    if (match) operators[operator] = match;
  }
  const nullTest = NULL_TEST_CANDIDATES.find((candidate) => candidate.name in operatorFields);
  if (Object.keys(operators).length === 0 && !nullTest) return undefined;
  return {
    operators,
    ...(nullTest ? { nullTest } : {}),
    ...(through.length > 0 ? { through } : {}),
  };
}

function filterPushdownFor(
  field: GraphQLField<unknown, unknown>,
  approvedFilterFields: readonly string[],
  outputSchema: JsonSchema,
  /**
   * The host's own statements, used to break a tie the schema cannot: which of
   * two filter-capable arguments actually filters. An `approvedInputFields`
   * path rooted at an argument names it; so does approving it for the planner.
   */
  decisions: {
    approvedVisitorArguments: readonly string[];
    approvedInputFields?: readonly string[] | undefined;
  },
): { pushdown?: FilterPushdown; ambiguousArguments?: string[] } {
  if (approvedFilterFields.length === 0) return {};
  const listCrossings = (path: string): boolean[] | undefined =>
    listCrossingSegments(path, outputSchema);
  const candidates: FilterPushdown[] = [];
  for (const argument of field.args) {
    const argumentType = getNamedType(argument.type);
    if (!isInputObjectType(argumentType)) continue;
    const fields = resolveFilterFields(argumentType, approvedFilterFields, listCrossings);
    if (Object.keys(fields).length === 0) continue;
    const argumentFields = argumentType.getFields();
    const combinators: Partial<Record<"all" | "any" | "none", { name: string; list: boolean }>> = {};
    for (const [combine, names] of Object.entries(COMBINATOR_CANDIDATES) as [
      "all" | "any" | "none",
      readonly string[],
    ][]) {
      const match = names.find((name) => name in argumentFields);
      if (!match) continue;
      // List-ness is read per combinator, not per type: Hasura's `_and` and
      // `_or` take lists while its `_not` beside them takes one bool_exp, and
      // one flag for all three compiled `_not` as a list a real Hasura rejects.
      combinators[combine] = {
        name: match,
        list: isListType(unwrapNonNull(argumentFields[match]!.type)),
      };
    }
    candidates.push({ argument: argument.name, fields, combinators });
  }
  if (candidates.length === 0) return {};
  if (candidates.length > 1) {
    // Two arguments could carry the filter — Saleor's connections declare both
    // `filter` and `where` — and choosing between them would be a guess about
    // which one the upstream narrows by, where a filter sent to the wrong
    // argument is ignored rather than refused. This used to refuse the whole
    // compile, which was the guess-refusal applied at the wrong severity: it
    // read the schema's arguments, never the host's decisions, so no edit to
    // the decisions file could satisfy it, and a host with two such arguments
    // could not compile the capability at all.
    //
    // The host's own statements break the tie instead. An `approvedInputFields`
    // path rooted at one of the candidates names it as the filter surface; so
    // does approving exactly one of them for the planner. Failing both, nothing
    // is pushed and the caller warns — planned filters then run post-fetch over
    // one page, flagged incomplete, which is the documented fallback and what
    // this capability did before push-down existed.
    const namedRoots = new Set(
      (decisions.approvedInputFields ?? []).map((path) => path.split(".")[0]!),
    );
    const named = candidates.filter((candidate) => namedRoots.has(candidate.argument));
    if (named.length === 1) return { pushdown: named[0]! };
    const visitorApproved = candidates.filter((candidate) =>
      decisions.approvedVisitorArguments.includes(candidate.argument),
    );
    if (visitorApproved.length === 1) return { pushdown: visitorApproved[0]! };
    return { ambiguousArguments: candidates.map((candidate) => candidate.argument) };
  }
  return { pushdown: candidates[0]! };
}

/**
 * The host's paging role, checked against the schema before it is trusted.
 *
 * Refused rather than ignored when the root is not an approved argument: a
 * declaration that names something the planner cannot set would silently do
 * nothing, and the host would believe their fetch window was managed.
 */
function pagingRoleFor(
  capabilityId: string,
  field: GraphQLField<unknown, unknown>,
  approved: GraphQlQueryDecisions,
): { pageSize?: readonly string[]; arguments: readonly string[] } | undefined {
  const declared = approved.pagingArguments;
  if (!declared) return undefined;
  const paths = [
    ...(declared.pageSize ? [declared.pageSize] : []),
    ...(declared.pageArguments ?? []),
  ];
  const roots = new Set<string>();
  for (const declaredPath of paths) {
    const path = pagingPath(declaredPath);
    const root = path[0]!;
    if (!approved.approvedVisitorArguments.includes(root)) {
      throw new Error(
        `Capability "${capabilityId}" declares pagingArguments "${declaredPath}", whose ` +
          `argument "${root}" is not in approvedVisitorArguments. A paging argument the ` +
          `planner may not set is one nothing can fill, so the fetch window would stay ` +
          `unmanaged while the declaration suggested otherwise.`,
      );
    }
    if (!field.args.some((argument) => argument.name === root)) {
      throw new Error(
        `Capability "${capabilityId}" declares pagingArguments "${declaredPath}", but ` +
          `"${field.name}" has no argument "${root}".`,
      );
    }
    roots.add(root);
  }
  return {
    ...(declared.pageSize ? { pageSize: pagingPath(declared.pageSize) } : {}),
    // The roots, because source-narrowing facts are stated per argument: a
    // nested page size still means the whole `pagination` argument chooses how
    // much rather than which records qualify.
    arguments: [...roots],
  };
}

function orderingPushdownFor(
  capabilityId: string,
  field: GraphQLField<unknown, unknown>,
  approved: GraphQlQueryDecisions,
): OrderingPushdown | undefined {
  const declared = approved.orderingArgument;
  if (!declared) return undefined;
  const prefix = `Capability "${capabilityId}" declares orderingArgument "${declared.name}"`;

  for (const [key, template] of [
    ["ascending", declared.ascending],
    ["descending", declared.descending],
  ] as const) {
    if (!template.includes(ORDERING_FIELD_TOKEN)) {
      throw new Error(
        `${prefix} with an ${key} template ("${template}") that never names the field. ` +
          `Both templates substitute "${ORDERING_FIELD_TOKEN}" with the approved field name; ` +
          `one without it would send the same value whatever the plan asked to order by.`,
      );
    }
  }

  if (approved.approvedVisitorArguments.includes(declared.name)) {
    throw new Error(
      `${prefix} and also approves it as a visitor argument. Declaring the grammar moves the ` +
        `writing of this value from the planner to the runtime, so the planner must no longer be ` +
        `offered it: remove "${declared.name}" from approvedVisitorArguments. Ordering still ` +
        `reaches the source — the planner asks for it as typed query.sort entries, which is what ` +
        `these templates render.`,
    );
  }

  const argument = field.args.find((candidate) => candidate.name === declared.name);
  if (!argument) {
    throw new Error(
      `${prefix}, which ${field.name} does not accept. Arguments it does accept: ` +
        `${field.args.map((candidate) => candidate.name).join(", ") || "none"}.`,
    );
  }

  if (isNonNullType(argument.type)) {
    throw new Error(
      `${prefix}, whose type ${argument.type.toString()} is non-null. The argument is sent only ` +
        `when a plan asks for ordering, so it has to be omittable. An upstream that requires an ` +
        `ordering expression on every request needs a different arrangement than this.`,
    );
  }

  const named = getNamedType(argument.type);
  if (!isScalarType(named)) {
    throw new Error(
      `${prefix}, whose type ${argument.type.toString()} is ` +
        `${isEnumType(named) ? "an enum" : isInputObjectType(named) ? "an input object" : "not a scalar"}. ` +
        `This declaration exists for ordering arguments whose grammar the schema cannot express; ` +
        `${named.name} expresses it already. Approve "${declared.name}" as a visitor argument ` +
        `instead and the planner is offered the real values.`,
    );
  }

  const list = isListType(argument.type);
  if (list && declared.separator !== undefined) {
    throw new Error(
      `${prefix} with a separator, but ${argument.type.toString()} takes a list: each ordering ` +
        `term is its own element there, so the separator would be rendered inside one of them.`,
    );
  }

  return {
    argument: declared.name,
    ascending: declared.ascending,
    descending: declared.descending,
    ...(declared.separator !== undefined ? { separator: declared.separator } : {}),
    list,
  };
}

function positivePageSize(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function createGraphQlCapabilityRuntime(options: {
  catalog: CapabilityCatalog;
  schema: GraphQlSchemaInput;
  binding: GraphQlOperationBinding;
  transport: GraphQlTransport;
  resolveProvenance: ExecuteApprovedGraphQlRequestOptions["resolveProvenance"];
  permissions?: ReadonlySet<string>;
  /** Injectable clock for freshness enforcement, primarily for host/test determinism. Defaults to the real clock. */
  now?: () => Date;
}): CapabilityRuntime {
  const maximumRows = options.catalog.capabilities.find(
    (capability) => capability.id === options.binding.capabilityId,
  )?.policy.maximumRows;

  return {
    capabilityId: options.binding.capabilityId,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    // Declared so the executor can tell whether ordering reaches the source
    // before it decides what else may be pushed down with it. See
    // `CapabilityRuntime.ordering`.
    ...(options.binding.ordering ? { ordering: options.binding.ordering } : {}),
    // Declared so the executor can tell whether a planned filter reaches the
    // source, which decides whether the fetch bounds the answer and whether an
    // empty result is an answer at all. See `CapabilityRuntime.filter`.
    ...(options.binding.filter ? { filter: options.binding.filter } : {}),
    execute: (input: unknown, context: CapabilityExecutionContext) =>
      executeApprovedGraphQlRequest({
        catalog: options.catalog,
        schema: options.schema,
        binding: options.binding,
        request: {
          capabilityId: options.binding.capabilityId,
          params: connectionPagingParams(
            options.binding,
            input,
            context.limit,
            maximumRows,
          ),
        },
        context: {
          identity: context.identity,
          ...(context.signal ? { signal: context.signal } : {}),
          // Forwarded as the plan's typed terms; the executor renders them into
          // the host's declared spelling after preflight.
          ...(context.sort ? { sort: context.sort } : {}),
          // Forwarded as the plan's typed conditions; the executor compiles them
          // into this upstream's own filter argument after preflight.
          ...(context.filter ? { filter: context.filter } : {}),
          // Forwarded because truncation is relative to the ask: a page that
          // satisfies the plan's own limit is not a cut-short answer, however
          // many rows exist beyond it.
          ...(context.limit !== undefined ? { limit: context.limit } : {}),
          ...(options.permissions ? { permissions: options.permissions } : {}),
        },
        transport: options.transport,
        resolveProvenance: options.resolveProvenance,
        ...(options.now ? { now: options.now } : {}),
      }),
  };
}

// Decisions lifecycle tools live beside the decisions format they operate on.
// Re-exported here so a consumer needs one import path for everything
// decisions-shaped; see decisions.ts for why compile never calls the migration.
export {
  diffGraphQlDecisions,
  migrateGraphQlDecisions,
  rebindGraphQlDecisions,
  type DecisionsBinding,
  type DecisionsDiff,
  type DecisionsMigrationChange,
  type DecisionsMigrationResult,
  type CapabilityDecisionsDiff,
} from "./decisions.js";
