/**
 * What a composed view was built from, stated so the visitor can see and
 * correct it.
 *
 * A planner reads a sentence and narrows one or more data requests: a
 * capability argument ("platform: shopify") or a filter value ("regions in
 * Germany, France"). Those choices used to exist only inside the plan, so a
 * visitor who named four places and got answers for three had no way to tell
 * that the fourth matched nothing, or to fix a value the planner misread.
 *
 * Both shapes here are plain data, hand-checked rather than Zod schemas for the
 * same reason as `parseComposeEvent`: this package is imported from both sides
 * of the workspace's Zod 3 / Zod 4 split.
 */

/**
 * One visitor-facing input of one data request, derived in code from the
 * validated plan and the planner-safe catalog. Never written by a model.
 *
 * Only inputs with a declared closed set of values appear: an argument or a
 * filter field whose schema states an `enum` (directly, or on `items` for a
 * list). Identity and session parameters never appear, because the planner
 * manifest these are derived from does not contain them.
 */
export interface UnderstoodInput {
  requestId: string;
  capabilityId: string;
  /** `param`: a capability argument. `filter`: a filter field of the request's query. */
  kind: "param" | "filter";
  /** The argument or field name, as the catalog spells it. */
  name: string;
  /** The catalog's label for it (a field label, a schema title, or the name made readable). */
  label: string;
  /** Whether the input holds several values. */
  multiple: boolean;
  /** Whether the capability requires the argument. Filters are never required. */
  required: boolean;
  /** The declared values in effect, in the catalog's own spelling. */
  values: string[];
  /**
   * Values the request carries that match none of the declared values, in the
   * words the plan used. They narrow nothing — a filter on "Texas" against a
   * list without Texas matches no rows — and are shown so the visitor knows,
   * rather than reading the rest as the whole answer.
   */
  notFound: string[];
  /** Every value the catalog declares for this input: what an edit may choose from. */
  options: string[];
  /**
   * Whether `setInput` can change this input. False when the request's filter
   * combines this field with others in a shape an edit could not rewrite
   * without changing its meaning; the values are still shown.
   */
  editable: boolean;
}

/**
 * A required argument the visitor did not state, asked for on a
 * `needs-clarification` result instead of guessed.
 *
 * The plan it belongs to is complete in every other respect and held by the
 * server under `planId`; nothing is fetched until it is answered. Answering is
 * a `setInput` refinement of that plan with one of `options`, which the server
 * validates against the capability's input schema — no model call.
 */
export interface ClarificationInput {
  /** The held plan to answer against. Owner-scoped like any composed plan. */
  planId: string;
  requestId: string;
  capabilityId: string;
  kind: "param";
  name: string;
  label: string;
  /** The declared values, in the catalog's own spelling. */
  options: string[];
}

const MAX_OPTIONS = 200;

/** A `ClarificationInput` read from untrusted wire data, or `undefined` when malformed. */
export function readClarificationInput(value: unknown): ClarificationInput | undefined {
  if (!isRecord(value)) return undefined;
  const { planId, requestId, capabilityId, kind, name, label, options } = value;
  if (
    !isNonEmptyString(planId) ||
    !isNonEmptyString(requestId) ||
    !isNonEmptyString(capabilityId) ||
    kind !== "param" ||
    !isNonEmptyString(name) ||
    !isNonEmptyString(label) ||
    !isStringList(options, 1)
  ) {
    return undefined;
  }
  return { planId, requestId, capabilityId, kind, name, label, options: [...options] };
}

/** The `UnderstoodInput` entries of untrusted wire data; malformed entries are skipped. */
export function readUnderstoodInputs(value: unknown): UnderstoodInput[] {
  if (!Array.isArray(value)) return [];
  const read: UnderstoodInput[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const {
      requestId,
      capabilityId,
      kind,
      name,
      label,
      multiple,
      required,
      values,
      notFound,
      options,
      editable,
    } = entry;
    if (
      !isNonEmptyString(requestId) ||
      !isNonEmptyString(capabilityId) ||
      (kind !== "param" && kind !== "filter") ||
      !isNonEmptyString(name) ||
      !isNonEmptyString(label) ||
      typeof multiple !== "boolean" ||
      typeof required !== "boolean" ||
      typeof editable !== "boolean" ||
      !isStringList(values, 0) ||
      !isStringList(notFound, 0) ||
      !isStringList(options, 1)
    ) {
      continue;
    }
    read.push({
      requestId,
      capabilityId,
      kind,
      name,
      label,
      multiple,
      required,
      values: [...values],
      notFound: [...notFound],
      options: [...options],
      editable,
    });
  }
  return read;
}

function isStringList(value: unknown, minimum: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= MAX_OPTIONS &&
    value.every((item) => typeof item === "string")
  );
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
