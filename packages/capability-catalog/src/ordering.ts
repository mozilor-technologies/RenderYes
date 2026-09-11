/**
 * Rendering a plan's ordering into an upstream's own spelling.
 *
 * Every other part of a request vocabulary arrives typed. A filter argument's
 * fields, operators, and value types are all in the schema, so the plan
 * contract offers the planner a closed menu and deterministic code compiles the
 * choice. Ordering is the exception whenever an API types it as an opaque
 * string: the grammar is real, documented, and enforced by the upstream's
 * parser, and none of it is visible to introspection.
 *
 * So the grammar is declared instead — once, by the host, in the artifact where
 * decisions already live — and rendered here. The planner is never asked to
 * spell it. That matters more than it sounds: an upstream that cannot parse an
 * ordering expression usually ignores it rather than failing, which turns "the
 * ten newest" into ten arbitrary rows in a convincing order.
 *
 * Transport-neutral on purpose. Nothing below knows about GraphQL; a REST
 * binding with the same hole in its description has the same shape of answer.
 */

/**
 * One ordering term, as a plan asks for it. Structurally the plan contract's
 * `Sort`, restated because this package does not depend on the plan contract.
 */
export interface OrderingRequest {
  field: string;
  direction: "asc" | "desc";
}

/** The token substituted with the field name in an ordering template. */
export const ORDERING_FIELD_TOKEN = "{field}";

/**
 * A host's declared ordering grammar, resolved against the upstream's schema.
 *
 * `list` is read off the argument's type rather than declared: an argument that
 * takes a list carries each ordering term as its own element, so joining is
 * neither needed nor correct there.
 */
export interface OrderingPushdown {
  argument: string;
  ascending: string;
  descending: string;
  separator?: string;
  list: boolean;
}

/**
 * Whether this ordering can be sent to the source as declared.
 *
 * The answer is no more often than a template alone would suggest, and every
 * `false` here is a case where rendering anyway would send a request the
 * upstream reads differently than we mean:
 *
 *  - A dotted field is a path through the projected row (`author.name`), not an
 *    argument value. Only a top-level approved field is also the upstream's own
 *    field name, and that equality is what makes substitution safe.
 *  - Several terms with nowhere to put the second one cannot be sent partially.
 *    Ordering by A then B is not ordering by A: dropping the tail silently
 *    changes which rows a top-N returns.
 *
 * Both fall back to the ordering the runtime applies over the fetched page,
 * which is what happens today when nothing is declared at all — no worse, and
 * honest about its bounds through the existing narrowing provenance.
 */
export function canPushOrdering(
  pushdown: OrderingPushdown | undefined,
  sort: readonly OrderingRequest[] | undefined,
): boolean {
  if (!pushdown || !sort || sort.length === 0) return false;
  if (sort.some((entry) => entry.field.includes("."))) return false;
  if (sort.length > 1 && !pushdown.list && pushdown.separator === undefined) {
    return false;
  }
  return true;
}

/**
 * The value to send for the ordering argument, or undefined when this ordering
 * cannot be pushed. Callers that have already asked `canPushOrdering` get a
 * value; the check is repeated rather than assumed so the two can never drift.
 */
export function renderOrderingValue(
  pushdown: OrderingPushdown | undefined,
  sort: readonly OrderingRequest[] | undefined,
): string | string[] | undefined {
  if (!pushdown || !canPushOrdering(pushdown, sort)) return undefined;
  const terms = (sort ?? []).map((entry) =>
    (entry.direction === "desc" ? pushdown.descending : pushdown.ascending).split(
      ORDERING_FIELD_TOKEN,
    ).join(entry.field),
  );
  if (pushdown.list) return terms;
  return terms.join(pushdown.separator ?? "");
}
