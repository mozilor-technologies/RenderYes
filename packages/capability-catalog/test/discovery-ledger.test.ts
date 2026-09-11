import { buildSchema, getNamedType, isInterfaceType, isObjectType } from "graphql";
import { describe, expect, it } from "vitest";
import { listGraphQlQueries } from "../src/graphql.js";

/**
 * The completeness invariant for discovery: **every field the schema declares
 * within reach is either on offer or on the ledger.**
 *
 * Discovery drops fields for four honest reasons and used to report them as
 * prose warnings addressed to the place the walk stopped, not to the fields
 * lost. "Output discovery stopped at the configured depth 4" does not tell a
 * host that `amount` exists one hop further on and they are about to approve a
 * currency with no amount — which is the Saleor failure, and it reached a
 * rendered view before anyone noticed.
 *
 * A test asserting "the depth warning is present" would have passed throughout.
 * This one recomputes the schema's own field list and demands the two lists sum
 * to it, so a future exclusion path added without a ledger entry fails here
 * rather than in someone's catalog.
 */

const SDL = `
  type Query {
    orders(first: Int): OrderConnection
    report(id: ID!): Report
    settings: Settings
  }

  type OrderConnection {
    edges: [OrderEdge!]!
    pageInfo: PageInfo!
  }
  type OrderEdge { cursor: String!  node: Order! }
  type PageInfo { hasNextPage: Boolean!  endCursor: String }

  type Order {
    id: ID!
    number: String!
    total: TaxedMoney
    "Requires an argument its schema calls optional nowhere — excluded."
    revenue(period: ReportingPeriod!): Money
    "Polymorphic — excluded, without vetoing the rest of the query."
    createdBy: Actor
    "Cycles back to Order."
    parent: Order
  }

  type TaxedMoney { currency: String!  gross: Money }
  type Money { currency: String!  amount: Float! }

  enum ReportingPeriod { DAY  MONTH }
  union Actor = Staff | App
  type Staff { email: String! }
  type App { name: String! }

  type Report { id: ID!  rows: Int! }
  type Settings { theme: String! }
`;

/**
 * Every field path the schema declares below `typeName`, to `maxDepth`,
 * computed independently of the code under test.
 *
 * Independent on purpose: reusing discovery's own walk would make the test a
 * tautology — it would pass for any pair of lists the implementation happened
 * to produce.
 */
function declaredPaths(
  typeName: string,
  maxDepth: number,
  prefix = "",
  ancestors: readonly string[] = [],
): string[] {
  const schema = buildSchema(SDL);
  const type = schema.getType(typeName);
  if (!isObjectType(type) && !isInterfaceType(type)) return [];
  const depth = prefix ? prefix.split(".").length : 0;
  if (depth >= maxDepth) return [];

  return Object.values(type.getFields()).flatMap((field) => {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    const named = getNamedType(field.type);
    // A cycle terminates the walk here the same way it does in discovery; the
    // field itself is still declared and still has to be accounted for.
    if (!isObjectType(named) && !isInterfaceType(named)) return [path];
    if (ancestors.includes(named.name)) return [path];
    const nested = declaredPaths(named.name, maxDepth, path, [...ancestors, type.name]);
    return nested.length > 0 ? nested : [path];
  });
}

describe("the discovery ledger accounts for every field", () => {
  for (const maxDepth of [2, 3, 4, 5]) {
    it(`sums to the schema's own field list at depth ${maxDepth}`, () => {
      const orders = listGraphQlQueries(SDL, { maximumDiscoveryDepth: maxDepth }).find(
        (query) => query.fieldName === "orders",
      )!;

      const offered = new Set(orders.outputFields.map((field) => field.path));
      const excluded = new Set(orders.exclusions.map((exclusion) => exclusion.path));

      /**
       * Accounted for means: offered; excluded; an ancestor of something
       * offered or excluded (an object field is not itself selectable, but it
       * did not vanish either); or below a field excluded *by a decision about
       * that field* — `revenue.amount` needs no entry of its own once
       * `revenue` is excluded for requiring an argument, and listing it would
       * turn one decision into a subtree.
       *
       * A depth stop is deliberately not such a decision. The parent there is
       * perfectly reachable; it is the children that are missing, and letting
       * the parent stand in for them is exactly the reporting this ledger
       * replaced. Recording only the stopping point fails this line.
       */
      const decidedAway = orders.exclusions
        .filter((exclusion) => exclusion.reason !== "depth")
        .map((exclusion) => exclusion.path);
      const accountedFor = (path: string): boolean =>
        offered.has(path) ||
        excluded.has(path) ||
        [...offered, ...excluded].some((entry) => entry.startsWith(`${path}.`)) ||
        decidedAway.some((entry) => path.startsWith(`${entry}.`));
      // One level *past* the budget, because that is the set the ledger exists
      // to name. Walking to the same depth as discovery would make the check
      // blind to exactly the fields a depth stop loses, and a ledger that
      // recorded only its stopping point would satisfy it.
      const declared = declaredPaths("Order", maxDepth + 1);
      expect(declared.filter((path) => !accountedFor(path))).toEqual([]);

      // And nothing is on both lists — an offered field with an exclusion entry
      // would be a warning about a field the host can approve anyway.
      const both = [...excluded].filter((path) => offered.has(path));
      expect(both).toEqual([]);
    });
  }

  it("names every reason it drops a field, and names the field", () => {
    const orders = listGraphQlQueries(SDL, { maximumDiscoveryDepth: 2 }).find(
      (query) => query.fieldName === "orders",
    )!;
    const by = (reason: string) =>
      orders.exclusions.filter((exclusion) => exclusion.reason === reason);

    expect(by("required-argument").map((entry) => entry.path)).toEqual(["revenue"]);
    expect(by("union").map((entry) => entry.path)).toEqual(["createdBy"]);
    expect(by("recursion").map((entry) => entry.path)).toContain("parent.id");
    // The one that mattered: the depth stop names the fields beyond it rather
    // than only the place it stopped. This is the measured Saleor case — at the
    // stopping depth `total.currency` is approvable and `total.gross.amount` is
    // not, so a host publishes a currency with no amount.
    expect(by("depth").map((entry) => entry.path)).toContain("total.gross.amount");
  });

  it("carries the type, so a reviewer can tell what raising the depth buys", () => {
    const orders = listGraphQlQueries(SDL, { maximumDiscoveryDepth: 2 }).find(
      (query) => query.fieldName === "orders",
    )!;
    const amount = orders.exclusions.find(
      (exclusion) => exclusion.path === "total.gross.amount",
    );
    expect(amount).toMatchObject({ reason: "depth", type: "Float!" });
  });

  it("raising the depth moves a field from the ledger onto the offer", () => {
    // The ledger's purpose, stated as a round trip: a host reads it, raises the
    // depth, and gets exactly the field it named.
    const at = (depth: number) =>
      listGraphQlQueries(SDL, { maximumDiscoveryDepth: depth }).find(
        (query) => query.fieldName === "orders",
      )!;

    expect(at(2).exclusions.map((entry) => entry.path)).toContain("total.gross.amount");
    expect(at(2).outputFields.map((field) => field.path)).not.toContain(
      "total.gross.amount",
    );
    expect(at(3).outputFields.map((field) => field.path)).toContain("total.gross.amount");
    expect(at(3).exclusions.map((entry) => entry.path)).not.toContain(
      "total.gross.amount",
    );
  });

  it("collapses a depth stop into one reviewer note, not one per field", () => {
    // The ledger is per field because that is what a host acts on. The notes
    // are per stop because a fifty-field type behind one depth decision is one
    // thing to read.
    const orders = listGraphQlQueries(SDL, { maximumDiscoveryDepth: 2 }).find(
      (query) => query.fieldName === "orders",
    )!;
    const depthNotes = orders.issues.filter((issue) =>
      issue.message.startsWith("Output discovery stopped"),
    );
    expect(depthNotes).toHaveLength(1);
    expect(depthNotes[0]?.message).toContain("total.gross.amount");
    expect(
      orders.exclusions.filter((exclusion) => exclusion.reason === "depth").length,
    ).toBeGreaterThan(1);
  });
});
