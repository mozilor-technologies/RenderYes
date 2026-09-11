import {
  buildSchema,
  getIntrospectionQuery,
  graphql,
  introspectionFromSchema,
} from "graphql";
import { describe, expect, it } from "vitest";
import {
  compileApprovedGraphQlCatalog,
  compileCuratedGraphQlCatalog,
  compileGraphQlOperation,
  createGraphQlCapabilityRuntime,
  createGraphQlCatalogInventory,
  customScalarNames,
  executeApprovedGraphQlRequest,
  GraphQlScalarMappingError,
  hashGraphQlSchema,
  listGraphQlQueries,
  type GraphQlCatalogDecisions,
  type GraphQlCatalogInventory,
  type GraphQlTransport,
} from "../src/graphql.js";

const schemaSdl = /* GraphQL */ `
  scalar DateTime

  type Category {
    id: ID!
    name: String!
  }

  type Product {
    id: ID!
    name: String!
    image: String
    price: Float!
    stock: Int!
    internalCost: Float!
    updatedAt: DateTime!
    category: Category!
    """
    Real-world field names that must not fool a substring-based semantic
    guess: a Boolean whose name happens to end in the letters "id", and a
    generic "total" paired with a more specific "count".
    """
    isPaid: Boolean!
    totalCount: Int!
    """
    A polymorphic related item, the same shape real schemas use for
    fields like "createdBy: UserOrApp" — it must not disqualify the rest
    of Product's otherwise-safe fields.
    """
    relatedItem: SearchResult
  }

  union SearchResult = Product | Category

  type Query {
    "Products visible to the current tenant."
    products(minStock: Int, maxStock: Int, tenantId: ID!): [Product!]!
    product(id: ID!, tenantId: ID!): Product
    totalProducts: Int!
    search: [SearchResult!]!
  }

  type Mutation {
    updateStock(id: ID!, stock: Int!): Product!
  }
`;

const source = {
  id: "host-graph",
  label: "Host GraphQL API",
  description: "The host-approved product graph.",
} as const;

function reviewDraft(
  schema: string | Record<string, unknown> = schemaSdl,
): GraphQlCatalogInventory {
  return createGraphQlCatalogInventory({
    schema,
    catalog: {
      id: "product-graph",
      version: "1.0.0",
      description: "Approved product queries.",
    },
    source,
    queries: [
      {
        fieldName: "products",
        capabilityId: "products.search",
        purpose: "Find products within approved stock constraints.",
        dataTypeId: "product",
        dataTypeDescription: "A product approved for generated product views.",
        resultShape: "collection",
        matchKey: "id",
        scalarMappings: {
          DateTime: {
            schema: { type: "string", format: "date-time" },
            semanticType: "date-time",
          },
        },
      },
    ],
    discoveryMaxDepth: 3,
  });
}

function approval(draft: GraphQlCatalogInventory): GraphQlCatalogDecisions {
  return {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    queries: [
      {
        capabilityId: "products.search",
        approvedVisitorArguments: ["minStock", "maxStock"],
        identityArguments: { tenantId: "tenantId" },
        approvedOutputFields: [
          "id",
          "name",
          "image",
          "price",
          "stock",
          "updatedAt",
          "category.id",
          "category.name",
        ],
        requiredOutputFields: ["id"],
        policy: {
          authentication: "session",
          requiredPermissions: ["inventory:read"],
          maximumRows: 50,
          timeoutMs: 2_000,
          cacheTtlSeconds: 30,
        },
        limits: {
          maximumSelectionDepth: 3,
          maximumSelectedFields: 12,
          freshnessMaximumAgeSeconds: 300,
        },
      },
    ],
  };
}

function compiled() {
  const draft = reviewDraft();
  return compileApprovedGraphQlCatalog(schemaSdl, draft, approval(draft));
}

describe("GraphQL catalog onboarding", () => {
  it("compiles a curated Query-only API through the same catalog and binding path", () => {
    const curatedSchema = /* GraphQL */ `
      enum TicketStatus {
        OPEN
        CLOSED
      }
      type Ticket {
        id: ID!
        title: String!
        status: TicketStatus!
        createdAt: String!
        opaque: Int!
      }
      type Query {
        "Find tickets visitors may view."
        tickets(status: TicketStatus, limit: Int): [Ticket!]!
      }
      type Mutation {
        closeTicket(id: ID!): Ticket!
      }
    `;

    const compiled = compileCuratedGraphQlCatalog({
      schema: curatedSchema,
      catalog: {
        id: "curated-support",
        version: "1.0.0",
        description: "Curated support data.",
      },
      source,
      policy: {
        authentication: "session",
        maximumRows: 50,
        timeoutMs: 2_000,
        freshnessMaximumAgeSeconds: 300,
      },
    });

    expect(compiled.catalog.capabilities.map((capability) => capability.id)).toEqual([
      "graphql.tickets",
    ]);
    expect(compiled.bindings.get("graphql.tickets")?.visitorArguments).toEqual([
      "status",
      "limit",
    ]);
    expect(compiled.bindings.get("graphql.tickets")?.approvedOutputFields).toEqual([
      "id",
      "title",
      "status",
      "createdAt",
    ]);
    expect(compiled.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "Query.tickets.opaque", severity: "warning" }),
      ]),
    );
    expect(JSON.stringify(compiled)).not.toContain("closeTicket");
  });

  it("reports semantically unclear fields and admits them via host decisions", () => {
    const curatedSchema = /* GraphQL */ `
      type Ticket {
        id: ID!
        title: String!
        opaque: Int!
        score: Float!
      }
      type Query {
        tickets(limit: Int): [Ticket!]!
      }
    `;
    const catalog = {
      id: "curated-support",
      version: "1.0.0",
      description: "Curated support data.",
    };
    const policy = { authentication: "session" as const, maximumRows: 50, timeoutMs: 2_000 };

    const undecided = compileCuratedGraphQlCatalog({
      schema: curatedSchema,
      catalog,
      source,
      policy,
    });
    expect(undecided.needsSemanticType).toEqual([
      expect.objectContaining({
        key: "Query.tickets.opaque",
        fieldName: "tickets",
        path: "opaque",
        type: "Int!",
      }),
      expect.objectContaining({ key: "Query.tickets.score", type: "Float!" }),
    ]);
    expect(undecided.bindings.get("graphql.tickets")?.approvedOutputFields).toEqual([
      "id",
      "title",
    ]);

    const decided = compileCuratedGraphQlCatalog({
      schema: curatedSchema,
      catalog,
      source,
      policy,
      semanticTypeOverrides: {
        "Query.tickets.opaque": "quantity",
        "Query.tickets.score": "percentage",
      },
    });
    expect(decided.needsSemanticType).toEqual([]);
    expect(decided.bindings.get("graphql.tickets")?.approvedOutputFields).toEqual([
      "id",
      "title",
      "opaque",
      "score",
    ]);
    const dataType = decided.catalog.dataTypes.find((type) => type.id === "tickets");
    expect(dataType?.fields.opaque?.semanticType).toBe("quantity");
    expect(dataType?.fields.score?.semanticType).toBe("percentage");
    // The decided fields carry no leftover warning.
    expect(
      decided.issues.filter((issue) => issue.path.startsWith("Query.tickets.")),
    ).toEqual([]);
  });

  it("rejects override keys that match nothing and non-decisions", () => {
    const curatedSchema = /* GraphQL */ `
      type Ticket {
        id: ID!
        opaque: Int!
      }
      type Query {
        tickets: [Ticket!]!
      }
    `;
    const base = {
      schema: curatedSchema,
      catalog: { id: "c", version: "1.0.0", description: "d" },
      source,
      policy: { authentication: "session" as const, maximumRows: 50, timeoutMs: 2_000 },
    };
    expect(() =>
      compileCuratedGraphQlCatalog({
        ...base,
        semanticTypeOverrides: { "Query.tickets.opqaue": "quantity" },
      }),
    ).toThrow('matches no discovered field');
    expect(() =>
      compileCuratedGraphQlCatalog({
        ...base,
        semanticTypeOverrides: { "Query.tickets.opaque": "unknown" },
      }),
    ).toThrow('omit the key instead');
  });

  it("refuses identity-like GraphQL arguments in curated mode", () => {
    expect(() =>
      compileCuratedGraphQlCatalog({
        schema: schemaSdl,
        catalog: {
          id: "curated-products",
          version: "1.0.0",
          description: "Curated products.",
        },
        source,
        policy: { authentication: "session", maximumRows: 50, timeoutMs: 2_000 },
      }),
    ).toThrow('identity-like argument "tenantId"');
  });

  it("discovers read-only queries without granting mutations or unsupported roots", () => {
    const queries = listGraphQlQueries(schemaSdl, { maximumDiscoveryDepth: 3 });

    expect(queries.map((query) => query.fieldName)).toEqual([
      "products",
      "product",
      "totalProducts",
      "search",
    ]);
    expect(queries.find((query) => query.fieldName === "products")?.support.status).toBe(
      "supported",
    );
    expect(queries.find((query) => query.fieldName === "products")?.outputFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "id", semanticType: "identifier" }),
        expect.objectContaining({ path: "image", semanticType: "image-url" }),
        expect.objectContaining({ path: "category.name" }),
        expect.objectContaining({ path: "internalCost" }),
      ]),
    );
    expect(
      queries.find((query) => query.fieldName === "totalProducts")?.support.status,
    ).toBe("unsupported");
    expect(queries.find((query) => query.fieldName === "search")?.support.status).toBe(
      "unsupported",
    );
    // A host who has never talked to us needs the rejection to name the
    // actual fix, not just say "unsupported" — list the union's member
    // types so they know to register those as separate capabilities.
    expect(
      queries.find((query) => query.fieldName === "search")?.support.reason,
    ).toContain("Product, Category");
    expect(JSON.stringify(queries)).not.toContain("updateStock");
  });

  /**
   * `metric` used to be unreachable. Inference returned `collection`,
   * `time-series` or `entity` and never `metric`, so the starter catalog's
   * metric card — which accepts only `metric` — could not be selected for
   * anything a GraphQL schema offers. An aggregate like `totalProducts` came
   * back as `entity`.
   *
   * The rule is numeric, not scalar. A `String` root under a KPI renderer is a
   * worse outcome than an unreachable component, because it looks like a
   * working feature.
   */
  it("suggests metric for a numeric scalar root and not for other scalars", () => {
    const queries = listGraphQlQueries(
      `
      type Query {
        totalProducts: Int!
        averageRating: Float
        apiVersion: String!
        maintenanceMode: Boolean!
        catalogId: ID!
      }
    `,
      { maximumDiscoveryDepth: 3 },
    );
    const shapeOf = (fieldName: string) =>
      queries.find((query) => query.fieldName === fieldName)?.suggestedResultShape;

    expect(shapeOf("totalProducts")).toBe("metric");
    expect(shapeOf("averageRating")).toBe("metric");
    // Not numbers, so not metrics — this is the half that keeps the rule honest.
    expect(shapeOf("apiVersion")).toBe("entity");
    expect(shapeOf("maintenanceMode")).toBe("entity");
    expect(shapeOf("catalogId")).toBe("entity");
  });

  /**
   * A custom scalar is numeric only if the host said so. Guessing from the name
   * would make `Money` numeric and `PhoneNumber` numeric too.
   */
  it("treats a custom scalar as a metric only when the host's mapping is numeric", () => {
    const sdl = `
      scalar Money
      scalar PhoneNumber
      type Query { revenue: Money!, supportLine: PhoneNumber! }
    `;
    const queries = listGraphQlQueries(sdl, {
      maximumDiscoveryDepth: 3,
      scalarMappings: {
        Money: { schema: { type: "number" }, semanticType: "money" },
        PhoneNumber: { schema: { type: "string" }, semanticType: "text" },
      },
    });
    const shapeOf = (fieldName: string) =>
      queries.find((query) => query.fieldName === fieldName)?.suggestedResultShape;

    expect(shapeOf("revenue")).toBe("metric");
    expect(shapeOf("supportLine")).toBe("entity");
  });

  it("excludes a nested union field without rejecting the whole query", () => {
    // A real schema's Order/Checkout/User-shaped objects routinely have a
    // polymorphic field a few hops down (e.g. "createdBy: UserOrApp").
    // Product.relatedItem: SearchResult is that shape. Regression for a bug
    // where any nested union anywhere in the reachable graph disqualified
    // the entire root query, not just that one field.
    const queries = listGraphQlQueries(schemaSdl, { maximumDiscoveryDepth: 3 });
    const products = queries.find((query) => query.fieldName === "products")!;

    expect(products.support.status).toBe("supported");
    expect(products.outputFields.map((field) => field.path)).not.toContain("relatedItem");
    expect(products.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          path: "relatedItem",
          message: expect.stringContaining('Union output "SearchResult"'),
        }),
      ]),
    );
  });

  it("classifies semantic types by whole words, not substrings", () => {
    // Regression for two field names taken directly from Saleor's real
    // production schema: "isPaid" (a Boolean whose name happens to end in
    // the letters "id") and "totalCount" (a plain Int, where a bare "total"
    // must defer to the more specific "count" sitting next to it).
    const queries = listGraphQlQueries(schemaSdl, { maximumDiscoveryDepth: 3 });
    const fields = queries.find((query) => query.fieldName === "products")!.outputFields;

    expect(fields.find((field) => field.path === "isPaid")?.semanticType).toBe("boolean");
    expect(fields.find((field) => field.path === "totalCount")?.semanticType).toBe(
      "quantity",
    );
    // Unaffected: the real "id" field, and a genuine money field, still
    // classify correctly under whole-word matching.
    expect(fields.find((field) => field.path === "id")?.semanticType).toBe("identifier");
    expect(fields.find((field) => field.path === "internalCost")?.semanticType).toBe(
      "money",
    );
  });

  it("accepts introspection JSON and produces the same stable schema hash", async () => {
    const schema = buildSchema(schemaSdl);
    const introspection = introspectionFromSchema(schema);
    const wrapped = { data: introspection } as unknown as Record<string, unknown>;

    expect(hashGraphQlSchema(wrapped)).toBe(hashGraphQlSchema(schemaSdl));
    expect(listGraphQlQueries(wrapped).map((query) => query.fieldName)).toContain(
      "products",
    );

    const result = await graphql({ schema, source: getIntrospectionQuery() });
    expect(result.errors).toBeUndefined();
  });

  it("compiles only host-approved arguments, fields, identity and policy", () => {
    const result = compiled();
    const capability = result.catalog.capabilities[0]!;
    const dataType = result.catalog.dataTypes[0]!;
    const plannerJson = JSON.stringify(result.plannerManifest);

    expect(capability.inputSchema.properties).toHaveProperty("minStock");
    expect(capability.inputSchema.properties).not.toHaveProperty("tenantId");
    expect(capability.requiredSessionKeys).toEqual(["tenantId"]);
    expect(capability.policy.requiredPermissions).toEqual(["inventory:read"]);
    expect(dataType.fields).toHaveProperty("category.name");
    expect(dataType.fields).not.toHaveProperty("internalCost");
    expect(plannerJson).not.toContain("tenantId");
    expect(plannerJson).not.toContain("inventory:read");
    expect(plannerJson).not.toContain("Host GraphQL API");
    expect(result.bindings.get("products.search")?.identityArguments).toEqual({
      tenantId: "tenantId",
    });
  });

  it("rejects missing ownership for required GraphQL arguments", () => {
    const draft = reviewDraft();
    const invalid = approval(draft);
    invalid.queries[0]!.identityArguments = {};

    expect(() => compileApprovedGraphQlCatalog(schemaSdl, draft, invalid)).toThrow(
      /Required GraphQL argument.*tenantId/,
    );
  });

  it("requires host-reviewed purpose and semantic meaning", () => {
    const draft = createGraphQlCatalogInventory({
      schema: schemaSdl,
      catalog: {
        id: "meaning-review",
        version: "1.0.0",
        description: "Review semantic requirements.",
      },
      source,
      queries: [
        {
          fieldName: "product",
          capabilityId: "products.get",
          dataTypeId: "product",
          resultShape: "entity",
        },
      ],
    });
    const hostApproval: GraphQlCatalogDecisions = {
      schemaVersion: "1.0",
      reviewSourceHash: draft.reviewSourceHash,
      queries: [
        {
          capabilityId: "products.get",
          approvedVisitorArguments: ["id"],
          identityArguments: { tenantId: "tenantId" },
          approvedOutputFields: ["name"],
          requiredOutputFields: [],
          policy: {
            authentication: "session",
            maximumRows: 1,
            timeoutMs: 1_000,
          },
          limits: {
            maximumSelectionDepth: 2,
            maximumSelectedFields: 5,
          },
        },
      ],
    };

    expect(() => compileApprovedGraphQlCatalog(schemaSdl, draft, hostApproval)).toThrow(
      /host-approved business purpose/,
    );
  });

  it("compiles a validated operation from approved fields and trusted identity", () => {
    const result = compiled();
    const binding = result.bindings.get("products.search")!;
    const operation = compileGraphQlOperation(
      schemaSdl,
      binding,
      {
        capabilityId: "products.search",
        params: { minStock: 1, maxStock: 9 },
        selection: ["name", "stock", "category.name"],
      },
      { tenantId: "tenant-7" },
    );

    expect(operation.document).toContain(
      "products(minStock: $minStock, maxStock: $maxStock, tenantId: $tenantId)",
    );
    expect(operation.document).toContain("category {");
    expect(operation.document).toContain("name");
    expect(operation.document).toContain("id");
    expect(operation.document).not.toContain("internalCost");
    expect(operation.variables).toEqual({
      minStock: 1,
      maxStock: 9,
      tenantId: "tenant-7",
    });
    expect(operation.selection).toEqual(["name", "stock", "category.name", "id"]);
  });

  it("rejects unapproved selections and schema drift before execution", () => {
    const result = compiled();
    const binding = result.bindings.get("products.search")!;

    expect(() =>
      compileGraphQlOperation(
        schemaSdl,
        binding,
        {
          capabilityId: "products.search",
          params: {},
          selection: ["internalCost"],
        },
        { tenantId: "tenant-7" },
      ),
    ).toThrow(/unknown requested output field "internalCost"/);

    expect(() =>
      compileGraphQlOperation(
        schemaSdl.replace("name: String!", "name: String"),
        binding,
        { capabilityId: "products.search", params: {} },
        { tenantId: "tenant-7" },
      ),
    ).toThrow(/schema drift/);
  });
});

describe("GraphQL runtime safety", () => {
  it("executes an approved query and validates host-provided provenance", async () => {
    const result = compiled();
    const binding = result.bindings.get("products.search")!;
    const schema = buildSchema(schemaSdl);
    const transport: GraphQlTransport = async (request) => {
      const executed = await graphql({
        schema,
        source: request.document,
        operationName: request.operationName,
        variableValues: request.variables,
        rootValue: {
          products: ({ minStock, maxStock, tenantId }: Record<string, unknown>) => {
            if (tenantId !== "tenant-7") throw new Error("Wrong tenant");
            return [
              {
                id: "p-1",
                name: "Safe Product",
                stock: minStock === 1 && maxStock === 9 ? 4 : 0,
              },
            ];
          },
        },
      });
      return {
        ...(executed.data ? { data: executed.data } : {}),
        ...(executed.errors
          ? {
              errors: executed.errors.map((error) => ({
                message: error.message,
                ...(error.path ? { path: error.path } : {}),
              })),
            }
          : {}),
      };
    };

    const execution = await executeApprovedGraphQlRequest({
      catalog: result.catalog,
      schema: schemaSdl,
      binding,
      request: {
        capabilityId: "products.search",
        params: { minStock: 1, maxStock: 9 },
        selection: ["name", "stock"],
      },
      context: {
        identity: { tenantId: "tenant-7" },
        permissions: new Set(["inventory:read"]),
      },
      transport,
      resolveProvenance: () => ({
        sources: [{ sourceId: "host-graph" }],
        freshness: { asOf: "2026-07-28T10:00:00.000Z" },
      }),
      now: () => new Date("2026-07-28T10:02:00.000Z"),
    });

    expect(execution).toEqual({
      ok: true,
      data: [{ id: "p-1", name: "Safe Product", stock: 4 }],
      provenance: {
        sources: [{ sourceId: "host-graph" }],
        freshness: { asOf: "2026-07-28T10:00:00.000Z" },
      },
    });
  });

  it("blames the host's resolver, not the upstream, when provenance is malformed", async () => {
    // Found the slow way while testing something else. A `resolveProvenance`
    // returning `sources` without `freshness` reported "the data source
    // returned something other than the approved result shape" — sending
    // whoever read it to inspect an upstream that had answered correctly, with
    // the valid rows sitting in the same object. The issue's path was computed
    // and then dropped, so the message did not even name the field.
    const result = compiled();
    const binding = result.bindings.get("products.search")!;
    const execution = await executeApprovedGraphQlRequest({
      catalog: result.catalog,
      schema: schemaSdl,
      binding,
      request: {
        capabilityId: "products.search",
        params: { minStock: 1, maxStock: 9 },
        selection: ["name", "stock"],
      },
      context: {
        identity: { tenantId: "tenant-7" },
        permissions: new Set(["inventory:read"]),
      },
      transport: async () => ({
        data: { products: [{ id: "p-1", name: "Safe Product", stock: 4 }] },
      }),
      // Valid-looking and incomplete: the shape a host lands on by reading the
      // type as "sources, and optionally more".
      resolveProvenance: () => ({ sources: [{ sourceId: "host-graph" }] }) as never,
      now: () => new Date("2026-07-28T10:02:00.000Z"),
    });

    expect(execution.ok).toBe(false);
    const message = (execution as { error: { message: string } }).error.message;
    expect(message).toMatch(/resolveProvenance/);
    expect(message).toMatch(/data source answered correctly/);
    // Names the field, which is the whole difference between a message someone
    // can act on and one that only says something is wrong somewhere.
    expect(message).toMatch(/\/provenance\/freshness/);
  });

  it("blocks missing permissions, partial GraphQL errors and stale host data", async () => {
    const result = compiled();
    const binding = result.bindings.get("products.search")!;
    let transportCalled = false;
    const transport: GraphQlTransport = async () => {
      transportCalled = true;
      return { data: { products: [] } };
    };

    const denied = await executeApprovedGraphQlRequest({
      catalog: result.catalog,
      schema: schemaSdl,
      binding,
      request: { capabilityId: "products.search", params: {} },
      context: { identity: { tenantId: "tenant-7" }, permissions: new Set() },
      transport,
      resolveProvenance: () => ({
        sources: [{ sourceId: "host-graph" }],
        freshness: { asOf: "2026-07-28T10:00:00.000Z" },
      }),
    });
    expect(denied).toMatchObject({ ok: false, error: { code: "PREFLIGHT_FAILED" } });
    expect(transportCalled).toBe(false);

    const graphqlError = await executeApprovedGraphQlRequest({
      catalog: result.catalog,
      schema: schemaSdl,
      binding,
      request: { capabilityId: "products.search", params: {} },
      context: {
        identity: { tenantId: "tenant-7" },
        permissions: new Set(["inventory:read"]),
      },
      transport: async () => ({
        data: { products: [] },
        errors: [{ message: "Resolver denied one field" }],
      }),
      resolveProvenance: () => ({
        sources: [{ sourceId: "host-graph" }],
        freshness: { asOf: "2026-07-28T10:00:00.000Z" },
      }),
    });
    expect(graphqlError).toMatchObject({
      ok: false,
      error: { code: "GRAPHQL_EXECUTION_ERROR" },
    });

    const stale = await executeApprovedGraphQlRequest({
      catalog: result.catalog,
      schema: schemaSdl,
      binding,
      request: { capabilityId: "products.search", params: {} },
      context: {
        identity: { tenantId: "tenant-7" },
        permissions: new Set(["inventory:read"]),
      },
      transport,
      resolveProvenance: () => ({
        sources: [{ sourceId: "host-graph" }],
        freshness: { asOf: "2026-07-28T09:00:00.000Z" },
      }),
      now: () => new Date("2026-07-28T10:00:00.000Z"),
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "STALE_GRAPHQL_RESULT" } });
  });
});

describe("createGraphQlCapabilityRuntime", () => {
  it("adapts an approved binding into a CapabilityRuntime that the trusted executor can call directly", async () => {
    const result = compiled();
    const binding = result.bindings.get("products.search")!;
    const schema = buildSchema(schemaSdl);
    const seenVariables: unknown[] = [];
    const transport: GraphQlTransport = async (request) => {
      seenVariables.push(request.variables);
      const executed = await graphql({
        schema,
        source: request.document,
        operationName: request.operationName,
        variableValues: request.variables,
        rootValue: {
          // This adapter has no per-request selection channel (see the
          // comment below), so it always requests the complete approved
          // field envelope. The mock resolver must satisfy every approved
          // field, including the non-nullable schema fields the narrower
          // executeApprovedGraphQlRequest tests above don't need to.
          products: ({ tenantId }: Record<string, unknown>) => {
            if (tenantId !== "tenant-7") throw new Error("Wrong tenant");
            return [
              {
                id: "p-1",
                name: "Safe Product",
                image: null,
                price: 19.99,
                stock: 4,
                internalCost: 8.5,
                updatedAt: "2026-07-28T09:00:00.000Z",
                category: { id: "c-1", name: "Widgets" },
              },
            ];
          },
        },
      });
      return {
        ...(executed.data ? { data: executed.data } : {}),
        ...(executed.errors
          ? {
              errors: executed.errors.map((error) => ({
                message: error.message,
                ...(error.path ? { path: error.path } : {}),
              })),
            }
          : {}),
      };
    };

    const runtime = createGraphQlCapabilityRuntime({
      catalog: result.catalog,
      schema: schemaSdl,
      binding,
      transport,
      resolveProvenance: () => ({
        sources: [{ sourceId: "host-graph" }],
        freshness: { asOf: "2026-07-28T10:00:00.000Z" },
      }),
      permissions: new Set(["inventory:read"]),
      now: () => new Date("2026-07-28T10:02:00.000Z"),
    });

    expect(runtime.capabilityId).toBe("products.search");

    // The runtime is called exactly the way the executor calls every
    // capability: planner-controlled params plus a trusted identity object,
    // never the session. Identity here is what proves this is not the same
    // code path as an unauthenticated public fetch.
    const execution = await runtime.execute(
      { minStock: 1, maxStock: 9 },
      { identity: Object.freeze({ tenantId: "tenant-7" }) },
    );

    expect(execution).toEqual({
      ok: true,
      data: [
        {
          id: "p-1",
          name: "Safe Product",
          image: null,
          price: 19.99,
          stock: 4,
          updatedAt: "2026-07-28T09:00:00.000Z",
          category: { id: "c-1", name: "Widgets" },
        },
      ],
      provenance: {
        sources: [{ sourceId: "host-graph" }],
        freshness: { asOf: "2026-07-28T10:00:00.000Z" },
      },
    });
    // This adapter requests the complete approved field envelope regardless
    // of any per-request selection, since CapabilityExecutionContext carries
    // no selection channel — that is its documented limitation.
    expect(seenVariables).toEqual([{ minStock: 1, maxStock: 9, tenantId: "tenant-7" }]);
  });

  it("denies execution when the configured permission set is missing the capability's requirement", async () => {
    const result = compiled();
    const binding = result.bindings.get("products.search")!;
    let transportCalled = false;

    const runtime = createGraphQlCapabilityRuntime({
      catalog: result.catalog,
      schema: schemaSdl,
      binding,
      transport: async () => {
        transportCalled = true;
        return { data: { products: [] } };
      },
      resolveProvenance: () => ({
        sources: [{ sourceId: "host-graph" }],
        freshness: { asOf: "2026-07-28T10:00:00.000Z" },
      }),
      // No permissions configured, but the compiled capability requires
      // "inventory:read" — the adapter must fail closed before transport.
    });

    const execution = await runtime.execute(
      { minStock: 1, maxStock: 9 },
      { identity: Object.freeze({ tenantId: "tenant-7" }) },
    );

    expect(execution).toMatchObject({ ok: false, error: { code: "PREFLIGHT_FAILED" } });
    expect(transportCalled).toBe(false);
  });

  it("propagates an abort signal from the executor into the transport call", async () => {
    const result = compiled();
    const binding = result.bindings.get("products.search")!;
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const runtime = createGraphQlCapabilityRuntime({
      catalog: result.catalog,
      schema: schemaSdl,
      binding,
      transport: async (request) => {
        receivedSignal = request.signal;
        return { data: { products: [] } };
      },
      resolveProvenance: () => ({
        sources: [{ sourceId: "host-graph" }],
        freshness: { asOf: "2026-07-28T10:00:00.000Z" },
      }),
      permissions: new Set(["inventory:read"]),
    });

    await runtime.execute(
      { minStock: 1, maxStock: 9 },
      { identity: Object.freeze({ tenantId: "tenant-7" }), signal: controller.signal },
    );

    expect(receivedSignal).toBe(controller.signal);
  });
});

describe("default query support for imported catalogs", () => {
  const listAndRecordSchema = /* GraphQL */ `
    type Ticket {
      id: ID!
      "Ticket subject line"
      title: String!
      "Current ticket status"
      status: String!
    }
    type Summary {
      "Count of open tickets"
      open: Int!
      "Count of pending tickets"
      pending: Int!
    }
    type Query {
      "Tickets a visitor may view."
      tickets(status: String): [Ticket!]!
      "One summary record."
      summary: Summary!
    }
  `;

  function compileFixture() {
    return compileCuratedGraphQlCatalog({
      schema: listAndRecordSchema,
      catalog: { id: "curated", version: "1.0.0", description: "Curated." },
      source,
      policy: { authentication: "session", maximumRows: 50, timeoutMs: 1000 },
    });
  }

  it("makes approved fields filterable and sortable on a list result without a second declaration", () => {
    const compiled = compileFixture();
    const list = compiled.catalog.capabilities.find(
      (capability) => capability.output.shape === "collection",
    );
    expect(list, "fixture should contain a collection-shaped capability").toBeDefined();

    // Filtering, sorting, grouping and aggregating were built end to end and
    // reachable only by hand-authoring a catalog: every imported catalog had no
    // `supports` at all, so "show me only the open ones" silently became "show
    // me everything" with nothing disclosing the difference.
    expect(list!.supports?.filterFields?.length ?? 0).toBeGreaterThan(0);
    expect([...(list!.supports?.sortFields ?? [])].sort()).toEqual(
      [...(list!.supports?.filterFields ?? [])].sort(),
    );

    // The approved output fields and nothing else: this follows the owner's
    // decision about what may be seen, it does not widen it.
    const approved = Object.keys(
      compiled.catalog.dataTypes.find(
        (dataType) => dataType.id === list!.output.dataTypeId,
      )?.fields ?? {},
    );
    expect([...(list!.supports?.filterFields ?? [])].sort()).toEqual(approved.sort());
  });

  it("leaves single-record results alone, where a filter means nothing", () => {
    for (const capability of compileFixture().catalog.capabilities) {
      if (capability.output.shape === "entity") {
        expect(capability.supports?.filterFields).toBeUndefined();
      }
    }
  });

  it("never defaults aggregates or pagination", () => {
    for (const capability of compileFixture().catalog.capabilities) {
      // Which arithmetic is meaningful is the owner's call, and pagination is a
      // claim about the upstream that nothing here can verify.
      expect(capability.supports?.aggregates).toBeUndefined();
      expect(capability.supports?.pagination).toBeUndefined();
    }
  });
});

describe("entity lookups that match nothing", () => {
  it("returns a successful null result instead of a raw validation error", async () => {
    const schemaSdl = /* GraphQL */ `
      type Recipe {
        id: ID!
        title: String!
      }
      type Query {
        recipe(id: ID!): Recipe
      }
    `;
    const draft = createGraphQlCatalogInventory({
      schema: schemaSdl,
      catalog: { id: "pantry", version: "1.0.0", description: "Recipes." },
      source: { id: "pantry-graph", label: "Pantry", description: "Recipe queries." },
      queries: [
        {
          fieldName: "recipe",
          capabilityId: "recipes.get",
          purpose: "Fetch one recipe by its exact id.",
          dataTypeId: "recipe",
          dataTypeDescription: "One recipe.",
          resultShape: "entity",
          fields: {
            id: { label: "ID", semanticType: "identifier" },
            title: { label: "Recipe", semanticType: "text" },
          },
        },
      ],
    });
    const compiledCatalog = compileApprovedGraphQlCatalog(schemaSdl, draft, {
      schemaVersion: "1.0",
      reviewSourceHash: draft.reviewSourceHash,
      queries: [
        {
          capabilityId: "recipes.get",
          approvedVisitorArguments: ["id"],
          identityArguments: {},
          approvedOutputFields: ["id", "title"],
          requiredOutputFields: ["id"],
          policy: { authentication: "session", maximumRows: 1, timeoutMs: 1_000 },
          limits: { maximumSelectionDepth: 2, maximumSelectedFields: 5 },
        },
      ],
    });

    const execution = await executeApprovedGraphQlRequest({
      catalog: compiledCatalog.catalog,
      schema: schemaSdl,
      binding: compiledCatalog.bindings.get("recipes.get")!,
      // The id the model asked for exists nowhere — the upstream answers null.
      request: { capabilityId: "recipes.get", params: { id: "no-such-recipe" } },
      context: { identity: {}, permissions: new Set() },
      transport: async () => ({ data: { recipe: null } }),
      resolveProvenance: () => ({
        sources: [{ sourceId: "pantry-graph" }],
        freshness: { asOf: "2026-08-17T10:00:00.000Z" },
      }),
    });

    // Success with null data — "no such record" — never an INVALID_GRAPHQL_RESULT
    // whose bare ajv text ("must be object") reached visitors as an error.
    expect(execution).toEqual({
      ok: true,
      data: null,
      provenance: {
        sources: [{ sourceId: "pantry-graph" }],
        freshness: { asOf: "2026-08-17T10:00:00.000Z" },
      },
    });
  });
});

/**
 * A schema shaped like the APIs the live evaluation ran against: a filter
 * input object with a custom scalar buried one level down, a sort input whose
 * enum carries a value with a runtime precondition, and Relay paging.
 */
const narrowingSdl = /* GraphQL */ `
  scalar Decimal

  enum ItemOrderField {
    NAME
    PRICE
    RANK
  }

  input PriceRangeInput {
    gte: Decimal
    lte: Decimal
  }

  input ItemWhereInput {
    name: String
    price: PriceRangeInput
  }

  input ItemOrder {
    field: ItemOrderField!
    direction: String
  }

  type Item {
    id: ID!
    name: String!
    price: Float!
  }

  type Query {
    "Items on offer."
    items(where: ItemWhereInput, sortBy: ItemOrder, search: String, first: Int): [Item!]!
  }
`;

function narrowingDraft(): GraphQlCatalogInventory {
  return createGraphQlCatalogInventory({
    schema: narrowingSdl,
    catalog: { id: "items", version: "1.0.0", description: "Approved item reads." },
    source,
    queries: [
      {
        fieldName: "items",
        capabilityId: "items.search",
        purpose: "Find items by approved constraints.",
        dataTypeId: "item",
        dataTypeDescription: "An item approved for generated views.",
        resultShape: "collection",
        matchKey: "id",
        scalarMappings: { Decimal: { schema: { type: "string" } } },
      },
    ],
    discoveryMaxDepth: 3,
  });
}

function narrowingApproval(
  draft: GraphQlCatalogInventory,
  overrides: Partial<GraphQlCatalogDecisions["queries"][number]> = {},
): GraphQlCatalogDecisions {
  return {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    queries: [
      {
        capabilityId: "items.search",
        approvedVisitorArguments: ["where", "sortBy", "search", "first"],
        identityArguments: {},
        approvedOutputFields: ["id", "name", "price"],
        requiredOutputFields: ["id"],
        policy: { authentication: "public", maximumRows: 50, timeoutMs: 2_000 },
        limits: { maximumSelectionDepth: 3, maximumSelectedFields: 12 },
        ...overrides,
      },
    ],
  };
}

describe("source narrowing vs post-fetch filtering", () => {
  it("derives sourceNarrowingArguments from the approved arguments, paging excluded", () => {
    const draft = narrowingDraft();
    const compiledCatalog = compileApprovedGraphQlCatalog(
      narrowingSdl,
      draft,
      narrowingApproval(draft),
    );
    const capability = compiledCatalog.catalog.capabilities[0]!;
    // `first` reads a page; it does not narrow which records qualify.
    expect(capability.supports?.sourceNarrowingArguments).toEqual([
      "where",
      "sortBy",
      "search",
    ]);
    // The two vocabularies stay separate: filterFields remain the projected
    // row paths the post-fetch engine accepts, valid for plan-level filters.
    expect(capability.supports?.filterFields).toEqual(["id", "name", "price"]);
    // And the manifest the planner reads carries the same facts whole.
    expect(
      compiledCatalog.plannerManifest.capabilities[0]!.supports
        ?.sourceNarrowingArguments,
    ).toEqual(["where", "sortBy", "search"]);
  });

  it("advertises nothing when only paging is approved", () => {
    const draft = narrowingDraft();
    const compiledCatalog = compileApprovedGraphQlCatalog(
      narrowingSdl,
      draft,
      narrowingApproval(draft, { approvedVisitorArguments: ["first"] }),
    );
    const capability = compiledCatalog.catalog.capabilities[0]!;
    expect(capability.supports?.sourceNarrowingArguments).toBeUndefined();
    // Post-fetch filtering is still honestly on offer — it is real, it just
    // runs over the fetched page.
    expect(capability.supports?.filterFields).toEqual(["id", "name", "price"]);
  });
});

describe("customScalarNames", () => {
  it("finds a scalar reachable only inside an input object when given the schema", () => {
    const candidates = listGraphQlQueries(narrowingSdl);
    const withSchema = customScalarNames(candidates, narrowingSdl);
    expect(withSchema).toEqual(["Decimal"]);
    // Input-object and enum type names need no mapping and are not listed.
    expect(withSchema).not.toContain("ItemWhereInput");
    expect(withSchema).not.toContain("ItemOrderField");
    // The schemaless form cannot see inside input objects — the gap the
    // schema-aware form exists to close.
    expect(customScalarNames(candidates)).not.toContain("Decimal");
  });
});

describe("scalar mapping failures", () => {
  it("names the scalar, the input path, the capability, and the fix", () => {
    const draft = createGraphQlCatalogInventory({
      schema: narrowingSdl,
      catalog: { id: "items", version: "1.0.0", description: "Approved item reads." },
      source,
      queries: [
        {
          fieldName: "items",
          capabilityId: "items.search",
          purpose: "Find items by approved constraints.",
          dataTypeId: "item",
          dataTypeDescription: "An item approved for generated views.",
          resultShape: "collection",
          matchKey: "id",
          // No mapping for Decimal, which lives only inside ItemWhereInput.
        },
      ],
      discoveryMaxDepth: 3,
    });
    let thrown: unknown;
    try {
      compileApprovedGraphQlCatalog(narrowingSdl, draft, narrowingApproval(draft));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GraphQlScalarMappingError);
    const error = thrown as GraphQlScalarMappingError;
    expect(error.scalarName).toBe("Decimal");
    expect(error.path).toBe("where.price.gte");
    expect(error.capabilityId).toBe("items.search");
    expect(error.message).toMatch(/where\.price\.gte/);
    expect(error.message).toMatch(/items\.search/);
    expect(error.message).toMatch(/scalarMappings\["Decimal"\]/);
  });
});

const recursiveFilterSdl = /* GraphQL */ `
  input StringFilter {
    equals: String
    not_equals: String
    contains: String
    in: [String!]
    exists: Boolean
  }

  input PostWhereInput {
    sectionSlug: StringFilter
    byline: StringFilter
    publishedAt: StringFilter
    heroImage: StringFilter
    wordCount: StringFilter
    AND: [PostWhereInput!]
    OR: [PostWhereInput!]
  }

  type Post {
    id: ID!
    title: String!
    sectionSlug: String!
  }

  type Query {
    "Published posts."
    posts(where: PostWhereInput, first: Int): [Post!]!
  }
`;

function recursiveFilterInventory(): GraphQlCatalogInventory {
  return createGraphQlCatalogInventory({
    schema: recursiveFilterSdl,
    catalog: { id: "news", version: "1.0.0", description: "Approved post reads." },
    source,
    queries: [
      {
        fieldName: "posts",
        capabilityId: "posts.list",
        purpose: "Find posts by approved constraints.",
        dataTypeId: "post",
        dataTypeDescription: "A published post.",
        resultShape: "collection",
        matchKey: "id",
      },
    ],
    discoveryMaxDepth: 3,
  });
}

function recursiveFilterDecisions(
  inventory: GraphQlCatalogInventory,
  overrides: Partial<GraphQlCatalogDecisions["queries"][number]> = {},
): GraphQlCatalogDecisions {
  return {
    schemaVersion: "1.0",
    reviewSourceHash: inventory.reviewSourceHash,
    queries: [
      {
        capabilityId: "posts.list",
        approvedVisitorArguments: ["where", "first"],
        identityArguments: {},
        approvedOutputFields: ["id", "title", "sectionSlug"],
        requiredOutputFields: ["id"],
        policy: {
          authentication: "public" as const,
          maximumRows: 50,
          timeoutMs: 5_000,
        },
        limits: { maximumSelectionDepth: 3, maximumSelectedFields: 20 },
        ...overrides,
      },
    ],
  };
}

/** The whole params schema, definitions included. */
function whereParams(decisions: GraphQlCatalogDecisions, inventory: GraphQlCatalogInventory) {
  return compileApprovedGraphQlCatalog(recursiveFilterSdl, inventory, decisions).catalog
    .capabilities[0]!.inputSchema as {
    properties: Record<string, Record<string, unknown>>;
    $defs?: Record<string, Record<string, unknown>>;
  };
}

/** The `where` argument as the planner would receive it. */
function whereSchema(decisions: GraphQlCatalogDecisions, inventory: GraphQlCatalogInventory) {
  const compiledCatalog = compileApprovedGraphQlCatalog(
    recursiveFilterSdl,
    inventory,
    decisions,
  );
  const inputSchema = compiledCatalog.catalog.capabilities[0]!.inputSchema as {
    properties: Record<string, Record<string, unknown>>;
    $defs?: Record<string, Record<string, unknown>>;
  };
  const argument = inputSchema.properties.where!;
  const variants = (argument.anyOf as Array<Record<string, unknown>> | undefined) ?? [argument];
  const chosen = variants.find(
    (variant) => variant.type === "object" || typeof variant.$ref === "string",
  ) as Record<string, unknown>;
  // A self-referential filter is now written once as a definition and
  // referenced, so resolve that before asserting on its shape. What the
  // pruning did is unchanged — where it is written down is not.
  const ref = chosen.$ref;
  if (typeof ref === "string") {
    return inputSchema.$defs![ref.replace("#/$defs/", "")] as {
      properties: Record<string, unknown>;
    };
  }
  return chosen as { properties: Record<string, unknown> };
}

describe("approvedInputFields", () => {
  it("keeps only the approved columns of an approved argument", () => {
    const inventory = recursiveFilterInventory();
    const rendered = whereSchema(
      recursiveFilterDecisions(inventory, {
        approvedInputFields: ["where.sectionSlug", "where.publishedAt"],
      }),
      inventory,
    );
    expect(Object.keys(rendered.properties).sort()).toEqual([
      "AND",
      "OR",
      "publishedAt",
      "sectionSlug",
    ]);
  });

  it("reaches a column through a combinator without naming every nesting", () => {
    const inventory = recursiveFilterInventory();
    const rendered = whereSchema(
      recursiveFilterDecisions(inventory, {
        approvedInputFields: ["where.sectionSlug"],
      }),
      inventory,
    );
    // `AND` nests the same input type, so the one declared path governs the
    // column wherever the grouping puts it. Naming `where.AND.sectionSlug`
    // would make a host enumerate every route to one decision.
    //
    // The pruning is what this pins, and it is unchanged: one approved column
    // survives and nothing else does. What changed is where the nested copy
    // lives — `AND` now references the same definition rather than carrying a
    // truncated second copy of it, so the grouped shape is the grouped shape at
    // any depth instead of running out at two.
    const and = rendered.properties.AND as { anyOf?: Array<Record<string, unknown>> };
    const list = (and.anyOf ?? [and]).find((variant) => variant.type === "array") as {
      items: Record<string, unknown>;
    };
    expect(typeof list.items.$ref).toBe("string");

    const params = whereParams(
      recursiveFilterDecisions(inventory, { approvedInputFields: ["where.sectionSlug"] }),
      inventory,
    );
    const nested = params.$defs![(list.items.$ref as string).replace("#/$defs/", "")]!;
    // Combinators are transparent to pruning by design, so they survive; every
    // column the host did not approve does not, at every level, because there
    // is only the one level.
    const columns = Object.keys(nested.properties as Record<string, unknown>).filter(
      (name) => name !== "AND" && name !== "OR",
    );
    expect(columns).toEqual(["sectionSlug"]);
  });

  it("leaves an argument nobody named alone", () => {
    const inventory = recursiveFilterInventory();
    const rendered = whereSchema(
      recursiveFilterDecisions(inventory, { approvedInputFields: ["where.sectionSlug"] }),
      inventory,
    );
    // Deny-by-default applies inside an argument a host took a position on.
    // `first` was approved and not mentioned, so it survives untouched.
    const compiledCatalog = compileApprovedGraphQlCatalog(
      recursiveFilterSdl,
      inventory,
      recursiveFilterDecisions(inventory, { approvedInputFields: ["where.sectionSlug"] }),
    );
    const inputSchema = compiledCatalog.catalog.capabilities[0]!.inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(inputSchema.properties.first).toBeDefined();
    expect(rendered.properties.sectionSlug).toBeDefined();
  });

  it("approves a column with the operators on it, not just its name", () => {
    const inventory = recursiveFilterInventory();
    const rendered = whereSchema(
      recursiveFilterDecisions(inventory, { approvedInputFields: ["where.sectionSlug"] }),
      inventory,
    );
    // The regression this exists for: an earlier cut kept descending past an
    // approved path, found nothing approved inside the operator object every
    // real filter API wraps its columns in, emptied it, and dropped the column
    // it had been told to keep — taking the whole argument with it. A fixture
    // whose columns were bare scalars could not see this.
    const column = rendered.properties.sectionSlug as {
      anyOf?: Array<Record<string, unknown>>;
    };
    const object = (column.anyOf ?? [column]).find(
      (variant) => variant.type === "object",
    ) as { properties: Record<string, unknown> };
    expect(Object.keys(object.properties).sort()).toEqual([
      "contains",
      "equals",
      "exists",
      "in",
      "not_equals",
    ]);
  });

  it("refuses a path that matches no input field", () => {
    const inventory = recursiveFilterInventory();
    expect(() =>
      compileApprovedGraphQlCatalog(
        recursiveFilterSdl,
        inventory,
        recursiveFilterDecisions(inventory, {
          approvedInputFields: ["where.sectionSlug", "where.sectionSlugg"],
        }),
      ),
    ).toThrow(/"where\.sectionSlugg".*matches no input field/s);
  });

  it("shrinks the contract it was built to shrink", () => {
    const inventory = recursiveFilterInventory();
    const full = JSON.stringify(
      whereSchema(recursiveFilterDecisions(inventory), inventory),
    ).length;
    const pruned = JSON.stringify(
      whereSchema(
        recursiveFilterDecisions(inventory, {
          approvedInputFields: ["where.sectionSlug"],
        }),
        inventory,
      ),
    ).length;
    // The measured case is 40x on a real schema; this fixture is small, so the
    // assertion is directional. What it locks is that pruning reaches the
    // recursive copies too — a prune that only trimmed the top level would
    // barely move this number.
    expect(pruned).toBeLessThan(full / 2);
  });
});

describe("excludeEnumValues", () => {
  it("strips the excluded value from the compiled input schema", () => {
    const draft = narrowingDraft();
    const compiledCatalog = compileApprovedGraphQlCatalog(
      narrowingSdl,
      draft,
      narrowingApproval(draft, {
        excludeEnumValues: { "sortBy.field": ["RANK"] },
      }),
    );
    const inputSchema = compiledCatalog.catalog.capabilities[0]!.inputSchema as {
      properties: Record<string, { anyOf?: Array<Record<string, unknown>> }>;
    };
    const sortBy = inputSchema.properties.sortBy!;
    const objectVariant = (sortBy.anyOf ?? [sortBy]).find(
      (variant) => variant.type === "object",
    ) as { properties: Record<string, { enum?: string[] }> };
    expect(objectVariant.properties.field!.enum).toEqual(["NAME", "PRICE"]);
  });

  it("refuses a value the enum does not declare", () => {
    const draft = narrowingDraft();
    expect(() =>
      compileApprovedGraphQlCatalog(
        narrowingSdl,
        draft,
        narrowingApproval(draft, {
          excludeEnumValues: { "sortBy.field": ["POPULARITY"] },
        }),
      ),
    ).toThrow(/"POPULARITY".*ItemOrderField does not declare/);
  });

  it("refuses a key that matches no enum, naming the key shape", () => {
    const draft = narrowingDraft();
    expect(() =>
      compileApprovedGraphQlCatalog(
        narrowingSdl,
        draft,
        narrowingApproval(draft, {
          excludeEnumValues: { "sortBy.direction": ["DESCENDING"] },
        }),
      ),
    ).toThrow(/match(es)? no enum/);
  });

  it("refuses an exclusion that empties the enum", () => {
    const draft = narrowingDraft();
    expect(() =>
      compileApprovedGraphQlCatalog(
        narrowingSdl,
        draft,
        narrowingApproval(draft, {
          excludeEnumValues: { "sortBy.field": ["NAME", "PRICE", "RANK"] },
        }),
      ),
    ).toThrow(/removes every value/);
  });
});

describe("conflicting data type definitions", () => {
  it("names both capabilities and the exact field difference", () => {
    const conflictSdl = /* GraphQL */ `
      type Item {
        id: ID!
        name: String!
        price: Float!
      }
      type Query {
        "All items."
        items: [Item!]!
        "Featured items."
        featured: [Item!]!
      }
    `;
    const draft = createGraphQlCatalogInventory({
      schema: conflictSdl,
      catalog: { id: "items", version: "1.0.0", description: "Approved item reads." },
      source,
      queries: [
        {
          fieldName: "items",
          capabilityId: "items.all",
          purpose: "List items.",
          dataTypeId: "item",
          resultShape: "collection",
          matchKey: "id",
        },
        {
          fieldName: "featured",
          capabilityId: "items.featured",
          purpose: "List featured items.",
          dataTypeId: "item",
          resultShape: "collection",
          matchKey: "id",
        },
      ],
      discoveryMaxDepth: 3,
    });
    const approvalBody: GraphQlCatalogDecisions = {
      schemaVersion: "1.0",
      reviewSourceHash: draft.reviewSourceHash,
      queries: [
        {
          capabilityId: "items.all",
          approvedVisitorArguments: [],
          identityArguments: {},
          approvedOutputFields: ["id", "name", "price"],
          requiredOutputFields: ["id"],
          policy: { authentication: "public", maximumRows: 50, timeoutMs: 2_000 },
          limits: { maximumSelectionDepth: 3, maximumSelectedFields: 12 },
        },
        {
          capabilityId: "items.featured",
          approvedVisitorArguments: [],
          identityArguments: {},
          // `price` missing: the classic conflict — same dataTypeId, different
          // projection.
          approvedOutputFields: ["id", "name"],
          requiredOutputFields: ["id"],
          policy: { authentication: "public", maximumRows: 50, timeoutMs: 2_000 },
          limits: { maximumSelectionDepth: 3, maximumSelectedFields: 12 },
        },
      ],
    };
    let message = "";
    try {
      compileApprovedGraphQlCatalog(conflictSdl, draft, approvalBody);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/"items\.all"/);
    expect(message).toMatch(/"items\.featured"/);
    expect(message).toMatch(/only in "items\.all": price/);
    expect(message).toMatch(/own dataTypeId/);
  });
});

describe("hierarchy shape claims", () => {
  const treeSdl = /* GraphQL */ `
    type Category {
      id: ID!
      name: String!
      parent: Category
    }
    type Query {
      "All categories."
      categories: [Category!]!
    }
  `;

  function treeCompile(resultShape: "hierarchy" | "collection") {
    const draft = createGraphQlCatalogInventory({
      schema: treeSdl,
      catalog: { id: "tree", version: "1.0.0", description: "Approved reads." },
      source,
      queries: [
        {
          fieldName: "categories",
          capabilityId: "categories.tree",
          purpose: "Browse the category tree.",
          dataTypeId: "category",
          resultShape,
          matchKey: "id",
        },
      ],
      discoveryMaxDepth: 3,
    });
    return compileApprovedGraphQlCatalog(treeSdl, draft, {
      schemaVersion: "1.0",
      reviewSourceHash: draft.reviewSourceHash,
      queries: [
        {
          capabilityId: "categories.tree",
          approvedVisitorArguments: [],
          identityArguments: {},
          approvedOutputFields: ["id", "name"],
          requiredOutputFields: ["id"],
          policy: { authentication: "public", maximumRows: 50, timeoutMs: 2_000 },
          limits: { maximumSelectionDepth: 3, maximumSelectedFields: 12 },
        },
      ],
    });
  }

  it("warns when a hierarchy projection carries no parent reference", () => {
    // Depth without parentage: siblings under different parents are
    // indistinguishable, under a heading asserting "what sits under what".
    // For a self-recursive type like this one the parent field is not even
    // discoverable (the recursion stop excludes it), so the claim is
    // unfulfillable — exactly what the warning must say out loud.
    const compiledCatalog = treeCompile("hierarchy");
    const warning = compiledCatalog.issues.find(
      (issue) => issue.path === "categories.tree" && /parent reference/.test(issue.message),
    );
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe("warning");
    expect(warning!.message).toMatch(/Category/);
    expect(warning!.message).toMatch(/"collection" is the honest shape/);
    // A warning, never a block: the catalog still compiled.
    expect(compiledCatalog.catalog.capabilities[0]!.id).toBe("categories.tree");
  });

  it("stays silent for the same projection declared as a collection", () => {
    const compiledCatalog = treeCompile("collection");
    const warning = compiledCatalog.issues.find((issue) =>
      /parent reference/.test(issue.message),
    );
    expect(warning).toBeUndefined();
  });
});
