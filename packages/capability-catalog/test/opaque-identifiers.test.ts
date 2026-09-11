import { describe, expect, it } from "vitest";
import {
  compileApprovedGraphQlCatalog,
  createGraphQlCatalogInventory,
} from "../src/graphql.js";

/**
 * An argument that takes an opaque identifier must say so to the planner.
 *
 * The semantic type an output field carries was dropped on the way into the
 * input schema: `order(id:)` reached the planner as `{type: "string"}`, with
 * nothing to distinguish an opaque key from a number a visitor can say. So a
 * plan answered "open order 2486" by putting `2486` where a global id belongs,
 * and the upstream refused it — the same shape on every API with opaque keys,
 * which is most of them.
 *
 * `ID` is the signal, and it is the GraphQL specification's own: an ID is not
 * intended to be human-readable. Nothing here parses, decodes, or builds an
 * identifier for any particular vendor's format — it only labels the argument
 * as one, so the planner can route the visitor's words to a filter instead.
 */

const SDL = `
  type Query {
    "Get one order by its id."
    order(id: ID!): Order
    "List orders."
    orders(first: Int, number: String, customerId: ID): OrderConnection
  }
  type OrderConnection { edges: [OrderEdge!]!  pageInfo: PageInfo! }
  type OrderEdge { cursor: String!  node: Order! }
  type PageInfo { hasNextPage: Boolean!  endCursor: String }
  type Order { id: ID!  number: String! }
`;

function manifest() {
  const draft = createGraphQlCatalogInventory({
    schema: SDL,
    catalog: { id: "shop", version: "1.0.0", description: "Approved order reads." },
    source: { id: "shop-api", label: "Shop", description: "The store's graph." },
    queries: [
      {
        fieldName: "order",
        capabilityId: "graphql.order",
        purpose: "One order in full.",
        dataTypeId: "Order",
        dataTypeDescription: "One order.",
        resultShape: "entity",
        matchKey: "id",
      },
      {
        fieldName: "orders",
        capabilityId: "graphql.orders",
        purpose: "List orders.",
        dataTypeId: "Order",
        dataTypeDescription: "One order.",
        resultShape: "collection",
        matchKey: "id",
        supports: { filterFields: ["number"], sortFields: ["number"] },
      },
    ],
  });
  const policy = { authentication: "public" as const, maximumRows: 50, timeoutMs: 5_000 };
  const limits = { maximumSelectionDepth: 2, maximumSelectedFields: 10 };
  const compiled = compileApprovedGraphQlCatalog(SDL, draft, {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    queries: [
      {
        capabilityId: "graphql.order",
        approvedVisitorArguments: ["id"],
        identityArguments: {},
        approvedOutputFields: ["id", "number"],
        requiredOutputFields: ["id"],
        policy,
        limits,
      },
      {
        capabilityId: "graphql.orders",
        approvedVisitorArguments: ["first", "number", "customerId"],
        identityArguments: {},
        approvedOutputFields: ["id", "number"],
        requiredOutputFields: ["id"],
        policy,
        limits,
      },
    ],
  });
  const propertiesOf = (capabilityId: string) =>
    (
      compiled.plannerManifest.capabilities.find((entry) => entry.id === capabilityId)
        ?.inputSchema as { properties: Record<string, { description?: string }> }
    ).properties;
  return { propertiesOf };
}

describe("opaque identifier arguments announce themselves", () => {
  it("an ID argument carries the rule; a human-facing key does not", () => {
    const { propertiesOf } = manifest();

    // The failing case: this argument is what "open order 2486" was filled into.
    expect(propertiesOf("graphql.order").id?.description).toMatch(/Opaque identifier/);
    expect(propertiesOf("graphql.order").id?.description).toMatch(
      /filter a collection capability instead/,
    );

    const list = propertiesOf("graphql.orders");
    // `number` is the field a visitor actually says out loud. Marking it would
    // be worse than marking nothing: it would push the planner away from the
    // one argument that can answer "order 2486".
    expect(list.number?.description).toBeUndefined();
    expect(list.first?.description).toBeUndefined();
    // Every ID argument, not only a lookup's — a nested `customerId` filter is
    // the same trap one level down.
    expect(list.customerId?.description).toMatch(/Opaque identifier/);
  });
});

/**
 * The shape a reviewer corrects belongs with every other correction.
 *
 * Semantic types, scalar mappings and withheld enum values were all editable
 * in the approval; the result shape was not, because it was an input to the
 * draft and therefore inside `reviewSourceHash`. Correcting it by hand came
 * back as review drift — a message about the schema moving, raised when the
 * reviewer had changed their own mind. Same draft, same hash, corrected shape.
 */
describe("a reviewer can correct the inferred result shape", () => {
  it("the approval's shape wins over the draft's, without touching the hash", () => {
    const draft = createGraphQlCatalogInventory({
      schema: SDL,
      catalog: { id: "shop", version: "1.0.0", description: "Approved order reads." },
      source: { id: "shop-api", label: "Shop", description: "The store's graph." },
      queries: [
        {
          fieldName: "orders",
          capabilityId: "graphql.orders",
          purpose: "List orders.",
          dataTypeId: "Order",
          dataTypeDescription: "One order.",
          resultShape: "collection",
          matchKey: "id",
        },
      ],
    });
    const policy = { authentication: "public" as const, maximumRows: 50, timeoutMs: 5_000 };
    const limits = { maximumSelectionDepth: 2, maximumSelectedFields: 10 };
    const compile = (resultShape?: "collection" | "time-series") =>
      compileApprovedGraphQlCatalog(SDL, draft, {
        schemaVersion: "1.0",
        reviewSourceHash: draft.reviewSourceHash,
        queries: [
          {
            capabilityId: "graphql.orders",
            approvedVisitorArguments: ["first"],
            identityArguments: {},
            approvedOutputFields: ["id", "number"],
            requiredOutputFields: ["id"],
            ...(resultShape ? { resultShape } : {}),
            policy,
            limits,
          },
        ],
      });

    const shapeOf = (compiled: ReturnType<typeof compile>) =>
      compiled.plannerManifest.capabilities.find((entry) => entry.id === "graphql.orders")
        ?.output.shape;

    // Unstated: discovery's inference stands.
    expect(shapeOf(compile())).toBe("collection");
    // Stated: the reviewer overrules it, and the draft is untouched — the same
    // hash compiles both, which is the whole point.
    expect(shapeOf(compile("time-series"))).toBe("time-series");
  });
});
