import { describe, expect, it } from "vitest";
import {
  compileApprovedGraphQlCatalog,
  createGraphQlCatalogInventory,
} from "../src/graphql.js";

/**
 * Two independent limits reject a field that is too deep, and the error used to
 * name the number without saying which file holds it.
 *
 * `inventory --depth <n>` decides what discovery records at all; a capability's
 * `limits.maximumSelectionDepth` in the decisions file decides what may be
 * approved. Raising one when the other is the binding constraint changes
 * nothing, and a cold install spent a round discovering that on money fields —
 * which are always nested, so they meet both limits first.
 */
const SDL = `
  type Query { orders(first: Int): [Order!]! }
  type Order { id: ID! total: Money! }
  type Money { gross: Amount! }
  type Amount { amount: Float! currency: String! }
`;

function compileWithDepth(maximumSelectionDepth: number) {
  const draft = createGraphQlCatalogInventory({
    schema: SDL,
    catalog: { id: "shop", version: "1.0.0", description: "A shop." },
    source: { id: "api", label: "API", description: "The endpoint." },
    queries: [
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
  return compileApprovedGraphQlCatalog(SDL, draft, {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    semanticTypeOverrides: { "Query.orders.total.gross.amount": "money" },
    queries: [
      {
        capabilityId: "graphql.orders",
        approvedVisitorArguments: ["first"],
        identityArguments: {},
        approvedOutputFields: ["id", "total.gross.amount", "total.gross.currency"],
        requiredOutputFields: ["id"],
        policy: { authentication: "public", maximumRows: 50, timeoutMs: 5_000, cacheTtlSeconds: 0 },
        limits: { maximumSelectionDepth, maximumSelectedFields: 20 },
      },
    ] as never,
  });
}

describe("the depth limit says which knob to turn", () => {
  it("names the decisions file, and the other limit it is not", () => {
    expect(() => compileWithDepth(2)).toThrow(/limits\.maximumSelectionDepth/);
    expect(() => compileWithDepth(2)).toThrow(/inventory --depth/);
  });

  it("compiles the deep money field once the limit clears it", () => {
    const { catalog } = compileWithDepth(4);
    expect(catalog.capabilities).toHaveLength(1);
    const order = catalog.dataTypes.find((type) => type.id === "Order");
    expect(JSON.stringify(order)).toContain("amount");
  });
});
