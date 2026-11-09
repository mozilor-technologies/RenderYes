import {
  isListResultShape,
  type PlannerCapability,
  type PlannerManifest,
} from "@renderyes/capability-catalog";
import type {
  DataRequest,
  FilterCondition,
  FilterGroup,
  FilterNode,
  JsonValue,
  PlanV3_1,
  UnderstoodInput,
} from "@renderyes/core";

/**
 * What a plan was narrowed by, read back out of it for the visitor, and the
 * one edit a visitor may make to it.
 *
 * Everything here is a pure function of a validated plan and the planner-safe
 * manifest. Nothing reads a prompt or calls a model, so the summary a visitor
 * sees is exactly what the executor will run, and an edit is checked against
 * the same declared values the catalog publishes.
 */

/** A capability input with a declared closed set of string values. */
export interface EnumeratedInput {
  kind: "param" | "filter";
  name: string;
  label: string;
  multiple: boolean;
  required: boolean;
  options: string[];
  /** Whether each row (or the argument) holds a list of values rather than one. */
  listValued: boolean;
}

/**
 * Ceiling on a declared value list read for the visitor. Far above the 32 the
 * planner contract shows a model, because the contract pays tokens per value
 * on every compose and a visitor's picker does not; bounded so a schema with a
 * vast enum cannot turn every envelope into a dump of it.
 */
const MAX_DECLARED_VALUES = 200;

/** The operators whose values name members of the field's declared set. */
const MEMBERSHIP_OPERATORS = new Set(["eq", "in", "contains"]);

/**
 * The inputs of one capability a visitor may see and change: arguments of the
 * input schema, and (for a list) filter fields the catalog approves for
 * filtering, each only when its schema declares string values.
 *
 * Read from the planner manifest, which by construction holds no session or
 * identity key — so no edit can ever name one, whatever a client sends.
 */
export function enumeratedInputs(
  manifest: PlannerManifest,
  capability: PlannerCapability,
): EnumeratedInput[] {
  const inputs: EnumeratedInput[] = [];
  const inputSchema = capability.inputSchema as Record<string, unknown>;
  const required = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  for (const [name, schema] of Object.entries(propertiesOf(inputSchema))) {
    const options = declaredStrings(schema);
    if (!options) continue;
    inputs.push({
      kind: "param",
      name,
      label: typeof schema.title === "string" && schema.title.trim() ? schema.title.trim() : readable(name),
      multiple: isArraySchema(schema),
      required: required.has(name),
      options,
      listValued: isArraySchema(schema),
    });
  }
  if (!isListResultShape(capability.output.shape)) return inputs;
  const dataType = manifest.dataTypes.find(
    (candidate) => candidate.id === capability.output.dataTypeId,
  );
  if (!dataType) return inputs;
  const fieldSchemas = propertiesOf(dataType.schema as Record<string, unknown>);
  const descriptors = dataType.fields as Record<string, { label?: string }>;
  for (const field of capability.supports?.filterFields ?? []) {
    const schema = fieldSchemas[field];
    const options = schema ? declaredStrings(schema) : undefined;
    if (!schema || !options) continue;
    inputs.push({
      kind: "filter",
      name: field,
      label: descriptors[field]?.label?.trim() || readable(field),
      multiple: true,
      required: false,
      options,
      listValued: isArraySchema(schema),
    });
  }
  return inputs;
}

/**
 * The summary of what a plan's requests were narrowed by, in plan order.
 *
 * An input appears when the request uses it: an argument with a value, or a
 * filter field the request's filter names with `eq`, `in` or `contains`. A
 * field the filter also excludes (`not-eq`, `not-in`, inside a `none` group)
 * is left out, because listing it as "what you asked for" would misstate it.
 */
export function describeUnderstoodInputs(
  manifest: PlannerManifest,
  plan: Pick<PlanV3_1, "dataRequests">,
): UnderstoodInput[] {
  const summary: UnderstoodInput[] = [];
  const capabilities = new Map(
    manifest.capabilities.map((capability) => [capability.id, capability]),
  );
  for (const request of plan.dataRequests ?? []) {
    const capability = capabilities.get(request.capabilityId);
    if (!capability) continue;
    for (const input of enumeratedInputs(manifest, capability)) {
      const read =
        input.kind === "param"
          ? readParam(request.params?.[input.name])
          : readFilterField(request.query?.filter, input.name);
      if (!read) continue;
      const { values, notFound } = classify(read.values, input.options);
      summary.push({
        requestId: request.requestId,
        capabilityId: request.capabilityId,
        kind: input.kind,
        name: input.name,
        label: input.label,
        multiple: input.multiple,
        required: input.required,
        values,
        notFound,
        options: input.options,
        editable: read.editable,
      });
    }
  }
  return summary;
}

/** One visitor edit: the complete set of declared values an input should now hold. */
export interface InputEdit {
  input: "param" | "filter";
  name: string;
  values: readonly string[];
}

export type InputEditResult =
  | { ok: true; request: DataRequest }
  | { ok: false; reason: string };

/**
 * Applies a visitor's edit to one data request, returning a new request.
 *
 * The edit names an input and the complete set of values it should hold. It
 * is refused unless the input is one `enumeratedInputs` lists for the
 * request's capability — which excludes every identity and session key, every
 * argument without declared values, and every field the catalog does not
 * approve for filtering — and unless every value is one the catalog declares,
 * in its own spelling. A filter is rewritten only where `readFilterField`
 * recognised its shape; anything else is refused rather than guessed at.
 *
 * Values the request carried that match nothing ("Texas") stay in the
 * rewritten filter, where they still match nothing, so the visitor keeps
 * seeing them as not found; clearing every declared value removes the
 * condition, and them with it.
 *
 * The caller still validates the result: params against the capability's
 * full input schema, the query against the catalog. This function only makes
 * sure the edit could not have named anything else.
 */
export function applyInputEdit(
  manifest: PlannerManifest,
  request: DataRequest,
  edit: InputEdit,
): InputEditResult {
  const capability = manifest.capabilities.find(
    (candidate) => candidate.id === request.capabilityId,
  );
  if (!capability) {
    return { ok: false, reason: `Capability "${request.capabilityId}" is not approved.` };
  }
  if (edit.input !== "param" && edit.input !== "filter") {
    return { ok: false, reason: `Unknown input kind "${String(edit.input)}".` };
  }
  const input = enumeratedInputs(manifest, capability).find(
    (candidate) => candidate.kind === edit.input && candidate.name === edit.name,
  );
  if (!input) {
    return {
      ok: false,
      reason: `"${String(edit.name)}" is not an input a visitor can change on ${capability.id}.`,
    };
  }
  if (
    !Array.isArray(edit.values) ||
    !edit.values.every((value) => typeof value === "string")
  ) {
    return { ok: false, reason: `Values for ${input.label} must be a list of strings.` };
  }
  const declared = new Set(input.options);
  const outside = edit.values.filter((value) => !declared.has(value));
  if (outside.length > 0) {
    return {
      ok: false,
      reason: `${outside.map((value) => JSON.stringify(value)).join(", ")} ${
        outside.length === 1 ? "is not a value" : "are not values"
      } this site lists for ${input.label}.`,
    };
  }
  const values = [...new Set(edit.values)];
  const next: DataRequest = structuredClone(request);

  if (input.kind === "param") {
    if (values.length === 0) {
      if (input.required) return { ok: false, reason: `${input.label} needs a value.` };
      delete next.params[input.name];
    } else if (input.multiple) {
      next.params[input.name] = values;
    } else if (values.length === 1) {
      next.params[input.name] = values[0];
    } else {
      return { ok: false, reason: `${input.label} takes one value.` };
    }
    return { ok: true, request: next };
  }

  const filter = next.query?.filter;
  const located = locateFilterField(filter, input.name);
  if (located.kind === "unrecognised") {
    return {
      ok: false,
      reason: `${input.label} is combined with other conditions in a way this edit cannot change. Ask again to change it.`,
    };
  }
  const query = { ...(next.query ?? {}) };
  if (located.kind === "absent") {
    if (values.length === 0) return { ok: true, request: next };
    if (filter && filter.combine !== "all") {
      return {
        ok: false,
        reason: `${input.label} cannot be added to this view's filter. Ask again to change it.`,
      };
    }
    // A list-valued field is matched by membership, as the System One draft
    // writes it; a scalar one by equality.
    const added = membershipNode(input.name, values, input.listValued ? "contains" : "eq");
    query.filter = filter
      ? { ...filter, conditions: [...filter.conditions, added] }
      : asGroup(added);
    next.query = query;
    return { ok: true, request: next };
  }

  const kept = values.length === 0 ? [] : [...values, ...located.notFound(input.options)];
  const replacement =
    kept.length === 0 ? undefined : membershipNode(input.name, kept, located.operator);
  if (located.at === "root") {
    if (replacement) query.filter = asGroup(replacement);
    else delete query.filter;
  } else {
    const conditions = [...(filter as FilterGroup).conditions];
    if (replacement) conditions[located.at] = replacement;
    else conditions.splice(located.at, 1);
    if (conditions.length > 0) query.filter = { ...(filter as FilterGroup), conditions };
    else delete query.filter;
  }
  next.query = query;
  return { ok: true, request: next };
}

/** A required argument with declared values that a request leaves unset. */
export interface MissingInput extends EnumeratedInput {
  kind: "param";
  requestId: string;
  capabilityId: string;
}

/**
 * Required arguments the request does not set, split by whether the catalog
 * declares their values. Only the declared kind can be asked for: a question
 * whose answers are the declared values is one a visitor can answer with a
 * pick, and one no answer can make invalid.
 */
export function missingRequiredInputs(
  manifest: PlannerManifest,
  request: DataRequest,
): { declared: MissingInput[]; undeclared: string[] } {
  const capability = manifest.capabilities.find(
    (candidate) => candidate.id === request.capabilityId,
  );
  if (!capability) return { declared: [], undeclared: [] };
  const inputSchema = capability.inputSchema as Record<string, unknown>;
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((name): name is string => typeof name === "string")
    : [];
  const enumerated = enumeratedInputs(manifest, capability);
  const declared: MissingInput[] = [];
  const undeclared: string[] = [];
  for (const name of required) {
    if (request.params?.[name] !== undefined) continue;
    const input = enumerated.find(
      (candidate) => candidate.kind === "param" && candidate.name === name,
    );
    if (input) {
      declared.push({
        ...input,
        kind: "param",
        requestId: request.requestId,
        capabilityId: request.capabilityId,
      });
    } else {
      undeclared.push(name);
    }
  }
  return { declared, undeclared };
}

/* ------------------------------------------------------------------------ */

function readParam(value: JsonValue | undefined): { values: string[]; editable: boolean } | undefined {
  if (typeof value === "string") return { values: [value], editable: true };
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) {
    return { values: value as string[], editable: true };
  }
  return undefined;
}

type Located =
  | { kind: "absent" }
  | { kind: "unrecognised" }
  | {
      kind: "node";
      /** `root` when the whole filter is about this field, else the index in a root `all` group. */
      at: "root" | number;
      operator: "eq" | "in" | "contains";
      values: string[];
      /** The node's values that match none of `options`, in the plan's own words. */
      notFound(options: readonly string[]): string[];
    };

/**
 * Where one field's membership condition sits in a filter, in the shapes an
 * edit can rewrite without changing what the rest of the filter means:
 *
 * - the whole filter is an `any` group of membership leaves on the field;
 * - the filter is an `all` group with exactly one child about the field —
 *   a membership leaf, or an `any` group of membership leaves on it — and no
 *   other mention of it.
 *
 * Anything else that mentions the field is `unrecognised`.
 */
function locateFilterField(filter: FilterGroup | undefined, field: string): Located {
  if (!filter || !mentions(filter, field)) return { kind: "absent" };
  const node = (at: "root" | number, target: FilterNode): Located => {
    const leaves = "combine" in target ? (target.conditions as FilterCondition[]) : [target];
    const values = leaves.flatMap(leafValues);
    const operator = leaves.some((leaf) => leaf.operator === "contains")
      ? "contains"
      : leaves.some((leaf) => leaf.operator === "in")
        ? "in"
        : "eq";
    return {
      kind: "node",
      at,
      operator,
      values,
      notFound: (options) => classify(values, options).notFound,
    };
  };
  if (filter.combine === "any" && filter.conditions.every((child) => isMembershipLeaf(child, field))) {
    return node("root", filter);
  }
  if (filter.combine !== "all") return { kind: "unrecognised" };
  const about = filter.conditions.flatMap((child, index) =>
    isAboutField(child, field) ? [index] : [],
  );
  const elsewhere = filter.conditions.some(
    (child) => !isAboutField(child, field) && mentions(child, field),
  );
  if (about.length !== 1 || elsewhere) return { kind: "unrecognised" };
  return node(about[0], filter.conditions[about[0]]);
}

function readFilterField(
  filter: FilterGroup | undefined,
  field: string,
): { values: string[]; editable: boolean } | undefined {
  const located = locateFilterField(filter, field);
  if (located.kind === "node") {
    return located.values.length > 0 ? { values: located.values, editable: true } : undefined;
  }
  if (located.kind === "absent" || !filter) return undefined;
  // A shape an edit cannot rewrite is still shown when every mention of the
  // field asks for members of it; one that excludes values is not "what was
  // asked for", so it is left out rather than misstated.
  const leaves: FilterCondition[] = [];
  if (!collectPositiveLeaves(filter, field, false, leaves)) return undefined;
  const values = leaves.flatMap(leafValues);
  return values.length > 0 ? { values, editable: false } : undefined;
}

function collectPositiveLeaves(
  node: FilterNode,
  field: string,
  negated: boolean,
  out: FilterCondition[],
): boolean {
  if ("combine" in node) {
    const inner = negated || node.combine === "none";
    return node.conditions.every((child) => collectPositiveLeaves(child, field, inner, out));
  }
  if (node.field !== field) return true;
  if (negated || !MEMBERSHIP_OPERATORS.has(node.operator)) return false;
  out.push(node);
  return true;
}

function isMembershipLeaf(node: FilterNode, field: string): node is FilterCondition {
  return (
    !("combine" in node) &&
    node.field === field &&
    MEMBERSHIP_OPERATORS.has(node.operator) &&
    leafValues(node).length > 0
  );
}

function isAboutField(node: FilterNode, field: string): boolean {
  if (isMembershipLeaf(node, field)) return true;
  return (
    "combine" in node &&
    node.combine === "any" &&
    node.conditions.length > 0 &&
    node.conditions.every((child) => isMembershipLeaf(child, field))
  );
}

function mentions(node: FilterNode, field: string): boolean {
  return "combine" in node
    ? node.conditions.some((child) => mentions(child, field))
    : node.field === field;
}

function leafValues(leaf: FilterCondition): string[] {
  const { value } = leaf;
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

/** The membership condition for `values`, in the operator the plan already used. */
function membershipNode(
  field: string,
  values: readonly string[],
  operator: "eq" | "in" | "contains",
): FilterNode {
  if (operator === "contains") {
    const leaves: FilterCondition[] = values.map((value) => ({ field, operator: "contains", value }));
    return leaves.length === 1 ? leaves[0] : { combine: "any", conditions: leaves };
  }
  if (operator === "in" || values.length > 1) return { field, operator: "in", value: [...values] };
  return { field, operator: "eq", value: values[0] };
}

function asGroup(node: FilterNode): FilterGroup {
  return "combine" in node ? node : { combine: "all", conditions: [node] };
}

/**
 * Splits values into declared ones (in the catalog's spelling) and the rest
 * (in the plan's), comparing the way text filters do: NFKC, trimmed,
 * case-insensitive. So "germany" counts as Germany, and "Texas" as not found.
 */
function classify(
  candidates: readonly string[],
  options: readonly string[],
): { values: string[]; notFound: string[] } {
  const canonical = new Map(options.map((option) => [normalize(option), option]));
  const values: string[] = [];
  const notFound: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = normalize(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const declared = canonical.get(key);
    if (declared !== undefined) values.push(declared);
    else notFound.push(candidate.trim());
  }
  return { values, notFound };
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function propertiesOf(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const bag = schema.properties;
  if (!isPlainRecord(bag)) return {};
  return Object.fromEntries(
    Object.entries(bag).filter((entry): entry is [string, Record<string, unknown>] =>
      isPlainRecord(entry[1]),
    ),
  );
}

/**
 * String values a schema declares, directly or on `items` for a list. `null`
 * is skipped (it means "no value", which a picker does not offer); any other
 * non-string member means the set is not one a visitor picks from by name.
 */
function declaredStrings(schema: Record<string, unknown>): string[] | undefined {
  const source = isArraySchema(schema) && isPlainRecord(schema.items) ? schema.items : schema;
  const declared = source.enum;
  if (!Array.isArray(declared)) return undefined;
  const strings = declared.filter((value) => value !== null);
  if (
    strings.length === 0 ||
    strings.length > MAX_DECLARED_VALUES ||
    !strings.every((value) => typeof value === "string")
  ) {
    return undefined;
  }
  return [...new Set(strings as string[])];
}

function isArraySchema(schema: Record<string, unknown>): boolean {
  return (
    schema.type === "array" || (Array.isArray(schema.type) && schema.type.includes("array"))
  );
}

/** "maxResults" -> "Max results"; "page_size" -> "Page size". */
function readable(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
