/**
 * Compiling the planner's filter into the upstream's own filter argument.
 *
 * The problem this exists for. Every planned request carried two independently
 * filterable fields: `params`, holding the upstream's native filter argument
 * when the host approved it, and `query.filter`, holding a typed condition tree
 * in this package's own grammar. The first is compiled into the GraphQL query
 * and narrowed by the database. The second was applied in this process, to
 * whatever rows a bounded fetch happened to return. Nothing told the planner
 * which was which, so it chose — and when it chose the grammar sitting beside
 * `sort` and `limit`, seven matching articles out of five hundred became zero
 * rows reported as a success.
 *
 * The planner should never have been choosing. It states intent; deterministic
 * code decides how that intent is executed. So `query.filter` is the only
 * filter it is offered, and this module turns that into the argument the
 * upstream actually accepts.
 *
 * Paths that reach through a relation. `categories.title` is one approved field
 * to the planner and two hops to the upstream, and most dialects publish the
 * second hop: Hasura's `articles_bool_exp` nests `categories_bool_exp` and
 * Prisma nests the related type's filter input inside a quantifier. Payload does
 * not — its relationship operator accepts ids only — so the same path compiles
 * at the source on three dialects and refuses on the fourth, from one rule
 * rather than four. What decides it is what the schema publishes, and what
 * decides the *meaning* of a condition through a to-many relation is the
 * post-fetch engine it has to agree with; see EXISTENTIAL_OPERATORS.
 *
 * Why this needs no host-declared grammar, where ordering did. An ordering
 * argument typed `sort: String` publishes nothing about its spelling, so the
 * host has to declare it. A filter argument publishes everything: the field
 * names, the operator names, and the value types are all input fields in the
 * schema. Reading them is not guessing — the names below are matched against
 * what the schema declares, and an operator the schema does not declare is
 * simply unavailable, never invented.
 */

/** The planner's condition vocabulary, as the planning contract publishes it. */
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
  value?: unknown;
}

export interface FilterGroup {
  combine: "all" | "any" | "none";
  conditions: readonly (FilterCondition | FilterGroup)[];
}

export function isFilterGroup(node: FilterCondition | FilterGroup): node is FilterGroup {
  return (node as FilterGroup).combine !== undefined;
}

/**
 * Operator names to look for, per IR operator, in preference order.
 *
 * Every entry is a name some widely-used schema declares — Payload's
 * `equals`/`not_equals`, Hasura's `_eq`/`_neq`, Prisma and Keystone's
 * `equals`/`gt`, Strapi's `eq`/`ne`. Matching is against what the schema
 * actually declares, so a name in this list that an upstream does not have
 * costs nothing; the operator is then unavailable for that field, which is a
 * fact about the upstream rather than a failure.
 *
 * `between` is absent on purpose: no dialect has one operator for it, and it
 * is compiled as a `gte`/`lte` pair when both exist.
 */
const OPERATOR_NAMES: Readonly<Record<Exclude<FilterOperator, "between" | "is-null" | "is-not-null">, readonly string[]>> = {
  eq: ["equals", "eq", "_eq", "equalTo", "is"],
  "not-eq": ["not_equals", "notEquals", "ne", "_neq", "notEqualTo", "not"],
  gt: ["greater_than", "greaterThan", "gt", "_gt"],
  gte: ["greater_than_equal", "greaterThanOrEqual", "greaterThanOrEqualTo", "gte", "_gte", "ge"],
  lt: ["less_than", "lessThan", "lt", "_lt"],
  lte: ["less_than_equal", "lessThanOrEqual", "lessThanOrEqualTo", "lte", "_lte", "le"],
  // Case-insensitive spellings first: the IR's `contains` serves a visitor's
  // search phrase, where case-sensitivity reads as breakage. `like`-family
  // names compile with wildcard wrapping — see LIKE_PATTERN_OPERATORS.
  contains: ["containsi", "includesInsensitive", "contains", "includes", "_ilike", "ilike", "_like", "like"],
  "starts-with": ["startsWith", "starts_with", "startsWithi", "_starts_with", "beginsWith"],
  "ends-with": ["endsWith", "ends_with", "_ends_with"],
  in: ["in", "_in"],
  "not-in": ["not_in", "notIn", "nin", "_nin"],
};

/**
 * Null tests, which carry their meaning in the value rather than the name.
 *
 * `_is_null: true` and `exists: false` both mean "this field is null", and a
 * table of names alone would compile one of them backwards. The inversion is
 * recorded per name instead of inferred, because getting it wrong returns
 * exactly the rows the visitor did not ask for, in a shape that looks correct.
 */
const NULL_TEST_NAMES: readonly { name: string; nullValue: boolean }[] = [
  { name: "_is_null", nullValue: true },
  { name: "is_null", nullValue: true },
  { name: "isNull", nullValue: true },
  { name: "exists", nullValue: false },
];

/** Combinator names, per IR combine mode, in preference order. */
const COMBINATOR_NAMES: Readonly<Record<"all" | "any" | "none", readonly string[]>> = {
  all: ["AND", "and", "_and"],
  any: ["OR", "or", "_or"],
  none: ["NOT", "not", "_not"],
};

/**
 * Operator names whose value is a SQL LIKE pattern rather than a plain string.
 *
 * Hasura's `_like`/`_ilike` match the *whole* value unless the caller supplies
 * `%` wildcards, so compiling `contains` into them with the raw value silently
 * turns "articles containing Inland" into "articles titled exactly Inland" —
 * zero rows, in a shape that looks like an answer. Payload's `contains`,
 * Strapi's `containsi` and PostGraphile's `includes*` are substring matches
 * natively and take the value untouched. `%` and `_` in the visitor's own value
 * are escaped so a search for "50%" is a search for "50%", not a wildcard.
 */
const LIKE_PATTERN_OPERATORS = new Set(["like", "_like", "ilike", "_ilike"]);

function likePattern(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return `%${value.replace(/([%_\\])/g, "\\$1")}%`;
}

export const OPERATOR_CANDIDATES = OPERATOR_NAMES;
export const NULL_TEST_CANDIDATES = NULL_TEST_NAMES;
export const COMBINATOR_CANDIDATES = COMBINATOR_NAMES;

/**
 * One relation to nest through on the way to a filtered leaf.
 *
 * `list` is read from the *output* schema, not the input: Hasura spells an
 * object relationship and an array relationship with the same nested
 * `bool_exp`, so the input type cannot say whether one related row or many
 * hang off this field, and the row shape can.
 *
 * `some`/`none` are the quantifier field names this relation's own filter input
 * publishes, when it publishes any. Prisma and Keystone do (`some`, `every`,
 * `none`) and reject a bare nesting; Hasura and Strapi publish none and read a
 * nested condition on a to-many relation existentially. Recorded rather than
 * assumed, in both directions.
 */
export interface FilterPathSegment {
  name: string;
  list: boolean;
  some?: string;
  none?: string;
}

/** One approved field's operator vocabulary, as resolved against the schema. */
export interface FilterFieldPushdown {
  /** IR operator -> the input field name this schema spells it with. */
  operators: Readonly<Record<string, string>>;
  /** Present when the schema declares a null test for this field. */
  nullTest?: { name: string; nullValue: boolean };
  /**
   * Relations to nest through, outermost first. Absent for a field the filter
   * input carries at its top level.
   */
  through?: readonly FilterPathSegment[];
}

/**
 * What an IR operator means on a path that crosses a list, where it still
 * means anything at all.
 *
 * These four are the operators the post-fetch engine already reads
 * existentially, and the mapping is taken from its own behaviour rather than
 * chosen here (`matchesCondition` in `@renderyes/data-runtime`): a
 * list-valued field `eq` a scalar is true when *any* element is equal, `in` is
 * true when any element is in the set, and the two negatives are true when
 * *every* element differs — which is the negation of the existential, not an
 * existential over the negation.
 *
 * Everything else is deliberately absent, because pushing it down would change
 * which rows qualify rather than where the narrowing happens:
 *
 * - `gt`/`gte`/`lt`/`lte`/`between` compare a list against a scalar, which
 *   post-fetch is false for every row. A source-side range would start
 *   returning rows that the fetched-page path returns none of.
 * - `contains` over a list is element *membership* post-fetch, not substring,
 *   so compiling it into a `like`/`ilike` inside the relation would widen it.
 * - `starts-with`/`ends-with` over a list are false for every row post-fetch.
 * - `is-null`/`is-not-null` read the list itself, so an empty-but-present
 *   relation is already "not null" and a source-side test on the leaf asks a
 *   different question.
 *
 * The consequence of absence is not a wrong answer: the condition simply does
 * not compile, the caller keeps narrowing after the fetch, and the result is
 * marked for it.
 */
const EXISTENTIAL_OPERATORS: Readonly<Partial<Record<FilterOperator, FilterOperator>>> = {
  eq: "eq",
  in: "in",
  "not-eq": "eq",
  "not-in": "in",
};

/** The two whose existential form has to be negated once compiled. */
const NEGATED_OPERATORS: ReadonlySet<FilterOperator> = new Set<FilterOperator>([
  "not-eq",
  "not-in",
]);

export interface FilterPushdown {
  /** The argument the compiled value is passed as, e.g. "where". */
  argument: string;
  fields: Readonly<Record<string, FilterFieldPushdown>>;
  /**
   * Combinator fields this input type declares, by IR combine mode — each with
   * its own list-ness, because one flag for all three compiled Hasura's
   * `_not` (a single bool_exp) as a list, which a real Hasura rejects while
   * `_and` and `_or` beside it genuinely take lists.
   */
  combinators: Readonly<Partial<Record<"all" | "any" | "none", { name: string; list: boolean }>>>;
}

/**
 * Why a filter could not be compiled, in the words the refusal uses.
 *
 * Returned rather than thrown: the caller decides between refusing the request
 * and narrowing locally, and that decision depends on facts this does not have.
 */
export type FilterPushdownRefusal =
  | { kind: "no-pushdown" }
  | { kind: "unknown-field"; field: string }
  | { kind: "unsupported-operator"; field: string; operator: FilterOperator }
  | { kind: "unsupported-combinator"; combine: "all" | "any" | "none" }
  | { kind: "unsupported-negation"; field: string; operator: FilterOperator };

export type FilterPushdownResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; refusal: FilterPushdownRefusal };

function conditionValue(
  pushdown: FilterPushdown,
  condition: FilterCondition,
): FilterPushdownResult {
  const field = pushdown.fields[condition.field];
  if (!field) return { ok: false, refusal: { kind: "unknown-field", field: condition.field } };

  const through = field.through ?? [];
  const crossesList = through.some((segment) => segment.list);
  // A path through a list keeps only the operators the post-fetch engine also
  // reads existentially; see EXISTENTIAL_OPERATORS for why each of the others
  // would move rows rather than move the work.
  const operator = crossesList
    ? EXISTENTIAL_OPERATORS[condition.operator]
    : condition.operator;
  if (operator === undefined) {
    return {
      ok: false,
      refusal: {
        kind: "unsupported-operator",
        field: condition.field,
        operator: condition.operator,
      },
    };
  }

  // The map key is the approved path, so the input field carrying the operators
  // is its last segment — the same segment `resolveFilterFields` matched
  // against the nested input type, which is why deriving it here cannot
  // disagree with what was resolved.
  const segments = condition.field.split(".");
  const leaf = leafOperator(field, condition, operator, segments[segments.length - 1]!);
  if (!leaf.ok) return leaf;
  if (through.length === 0) return leaf;
  return nestThroughRelations(
    pushdown,
    field,
    condition,
    leaf.value,
    crossesList && NEGATED_OPERATORS.has(condition.operator),
  );
}

/**
 * Wraps a compiled leaf condition in the relations on the way to it.
 *
 * A negated existential is negated *here* rather than at the leaf: "no category
 * is Politics" is `NOT EXISTS(title = Politics)`, and the same condition
 * expressed as `EXISTS(title != Politics)` is true for any post filed under two
 * desks. The negation goes on the outermost list segment when that relation
 * publishes a `none`, and otherwise on the filter's own root negation.
 *
 * Swapping `some` for `none` on that segment is safe because a relation filter
 * that publishes both gives them the same related-type input — Prisma's
 * `some`/`every`/`none` all take the one `WhereInput` — so the leaf resolved
 * through one is valid under the other.
 */
function nestThroughRelations(
  pushdown: FilterPushdown,
  field: FilterFieldPushdown,
  condition: FilterCondition,
  leafValue: Record<string, unknown>,
  negate: boolean,
): FilterPushdownResult {
  const through = field.through ?? [];
  const outermostList = through.findIndex((segment) => segment.list);
  const negateAt = negate && through[outermostList]?.none !== undefined ? outermostList : -1;
  let value: Record<string, unknown> = leafValue;
  for (let index = through.length - 1; index >= 0; index -= 1) {
    const segment = through[index]!;
    if (!segment.list) {
      value = { [segment.name]: value };
      continue;
    }
    const quantifier = index === negateAt ? segment.none : segment.some;
    value = { [segment.name]: quantifier ? { [quantifier]: value } : value };
  }
  if (!negate || negateAt >= 0) return { ok: true, value };

  const none = pushdown.combinators["none"];
  if (!none) {
    return {
      ok: false,
      refusal: {
        kind: "unsupported-negation",
        field: condition.field,
        operator: condition.operator,
      },
    };
  }
  return { ok: true, value: { [none.name]: none.list ? [value] : value } };
}

function leafOperator(
  field: FilterFieldPushdown,
  condition: FilterCondition,
  effectiveOperator: FilterOperator,
  leafName: string,
): FilterPushdownResult {
  if (effectiveOperator === "is-null" || effectiveOperator === "is-not-null") {
    if (!field.nullTest) {
      return {
        ok: false,
        refusal: { kind: "unsupported-operator", field: condition.field, operator: condition.operator },
      };
    }
    const asserted =
      effectiveOperator === "is-null" ? field.nullTest.nullValue : !field.nullTest.nullValue;
    return { ok: true, value: { [leafName]: { [field.nullTest.name]: asserted } } };
  }

  if (effectiveOperator === "between") {
    // No dialect spells this as one operator, so it is the pair — and only when
    // the schema declares both halves. Compiled here rather than refused
    // outright because a range is the most common thing a date question asks
    // for, and both halves are present in every dialect that has either.
    const lower = field.operators["gte"];
    const upper = field.operators["lte"];
    const bounds = Array.isArray(condition.value) ? condition.value : undefined;
    if (!lower || !upper || !bounds || bounds.length !== 2) {
      return {
        ok: false,
        refusal: { kind: "unsupported-operator", field: condition.field, operator: "between" },
      };
    }
    return { ok: true, value: { [leafName]: { [lower]: bounds[0], [upper]: bounds[1] } } };
  }

  const name = field.operators[effectiveOperator];
  if (!name) {
    return {
      ok: false,
      refusal: { kind: "unsupported-operator", field: condition.field, operator: condition.operator },
    };
  }
  const value = LIKE_PATTERN_OPERATORS.has(name) ? likePattern(condition.value) : condition.value;
  return { ok: true, value: { [leafName]: { [name]: value } } };
}

function groupValue(pushdown: FilterPushdown, group: FilterGroup): FilterPushdownResult {
  const parts: Record<string, unknown>[] = [];
  for (const node of group.conditions) {
    const compiled = isFilterGroup(node)
      ? groupValue(pushdown, node)
      : conditionValue(pushdown, node);
    if (!compiled.ok) return compiled;
    parts.push(compiled.value);
  }

  // A single-condition `all` needs no combinator at all, which is what makes
  // the common case work on a schema that declares none.
  if (group.combine === "all" && parts.length === 1) return { ok: true, value: parts[0]! };

  const combinator = pushdown.combinators[group.combine];
  if (!combinator) {
    return { ok: false, refusal: { kind: "unsupported-combinator", combine: group.combine } };
  }
  if (!combinator.list && parts.length > 1) {
    // A single-object combinator (`_not: bool_exp`) holding several conditions:
    // nest them under the type's own "all" so the meaning survives. Without an
    // "all" there is no faithful rendering, and half-applying is worse than
    // refusing.
    const all = pushdown.combinators["all"];
    if (!all) {
      return { ok: false, refusal: { kind: "unsupported-combinator", combine: group.combine } };
    }
    return {
      ok: true,
      value: { [combinator.name]: all.list ? { [all.name]: parts } : { [all.name]: parts[0] } },
    };
  }
  return {
    ok: true,
    value: { [combinator.name]: combinator.list ? parts : parts[0] },
  };
}

/**
 * The upstream's filter argument value for a planned filter, or why not.
 *
 * Deterministic and transport-neutral: given the same pushdown and the same
 * filter it produces the same object, and it knows nothing about how that
 * object reaches the upstream.
 */
export function renderFilterValue(
  pushdown: FilterPushdown | undefined,
  filter: FilterGroup | undefined,
): FilterPushdownResult {
  if (!pushdown || !filter) return { ok: false, refusal: { kind: "no-pushdown" } };
  return groupValue(pushdown, filter);
}

/**
 * Every condition in a planned filter, as field and operator.
 *
 * What a result needs to say about itself once the filter reached the source:
 * *which* column answered. Values are deliberately absent — they are the
 * visitor's own words, and this travels into provenance, logs and rendered
 * surfaces.
 */
export function filterConditionSummary(
  filter: FilterGroup | undefined,
): { field: string; operator: FilterOperator }[] {
  if (!filter) return [];
  const found: { field: string; operator: FilterOperator }[] = [];
  const walk = (group: FilterGroup): void => {
    for (const node of group.conditions) {
      if (isFilterGroup(node)) walk(node);
      else found.push({ field: node.field, operator: node.operator });
    }
  };
  walk(filter);
  return found;
}

/** Whether a planned filter compiles, without building the value. */
export function canPushFilter(
  pushdown: FilterPushdown | undefined,
  filter: FilterGroup | undefined,
): boolean {
  return renderFilterValue(pushdown, filter).ok;
}

/** The refusal, as a sentence naming what the upstream does not offer. */
export function describeFilterRefusal(refusal: FilterPushdownRefusal): string {
  switch (refusal.kind) {
    case "no-pushdown":
      return "This capability has no filter argument the plan's filter could be compiled into.";
    case "unknown-field":
      return `The upstream's filter argument has no field "${refusal.field}".`;
    case "unsupported-operator":
      return `The upstream's filter argument cannot express "${refusal.operator}" on "${refusal.field}".`;
    case "unsupported-combinator":
      return `The upstream's filter argument has no "${refusal.combine}" combinator.`;
    case "unsupported-negation":
      return (
        `"${refusal.operator}" on "${refusal.field}" reads across a related list, so the ` +
        `upstream has to be asked for the rows where no related record matches — and its ` +
        `filter argument publishes neither a "none" quantifier on that relation nor a ` +
        `negation at its root.`
      );
  }
}
