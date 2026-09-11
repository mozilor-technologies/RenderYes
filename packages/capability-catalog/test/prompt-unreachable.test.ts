import { describe, expect, it } from "vitest";
import {
  compileApprovedGraphQlCatalog,
  createGraphQlCatalogInventory,
} from "../src/graphql.js";

/**
 * A capability the planner can never select, recorded as such.
 *
 * `order(id: ID!)` takes an opaque key. It compiles, publishes and probes
 * correctly, and no prompt will ever reach it — nobody types
 * `T3JkZXI6NGYwMzVlMTY…`. The compile already detected this and only warned, so
 * a coverage report reading the published catalog counted it as answerable for
 * the life of the catalog. The fact now travels on the capability.
 */
const SDL = `
  type Query {
    order(id: ID!): Order
    orders(first: Int): [Order!]!
  }
  type Order { id: ID! number: String! }
`;

function compile(select?: string[]) {
  const draft = createGraphQlCatalogInventory({
    schema: SDL,
    catalog: { id: "shop", version: "1.0.0", description: "A shop." },
    source: { id: "api", label: "API", description: "The endpoint." },
    queries: [
      {
        fieldName: "order",
        capabilityId: "graphql.order",
        purpose: "One order in full.",
        dataTypeId: "Order",
        dataTypeDescription: "An order.",
        resultShape: "entity",
      },
      {
        fieldName: "orders",
        capabilityId: "graphql.orders",
        purpose: "Recent orders for a reader.",
        dataTypeId: "Order",
        dataTypeDescription: "An order.",
        resultShape: "collection",
      },
    ] as never,
  });
  const base = {
    identityArguments: {},
    approvedOutputFields: ["id", "number"],
    requiredOutputFields: ["id"],
    policy: { authentication: "public", maximumRows: 50, timeoutMs: 5_000, cacheTtlSeconds: 0 },
    limits: { maximumSelectionDepth: 4, maximumSelectedFields: 20 },
  };
  const byId: Record<string, unknown> = {
    "graphql.order": { capabilityId: "graphql.order", approvedVisitorArguments: ["id"], ...base },
    "graphql.orders": {
      capabilityId: "graphql.orders",
      approvedVisitorArguments: ["first"],
      ...base,
    },
  };
  // A list rather than a filter, so a capability can appear twice — the other
  // way decisionsFor refuses.
  const queries = (select ?? ["graphql.order", "graphql.orders"]).map((id) => byId[id]);
  return compileApprovedGraphQlCatalog(SDL, draft, {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    queries: queries as never,
  });
}

describe("a capability no prompt can reach", () => {
  it("records the argument on the capability, not only in a warning", () => {
    const { catalog } = compile();
    const detail = catalog.capabilities.find((c) => c.id === "graphql.order");
    expect(detail?.supports?.unknowableArguments).toEqual(["id"]);
  });

  it("leaves a capability whose arguments a visitor can supply unmarked", () => {
    const { catalog } = compile();
    const list = catalog.capabilities.find((c) => c.id === "graphql.orders");
    expect(list?.supports?.unknowableArguments).toBeUndefined();
  });

  it("still warns, and the warning names a remedy that exists", () => {
    const { issues } = compile();
    const warning = issues.find((issue) => issue.path === "graphql.order.arguments");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toMatch(/links from that row/);
  });

  /**
   * The advice used to say "drop this capability", which reads as an instruction
   * to remove it from the decisions file — where it fails, three commands later,
   * with "Decisions must contain exactly one selection". The drop happens at the
   * inventory step, and --queries is an allowlist, so the remedy is to re-run
   * naming what you want rather than naming what you don't.
   */
  /**
   * The other half of the same mistake: the error you land on if you take that
   * advice to the wrong file. It said only "found 0", three commands after the
   * warning that sent you there, so neither message referred to the other.
   */
  it("names where a capability is actually dropped when its decision is missing", () => {
    expect(() => compile(["graphql.orders"])).toThrow(
      /dropped where the inventory is produced, not here/,
    );
    expect(() => compile(["graphql.orders"])).toThrow(/--queries/);
  });

  /**
   * Why the message above only has to explain a missing entry: two entries are
   * refused earlier, by a check that names the real problem. `decisionsFor`
   * therefore only ever sees zero.
   */
  it("refuses a capability decided twice before it reaches that message", () => {
    expect(() => compile(["graphql.order", "graphql.order", "graphql.orders"])).toThrow(
      /duplicate capability selections/,
    );
  });

  it("points the drop at the inventory step, not the decisions file", () => {
    const { issues } = compile();
    const warning = issues.find((issue) => issue.path === "graphql.order.arguments");
    expect(warning?.message).toMatch(/re-run inventory with --queries/);
    expect(warning?.message).toMatch(/allowlist rather than a drop list/);
    expect(warning?.message).not.toMatch(/drop this capability/);
  });
});
