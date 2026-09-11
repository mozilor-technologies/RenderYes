export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type FilterOperator =
  | "eq"
  | "not-eq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "contains"
  | "starts-with"
  | "ends-with"
  | "in"
  | "not-in"
  | "is-null"
  | "is-not-null";

export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  /**
   * Omitted only for is-null and is-not-null. `between` takes an inclusive
   * [min, max] array. Semantic validation against the selected capability and
   * data type happens in the trusted data runtime.
   */
  value?: JsonValue;
}

/**
 * A filter node is either a leaf condition or a nested group, so filters form a
 * tree: `all` = AND, `any` = OR, `none` = NOT(any) / NOR.
 */
export type FilterNode = FilterCondition | FilterGroup;

export interface FilterGroup {
  combine: "all" | "any" | "none";
  conditions: FilterNode[];
}

export interface Sort {
  field: string;
  direction: "asc" | "desc";
}

export type AggregateOp = "count" | "sum" | "average" | "minimum" | "maximum";

/**
 * A single aggregate over a group (or the whole result when no groupBy is set).
 * `field` is required for sum/average/minimum/maximum and omitted for count.
 * `as` names the output column.
 */
export interface Aggregate {
  op: AggregateOp;
  field?: string;
  as: string;
}

/**
 * Model-selectable, transport-neutral operations over one capability result.
 *
 * This is declarative data only. It cannot contain executable code, identity,
 * endpoint details, renderer paths, or references to another request.
 */
export interface QuerySpec {
  filter?: FilterGroup;
  groupBy?: string[];
  aggregates?: Aggregate[];
  sort?: Sort[];
  project?: string[];
  offset?: number;
  limit?: number;
}

/** A model-controlled request for one owner-approved data capability. */
export interface DataRequest {
  requestId: string;
  capabilityId: string;
  params: Record<string, JsonValue>;
  query?: QuerySpec;
}

/** The owner-approved set operations two compatible datasets may combine with. */
export type SetOperation = "union" | "intersection" | "difference";

/**
 * A model-controlled composition of two or more request results into one
 * dataset. Rows are matched by the shared output data type's catalog-declared
 * match key; RenderYes resolves that key at execution time, so it is not part of
 * the wire contract. `inputs` reference top-level dataRequests only (no nested
 * compositions). An optional post-merge query may sort, project, or limit; a
 * filter is not permitted here.
 */
export interface DataComposition {
  compositionId: string;
  operation: SetOperation;
  inputs: string[];
  query?: QuerySpec;
}

/**
 * A model-controlled join that enriches one dataset's rows with a related
 * dataset's fields through an owner-approved catalog relationship. The join keys
 * are never in the wire contract — only the `relationshipId`; the trusted
 * executor resolves the keys from the catalog. `left`/`right` reference
 * top-level dataRequests; joined right fields are namespaced under `as`.
 */
export interface DataJoin {
  joinId: string;
  relationshipId: string;
  left: string;
  right: string;
  as: string;
}

/**
 * A named component data slot bound to one top-level data source: a request
 * result, a composed result, or a joined result.
 */
export type DataBinding =
  { requestId: string } | { compositionId: string } | { joinId: string };

export interface SurfaceNode {
  nodeId: string;
  componentId: string;
  props: Record<string, JsonValue>;
  /**
   * Plan 3.1 only. Keys name component-declared data slots; values may
   * reference a top-level request, composition, or join. The trusted host later
   * chooses the actual A2UI data-model path.
   */
  dataBindings?: Record<string, DataBinding>;
  slots?: Record<string, SurfaceNode[]>;
}

export interface Surface {
  id: string;
  nodes: SurfaceNode[];
}

export interface CatalogReference {
  id: string;
  version: string;
  fingerprint: string;
}

export interface GenerationMetadata {
  providerId: string;
  modelId: string;
  createdAt: string;
  repairCount: number;
  /**
   * Whether the model produced this plan under a provider-enforced response
   * schema (true) or in prompt-embedded JSON mode after the provider rejected
   * the schema (false). Absent means the provider didn't say — a custom
   * provider is not forced to report it. Recorded because the two modes have
   * different reliability characteristics, and a silent fallback made it
   * impossible to tell which mode produced any given plan.
   */
  constrainedDecoding?: boolean;
}

export interface CapabilityCatalogReference {
  id: string;
  version: string;
  hash: string;
}

interface PlanBase {
  planId: string;
  siteId: string;
  sourcePrompt?: string;
  catalog: CatalogReference;
  surfaces: Surface[];
  generation: GenerationMetadata;
}

/** Existing component-only plan. Its persisted wire contract remains valid. */
export interface PlanV3_0 extends PlanBase {
  schemaVersion: "3.0";
  dataCatalog?: never;
  dataRequests?: never;
}

/**
 * Data-aware plan. It persists only catalog identity plus approved capability
 * requests and request-id bindings—never session data, permissions, endpoints,
 * runtime functions, or resolved rows.
 */
export interface PlanV3_1 extends PlanBase {
  schemaVersion: "3.1";
  dataCatalog: CapabilityCatalogReference;
  dataRequests: DataRequest[];
  dataCompositions?: DataComposition[];
  dataJoins?: DataJoin[];
}

export type Plan = PlanV3_0 | PlanV3_1;

export interface PlanDraft {
  surfaces: Surface[];
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
