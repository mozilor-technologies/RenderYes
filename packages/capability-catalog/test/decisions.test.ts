import { describe, expect, it } from "vitest";
import {
  compileApprovedGraphQlCatalog,
  createGraphQlCatalogInventory,
  diffGraphQlDecisions,
  migrateGraphQlDecisions,
} from "../src/graphql.js";

/**
 * A decisions file is the durable record of a host's review, and it has been
 * cheaper to discard than to keep: when paths became row-relative every
 * existing decisions silently stopped compiling, and the remedy was repeating
 * every click in the review UI. These tests hold the two tools that end that —
 * a migration that reports what it rewrote, and a diff that tells a host what
 * changed underneath their decisions instead of "hash mismatch".
 */

const SDL = `
  type Query {
    orders(first: Int, after: String): OrderCountableConnection
  }
  type OrderCountableConnection {
    edges: [OrderCountableEdge!]!
    pageInfo: PageInfo!
  }
  type OrderCountableEdge { cursor: String!  node: Order! }
  type PageInfo { hasNextPage: Boolean!  endCursor: String }
  type Order {
    id: ID!
    number: String!
    weight: Int!
    total: TaxedMoney
  }
  type TaxedMoney { gross: Money }
  type Money { amount: Float! }
`;

function draftFor(schema: string) {
  return createGraphQlCatalogInventory({
    schema,
    catalog: { id: "shop", version: "1.0.0", description: "Approved reads." },
    source: { id: "shop-api", label: "Shop", description: "The store's graph." },
    queries: [
      {
        fieldName: "orders",
        capabilityId: "graphql.orders",
        purpose: "List orders.",
        dataTypeId: "order",
        dataTypeDescription: "One order.",
        resultShape: "collection",
        matchKey: "id",
      },
    ],
    discoveryMaxDepth: 4,
  });
}

function approvalWith(
  inventory: ReturnType<typeof draftFor>,
  paths: string[],
  overrides?: Record<string, string>,
) {
  return {
    schemaVersion: "1.0" as const,
    reviewSourceHash: inventory.reviewSourceHash,
    ...(overrides ? { semanticTypeOverrides: overrides } : {}),
    queries: [
      {
        capabilityId: "graphql.orders",
        approvedVisitorArguments: ["first", "after"],
        identityArguments: {},
        approvedOutputFields: paths,
        // The same format the approved paths use — an old-format decisions
        // carried the wrapper prefix here too.
        requiredOutputFields: paths.filter((path) => path.endsWith("id")).slice(0, 1),
        policy: {
          authentication: "public" as const,
          maximumRows: 50,
          timeoutMs: 5_000,
          cacheTtlSeconds: 0,
        },
        limits: { maximumSelectionDepth: 4, maximumSelectedFields: 50 },
      },
    ],
  };
}

describe("migrating a pre-connection decisions", () => {
  it("strips the transport prefix and reports every rewrite", () => {
    const inventory = draftFor(SDL);
    // The shape a decisions file exported before connections were read as
    // collections: every field addressed through the wrapper.
    const old = approvalWith(inventory, [
      "edges.node.id",
      "edges.node.number",
      "edges.node.total.gross.amount",
    ]);

    const { decisions, changed } = migrateGraphQlDecisions(old);

    expect(decisions.queries[0]?.approvedOutputFields).toEqual([
      "id",
      "number",
      "total.gross.amount",
    ]);
    expect(decisions.queries[0]?.requiredOutputFields).toEqual(["id"]);
    // Auditable, not silent: each rewrite names itself.
    expect(changed).toHaveLength(4);
    expect(changed[0]).toMatchObject({
      capabilityId: "graphql.orders",
      path: "edges.node.id",
      migratedTo: "id",
    });

    // The point of the exercise: the migrated decisions compiles.
    const compiled = compileApprovedGraphQlCatalog(SDL, inventory, decisions);
    expect(compiled.catalog.capabilities).toHaveLength(1);
  });

  it("leaves a current-format decisions untouched", () => {
    const inventory = draftFor(SDL);
    const current = approvalWith(inventory, ["id", "number"]);
    const { decisions, changed } = migrateGraphQlDecisions(current);
    expect(changed).toEqual([]);
    expect(decisions).toEqual(current);
  });
});

describe("diffing a decisions file against the current schema", () => {
  it("reports what a human needs to decide, before compilation fails on it", () => {
    const inventory = draftFor(SDL);
    const decisions = approvalWith(inventory, [
      "id",
      "number",
      // Unknown semantic type (`Int` named weight) with no override: compile
      // would raise GraphQlSemanticTypeError; the diff says so first.
      "weight",
      // Approved once, since removed upstream.
      "legacyReference",
    ]);

    const diff = diffGraphQlDecisions(inventory, decisions);
    expect(diff.capabilitiesGone).toEqual([]);
    const [orders] = diff.capabilities;

    expect(orders?.missingFromSchema).toEqual(["legacyReference"]);
    // Under-decisions made visible: the fields the host never saw a list of.
    expect(orders?.unapproved.map((entry) => entry.path)).toContain(
      "total.gross.amount",
    );
    expect(orders?.needsSemanticType).toEqual([
      { path: "weight", overrideKey: "Query.orders.weight", type: "Int!" },
    ]);
  });

  it("a decided override clears the gap, and a gone capability is named", () => {
    const inventory = draftFor(SDL);
    const decisions = approvalWith(inventory, ["id", "weight"], {
      "Query.orders.weight": "quantity",
    });
    decisions.queries.push({
      ...decisions.queries[0]!,
      capabilityId: "graphql.customers",
    });

    const diff = diffGraphQlDecisions(inventory, decisions);
    expect(diff.capabilities[0]?.needsSemanticType).toEqual([]);
    expect(diff.capabilitiesGone).toEqual(["graphql.customers"]);
  });

  /**
   * Re-review after the upstream changes is what this diff is for, and it
   * reported only losses: a root query added since the decisions was written
   * appeared nowhere, because the walk iterates the decisions's own entries.
   * The host was left to notice additions by reading the schema — the same
   * silent under-decisions the field-level `unapproved` list exists to prevent,
   * one level up.
   */
  it("names an operation the schema gained since the decisions", () => {
    const inventory = draftFor(SDL);
    const decisions = approvalWith(inventory, ["id"]);
    // The decisions covers only the first capability the inventory reviews.
    decisions.queries = [decisions.queries[0]!];

    const diff = diffGraphQlDecisions(inventory, decisions);
    const reviewed = new Set(decisions.queries.map((entry) => entry.capabilityId));
    const expected = inventory.queries
      .map((query) => query.capabilityId)
      .filter((capabilityId) => !reviewed.has(capabilityId));

    expect(diff.capabilitiesNew).toEqual(expected);
    // Unapproved is a legitimate answer, so this is reported and not a loss.
    expect(diff.capabilitiesGone).toEqual([]);
  });
});
