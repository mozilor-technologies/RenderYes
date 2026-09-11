import { describe, expect, it } from "vitest";
import {
  compileApprovedOpenApiCatalog,
  createOpenApiCatalogInventory,
  detectOpenApiDocumentDrift,
  hashOpenApiDocument,
  importOpenApiCatalogInventory,
  listOpenApiGetOperations,
  listOpenApiOperations,
} from "../src/openapi.js";
import { OperationClassificationResultSchema } from "../src/operation-effect.js";

describe("OpenAPI onboarding smoke test", () => {
  it("imports only the explicitly approved GET capability and fields", () => {
    const result = importOpenApiCatalogInventory({
      document: {
        openapi: "3.1.0",
        info: { title: "Products", version: "1.0.0" },
        paths: {
          "/products": {
            get: {
              operationId: "listProducts",
              parameters: [
                {
                  name: "maximumStock",
                  in: "query",
                  schema: { type: "integer", minimum: 0 },
                },
              ],
              responses: {
                "200": {
                  description: "Products",
                  content: {
                    "application/json": {
                      schema: {
                        type: "array",
                        items: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            stock: { type: "integer" },
                            internalCost: { type: "number" },
                          },
                          required: ["id", "name", "stock"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      catalog: {
        id: "approved-products",
        version: "1.0.0",
        description: "Approved product API capabilities.",
      },
      source: { id: "product-api", label: "Product API" },
      operations: [
        {
          operationId: "listProducts",
          capabilityId: "products.search",
          dataTypeId: "product",
          matchKey: "id",
          resultShape: "collection",
          contentParameters: ["maximumStock"],
          exposeFields: ["id", "name", "stock"],
          // Required now, with no default. This selection used to omit it and
          // compile to `authentication: "public"`, which skipped both the
          // authentication and the permission gate at execution.
          policy: { authentication: "session" },
        },
      ],
    });

    expect(result.catalog.capabilities).toHaveLength(1);
    expect(result.catalog.dataTypes[0]?.fields).not.toHaveProperty("internalCost");
    expect(JSON.stringify(result.plannerManifest)).not.toContain("/products");
    expect(result.bindings.get("products.search")?.path).toBe("/products");
  });
});

describe("OpenAPI semantic-effect discovery", () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "Support", version: "1.0.0" },
    security: [{ bearerAuth: [] }],
    paths: {
      "/health": {
        get: {
          operationId: "health",
          summary: "Service health",
          responses: {
            "200": {
              description: "Health",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { status: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
      "/conversation-list": {
        post: {
          operationId: "getConversationList",
          summary: "Get Conversation List",
          description: "Returns filtered support conversations.",
          tags: ["Chat"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["workspace"],
                  properties: {
                    workspace: { type: "string", description: "Workspace code" },
                    search: { type: "string" },
                    page: { type: "integer", default: 1 },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Conversations",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: { ticket_id: { type: "string" } },
                        },
                      },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/ticket-update": {
        post: {
          operationId: "updateTicket",
          summary: "Update ticket",
          "x-renderyes-effect": "action",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string" } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Updated ticket",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { id: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
  };

  it("discovers typed POST operations without granting or classifying them", () => {
    const operations = listOpenApiOperations(document);
    expect(
      operations.map((operation) => `${operation.method}:${operation.path}`),
    ).toEqual(["get:/health", "post:/conversation-list", "post:/ticket-update"]);

    const conversationList = operations[1]!;
    expect(conversationList.support.status).toBe("supported");
    expect(conversationList.explicitEffect).toBeUndefined();
    expect(conversationList.classificationInput).toMatchObject({
      operationKey: "post:/conversation-list",
      protocol: "openapi",
      coordinate: "POST /conversation-list",
      operationName: "getConversationList",
      summary: "Get Conversation List",
      tags: ["Chat"],
      security: [{ bearerAuth: [] }],
      inputShape: {
        requestBody: {
          required: true,
          schema: {
            type: "object",
            required: ["workspace"],
            properties: {
              workspace: { type: "string", description: "Workspace code" },
              search: { type: "string" },
              page: { type: "integer", default: 1 },
            },
          },
        },
      },
    });
    // Discovery supplies evidence only. It deliberately does not invent an
    // effect or an executable capability.
    expect(conversationList.classificationInput.explicitEffect).toBeUndefined();
    expect(conversationList).not.toHaveProperty("capabilityId");
  });

  it("honors an explicit publisher effect annotation as highest-priority metadata", () => {
    const update = listOpenApiOperations(document).find(
      (operation) => operation.path === "/ticket-update",
    );
    expect(update?.explicitEffect).toBe("state-changing-action");
    expect(update?.classificationInput.explicitEffect).toBe("state-changing-action");
  });

  it("keeps the old GET-only discovery API backward compatible", () => {
    expect(listOpenApiGetOperations(document).map((operation) => operation.path)).toEqual(
      ["/health"],
    );
  });

  it("compiles a reviewed read-only POST with a constrained JSON body binding", () => {
    const draft = createOpenApiCatalogInventory({
      document,
      catalog: {
        id: "support-reads",
        version: "1.0.0",
        description: "Approved support reads.",
      },
      source: { id: "support-api", label: "Support API" },
      operations: [
        {
          operationId: "getConversationList",
          method: "post",
          capabilityId: "conversations.list",
          purpose: "List support conversations using approved search filters.",
          dataTypeId: "ConversationList",
          resultShape: "search-results",
        },
      ],
    });
    const compiled = compileApprovedOpenApiCatalog(document, draft, {
      schemaVersion: "1.0",
      reviewSourceHash: draft.reviewSourceHash,
      operations: [
        {
          capabilityId: "conversations.list",
          approvedVisitorParameters: ["body.workspace", "body.search"],
          approvedOutputFields: ["ticket_id"],
          // The reviewer's access decision now lives in the approval artifact
          // itself, so an approval that records which fields were approved but
          // not who may read them no longer validates.
          policy: { authentication: "session" },
        },
      ],
    });

    expect(compiled.bindings.get("conversations.list")).toMatchObject({
      method: "POST",
      path: "/conversation-list",
      contentParameters: [],
      bodyParameters: ["workspace", "search"],
    });
    expect(compiled.catalog.capabilities[0]?.inputSchema).toMatchObject({
      required: ["workspace"],
      properties: { workspace: { type: "string" }, search: { type: "string" } },
    });
  });

  it("rejects a read-only POST when a required JSON body field is not approved", () => {
    const draft = createOpenApiCatalogInventory({
      document,
      catalog: {
        id: "support-reads",
        version: "1.0.0",
        description: "Approved support reads.",
      },
      source: { id: "support-api", label: "Support API" },
      operations: [
        {
          operationId: "getConversationList",
          method: "post",
          capabilityId: "conversations.list",
          dataTypeId: "ConversationList",
          resultShape: "search-results",
        },
      ],
    });
    expect(() =>
      compileApprovedOpenApiCatalog(document, draft, {
        schemaVersion: "1.0",
        reviewSourceHash: draft.reviewSourceHash,
        operations: [
          {
            capabilityId: "conversations.list",
            approvedVisitorParameters: ["body.search"],
            approvedOutputFields: ["ticket_id"],
            policy: { authentication: "session" },
          },
        ],
      }),
    ).toThrow("Required JSON body parameter(s) must be approved");
  });

  it("rejects malformed model classifications at the shared contract boundary", () => {
    expect(() =>
      OperationClassificationResultSchema.parse({
        operationKey: "post:/conversation-list",
        effect: "read-only-query",
        confidence: 2,
        reason: "Looks like a read",
        riskSignals: [],
      }),
    ).toThrow();
  });
});

describe("OpenAPI description drift", () => {
  const productsDocument = {
    openapi: "3.1.0",
    info: { title: "Products", version: "1.0.0" },
    paths: {
      "/products": {
        get: {
          operationId: "listProducts",
          responses: {
            "200": {
              description: "Products",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: { id: { type: "string" }, name: { type: "string" } },
                      required: ["id", "name"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  function approve(document: unknown) {
    return importOpenApiCatalogInventory({
      document,
      catalog: { id: "products", version: "1.0.0", description: "Products." },
      source: { id: "product-api", label: "Product API" },
      operations: [
        {
          operationId: "listProducts",
          capabilityId: "products.list",
          dataTypeId: "product",
          matchKey: "id",
          resultShape: "collection",
          contentParameters: [],
          exposeFields: ["id", "name"],
          policy: { authentication: "session" },
        },
      ],
    });
  }

  it("records the description hash on every binding", () => {
    const draft = approve(productsDocument);
    const binding = draft.bindings.get("products.list");
    expect(binding?.documentHash).toBeTypeOf("string");
    expect(binding?.documentHash).toBe(hashOpenApiDocument(productsDocument));
  });

  it("reports nothing when the description has not moved, key order aside", () => {
    const draft = approve(productsDocument);
    expect(detectOpenApiDocumentDrift([...draft.bindings.values()], productsDocument)).toEqual(
      [],
    );

    // Canonicalised, so a re-serialised document is not drift. Without this a
    // host whose description round-trips through a formatter would be told every
    // capability had changed, and would stop believing the check.
    const reordered = {
      paths: productsDocument.paths,
      info: productsDocument.info,
      openapi: productsDocument.openapi,
    };
    expect(detectOpenApiDocumentDrift([...draft.bindings.values()], reordered)).toEqual([]);
  });

  it("reports the affected capability when the description changes", () => {
    const draft = approve(productsDocument);
    // A field turning optional: still a valid response shape, so the per-request
    // output validation would not notice, which is the gap this closes.
    const moved = structuredClone(productsDocument);
    moved.paths["/products"].get.responses["200"].content["application/json"].schema.items.required =
      ["id"];

    const drift = detectOpenApiDocumentDrift([...draft.bindings.values()], moved);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.capabilityId).toBe("products.list");
    expect(drift[0]?.approvedDocumentHash).toBe(hashOpenApiDocument(productsDocument));
    expect(drift[0]?.currentDocumentHash).toBe(hashOpenApiDocument(moved));
    expect(drift[0]?.approvedDocumentHash).not.toBe(drift[0]?.currentDocumentHash);
  });
});
