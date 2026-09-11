import { describe, expect, it } from "vitest";
import { validateCapabilityPreflight } from "../src/validate-data.js";
import { createDataPlanningContract, createPlannerManifest } from "../src/index.js";
import {
  compileApprovedGraphQlCatalog,
  compileCuratedGraphQlCatalog,
  compileGraphQlOperation,
  createGraphQlCapabilityRuntime,
  createGraphQlCatalogInventory,
  executeApprovedGraphQlRequest,
  GraphQlSemanticTypeError,
  listGraphQlQueries,
  relayConnectionInfo,
} from "../src/graphql.js";
import { buildSchema } from "graphql";
import { relayConformanceTransport } from "./relay-conformance.js";

/**
 * Relay connections, which is every list field on a Relay-shaped API —
 * Saleor, Shopify, GitHub, Hasura. On one such schema 37 of 90 root fields are
 * connections, and before this the whole class silently delivered one object
 * and zero rows: a `collection` capability over thousands of records where
 * nothing could filter, sort, or count.
 *
 * The wrapper also spent two of the discovery depth levels, so a money field
 * one hop inside a row reached `total.currency` and never `total.gross.amount`
 * — a currency with no amount, which reads as data rather than as a gap.
 */

const SDL = `
  type Query {
    orders(first: Int, after: String, channel: String): OrderCountableConnection
    order(id: ID!): Order
  }

  type OrderCountableConnection {
    edges: [OrderCountableEdge!]!
    pageInfo: PageInfo!
    totalCount: Int
  }

  type OrderCountableEdge {
    cursor: String!
    node: Order!
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  type Order {
    id: ID!
    number: String!
    status: String!
    total: TaxedMoney
  }

  type TaxedMoney {
    currency: String!
    gross: Money
  }

  type Money {
    currency: String!
    amount: Float!
  }
`;

const schema = SDL;

describe("relayConnectionInfo", () => {
  it("recognises a connection by shape, not by type name", () => {
    const built = buildSchema(SDL);
    const orders = built.getQueryType()!.getFields()["orders"]!;
    expect(relayConnectionInfo(orders.type)).toEqual({
      edgesField: "edges",
      nodeField: "node",
      nodeTypeName: "Order",
      hasPageInfo: true,
      // Only the cursor fields this schema declares — selecting one it lacks
      // would invalidate the whole query.
      pageInfoFields: ["hasNextPage", "hasPreviousPage", "startCursor", "endCursor"],
      cursorField: "cursor",
      // Detected on the same terms as the cursor fields: present in the schema,
      // and numeric. It is what lets a truncated result say "100 of 2,500"
      // rather than "100 of many".
      totalCountField: "totalCount",
    });
  });

  it("ignores a totalCount the schema does not declare as a number", () => {
    // A `String` total would serialise fine and then be reported as a row
    // count, so the shape check is the guard rather than the field's name.
    const nonNumeric = buildSchema(`
      type Order { id: ID! }
      type OrderEdge { node: Order!, cursor: String! }
      type OrderConnection { edges: [OrderEdge!]!, totalCount: String! }
      type Query { orders: OrderConnection! }
    `);
    const orders = nonNumeric.getQueryType()!.getFields()["orders"]!;
    expect(relayConnectionInfo(orders.type)?.totalCountField).toBeUndefined();
  });

  it("does not mistake a plain object for a connection", () => {
    const built = buildSchema(SDL);
    const order = built.getQueryType()!.getFields()["order"]!;
    expect(relayConnectionInfo(order.type)).toBeUndefined();
  });
});

describe("discovery through a connection", () => {
  const queries = () => listGraphQlQueries(schema, { maximumDiscoveryDepth: 4 });
  const orders = () => queries().find((query) => query.fieldName === "orders")!;

  it("reports row-relative paths, not transport paths", () => {
    const paths = orders().outputFields.map((field) => field.path);
    expect(paths).toContain("number");
    expect(paths).toContain("total.gross.amount");
    expect(paths.some((path) => path.startsWith("edges."))).toBe(false);
  });

  it("reaches a money field the wrapper used to put out of depth range", () => {
    // The measured Saleor failure: at depth 4 `total.currency` was reachable
    // and `total.gross.amount` was not, so a host published orders with a
    // currency and no amount.
    const atThree = listGraphQlQueries(schema, { maximumDiscoveryDepth: 3 })
      .find((query) => query.fieldName === "orders")!
      .outputFields.map((field) => field.path);
    expect(atThree).toContain("total.gross.amount");
  });

  /**
   * What the *default* depth reaches, with nothing passed.
   *
   * Every other test in this file sets `maximumDiscoveryDepth` explicitly, so
   * lowering the default would leave all of them green while quietly narrowing
   * what a real host is offered — a host never passes it.
   *
   * Kept because a decision rests on it. Raising the default was proposed on
   * the strength of the comment at the top of this file, which says the wrapper
   * spends two depth levels; that describes the state before `discoveredFrom`
   * unwrapped the connection first. The proposal was dropped after measuring
   * this, and a measurement that decides something should not be a number
   * someone once saw in a terminal.
   *
   * A local schema rather than the shared one above: `SDL` is three levels deep
   * and feeds eleven describe blocks, several asserting exact field sets.
   */
  it("reaches four levels inside a row at the default depth", () => {
    const deep = `
      type City { name: String! }
      type Address { city: City!, line1: String! }
      type Customer { name: String!, defaultAddress: Address! }
      type Row { id: ID!, customer: Customer! }
      type RowEdge { node: Row!, cursor: String! }
      type RowConnection { edges: [RowEdge!]!, totalCount: Int }
      type Query { rows: RowConnection! }
    `;
    const paths = listGraphQlQueries(deep)
      .find((query) => query.fieldName === "rows")!
      .outputFields.map((field) => field.path);

    // Four hops from the row, through a wrapper that now costs nothing.
    expect(paths).toContain("customer.defaultAddress.city.name");
    expect(paths).toContain("customer.defaultAddress.line1");
    expect(paths).toContain("customer.name");
  });

  it("offers no wrapper plumbing as a selectable field", () => {
    // `edges` and `pageInfo` were reaching the planner as sortable fields.
    const paths = orders().outputFields.map((field) => field.path);
    expect(paths).not.toContain("pageInfo");
    expect(paths).not.toContain("edges");
    expect(paths.some((path) => path.includes("cursor"))).toBe(false);
  });

  it("declares the connection a collection and records how to unwrap it", () => {
    expect(orders().suggestedResultShape).toBe("collection");
    expect(orders().connection?.nodeTypeName).toBe("Order");
    expect(orders().support.status).toBe("supported");
  });
});

/** Approve the fields a "list recent orders" view needs. */
function approvedCatalog(
  policyOverrides: { maximumRows?: number; maximumPageSize?: number } = {},
) {
  const draft = createGraphQlCatalogInventory({
    schema,
    catalog: { id: "shop", version: "1.0.0", description: "Approved order reads." },
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
  return compileApprovedGraphQlCatalog(schema, draft, {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    queries: [
      {
        capabilityId: "graphql.orders",
        approvedVisitorArguments: ["first", "after"],
        identityArguments: {},
        approvedOutputFields: ["id", "number", "total.gross.amount"],
        requiredOutputFields: ["id"],
        policy: {
          authentication: "public",
          maximumRows: policyOverrides.maximumRows ?? 50,
          ...(policyOverrides.maximumPageSize !== undefined
            ? { maximumPageSize: policyOverrides.maximumPageSize }
            : {}),
          timeoutMs: 5_000,
          cacheTtlSeconds: 0,
        },
        limits: { maximumSelectionDepth: 4, maximumSelectedFields: 50 },
      },
    ],
  });
}

describe("the page cap is stated where the planner can see it", () => {
  // `connectionPagingParams` clamps a `first` this package derives itself, but
  // deliberately never one the planner set. With the input schema unbounded,
  // the planner could set `first: 1000` against an upstream capped at 100 —
  // valid at plan time, rejected outright at execution ("exceeds the 'first'
  // limit of 100"). The ceiling now lives in the schema: the contract tells
  // the model up front, and a draft that ignores it fails validation into the
  // repair loop instead of burning the visitor's request.
  function firstArgument(compiled: ReturnType<typeof approvedCatalog>) {
    const capability = compiled.catalog.capabilities[0]!;
    return (
      capability.inputSchema as {
        properties: Record<string, { minimum?: number; maximum?: number }>;
      }
    ).properties.first!;
  }

  it("bounds the approved `first` by the declared maximumPageSize", () => {
    const first = firstArgument(approvedCatalog({ maximumPageSize: 250 }));
    expect(first.maximum).toBe(250);
    expect(first.minimum).toBe(1);
  });

  it("assumes the conservative Relay cap when the host declared none", () => {
    // The same 100 that connectionPagingParams clamps derived pages to —
    // stating a different number here would let the planner promise a page
    // the executor would then shrink.
    expect(firstArgument(approvedCatalog()).maximum).toBe(100);
  });
});

describe("compiling a connection query", () => {
  it("puts the wrapper back around the approved row fields", () => {
    const draft = approvedCatalog();
    const operation = compileGraphQlOperation(
      schema,
      draft.bindings.get("graphql.orders")!,
      { capabilityId: "graphql.orders", params: { first: 3 } },
      {},
    );

    expect(operation.document).toContain("edges {");
    expect(operation.document).toContain("node {");
    expect(operation.document).toContain("pageInfo {");
    // The approved field sits inside the wrapper, addressed as the row knows it.
    expect(operation.document).toMatch(/node \{[\s\S]*gross[\s\S]*\}/);
    expect(operation.variables).toEqual({ first: 3 });
  });

  it("validates the response as an array of rows", () => {
    const draft = approvedCatalog();
    const operation = compileGraphQlOperation(
      schema,
      draft.bindings.get("graphql.orders")!,
      { capabilityId: "graphql.orders", params: {} },
      {},
    );
    expect(operation.outputSchema).toMatchObject({ type: "array" });
  });
});

describe("executing a connection query", () => {
  const draft = () => approvedCatalog();

  const run = (data: unknown) => {
    const compiled = draft();
    return executeApprovedGraphQlRequest({
      catalog: compiled.catalog,
      schema,
      binding: compiled.bindings.get("graphql.orders")!,
      request: { capabilityId: "graphql.orders", params: { first: 2 } },
      context: { identity: {} },
      transport: async () => ({ data }),
      resolveProvenance: () => ({
        sources: [{ sourceId: "shop-api" }],
        freshness: { asOf: "2026-08-13T10:00:00.000Z" },
      }),
    });
  };

  const response = {
    orders: {
      pageInfo: {
        hasNextPage: true,
        hasPreviousPage: false,
        startCursor: "c1",
        endCursor: "c2",
      },
      edges: [
        { cursor: "c1", node: { id: "1", number: "2500", total: { gross: { amount: 42.5 } } } },
        { cursor: "c2", node: { id: "2", number: "2499", total: { gross: { amount: 17 } } } },
      ],
    },
  };

  it("delivers rows, not the envelope", async () => {
    const result = await run(response);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toHaveLength(2);
    expect((result.data as { number: string }[])[0]?.number).toBe("2500");
  });

  it("drops an edge whose node the viewer cannot read", async () => {
    // Relay permits a null node; a null row would fail output validation for a
    // reason unrelated to the host's schema.
    const result = await run({
      orders: {
        pageInfo: { hasNextPage: false },
        edges: [{ cursor: "c1", node: null }, { cursor: "c2", node: { id: "2", number: "1", total: { gross: { amount: 1 } } } }],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(1);
  });

  it("reports a response that is not a connection instead of passing it on", async () => {
    const result = await run({ orders: { nope: true } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/not a connection/);
  });

  it("an empty connection is an empty collection, not a failure", async () => {
    const result = await run({ orders: { pageInfo: { hasNextPage: false }, edges: [] } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });
});

/**
 * GraphQL is explicitly partial: a resolver error nulls its own field and the
 * response carries `data` and `errors` together. Treating any `errors` entry as
 * total failure discarded every row and every other field over one broken
 * column — and the column that breaks this way is not hypothetical. Saleor
 * declares `ProductVariant.revenue`'s `period` argument optional and its
 * resolver requires it, so an approved, published, correctly-selected field
 * errors on every row indefinitely.
 *
 * These pin the line between "a field failed" and "the request failed", because
 * the second one must still fail: degrading everything would serve a response
 * nobody can trust as though it were data.
 */
describe("partial data with field errors", () => {
  const runWith = (
    data: unknown,
    errors: { message: string; path?: (string | number)[] }[],
  ) => {
    const compiled = approvedCatalog();
    return executeApprovedGraphQlRequest({
      catalog: compiled.catalog,
      schema,
      binding: compiled.bindings.get("graphql.orders")!,
      request: { capabilityId: "graphql.orders", params: { first: 2 } },
      context: { identity: {} },
      transport: async () => ({ data, errors }),
      resolveProvenance: () => ({
        sources: [{ sourceId: "shop-api" }],
        freshness: { asOf: "2026-08-13T10:00:00.000Z" },
      }),
    });
  };

  /** Two rows whose money resolver failed, exactly as an upstream returns it. */
  const withNulledMoney = {
    orders: {
      pageInfo: { hasNextPage: false },
      edges: [
        { cursor: "c1", node: { id: "1", number: "2500", total: { gross: null } } },
        { cursor: "c2", node: { id: "2", number: "2499", total: { gross: null } } },
      ],
    },
  };

  it("serves the rows and names the field that failed", async () => {
    const result = await runWith(withNulledMoney, [
      {
        message: 'Argument "period" of required type "ReportingPeriod!" was not provided.',
        path: ["orders", "edges", 0, "node", "total", "gross", "amount"],
      },
      {
        message: 'Argument "period" of required type "ReportingPeriod!" was not provided.',
        path: ["orders", "edges", 1, "node", "total", "gross", "amount"],
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
    expect((result.data as { number: string }[])[0]?.number).toBe("2500");
    // Row-relative and de-duplicated: the same broken column on forty rows is
    // one thing to fix, and it is addressed the way the host approved it —
    // never as `edges.0.node.total.gross.amount`.
    expect(result.provenance.degradedFields).toEqual(["total.gross.amount"]);
  });

  it("a clean response reports no degradation at all", async () => {
    // The absence matters: `degradedFields` present and empty would make every
    // consumer's truthiness check wrong in the opposite direction.
    const result = await runWith(
      {
        orders: {
          pageInfo: { hasNextPage: false },
          edges: [
            { cursor: "c1", node: { id: "1", number: "2500", total: { gross: { amount: 5 } } } },
          ],
        },
      },
      [],
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provenance.degradedFields).toBeUndefined();
  });

  it("still fails when a required field is what broke", async () => {
    // `id` is the match key. A row without it is not a row that lost a column,
    // it is a record with no identity, and handing that to a component is worse
    // than reporting the failure.
    const result = await runWith(withNulledMoney, [
      { message: "id resolver exploded", path: ["orders", "edges", 0, "node", "id"] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("GRAPHQL_EXECUTION_ERROR");
      expect(result.error.message).toMatch(/required output field/);
    }
  });

  it("still fails on an error with no path", async () => {
    // Parse, validation and auth errors arrive without one. There is no field
    // to attribute them to and nothing about the response can be trusted.
    const result = await runWith(withNulledMoney, [{ message: "Unauthenticated." }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("GRAPHQL_EXECUTION_ERROR");
  });

  it("still fails when the error is on the wrapper rather than a row", async () => {
    // `pageInfo` failing means the paging state is unknown, so "no next page"
    // would be a claim the response does not support.
    const result = await runWith(withNulledMoney, [
      { message: "cursor backend down", path: ["orders", "pageInfo", "endCursor"] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/cursor backend down/);
  });

  it("still fails when the errors nulled the whole result", async () => {
    // A non-null field error bubbles up. If it reaches the root there is
    // nothing left to serve, however field-shaped the error path looked.
    const result = await runWith({ orders: null }, [
      {
        message: "boom",
        path: ["orders", "edges", 0, "node", "total", "gross", "amount"],
      },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("GRAPHQL_EXECUTION_ERROR");
  });

  it("still fails when the error names a different root field entirely", async () => {
    const result = await runWith(withNulledMoney, [
      { message: "unrelated", path: ["customers", 0, "email"] },
    ]);
    expect(result.ok).toBe(false);
  });
});

describe("paging a connection", () => {
  const runtimeFor = (
    limit: number | undefined,
    params: Record<string, unknown> = {},
    policyOverrides: { maximumRows?: number; maximumPageSize?: number } = {},
  ) => {
    const compiled = approvedCatalog(policyOverrides);
    const documents: Record<string, unknown>[] = [];
    const runtime = createGraphQlCapabilityRuntime({
      catalog: compiled.catalog,
      schema,
      binding: compiled.bindings.get("graphql.orders")!,
      transport: async (request) => {
        documents.push({ variables: request.variables });
        return { data: { orders: { pageInfo: { hasNextPage: false }, edges: [] } } };
      },
      resolveProvenance: () => ({
        sources: [{ sourceId: "shop-api" }],
        freshness: { asOf: "2026-08-13T10:00:00.000Z" },
      }),
    });
    return runtime
      .execute(params, {
        identity: {},
        ...(limit === undefined ? {} : { limit }),
      })
      .then(() => documents[0]?.variables as Record<string, unknown>);
  };

  it("asks the upstream for only as many rows as the plan wants", async () => {
    // A Relay API pages by `first`; without this a plan wanting 10 rows fetched
    // the upstream's default page and trimmed it here.
    expect(await runtimeFor(10)).toMatchObject({ first: 10 });
  });

  it("does not override a page size the planner chose itself", async () => {
    // An approved argument the planner filled is a decision; this is a default.
    expect(await runtimeFor(10, { first: 3 })).toMatchObject({ first: 3 });
  });

  it("falls back to the capability's own row ceiling when the plan set no limit", async () => {
    // This used to send nothing, on the assumption that a limitless request
    // gets the upstream's default page. Relay defines no default page, and an
    // API may reject a connection naming neither `first` nor `last` — Saleor
    // does — so a limitless plan was invalid rather than merely unbounded.
    expect(await runtimeFor(undefined)).toMatchObject({ first: 50 });
  });

  it("falls back rather than sending a nonsensical limit", async () => {
    expect(await runtimeFor(0)).toMatchObject({ first: 50 });
    expect(await runtimeFor(-5)).toMatchObject({ first: 50 });
  });

  /**
   * A page cap and a row budget are different quantities, and the first version
   * of the fallback above conflated them: with `maximumRows: 1000` it asked for
   * `first: 1000` and the API rejected the request outright — "Requesting 1000
   * records on the `orders` connection exceeds the `first` limit of 100
   * records". Caps are the norm (Saleor and GitHub 100, Shopify 250) and are
   * not discoverable from the schema, so an undeclared one is assumed.
   */
  it("clamps a row budget to the assumed page cap", async () => {
    expect(await runtimeFor(undefined, {}, { maximumRows: 1_000 })).toMatchObject({
      first: 100,
    });
  });

  it("clamps a plan limit above the cap too", async () => {
    expect(await runtimeFor(500, {}, { maximumRows: 1_000 })).toMatchObject({ first: 100 });
  });

  it("honours a page cap the host declared", async () => {
    expect(
      await runtimeFor(undefined, {}, { maximumRows: 1_000, maximumPageSize: 250 }),
    ).toMatchObject({ first: 250 });
    // And never sends more than the rows it is willing to hold.
    expect(
      await runtimeFor(undefined, {}, { maximumRows: 20, maximumPageSize: 250 }),
    ).toMatchObject({ first: 20 });
  });

  it("discloses that a capped page left rows behind", async () => {
    const compiled = approvedCatalog({ maximumRows: 1_000 });
    const runtime = createGraphQlCapabilityRuntime({
      catalog: compiled.catalog,
      schema,
      binding: compiled.bindings.get("graphql.orders")!,
      // 2,500 rows behind a 100-row cap: the case where a host sees a clean
      // page and no sign of the rest.
      transport: relayConformanceTransport({ rows: manyOrders(2_500) }),
      resolveProvenance: () => ({
        sources: [{ sourceId: "shop-api" }],
        freshness: { asOf: "2026-08-13T10:00:00.000Z" },
      }),
    });

    const result = await runtime.execute({}, { identity: {} });
    expect(result.ok).toBe(true);
    // 100 clean-looking rows out of thousands, presented as the whole answer,
    // is the wrong answer rather than a smaller one.
    if (result.ok) expect(result.provenance.truncated).toBe(true);
    // And the schema knew the real number all along. `pageInfo` cannot supply
    // it — the upstream returned exactly the 100 rows it was asked for, so the
    // row budget never trips — which is why a visitor saw "100 of many" against
    // a connection perfectly willing to say 2,500.
    if (result.ok) expect(result.provenance.totalRowsBeforeTruncation).toBe(2_500);
    // Both facts, because they are different facts: the dataset goes on
    // (`moreAvailable`) and this answer fell short of the ask (`truncated`).
    if (result.ok) expect(result.provenance.moreAvailable).toBe(true);
  });

  it("does not call an answer truncated when the plan's own limit was met", async () => {
    // The plan asked for 10, the page delivered 10. 2,490 more exist — which is
    // `moreAvailable`, the routine condition of any bounded question over a
    // large collection. Calling this `truncated` was the old behaviour, and it
    // fired on nearly every bounded question: noise that made a genuinely
    // cut-short answer indistinguishable from a request that got exactly what
    // it asked for.
    const compiled = approvedCatalog({ maximumRows: 1_000 });
    const runtime = createGraphQlCapabilityRuntime({
      catalog: compiled.catalog,
      schema,
      binding: compiled.bindings.get("graphql.orders")!,
      transport: relayConformanceTransport({ rows: manyOrders(2_500) }),
      resolveProvenance: () => ({
        sources: [{ sourceId: "shop-api" }],
        freshness: { asOf: "2026-08-13T10:00:00.000Z" },
      }),
    });

    const result = await runtime.execute({}, { identity: {}, limit: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(10);
      expect(result.provenance.moreAvailable).toBe(true);
      expect(result.provenance.truncated).toBeUndefined();
      // No truncation, so no "of 2,500" claim either — the answer is whole.
      expect(result.provenance.totalRowsBeforeTruncation).toBeUndefined();
    }
  });

  it("claims no total when the page was not truncated", async () => {
    const compiled = approvedCatalog({ maximumRows: 1_000 });
    const runtime = createGraphQlCapabilityRuntime({
      catalog: compiled.catalog,
      schema,
      binding: compiled.bindings.get("graphql.orders")!,
      // Fewer rows than the cap, so the answer is complete.
      transport: relayConformanceTransport({ rows: manyOrders(3) }),
      resolveProvenance: () => ({
        sources: [{ sourceId: "shop-api" }],
        freshness: { asOf: "2026-08-13T10:00:00.000Z" },
      }),
    });

    const result = await runtime.execute({}, { identity: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance.truncated).not.toBe(true);
      // A complete result's total is its row count. Writing it into
      // `totalRowsBeforeTruncation` would assert a truncation that never
      // happened, and a component would render "3 of 3" as if rows were cut.
      expect(result.provenance.totalRowsBeforeTruncation).toBeUndefined();
    }
  });

  /**
   * The fixture transport answers whatever document it is handed, so nothing in
   * this suite reproduced the upstream rule that made the omission fatal. Green
   * tests, broken feature. This one refuses the request the way the real API
   * does.
   */
  it("satisfies an upstream that requires first or last", async () => {
    const compiled = approvedCatalog();
    const runtime = createGraphQlCapabilityRuntime({
      catalog: compiled.catalog,
      schema,
      binding: compiled.bindings.get("graphql.orders")!,
      transport: relayConformanceTransport({ rows: manyOrders(1) }),
      resolveProvenance: () => ({
        sources: [{ sourceId: "shop-api" }],
        freshness: { asOf: "2026-08-13T10:00:00.000Z" },
      }),
    });

    const result = await runtime.execute({}, { identity: {} });
    expect(result.ok, "a plan with no limit must still be a valid request").toBe(true);
    if (result.ok) expect(result.data).toHaveLength(1);
  });
});

describe("curated mode against a large schema", () => {
  const WIDE = `
    type Query {
      orders(first: Int): OrderCountableConnection
      stock: Stock
    }
    type OrderCountableConnection {
      edges: [OrderCountableEdge!]!
      pageInfo: PageInfo!
    }
    type OrderCountableEdge { cursor: String!  node: Order! }
    type PageInfo { hasNextPage: Boolean!  endCursor: String }
    type Order { id: ID!  number: String! }
    type Stock {
      ${Array.from({ length: 40 }, (_, index) => `f${index}: String`).join("\n      ")}
    }
  `;

  const compileWide = (maximumSelectedFields: number) =>
    compileCuratedGraphQlCatalog({
      schema: WIDE,
      catalog: { id: "shop", version: "1.0.0", description: "Curated reads." },
      source: { id: "shop-api", label: "Shop", description: "The store's graph." },
      policy: {
        authentication: "public",
        maximumRows: 50,
        timeoutMs: 5_000,
        cacheTtlSeconds: 0,
        maximumSelectedFields,
        maximumSelectionDepth: 4,
      },
    });

  it("excludes the query that exceeds the shared limit and keeps the rest", () => {
    // One field-heavy type used to abort the whole catalog, forcing every
    // large-schema host onto field-by-field review of everything.
    const result = compileWide(10);
    const ids = result.catalog.capabilities.map((capability) => capability.id);
    expect(ids).toContain("graphql.orders");
    expect(ids).not.toContain("graphql.stock");
  });

  it("names the excluded query and what to do about it", () => {
    const result = compileWide(10);
    const excluded = result.issues.filter((issue) => issue.severity === "error");
    expect(excluded).toHaveLength(1);
    expect(excluded[0]?.message).toMatch(/"stock" exposes 40 fields/);
    expect(excluded[0]?.message).toMatch(/Raise the limit|detailed review/);
  });

  it("still refuses when the limits exclude everything", () => {
    // Excluding every query is not a catalog; that is a misconfiguration.
    expect(() => compileWide(1)).toThrow(/No query in this curated GraphQL API fits/);
  });
});

describe("recursive filter inputs", () => {
  // The shape every modern filter API uses — Saleor's `where`, Hasura, Prisma.
  // Refusing it outright made "point it at your GraphQL API" false for all of
  // them; only a legacy flat `filter` worked.
  const RECURSIVE = `
    type Query {
      orders(where: OrderWhereInput, first: Int): OrderCountableConnection
    }
    input OrderWhereInput {
      AND: [OrderWhereInput!]
      OR: [OrderWhereInput!]
      status: StatusFilter
    }
    input StatusFilter { eq: String  oneOf: [String!] }
    type OrderCountableConnection {
      edges: [OrderCountableEdge!]!
      pageInfo: PageInfo!
    }
    type OrderCountableEdge { cursor: String!  node: Order! }
    type PageInfo { hasNextPage: Boolean!  endCursor: String }
    type Order { id: ID!  number: String! }
  `;

  const compileWhere = () => {
    const draft = createGraphQlCatalogInventory({
      schema: RECURSIVE,
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
    return compileApprovedGraphQlCatalog(RECURSIVE, draft, {
      schemaVersion: "1.0",
      reviewSourceHash: draft.reviewSourceHash,
      queries: [
        {
          capabilityId: "graphql.orders",
          approvedVisitorArguments: ["where", "first"],
          identityArguments: {},
          approvedOutputFields: ["id", "number"],
          requiredOutputFields: ["id"],
          policy: {
            authentication: "public",
            maximumRows: 50,
            timeoutMs: 5_000,
            cacheTtlSeconds: 0,
          },
          limits: { maximumSelectionDepth: 4, maximumSelectedFields: 50 },
        },
      ],
    });
  };

  const whereSchema = () => {
    const capability = compileWhere().catalog.capabilities.find(
      (entry) => entry.id === "graphql.orders",
    )!;
    return (capability.inputSchema as { properties: Record<string, unknown> }).properties
      .where as Record<string, unknown>;
  };

  const paramsSchema = () =>
    compileWhere().catalog.capabilities.find((entry) => entry.id === "graphql.orders")!
      .inputSchema as Record<string, unknown>;

  // Nullable inputs are wrapped as anyOf[schema, null] — unwrap to the real
  // variant whatever its type is, not just objects. A recursive type is now a
  // reference into the params root, so resolve that too: the shape is the same
  // shape, written once instead of at every level.
  const objectAt = (
    schema: Record<string, unknown>,
    params?: Record<string, unknown>,
  ): Record<string, unknown> => {
    const anyOf = schema.anyOf as Record<string, unknown>[] | undefined;
    const unwrapped = (anyOf?.find((entry) => entry.type !== "null") ?? schema) as Record<
      string,
      unknown
    >;
    const ref = unwrapped.$ref;
    if (typeof ref !== "string") return unwrapped;
    const defs = (params ?? paramsSchema()).$defs as Record<string, Record<string, unknown>>;
    return defs[ref.replace("#/$defs/", "")]!;
  };

  it("compiles a self-referential filter instead of refusing it", () => {
    expect(() => compileWhere()).not.toThrow();
    const root = objectAt(whereSchema());
    expect(Object.keys(root.properties as object).sort()).toEqual([
      "AND",
      "OR",
      "status",
    ]);
  });

  it("writes the recursive type once, as a definition the argument references", () => {
    // What this replaces: the type was written out again at every level until
    // the depth budget stopped it — the same fields, the same operator objects,
    // down every combinator branch. On a real host that duplication was 93% of
    // the planning contract, and it was never information.
    const params = paramsSchema();
    const where = whereSchema();
    const anyOf = where.anyOf as Record<string, unknown>[] | undefined;
    const ref = (anyOf?.find((entry) => entry.type !== "null") ?? where).$ref;
    expect(typeof ref).toBe("string");
    const defs = params.$defs as Record<string, unknown>;
    expect(Object.keys(defs)).toHaveLength(1);
    // Self-contained: preflight validates this schema on its own, with no
    // contract around it, so the definitions live at the params root.
    expect(defs[(ref as string).replace("#/$defs/", "")]).toBeTruthy();
  });

  it("expresses one level of nesting — enough for A AND (B OR C)", () => {
    const root = objectAt(whereSchema());
    const and = (root.properties as Record<string, Record<string, unknown>>).AND;
    expect(and).toBeTruthy();
    const items = objectAt(and!).items as Record<string, unknown> | undefined;
    expect(items).toBeTruthy();
    const nested = objectAt(items!);
    // The nested group still filters, so a grouped predicate is expressible.
    expect(Object.keys(nested.properties as object)).toContain("status");
  });

  it("nests without a ceiling, where the old expansion stopped at two", () => {
    // The reference points at the type it lives on, so `A AND (B OR (C AND D))`
    // and anything deeper are all expressible by the same schema. Depth is no
    // longer bought with contract bytes, which is why there is no budget left
    // to spend.
    const root = objectAt(whereSchema());
    const and = (root.properties as Record<string, Record<string, unknown>>).AND;
    const items = objectAt(and!).items as Record<string, unknown>;
    const nested = objectAt(items);
    expect(nested).toStrictEqual(root);
  });

  it("costs one copy of the type however deep a visitor nests", () => {
    // What the depth budget was protecting against: every level repeating the
    // whole field set in a contract resent on every repair attempt. A reference
    // costs the same at any depth, so the protection is no longer needed — and
    // the type appears exactly once in the whole params schema.
    const serialized = JSON.stringify(paramsSchema());
    const occurrences = serialized.split('"status"').length - 1;
    expect(occurrences).toBe(1);
  });

  it("has nothing to say about trimming, because nothing is trimmed", () => {
    // This used to assert the opposite: a warning naming what the depth budget
    // cut and what a visitor could no longer express. Referencing the type
    // instead of re-expanding it means there is no cut to report — the warning
    // is not suppressed, it has no subject.
    const trimmed = compileWhere().issues.filter((issue) =>
      issue.message.includes("input recursion depth"),
    );
    expect(trimmed).toEqual([]);
    // And the capability still compiles and still filters — the absence of the
    // warning is the type being fully expressible, not the type being dropped.
    const capability = compileWhere().catalog.capabilities.find(
      (entry) => entry.id === "graphql.orders",
    )!;
    expect(
      (capability.inputSchema as { properties: Record<string, unknown> }).properties.where,
    ).toBeTruthy();
  });
});

describe("a plain list nested inside a row", () => {
  // Saleor's `Order.lines` is `[OrderLine!]!` — a nested list on the row, not a
  // connection and not a cross-source join. If this works, "an order has many
  // lines" needs no join machinery at all.
  const NESTED = `
    type Query {
      orders(first: Int): OrderCountableConnection
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
      lines: [OrderLine!]!
    }
    type OrderLine {
      id: ID!
      productName: String!
      quantity: Int!
    }
  `;

  const compileNested = (approvedOutputFields: string[]) => {
    const draft = createGraphQlCatalogInventory({
      schema: NESTED,
      catalog: { id: "shop", version: "1.0.0", description: "Approved reads." },
      source: { id: "shop-api", label: "Shop", description: "The store's graph." },
      queries: [
        {
          fieldName: "orders",
          capabilityId: "graphql.orders",
          purpose: "List orders with their lines.",
          dataTypeId: "order",
          dataTypeDescription: "One order.",
          resultShape: "collection",
          matchKey: "id",
        },
      ],
      discoveryMaxDepth: 4,
    });
    return compileApprovedGraphQlCatalog(NESTED, draft, {
      schemaVersion: "1.0",
      reviewSourceHash: draft.reviewSourceHash,
      queries: [
        {
          capabilityId: "graphql.orders",
          approvedVisitorArguments: ["first"],
          identityArguments: {},
          approvedOutputFields,
          requiredOutputFields: ["id"],
          policy: {
            authentication: "public",
            maximumRows: 50,
            timeoutMs: 5_000,
            cacheTtlSeconds: 0,
          },
          limits: { maximumSelectionDepth: 4, maximumSelectedFields: 50 },
        },
      ],
    });
  };

  const approved = ["id", "number", "lines.productName", "lines.quantity"];

  /**
   * `lines.productName` has one value per line, not per order, so "sort orders
   * by lines.productName" names no ordering — which line would decide it? The
   * query engine only checks membership in `sortFields`, so offering it means
   * whatever comparing the first encountered value happens to give. Filtering
   * is different: "any line matches" is a well-formed question about a row.
   */
  it("offers a nested-list field to filter but not to sort", () => {
    const compiled = compileNested(approved);
    const list = compiled.catalog.capabilities.find(
      (capability) => capability.output.shape === "collection",
    );
    expect(list!.supports?.filterFields).toContain("lines.productName");
    expect(list!.supports?.sortFields).not.toContain("lines.productName");
    // A row-level leaf is still sortable; this narrows one case, not the feature.
    expect(list!.supports?.sortFields).toContain("number");
  });

  it("discovers the nested list's fields as row-relative paths", () => {
    const paths = listGraphQlQueries(NESTED, { maximumDiscoveryDepth: 4 })
      .find((query) => query.fieldName === "orders")!
      .outputFields.map((field) => field.path);
    expect(paths).toContain("lines.productName");
    expect(paths).toContain("lines.quantity");
  });

  it("selects the nested list in one query — no join required", () => {
    const draft = compileNested(approved);
    const operation = compileGraphQlOperation(
      NESTED,
      draft.bindings.get("graphql.orders")!,
      { capabilityId: "graphql.orders", params: { first: 2 } },
      {},
    );
    expect(operation.document).toMatch(/lines \{[\s\S]*productName[\s\S]*\}/);
  });

  it("describes the nested list as an array of objects in the output schema", () => {
    const capability = compileNested(approved).catalog.capabilities.find(
      (entry) => entry.id === "graphql.orders",
    )!;
    const rowSchema = (capability.outputSchema as { items: Record<string, unknown> })
      .items;
    const lines = (rowSchema.properties as Record<string, Record<string, unknown>>)
      .lines;
    // Nullable wrappers may sit around it; find the array.
    const asArray = (schema: Record<string, unknown>): Record<string, unknown> => {
      if (schema.type === "array") return schema;
      const anyOf = schema.anyOf as Record<string, unknown>[] | undefined;
      return (anyOf?.find((entry) => entry.type === "array") ?? schema) as Record<
        string,
        unknown
      >;
    };
    const array = asArray(lines!);
    expect(array.type).toBe("array");
    const items = asArray(lines!).items as Record<string, unknown>;
    const itemProperties = Object.keys(
      ((items.anyOf as Record<string, unknown>[] | undefined)?.find(
        (entry) => entry.type === "object",
      ) ?? items).properties as object,
    );
    expect(itemProperties.sort()).toEqual(["productName", "quantity"]);
  });

  it("executes and validates real nested rows", async () => {
    const compiled = compileNested(approved);
    const result = await executeApprovedGraphQlRequest({
      catalog: compiled.catalog,
      schema: NESTED,
      binding: compiled.bindings.get("graphql.orders")!,
      request: { capabilityId: "graphql.orders", params: { first: 1 } },
      context: { identity: {} },
      transport: async () => ({
        data: {
          orders: {
            pageInfo: { hasNextPage: false },
            edges: [
              {
                cursor: "c1",
                node: {
                  id: "1",
                  number: "2500",
                  lines: [
                    { productName: "Apple Juice", quantity: 2 },
                    { productName: "Monospace Tee", quantity: 1 },
                  ],
                },
              },
            ],
          },
        },
      }),
      resolveProvenance: () => ({
        sources: [{ sourceId: "shop-api" }],
        freshness: { asOf: "2026-08-13T10:00:00.000Z" },
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = result.data as { lines: { productName: string }[] }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lines).toHaveLength(2);
    expect(rows[0]?.lines[0]?.productName).toBe("Apple Juice");
  });
});

/**
 * Approved field paths carry the objects on the way to a value, and
 * `supports.filterFields`/`sortFields` were defaulted to that list verbatim.
 * The query engine checks membership in the list and nothing else, so a plan
 * could legally sort a collection by `total` — an object — and get whatever
 * comparing two objects happens to produce.
 */
describe("filter and sort defaults offer leaves, not the objects above them", () => {
  const compileNested = () =>
    compileCuratedGraphQlCatalog({
      schema: SDL,
      catalog: { id: "shop", version: "1.0.0", description: "Curated reads." },
      source: { id: "shop-api", label: "Shop", description: "The store's graph." },
      policy: {
        authentication: "public",
        maximumRows: 50,
        timeoutMs: 5_000,
        cacheTtlSeconds: 0,
        maximumSelectedFields: 40,
        maximumSelectionDepth: 4,
      },
    });

  it("drops a path that another approved path extends", () => {
    const compiled = compileNested();
    const list = compiled.catalog.capabilities.find(
      (capability) => capability.output.shape === "collection",
    );
    expect(list, "fixture should contain a collection-shaped capability").toBeDefined();

    const approved = Object.keys(
      compiled.catalog.dataTypes.find((dataType) => dataType.id === list!.output.dataTypeId)
        ?.fields ?? {},
    );
    const offered = list!.supports?.filterFields ?? [];

    // `total.gross.amount` is approved, so neither `total` nor `total.gross`
    // may be offered — both are objects.
    expect(approved).toContain("total.gross.amount");
    expect(offered).not.toContain("total");
    expect(offered).not.toContain("total.gross");
    expect(offered).toContain("total.gross.amount");
  });

  it("still offers every leaf, and sorts by the same set it filters by", () => {
    const compiled = compileNested();
    const list = compiled.catalog.capabilities.find(
      (capability) => capability.output.shape === "collection",
    );
    const approved = Object.keys(
      compiled.catalog.dataTypes.find((dataType) => dataType.id === list!.output.dataTypeId)
        ?.fields ?? {},
    );
    const leaves = approved.filter(
      (path) => !approved.some((other) => other.startsWith(`${path}.`)),
    );

    expect([...(list!.supports?.filterFields ?? [])].sort()).toEqual(leaves.sort());
    expect([...(list!.supports?.sortFields ?? [])].sort()).toEqual(
      [...(list!.supports?.filterFields ?? [])].sort(),
    );
  });
});

/** `count` order rows shaped like the approved output fields. */
function manyOrders(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    number: String(2_500 - index),
    total: { gross: { amount: index + 1 } },
  }));
}

/**
 * The detailed path threw on the first approved field whose semantic type was
 * unknown, with no override and no list of the others — so a field a host could
 * see in the review UI was a field they could not approve, and the
 * stricter-looking path was the unusable one. The curated path has always had
 * both mechanisms.
 */
describe("an undecided semantic type is resolvable, not fatal", () => {
  const OPAQUE = `
    type Query { orders(first: Int): OrderCountableConnection }
    type OrderCountableConnection { edges: [OrderCountableEdge!]!  pageInfo: PageInfo! }
    type OrderCountableEdge { cursor: String!  node: Order! }
    type PageInfo { hasNextPage: Boolean!  endCursor: String }
    type Order { id: ID!  weight: Int! }
  `;

  const compile = (semanticTypeOverrides?: Record<string, string>) => {
    const draft = createGraphQlCatalogInventory({
      schema: OPAQUE,
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
    return compileApprovedGraphQlCatalog(OPAQUE, draft, {
      schemaVersion: "1.0",
      reviewSourceHash: draft.reviewSourceHash,
      ...(semanticTypeOverrides ? { semanticTypeOverrides } : {}),
      queries: [
        {
          capabilityId: "graphql.orders",
          approvedVisitorArguments: ["first"],
          identityArguments: {},
          approvedOutputFields: ["id", "weight"],
          requiredOutputFields: ["id"],
          policy: {
            authentication: "public",
            maximumRows: 50,
            timeoutMs: 5_000,
            cacheTtlSeconds: 0,
          },
          limits: { maximumSelectionDepth: 4, maximumSelectedFields: 50 },
        },
      ],
    });
  };

  it("reports every gap at once, with the key that resolves it", () => {
    let raised: unknown;
    try {
      compile();
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(GraphQlSemanticTypeError);
    const gaps = (raised as GraphQlSemanticTypeError).gaps;
    // Carried as data so a review UI renders the same list the curated flow
    // does, rather than parsing a sentence.
    expect(gaps.map((gap) => gap.key)).toEqual(["Query.orders.weight"]);
    expect(gaps[0]?.type).toBe("Int!");
    expect((raised as Error).message).toMatch(/semanticTypeOverrides/);
  });

  it("compiles once the host decides, and carries the decision through", () => {
    const compiled = compile({ "Query.orders.weight": "quantity" });
    const dataType = compiled.catalog.dataTypes.find((entry) => entry.id === "order");
    expect(dataType?.fields["weight"]?.semanticType).toBe("quantity");
    // And a decided field is offerable, which was the point of approving it.
    const list = compiled.catalog.capabilities.find(
      (capability) => capability.output.shape === "collection",
    );
    expect(list!.supports?.filterFields).toContain("weight");
  });
});

describe("a null result names the request instead of what broke downstream", () => {
  /**
   * `null` is GraphQL's "no such thing": a lookup whose argument matched
   * nothing returns 200, no errors, null. Left alone that surfaced as whatever
   * failed next — "is not a connection", or a schema complaint — three hops
   * from a cause that was a slug matching no record. The person debugging it
   * typed that slug, so the failure now echoes the parameters it ran with.
   */
  it("fails with the capability, the response key, and the parameters", async () => {
    const compiled = approvedCatalog();
    const runtime = createGraphQlCapabilityRuntime({
      catalog: compiled.catalog,
      schema,
      binding: compiled.bindings.get("graphql.orders")!,
      transport: async () => ({ data: { orders: null } }),
      resolveProvenance: () => ({
        sources: [{ sourceId: "shop-api" }],
        freshness: { asOf: "2026-08-13T10:00:00.000Z" },
      }),
    });

    const result = await runtime.execute({}, { identity: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("GRAPHQL_NULL_RESULT");
      expect(result.error.message).toContain('no "orders" result');
      expect(result.error.message).toContain("graphql.orders");
      // The parameters the request actually carried — here the injected page
      // size — so a wrong slug or id is visible in the failure itself.
      expect(result.error.message).toContain('"first"');
      expect(result.error.retryable).toBe(false);
    }
  });
});

/**
 * The ceiling that moved when the duplication went.
 *
 * A recursive input type used to be written out a fixed number of times, so
 * nesting past that had nowhere to go — the schema made it impossible.
 * Referencing the type removed the ceiling along with the duplication, so the
 * bound is now something validation refuses rather than something the shape
 * forbids. That is a real weakening, and this is what it was replaced with.
 */
describe("nesting depth, now that the schema no longer bounds it", () => {
  const catalog = {
    schemaVersion: "1.0",
    id: "c",
    version: "1.0.0",
    description: "d",
    dataTypes: [
      {
        id: "t",
        version: "1.0.0",
        description: "T",
        schema: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
        },
        fields: { id: { label: "Id", semanticType: "identifier" } },
      },
    ],
    sources: [{ id: "s", label: "S" }],
    capabilities: [
      {
        id: "cap",
        version: "1.0.0",
        purpose: "Read rows for a reader.",
        kind: "query",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { where: { $ref: "#/$defs/W" } },
          $defs: {
            W: {
              type: "object",
              additionalProperties: false,
              properties: { status: { type: "string" }, AND: { type: "array", items: { $ref: "#/$defs/W" } } },
            },
          },
        },
        outputSchema: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
        },
        output: { dataTypeId: "t", shape: "collection" },
        requiredSessionKeys: [],
        sourceIds: ["s"],
        policy: { authentication: "public", maximumRows: 50, timeoutMs: 2_000 },
      },
    ],
    relationships: [],
  };
  const nested = (levels: number) => {
    let value: Record<string, unknown> = { status: "x" };
    for (let i = 0; i < levels; i += 1) value = { status: "x", AND: [value] };
    return { where: value };
  };
  const preflight = (params: unknown) =>
    validateCapabilityPreflight(catalog as never, "cap", params, {
      identity: { subject: "reader" },
    });

  it("accepts the nesting a real question produces, which the old budget refused", () => {
    // `A AND (B OR (C AND D))` and deeper. Two levels was the old ceiling.
    expect(preflight(nested(5)).ok).not.toBe(false);
  });

  it("refuses nesting no question produces", () => {
    const result = preflight(nested(200));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/nest deeper than 16 levels/);
  });

  it("still enforces the approved shape inside the recursion", () => {
    // The property that must not be lost: a reference is not a hole. An
    // unapproved field deep inside a grouping is refused exactly as it is at
    // the top level.
    expect(preflight({ where: { status: "x", AND: [{ notApproved: 1 }] } }).ok).toBe(false);
  });
});

/**
 * The size of the thing we send, pinned.
 *
 * A recursive filter input used to be written out again at every level until
 * the depth budget stopped it. Measured on a Payload-shaped schema at the scale
 * a real host runs — nine collections, 28 filterable columns, eleven operators
 * — that duplication was 620 KB of planning contract; referencing the type
 * instead brings it to 234 KB.
 *
 * Pinned because that saving is invisible to every other test in this repo.
 * They all assert shape, and the shape is identical whether the type appears
 * once or forty times — so reintroducing the duplication, or adding a field
 * that re-expands it, would leave the suite green and triple what every plan
 * attempt costs. The contract is resent on each of up to three attempts per
 * compose, so this is the number a host pays three times over.
 *
 * The ceiling is deliberately loose. It exists to catch a regression in kind,
 * not to freeze a byte count that legitimate changes will move.
 */
describe("what a Payload-scale contract costs", () => {
  const COLUMNS = Array.from({ length: 28 }, (_, index) => `col_${index}`);
  const SDL = `
    type Query {${Array.from({ length: 9 }, (_, i) => `
      coll${i}(where: Where${i}, limit: Int, page: Int): Coll${i}`).join("")}
    }
    ${Array.from({ length: 9 }, (_, i) => `
    type Coll${i} { docs: [Doc${i}!]!, totalDocs: Int!, hasNextPage: Boolean! }
    type Doc${i} { id: ID!, ${COLUMNS.slice(0, 12).map((c) => `${c}: String`).join(", ")} }
    input Where${i} { ${COLUMNS.map((c) => `${c}: Op`).join(", ")}, AND: [Where${i}!], OR: [Where${i}!] }`).join("")}
    input Op {
      equals: String, not_equals: String, greater_than: String, greater_than_equal: String,
      less_than: String, less_than_equal: String, like: String, contains: String,
      in: [String!], not_in: [String!], exists: Boolean
    }
  `;
  const ENVELOPE = {
    rowsField: "docs",
    totalCountField: "totalDocs",
    hasNextPageField: "hasNextPage",
    pageSizeArgument: "limit",
    pageArguments: ["page"],
  } as const;

  const contractBytes = () => {
    const draft = createGraphQlCatalogInventory({
      schema: SDL,
      catalog: { id: "paper", version: "1.0.0", description: "Newspaper." },
      source: { id: "api", label: "API", description: "The newspaper's CMS." },
      queries: Array.from({ length: 9 }, (_, i) => ({
        fieldName: `coll${i}`,
        capabilityId: `paper.c${i}`,
        purpose: `List collection ${i} for a reader.`,
        dataTypeId: `d${i}`,
        dataTypeDescription: `One row of collection ${i}.`,
        resultShape: "collection" as const,
        matchKey: "id",
        listEnvelope: ENVELOPE,
      })),
    });
    const compiled = compileApprovedGraphQlCatalog(SDL, draft, {
      schemaVersion: "1.0",
      reviewSourceHash: draft.reviewSourceHash,
      queries: Array.from({ length: 9 }, (_, i) => ({
        capabilityId: `paper.c${i}`,
        approvedVisitorArguments: ["where", "limit"],
        identityArguments: {},
        approvedOutputFields: ["id", ...COLUMNS.slice(0, 12)],
        requiredOutputFields: ["id"],
        policy: {
          authentication: "public" as const,
          maximumRows: 50,
          timeoutMs: 5_000,
          cacheTtlSeconds: 0,
        },
        limits: { maximumSelectionDepth: 6, maximumSelectedFields: 60 },
      })),
    });
    return JSON.stringify(
      createDataPlanningContract(createPlannerManifest(compiled.catalog)).jsonSchema,
    ).length;
  };

  it("stays a quarter of a megabyte, not two thirds", () => {
    const bytes = contractBytes();
    // 234 KB measured; 620 KB before the type was written once. 320 KB leaves
    // room for real growth while catching a return to duplication, which would
    // land near 600 KB again.
    expect(bytes).toBeLessThan(320 * 1024);
  });

  it("writes each capability's filter type exactly once", () => {
    // The property behind the number, asserted directly so a failure says what
    // broke rather than only that something grew. One `$defs` entry per
    // capability, and the operator block appearing once inside it.
    const draft = createGraphQlCatalogInventory({
      schema: SDL,
      catalog: { id: "paper", version: "1.0.0", description: "Newspaper." },
      source: { id: "api", label: "API", description: "The newspaper's CMS." },
      queries: [
        {
          fieldName: "coll0",
          capabilityId: "paper.c0",
          purpose: "List collection 0 for a reader.",
          dataTypeId: "d0",
          dataTypeDescription: "One row.",
          resultShape: "collection" as const,
          matchKey: "id",
          listEnvelope: ENVELOPE,
        },
      ],
    });
    const compiled = compileApprovedGraphQlCatalog(SDL, draft, {
      schemaVersion: "1.0",
      reviewSourceHash: draft.reviewSourceHash,
      queries: [
        {
          capabilityId: "paper.c0",
          approvedVisitorArguments: ["where", "limit"],
          identityArguments: {},
          approvedOutputFields: ["id", ...COLUMNS.slice(0, 12)],
          requiredOutputFields: ["id"],
          policy: {
            authentication: "public" as const,
            maximumRows: 50,
            timeoutMs: 5_000,
            cacheTtlSeconds: 0,
          },
          limits: { maximumSelectionDepth: 6, maximumSelectedFields: 60 },
        },
      ],
    });
    const params = compiled.catalog.capabilities[0]!.inputSchema as Record<string, unknown>;
    expect(Object.keys(params.$defs as object)).toHaveLength(1);
    // `not_equals` belongs to the operator block. Once per column, and the
    // columns appear once — so 28, not 28 times the nesting depth.
    const occurrences = JSON.stringify(params).split('"not_equals"').length - 1;
    expect(occurrences).toBe(COLUMNS.length);
  });
});
