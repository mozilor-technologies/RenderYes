import { findCapability, type CapabilityCatalog } from "@renderyes/capability-catalog";
import type { JsonValue, DataJoin, PlanV3_1 } from "@renderyes/core";
import type { ExecutedPlanData, DataExecutorOptions } from "./index.js";
import { asSuccessRows, mergeProvenance, type ComposedProvenance } from "./compose.js";
import { readField } from "./query.js";

const TO_ONE_CARDINALITIES = new Set(["one-to-one", "many-to-one"]);
const DEFAULT_MAX_COMPOSED_ROWS = 5000;

export type JoinFailureCode =
  | "NO_RELATIONSHIP"
  | "JOIN_TYPE_MISMATCH"
  | "JOIN_CARDINALITY_UNSUPPORTED"
  | "JOIN_INPUT_FAILED"
  | "UNKNOWN_JOIN_INPUT"
  | "JOIN_TOO_LARGE"
  | "JOIN_FIELD_COLLISION";

/**
 * The field contract of a joined row.
 *
 * A join produces a shape no catalog data type declares: every left field,
 * plus each matched right field under a `${join.as}_` prefix. Without this,
 * that shape was only discoverable by inspecting the rows that happened to
 * come back — so a component binding to a joined slot had nothing to validate
 * against, and an unmatched left row (which carries no prefixed fields at all)
 * was indistinguishable from a misspelled binding.
 */
export interface JoinOutputSchema {
  /** Data type id of the left side. Unchanged by the join. */
  leftDataTypeId: string;
  /** Data type id whose fields were prefixed in. */
  rightDataTypeId: string;
  /** The `join.as` value every added field is prefixed with. */
  prefix: string;
  /** Field names carried over from the left row, unprefixed. */
  leftFields: string[];
  /**
   * Fields added from the matched right row, already prefixed — exactly the
   * keys that appear on an enriched row.
   */
  rightFields: string[];
  /**
   * True when at least one left row found no match. Those rows carry none of
   * `rightFields`, so a consumer must treat every prefixed field as optional.
   */
  hasUnmatchedRows: boolean;
}

export interface JoinSuccess {
  ok: true;
  joinId: string;
  data: Array<Record<string, JsonValue>>;
  provenance: ComposedProvenance;
  /** The formal shape of `data`. See `JoinOutputSchema`. */
  outputSchema: JoinOutputSchema;
}

export interface JoinFailure {
  ok: false;
  joinId: string;
  error: { code: JoinFailureCode; message: string; retryable: boolean };
}

export type JoinResult = JoinSuccess | JoinFailure;

/**
 * Enriches each left row with its single related right row's fields through an
 * owner-approved catalog relationship. The join keys come from the catalog
 * (`relationship.from.field` / `relationship.to.field`), never from the plan.
 * To-one only (one-to-one / many-to-one); deterministic and side-effect free.
 */
export function joinExecutedData(input: {
  plan: PlanV3_1;
  executed: ExecutedPlanData;
  catalog: CapabilityCatalog;
  options?: DataExecutorOptions;
}): Record<string, JoinResult> {
  const results: Record<string, JoinResult> = {};
  const maxRows = positiveInteger(
    input.options?.maxComposedRows,
    DEFAULT_MAX_COMPOSED_ROWS,
  );
  const requestsById = new Map(
    input.plan.dataRequests.map((request) => [request.requestId, request]),
  );

  for (const join of input.plan.dataJoins ?? []) {
    results[join.joinId] = joinOne(
      join,
      input.executed,
      input.catalog,
      requestsById,
      maxRows,
    );
  }
  return results;
}

function joinOne(
  join: DataJoin,
  executed: ExecutedPlanData,
  catalog: CapabilityCatalog,
  requestsById: Map<string, { capabilityId: string }>,
  maxRows: number,
): JoinResult {
  const fail = (
    code: JoinFailureCode,
    message: string,
    retryable = false,
  ): JoinFailure => ({
    ok: false,
    joinId: join.joinId,
    error: { code, message, retryable },
  });

  const relationship = catalog.relationships.find(
    (candidate) => candidate.id === join.relationshipId,
  );
  if (!relationship) {
    return fail("NO_RELATIONSHIP", `Unknown relationship "${join.relationshipId}"`);
  }
  if (!TO_ONE_CARDINALITIES.has(relationship.cardinality)) {
    return fail(
      "JOIN_CARDINALITY_UNSUPPORTED",
      `Relationship "${relationship.id}" is ${relationship.cardinality}; only to-one joins are supported`,
    );
  }

  const leftRequest = requestsById.get(join.left);
  const rightRequest = requestsById.get(join.right);
  if (!leftRequest || !rightRequest) {
    return fail("UNKNOWN_JOIN_INPUT", "Join references an unknown data request");
  }
  const leftCapability = findCapability(catalog, leftRequest.capabilityId);
  const rightCapability = findCapability(catalog, rightRequest.capabilityId);
  if (!leftCapability || !rightCapability) {
    return fail("UNKNOWN_JOIN_INPUT", "Join references a capability outside the catalog");
  }
  if (
    leftCapability.output.dataTypeId !== relationship.from.dataTypeId ||
    rightCapability.output.dataTypeId !== relationship.to.dataTypeId
  ) {
    return fail(
      "JOIN_TYPE_MISMATCH",
      `Join inputs (${leftCapability.output.dataTypeId} → ${rightCapability.output.dataTypeId}) do not match relationship ${relationship.from.dataTypeId} → ${relationship.to.dataTypeId}`,
    );
  }

  const left = asSuccessRows(executed.results[join.left]);
  const right = asSuccessRows(executed.results[join.right]);
  if (!left || !right) {
    return fail("JOIN_INPUT_FAILED", "A join input failed to resolve", true);
  }
  if (left.rows.length + right.rows.length > maxRows) {
    return fail(
      "JOIN_TOO_LARGE",
      `Join inputs total ${left.rows.length + right.rows.length} rows, over the ${maxRows} budget`,
    );
  }

  // Index right rows by the catalog-declared join key (first wins on duplicate).
  const rightByKey = new Map<string, Record<string, JsonValue>>();
  for (const row of right.rows) {
    const key = keyOf(row, relationship.to.field);
    if (key !== null && !rightByKey.has(key)) rightByKey.set(key, row);
  }

  // Collected while mapping so the declared schema describes the rows actually
  // produced, rather than what the catalog says should exist. A right row that
  // was fetched but never matched contributes no fields here.
  const leftFields = new Set<string>();
  const rightFields = new Set<string>();
  let hasUnmatchedRows = false;

  // Detected before any row is built, and fatal rather than flagged.
  //
  // The prefix makes a collision unlikely, not impossible: a left row that
  // already carries `agent_name` collides with `as: "agent"` joined to a right
  // field `name`. The previous code assigned straight over it, so the left
  // value silently became the right one — a wrong answer presented as a
  // correct one, invisible in the output because the key still exists and
  // still holds a plausible value. That is worse than an error.
  //
  // A collision is a catalog configuration problem with an obvious fix
  // (choose a different `as`), and it is deterministic: if it happens for one
  // row it happens for every row with a match. So this fails the join rather
  // than degrading it.
  const collision = findFieldCollision(left.rows, rightByKey, join.as);
  if (collision) {
    return fail(
      "JOIN_FIELD_COLLISION",
      `Join "${join.joinId}" would overwrite the left field "${collision}". Choose a different \`as\` prefix.`,
    );
  }

  const data = left.rows.map((leftRow) => {
    for (const field of Object.keys(leftRow)) leftFields.add(field);
    const key = keyOf(leftRow, relationship.from.field);
    const matched = key === null ? undefined : rightByKey.get(key);
    if (!matched) {
      hasUnmatchedRows = true;
      return { ...leftRow };
    }
    const enriched: Record<string, JsonValue> = { ...leftRow };
    for (const [field, value] of Object.entries(matched)) {
      const prefixed = `${join.as}_${field}`;
      rightFields.add(prefixed);
      enriched[prefixed] = value;
    }
    return enriched;
  });

  return {
    ok: true,
    joinId: join.joinId,
    data,
    provenance: mergeProvenance([
      { provenance: left.provenance },
      { provenance: right.provenance },
    ]),
    outputSchema: {
      leftDataTypeId: relationship.from.dataTypeId,
      rightDataTypeId: relationship.to.dataTypeId,
      prefix: join.as,
      leftFields: [...leftFields],
      rightFields: [...rightFields],
      hasUnmatchedRows,
    },
  };
}

function keyOf(row: Record<string, JsonValue>, field: string): string | null {
  const value = readField(row, field);
  if (value === undefined || value === null) return null;
  return `${typeof value}:${JSON.stringify(value)}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

/**
 * The first left-hand field a prefixed right-hand field would overwrite, or
 * undefined when the join is safe.
 *
 * Only rows that actually match are considered: an unmatched left row is
 * returned untouched, so a field name it happens to share with the prefix
 * space is never written over.
 */
function findFieldCollision(
  leftRows: readonly Record<string, JsonValue>[],
  rightByKey: Map<string, Record<string, JsonValue>>,
  prefix: string,
): string | undefined {
  for (const leftRow of leftRows) {
    for (const matched of rightByKey.values()) {
      for (const field of Object.keys(matched)) {
        const prefixed = `${prefix}_${field}`;
        if (Object.prototype.hasOwnProperty.call(leftRow, prefixed)) return prefixed;
      }
      // Right rows share one schema, so one is enough to know the field set.
      break;
    }
  }
  return undefined;
}
