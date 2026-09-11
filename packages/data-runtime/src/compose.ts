import { findCapability, type CapabilityCatalog } from "@renderyes/capability-catalog";
import type {
  JsonValue,
  DataComposition,
  PlanV3_1,
  SetOperation,
} from "@renderyes/core";
import type { ExecutedPlanData, DataExecutorOptions, ExecutionResult } from "./index.js";
import { applyValidatedQuery, isRow, readField } from "./query.js";

const COLLECTION_SHAPES = new Set(["collection", "search-results", "media-collection"]);
const DEFAULT_MAX_COMPOSED_ROWS = 5000;

export type CompositionFailureCode =
  | "COMPOSITION_INPUT_FAILED"
  | "COMPOSITION_TYPE_MISMATCH"
  | "NO_MATCH_KEY"
  | "SET_OP_NOT_SUPPORTED"
  | "NOT_A_COLLECTION"
  | "UNKNOWN_COMPOSITION_INPUT"
  | "INVALID_COMPOSITION_QUERY"
  | "COMPOSITION_TOO_LARGE";

export interface ComposedSourceReference {
  sourceId: string;
  recordUrl?: string;
}

export interface ComposedFreshness {
  asOf: string;
  staleAt?: string;
}

export interface ComposedProvenance {
  sources: ComposedSourceReference[];
  freshness: ComposedFreshness;
}

export interface CompositionSuccess {
  ok: true;
  compositionId: string;
  operation: SetOperation;
  data: Array<Record<string, JsonValue>>;
  provenance: ComposedProvenance;
  /** True when a union tolerated a failed input. */
  partial?: boolean;
  failedInputs?: string[];
}

export interface CompositionFailure {
  ok: false;
  compositionId: string;
  error: {
    code: CompositionFailureCode;
    message: string;
    retryable: boolean;
  };
}

export type CompositionResult = CompositionSuccess | CompositionFailure;

interface ResolvedInput {
  requestId: string;
  rows: Array<Record<string, JsonValue>>;
  provenance?: ComposedProvenance;
}

/**
 * Applies each declared composition over already-executed per-request results.
 * Rows are matched by the shared output data type's catalog-declared `matchKey`
 * — never a plan-supplied key. Provenance and freshness are merged across the
 * contributing results. This is deterministic and side-effect free; it performs
 * no capability execution and touches no session or credentials.
 */
export function composeExecutedData(input: {
  plan: PlanV3_1;
  executed: ExecutedPlanData;
  catalog: CapabilityCatalog;
  options?: DataExecutorOptions;
}): Record<string, CompositionResult> {
  const results: Record<string, CompositionResult> = {};
  const maxRows = positiveInteger(
    input.options?.maxComposedRows,
    DEFAULT_MAX_COMPOSED_ROWS,
  );
  const requestsById = new Map(
    input.plan.dataRequests.map((request) => [request.requestId, request]),
  );

  for (const composition of input.plan.dataCompositions ?? []) {
    results[composition.compositionId] = composeOne(
      composition,
      input.executed,
      input.catalog,
      requestsById,
      maxRows,
    );
  }
  return results;
}

function composeOne(
  composition: DataComposition,
  executed: ExecutedPlanData,
  catalog: CapabilityCatalog,
  requestsById: Map<string, { capabilityId: string }>,
  maxRows: number,
): CompositionResult {
  const fail = (
    code: CompositionFailureCode,
    message: string,
    retryable = false,
  ): CompositionFailure => ({
    ok: false,
    compositionId: composition.compositionId,
    error: { code, message, retryable },
  });

  // 1. Resolve capabilities and confirm the datasets are set-op compatible.
  let sharedDataTypeId: string | undefined;
  for (const requestId of composition.inputs) {
    const request = requestsById.get(requestId);
    if (!request) {
      return fail(
        "UNKNOWN_COMPOSITION_INPUT",
        `Composition input references unknown data request "${requestId}"`,
      );
    }
    const capability = findCapability(catalog, request.capabilityId);
    if (!capability) {
      return fail(
        "UNKNOWN_COMPOSITION_INPUT",
        `No capability "${request.capabilityId}" for input "${requestId}"`,
      );
    }
    if (!COLLECTION_SHAPES.has(capability.output.shape)) {
      return fail(
        "NOT_A_COLLECTION",
        `Capability "${capability.id}" output shape "${capability.output.shape}" is not a collection`,
      );
    }
    if (!capability.supports?.setOperations?.includes(composition.operation)) {
      return fail(
        "SET_OP_NOT_SUPPORTED",
        `Capability "${capability.id}" does not support the "${composition.operation}" set operation`,
      );
    }
    if (sharedDataTypeId === undefined) {
      sharedDataTypeId = capability.output.dataTypeId;
    } else if (sharedDataTypeId !== capability.output.dataTypeId) {
      return fail(
        "COMPOSITION_TYPE_MISMATCH",
        `Composition inputs must share one data type; found "${sharedDataTypeId}" and "${capability.output.dataTypeId}"`,
      );
    }
  }
  if (!sharedDataTypeId) {
    return fail("COMPOSITION_TYPE_MISMATCH", "Composition has no resolvable data type");
  }

  const dataType = catalog.dataTypes.find((type) => type.id === sharedDataTypeId);
  const matchKey = dataType?.matchKey;
  if (!matchKey) {
    return fail(
      "NO_MATCH_KEY",
      `Data type "${sharedDataTypeId}" declares no matchKey for set composition`,
    );
  }

  // 2. Gather results and apply the partial-failure policy.
  const resolved: ResolvedInput[] = [];
  const failedInputs: string[] = [];
  for (const requestId of composition.inputs) {
    const success = asSuccessRows(executed.results[requestId]);
    if (success) {
      resolved.push({ requestId, rows: success.rows, provenance: success.provenance });
    } else {
      failedInputs.push(requestId);
    }
  }

  if (composition.operation === "union") {
    if (resolved.length === 0) {
      return fail(
        "COMPOSITION_INPUT_FAILED",
        "Every union input failed to resolve",
        true,
      );
    }
  } else if (failedInputs.length > 0) {
    return fail(
      "COMPOSITION_INPUT_FAILED",
      `The ${composition.operation} composition cannot proceed while inputs failed: ${failedInputs.join(", ")}`,
      true,
    );
  }

  const totalInputRows = resolved.reduce((sum, input) => sum + input.rows.length, 0);
  if (totalInputRows > maxRows) {
    return fail(
      "COMPOSITION_TOO_LARGE",
      `Composition inputs total ${totalInputRows} rows, over the ${maxRows} budget`,
    );
  }

  // 3. Set semantics keyed by the catalog matchKey.
  let merged: Array<Record<string, JsonValue>>;
  let contributing: ResolvedInput[];
  if (composition.operation === "union") {
    merged = unionRows(resolved, matchKey);
    contributing = resolved;
  } else if (composition.operation === "intersection") {
    merged = intersectionRows(resolved, matchKey);
    contributing = resolved;
  } else {
    merged = differenceRows(resolved, matchKey);
    contributing = resolved.slice(0, 1);
  }

  if (merged.length > maxRows) {
    return fail(
      "COMPOSITION_TOO_LARGE",
      `Composition produced ${merged.length} rows, over the ${maxRows} budget`,
    );
  }

  // 4. Optional post-merge query (sort/project/limit only — filter is rejected by core).
  if (composition.query) {
    const allowedFields = new Set(Object.keys(dataType?.fields ?? {}));
    for (const sort of composition.query.sort ?? []) {
      if (!allowedFields.has(sort.field)) {
        return fail(
          "INVALID_COMPOSITION_QUERY",
          `Data type "${sharedDataTypeId}" does not expose sort field "${sort.field}"`,
        );
      }
    }
    for (const field of composition.query.project ?? []) {
      if (!allowedFields.has(field)) {
        return fail(
          "INVALID_COMPOSITION_QUERY",
          `Data type "${sharedDataTypeId}" does not expose projection field "${field}"`,
        );
      }
    }
    try {
      const queried = applyValidatedQuery(merged, composition.query);
      merged = Array.isArray(queried)
        ? (queried as Array<Record<string, JsonValue>>)
        : [];
    } catch {
      return fail(
        "INVALID_COMPOSITION_QUERY",
        "The composition query is incompatible with the merged result",
      );
    }
  }

  const success: CompositionSuccess = {
    ok: true,
    compositionId: composition.compositionId,
    operation: composition.operation,
    data: merged,
    provenance: mergeProvenance(contributing),
  };
  if (composition.operation === "union" && failedInputs.length > 0) {
    success.partial = true;
    success.failedInputs = failedInputs;
  }
  return success;
}

function unionRows(
  inputs: ResolvedInput[],
  matchKey: string,
): Array<Record<string, JsonValue>> {
  const seen = new Set<string>();
  const out: Array<Record<string, JsonValue>> = [];
  for (const input of inputs) {
    for (const row of input.rows) {
      const key = keyOf(row, matchKey);
      if (key === null || seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

function intersectionRows(
  inputs: ResolvedInput[],
  matchKey: string,
): Array<Record<string, JsonValue>> {
  const [base, ...rest] = inputs;
  if (!base) return [];
  const otherKeySets = rest.map((input) => keySet(input.rows, matchKey));
  const seen = new Set<string>();
  const out: Array<Record<string, JsonValue>> = [];
  for (const row of base.rows) {
    const key = keyOf(row, matchKey);
    if (key === null || seen.has(key)) continue;
    if (otherKeySets.every((set) => set.has(key))) {
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

function differenceRows(
  inputs: ResolvedInput[],
  matchKey: string,
): Array<Record<string, JsonValue>> {
  const [base, ...rest] = inputs;
  if (!base) return [];
  const excluded = new Set<string>();
  for (const input of rest) {
    for (const key of keySet(input.rows, matchKey)) excluded.add(key);
  }
  const seen = new Set<string>();
  const out: Array<Record<string, JsonValue>> = [];
  for (const row of base.rows) {
    const key = keyOf(row, matchKey);
    if (key === null || seen.has(key) || excluded.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function keySet(rows: Array<Record<string, JsonValue>>, matchKey: string): Set<string> {
  const set = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row, matchKey);
    if (key !== null) set.add(key);
  }
  return set;
}

/** A type-tagged, stable key so 1 (number) and "1" (string) never collide. */
function keyOf(row: Record<string, JsonValue>, matchKey: string): string | null {
  const value = readField(row, matchKey);
  if (value === undefined || value === null) return null;
  return `${typeof value}:${JSON.stringify(value)}`;
}

export function mergeProvenance(
  inputs: Array<{ provenance?: ComposedProvenance }>,
): ComposedProvenance {
  const sources: ComposedSourceReference[] = [];
  const seenSources = new Set<string>();
  let asOf: string | undefined;
  let staleAt: string | undefined;

  for (const input of inputs) {
    const provenance = input.provenance;
    if (!provenance) continue;
    for (const source of provenance.sources ?? []) {
      if (!source || seenSources.has(source.sourceId)) continue;
      seenSources.add(source.sourceId);
      sources.push(
        source.recordUrl
          ? { sourceId: source.sourceId, recordUrl: source.recordUrl }
          : { sourceId: source.sourceId },
      );
    }
    const freshness = provenance.freshness;
    if (freshness?.asOf && (asOf === undefined || freshness.asOf < asOf)) {
      asOf = freshness.asOf;
    }
    if (freshness?.staleAt && (staleAt === undefined || freshness.staleAt < staleAt)) {
      staleAt = freshness.staleAt;
    }
  }

  const freshness: ComposedFreshness = { asOf: asOf ?? new Date(0).toISOString() };
  if (staleAt !== undefined) freshness.staleAt = staleAt;
  return { sources, freshness };
}

export function asSuccessRows(
  result: ExecutionResult | undefined,
): { rows: Array<Record<string, JsonValue>>; provenance?: ComposedProvenance } | null {
  if (!result || result.ok !== true) return null;
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const rows = data.filter(isRow);
  const provenance = (result as { provenance?: ComposedProvenance }).provenance;
  return { rows, provenance };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
