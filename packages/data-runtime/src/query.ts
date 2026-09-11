import type {
  JsonValue,
  Aggregate,
  FilterGroup,
  FilterOperator,
  QuerySpec,
} from "@renderyes/core";

/**
 * Deterministic, transport-neutral query application over an already-validated
 * capability (or composed) result. Shared by the single-request executor and
 * the multi-dataset composition engine so both apply identical semantics.
 */
export function applyValidatedQuery(
  data: unknown,
  query: QuerySpec,
  /**
   * Paths the capability declares a projection may not drop. Unioned into
   * `query.project` rather than validated against it, mirroring what the
   * GraphQL binding already does when it builds the fetch selection: the
   * planner asked for a subset, the host said these are never optional, and
   * both are satisfied by selecting the union.
   */
  requiredFields?: readonly string[],
): JsonValue {
  if (query.project && requiredFields?.length) {
    const project = [...new Set([...query.project, ...requiredFields])];
    if (project.length !== query.project.length) query = { ...query, project };
  }
  const hasListOperation =
    query.filter !== undefined ||
    query.groupBy !== undefined ||
    query.aggregates !== undefined ||
    query.sort !== undefined ||
    query.offset !== undefined ||
    query.limit !== undefined;

  if (!Array.isArray(data)) {
    if (hasListOperation || !isRow(data)) {
      throw new Error("List query requires a collection result");
    }
    return projectRow(data, query.project);
  }

  let rows = data.map((row) => {
    if (!isRow(row)) throw new Error("Collection query requires object rows");
    return row;
  });

  if (query.filter) {
    const group = query.filter;
    rows = rows.filter((row) => evaluateGroup(row, group));
  }

  if (query.groupBy?.length || query.aggregates?.length) {
    rows = aggregateRows(rows, query.groupBy ?? [], query.aggregates ?? []);
  }

  if (query.sort?.length) {
    rows = rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        for (const sort of query.sort ?? []) {
          const leftValue = readField(left.row, sort.field);
          const rightValue = readField(right.row, sort.field);
          const missingComparison = compareMissingValues(leftValue, rightValue);
          if (missingComparison !== 0) return missingComparison;
          const compared = compareValues(leftValue, rightValue);
          if (compared !== 0) {
            return sort.direction === "desc" ? -compared : compared;
          }
        }
        return left.index - right.index;
      })
      .map(({ row }) => row);
  }

  if (query.offset !== undefined || query.limit !== undefined) {
    const start = query.offset ?? 0;
    const end = query.limit !== undefined ? start + query.limit : undefined;
    rows = rows.slice(start, end);
  }

  return rows.map((row) => projectRow(row, query.project));
}

/**
 * Recursively evaluates a filter tree: `all` = AND (every), `any` = OR (some),
 * `none` = NOT-any (NOR). Leaves evaluate via matchesCondition; nested groups
 * recurse.
 */
function evaluateGroup(row: Record<string, JsonValue>, group: FilterGroup): boolean {
  const results = group.conditions.map((node) =>
    "combine" in node
      ? evaluateGroup(row, node)
      : matchesCondition(readField(row, node.field), node.operator, node.value),
  );
  if (group.combine === "any") return results.some(Boolean);
  if (group.combine === "none") return !results.some(Boolean);
  return results.every(Boolean);
}

/**
 * Groups rows by the groupBy tuple (preserving first-appearance order) and
 * emits one row per group: the group-key fields plus one column per aggregate.
 * With no groupBy, produces a single summary row over all input rows.
 */
function aggregateRows(
  rows: Array<Record<string, JsonValue>>,
  groupBy: string[],
  aggregates: Aggregate[],
): Array<Record<string, JsonValue>> {
  const groups: Array<{
    key: Record<string, JsonValue>;
    rows: Array<Record<string, JsonValue>>;
  }> = [];
  const byKey = new Map<string, (typeof groups)[number]>();

  if (groupBy.length === 0) {
    groups.push({ key: {}, rows });
  } else {
    for (const row of rows) {
      const key: Record<string, JsonValue> = {};
      for (const field of groupBy) {
        const value = readField(row, field);
        key[field] = value === undefined ? null : value;
      }
      const keyId = groupBy
        .map((field) => `${typeof key[field]}:${JSON.stringify(key[field])}`)
        .join("|");
      let group = byKey.get(keyId);
      if (!group) {
        group = { key, rows: [] };
        byKey.set(keyId, group);
        groups.push(group);
      }
      group.rows.push(row);
    }
  }

  return groups.map((group) => {
    const out: Record<string, JsonValue> = { ...group.key };
    for (const aggregate of aggregates) {
      out[aggregate.as] = computeAggregate(aggregate, group.rows);
    }
    return out;
  });
}

function computeAggregate(
  aggregate: Aggregate,
  rows: Array<Record<string, JsonValue>>,
): JsonValue {
  if (aggregate.op === "count") return rows.length;
  const field = aggregate.field;
  const values = rows
    .map((row) => (field ? readField(row, field) : undefined))
    .filter((value): value is number => typeof value === "number");
  if (values.length === 0) return null;
  switch (aggregate.op) {
    case "sum":
      return values.reduce((total, value) => total + value, 0);
    case "average":
      return values.reduce((total, value) => total + value, 0) / values.length;
    case "minimum":
      return values.reduce((min, value) => (value < min ? value : min));
    case "maximum":
      return values.reduce((max, value) => (value > max ? value : max));
    default:
      return null;
  }
}

export function isRow(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a catalog field from a row, traversing `.` as a path separator.
 *
 * The catalog's field vocabulary is dotted paths — GraphQL discovery emits
 * nested leaves as `total.open`, and `buildSelectionTree` in
 * `@renderyes/capability-catalog` splits on `.` to build the matching
 * nested GraphQL selection. So an adapter returns a *nested* response
 * (`{total: {open: 62}}`) while every field name naming it is flat text
 * (`"total.open"`). A plain `hasOwnProperty("total.open")` therefore finds
 * nothing, and since `projectRow` drops undefined fields, a capability whose
 * approved fields are all nested projects to `{}` — data fetched, discarded
 * on the way out. Hit in practice on `getOpenSummary`, whose fields all sit
 * under `total.`; capabilities with flat fields were unaffected, which is why
 * this stayed hidden.
 *
 * A literal own-property match still wins, so a key that genuinely contains a
 * dot keeps working.
 */
export function readField(
  row: Record<string, JsonValue>,
  field: string,
): JsonValue | undefined {
  if (Object.prototype.hasOwnProperty.call(row, field)) return row[field];
  if (!field.includes(".")) return undefined;

  let current: JsonValue | undefined = row;
  for (const segment of field.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      // A nested path crossing a list reads the segment from each element —
      // `messages.author` over a list of messages is the list of authors —
      // so a nested field under a collection projects to something usable
      // rather than silently vanishing.
      const mapped: JsonValue[] = current
        .map((item): JsonValue | undefined =>
          isRow(item) ? readField(item, segment) : undefined,
        )
        .filter((value): value is JsonValue => value !== undefined);
      current = mapped.length ? mapped : undefined;
      continue;
    }
    if (!isRow(current)) return undefined;
    current = Object.prototype.hasOwnProperty.call(current, segment)
      ? current[segment]
      : undefined;
  }
  return current;
}

/**
 * Projects a row down to its approved fields, restoring nested shape.
 *
 * `readField` already resolves a dotted path, but writing the result back
 * under the dotted name produced flat literal keys: a capability whose
 * approved fields are `stages.key`, `stages.label`, and `stages.count` came
 * out as three unrelated top-level entries, so a component declaring
 * `stages: [{ key, label, count }]` received nothing it could render. Reading
 * the nested data and then flattening it on the way out is the same loss as
 * not reading it — just later.
 *
 * This is deterministic reshaping of fields the catalog already approved. It
 * cannot introduce a field or a path a plan did not ask for.
 */
export function projectRow(
  row: Record<string, JsonValue>,
  fields: string[] | undefined,
): Record<string, JsonValue> {
  if (!fields) return { ...row };
  const projected: Record<string, JsonValue> = {};
  for (const field of fields) {
    const value = readField(row, field);
    if (value === undefined) continue;
    // A genuine top-level key containing a dot is legitimate, and `readField`
    // gives it priority; preserve that same literal key here so the two stay
    // consistent.
    if (Object.prototype.hasOwnProperty.call(row, field) || !field.includes(".")) {
      projected[field] = value;
      continue;
    }
    writeProjectedPath(projected, field.split("."), value);
  }
  return projected;
}

/**
 * Writes one resolved value into `target` at a dotted path.
 *
 * The array case is what makes a funnel work. `readField` returns a nested
 * path crossing a list as parallel arrays — `stages.key` is every key,
 * `stages.label` every label — so each successive field zips into the
 * same `stages` array by index rather than replacing it, rebuilding the
 * list of objects the source actually returned.
 */
function writeProjectedPath(
  target: Record<string, JsonValue>,
  segments: string[],
  value: JsonValue,
): void {
  const [head, ...remaining] = segments;
  if (head === undefined) return;
  if (remaining.length === 0) {
    target[head] = value;
    return;
  }

  if (Array.isArray(value)) {
    const items: JsonValue[] = Array.isArray(target[head])
      ? (target[head] as JsonValue[])
      : [];
    for (let index = 0; index < value.length; index += 1) {
      const existing = items[index];
      const item: Record<string, JsonValue> = isRow(existing) ? existing : {};
      writeProjectedPath(item, remaining, value[index] as JsonValue);
      items[index] = item;
    }
    target[head] = items;
    return;
  }

  const child: Record<string, JsonValue> = isRow(target[head])
    ? (target[head] as Record<string, JsonValue>)
    : {};
  writeProjectedPath(child, remaining, value);
  target[head] = child;
}

export function jsonEquals(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => jsonEquals(value, right[index]))
    );
  }
  if (isRow(left) && isRow(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          jsonEquals(readField(left, key), readField(right, key)),
      )
    );
  }
  return false;
}

function matchesCondition(
  fieldValue: JsonValue | undefined,
  operator: FilterOperator,
  expected: JsonValue | undefined,
): boolean {
  if (fieldValue === undefined && operator !== "is-null" && operator !== "is-not-null") {
    return false;
  }
  switch (operator) {
    case "eq":
      // A path that crosses a list reads to a list (`readField` maps
      // `categories.title` over the row's categories), so `eq` against a
      // scalar means "any element equals" — the semantics `contains` already
      // has for arrays. Strict equality here made such a field unfilterable:
      // `["Politics"] eq "Politics"` was false for every row, while
      // `filterFields` advertised the path to the planner as filterable.
      // Array-to-array comparison stays exact equality.
      return Array.isArray(fieldValue) && !Array.isArray(expected)
        ? fieldValue.some((value) => filterEquals(value, expected))
        : filterEquals(fieldValue, expected);
    case "not-eq":
      return Array.isArray(fieldValue) && !Array.isArray(expected)
        ? fieldValue.every((value) => !filterEquals(value, expected))
        : !filterEquals(fieldValue, expected);
    case "gt":
      return compareComparable(fieldValue, expected, (value) => value > 0);
    case "gte":
      return compareComparable(fieldValue, expected, (value) => value >= 0);
    case "lt":
      return compareComparable(fieldValue, expected, (value) => value < 0);
    case "lte":
      return compareComparable(fieldValue, expected, (value) => value <= 0);
    case "between":
      return (
        Array.isArray(expected) &&
        expected.length === 2 &&
        compareComparable(fieldValue, expected[0], (value) => value >= 0) &&
        compareComparable(fieldValue, expected[1], (value) => value <= 0)
      );
    case "contains":
      return typeof fieldValue === "string" && typeof expected === "string"
        ? normalizeFilterText(fieldValue).includes(normalizeFilterText(expected))
        : Array.isArray(fieldValue)
          ? fieldValue.some((value) => filterEquals(value, expected))
          : false;
    case "starts-with":
      return typeof fieldValue === "string" && typeof expected === "string"
        ? normalizeFilterText(fieldValue).startsWith(normalizeFilterText(expected))
        : false;
    case "ends-with":
      return typeof fieldValue === "string" && typeof expected === "string"
        ? normalizeFilterText(fieldValue).endsWith(normalizeFilterText(expected))
        : false;
    case "in":
      // Same list-crossing rule as `eq`: a list-valued field is in the set
      // when any of its elements is.
      return Array.isArray(expected)
        ? Array.isArray(fieldValue)
          ? fieldValue.some((field) => expected.some((value) => filterEquals(field, value)))
          : expected.some((value) => filterEquals(fieldValue, value))
        : false;
    case "not-in":
      return Array.isArray(expected)
        ? Array.isArray(fieldValue)
          ? fieldValue.every((field) => expected.every((value) => !filterEquals(field, value)))
          : expected.every((value) => !filterEquals(fieldValue, value))
        : false;
    case "is-null":
      return fieldValue === null || fieldValue === undefined;
    case "is-not-null":
      return fieldValue !== null && fieldValue !== undefined;
  }
}

/**
 * Model-authored text filters use human comparison semantics: Unicode
 * compatibility normalization, surrounding-whitespace removal, and
 * case-insensitive matching. This is deliberately scoped to filter operators;
 * JSON equality, relationship keys, sorting, and non-string values retain
 * their exact behavior.
 */
function normalizeFilterText(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function filterEquals(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): boolean {
  return typeof left === "string" && typeof right === "string"
    ? normalizeFilterText(left) === normalizeFilterText(right)
    : jsonEquals(left, right);
}

function compareComparable(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
  predicate: (comparison: number) => boolean,
): boolean {
  if (
    (typeof left !== "number" && typeof left !== "string") ||
    typeof left !== typeof right
  ) {
    return false;
  }
  return predicate(compareScalars(left, right as number | string));
}

export function compareValues(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): number {
  const leftMissing = left === null || left === undefined;
  const rightMissing = right === null || right === undefined;
  if (leftMissing || rightMissing) {
    if (leftMissing && rightMissing) return 0;
    return leftMissing ? 1 : -1;
  }
  if (
    (typeof left === "number" && typeof right === "number") ||
    (typeof left === "string" && typeof right === "string") ||
    (typeof left === "boolean" && typeof right === "boolean")
  ) {
    return compareScalars(left, right);
  }
  return 0;
}

/**
 * The first place a fetched result contradicts an ordering that was supposed to
 * have been applied to it, or undefined when nothing does.
 *
 * Only meaningful for rows an upstream claims to have ordered — it is how the
 * executor checks a host's declared ordering grammar against what the upstream
 * actually parsed. Uses the same comparators as the local sort above, so a
 * result this accepts is one the local sort would leave alone.
 *
 * Deliberately silent about pairs it cannot judge. A row missing the ordering
 * field is skipped rather than compared, because where an upstream puts nulls
 * is its own convention (first, last, or by collation) and disagreeing with it
 * is not evidence that the ordering was ignored. What remains is a comparison
 * every ordering agrees on: two present, unequal values in the wrong order.
 */
export function firstOrderingViolation(
  rows: readonly Record<string, JsonValue>[],
  sort: readonly { field: string; direction: "asc" | "desc" }[],
): { index: number; field: string } | undefined {
  if (sort.length === 0) return undefined;
  for (let index = 1; index < rows.length; index += 1) {
    for (const entry of sort) {
      const left = readField(rows[index - 1]!, entry.field);
      const right = readField(rows[index]!, entry.field);
      if (left === null || left === undefined) break;
      if (right === null || right === undefined) break;
      const compared = compareValues(left, right);
      // Equal on this term decides nothing; the next term breaks the tie, and
      // the upstream is free to order the tie however it likes if none does.
      if (compared === 0) continue;
      if (entry.direction === "desc" ? compared < 0 : compared > 0) {
        return { index, field: entry.field };
      }
      break;
    }
  }
  return undefined;
}

export function compareMissingValues(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): number {
  const leftMissing = left === null || left === undefined;
  const rightMissing = right === null || right === undefined;
  if (leftMissing === rightMissing) return 0;
  return leftMissing ? 1 : -1;
}

function compareScalars(
  left: number | string | boolean,
  right: number | string | boolean,
): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
