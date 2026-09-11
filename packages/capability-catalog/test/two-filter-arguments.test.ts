import { describe, expect, it } from "vitest";
import {
  compileApprovedGraphQlCatalog,
  createGraphQlCatalogInventory,
} from "../src/graphql.js";

/**
 * A schema with two arguments that could carry the plan's filter.
 *
 * Saleor's connections declare both `filter` (the older API) and `where` (the
 * newer one), and the compile used to refuse the capability outright the moment
 * it saw them — reading the schema's arguments, never the host's decisions, so
 * no edit to the decisions file could satisfy it, and its error named a lever
 * (`filterFields`) the decisions format does not have. A real host could not
 * compile any collection capability at all.
 *
 * The refusal's reasoning was right and its severity was wrong. Choosing
 * between the two *would* be a guess, and a filter sent to the wrong argument
 * is ignored rather than refused — but declining to push sends nothing to any
 * argument. So ambiguity now degrades to the documented fallback (post-fetch,
 * flagged incomplete) with a warning naming two executable tie-breaks, and the
 * host's own statements resolve it: an `approvedInputFields` path rooted at an
 * argument names it as the filter surface, and approving exactly one for the
 * planner does too.
 */

const SDL = `
  type Query {
    orders(first: Int, after: String, filter: OrderFilterInput, where: OrderWhereInput): OrderConnection!
  }
  type OrderConnection {
    edges: [OrderEdge!]!
    pageInfo: PageInfo!
  }
  type OrderEdge {
    node: Order!
    cursor: String!
  }
  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }
  type Order {
    id: ID!
    number: String!
    total: Float!
  }
  input OrderFilterInput {
    number: StringOp
    total: FloatOp
  }
  input OrderWhereInput {
    number: StringOp
    total: FloatOp
  }
  input StringOp {
    eq: String
    contains: String
  }
  input FloatOp {
    gte: Float
    lte: Float
  }
`;

function compile(extras: Record<string, unknown> = {}) {
  const draft = createGraphQlCatalogInventory({
    schema: SDL,
    catalog: { id: "shop", version: "1.0.0", description: "A shop." },
    source: { id: "api", label: "API", description: "The shop's endpoint." },
    queries: [
      {
        fieldName: "orders",
        capabilityId: "graphql.orders",
        purpose: "List orders for a reader.",
        dataTypeId: "Order",
        dataTypeDescription: "One order.",
        resultShape: "collection",
      } as never,
    ],
  });
  return compileApprovedGraphQlCatalog(SDL, draft, {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    semanticTypeOverrides: { "Query.orders.total": "money" },
    queries: [
      {
        capabilityId: "graphql.orders",
        approvedVisitorArguments: ["first", "after"],
        identityArguments: {},
        approvedOutputFields: ["id", "number", "total"],
        requiredOutputFields: ["id"],
        policy: { authentication: "public", maximumRows: 50, timeoutMs: 5_000, cacheTtlSeconds: 0 },
        limits: { maximumSelectionDepth: 4, maximumSelectedFields: 20 },
        ...extras,
      } as never,
    ],
  });
}

describe("two arguments that could carry the filter", () => {
  it("compiles instead of refusing, and warns naming both", () => {
    const { catalog, issues } = compile();
    expect(catalog.capabilities).toHaveLength(1);
    const warning = issues.find(
      (issue) => issue.path === "graphql.orders.filter" && /"filter", "where"/.test(issue.message),
    );
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toMatch(/approvedInputFields/);
    expect(warning?.message).toMatch(/approvedVisitorArguments/);
  });

  it("pushes nothing while ambiguous — the fallback, not a guess", () => {
    const { catalog, bindings } = compile();
    expect(bindings.get("graphql.orders")!.filter).toBeUndefined();
    // The planner keeps the full post-fetch vocabulary: narrowing it to the
    // pushable subset of an argument nobody chose would be the same guess.
    expect(catalog.capabilities[0]!.supports?.sourceFilterFields).toBeUndefined();
    expect(catalog.capabilities[0]!.supports?.filterFields).toContain("number");
  });

  it("an approvedInputFields path rooted at one argument breaks the tie", () => {
    const { bindings, issues } = compile({
      approvedInputFields: ["where.number", "where.total"],
      approvedVisitorArguments: ["first", "after", "where"],
    });
    expect(bindings.get("graphql.orders")).toBeDefined();
    expect(
      issues.find((issue) => /"filter", "where"/.test(issue.message)),
    ).toBeUndefined();
  });

  it("naming an argument without approving it is refused, not a tie-break", () => {
    // approvedInputFields paths must be rooted at an approved argument, so it
    // cannot alone name a filter surface the planner is not given. Pinned
    // because the ambiguity warning must not offer it as a standalone remedy —
    // the executable tie-break is approving the argument, with
    // approvedInputFields narrowing it afterwards.
    expect(() => compile({ approvedInputFields: ["where.number", "where.total"] })).toThrow(
      /rooted at an approved argument/,
    );
  });

  it("approving exactly one of them for the planner breaks the tie too", () => {
    const { catalog, issues } = compile({
      approvedVisitorArguments: ["first", "after", "where"],
    });
    expect(catalog.capabilities).toHaveLength(1);
    expect(
      issues.find((issue) => /"filter", "where"/.test(issue.message)),
    ).toBeUndefined();
  });
});
