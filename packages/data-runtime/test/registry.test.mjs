import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import {
  createCapabilityCatalogStore,
  createRuntimesFromBindings,
  executeDataRequest,
} from "../dist/index.js";
import {
  compileApprovedGraphQlCatalog,
  createGraphQlCatalogInventory,
} from "@renderyes/capability-catalog/graphql";

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Shaped exactly like the review UI's `capability-catalog.json` export. */
const approvedCatalog = {
  schemaVersion: "1.0",
  id: "support-assist",
  version: "1.0.0",
  description: "Approved Support Assist reads.",
  dataTypes: [
    {
      id: "AgentReport",
      version: "1.0.0",
      description: "An approved agent report summary.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["status", "total_reports"],
        properties: {
          status: { type: "string" },
          total_reports: { type: "integer" },
        },
      },
      fields: {
        status: { label: "Status", semanticType: "status" },
        total_reports: { label: "Total Reports", semanticType: "quantity" },
      },
    },
  ],
  sources: [{ id: "support-api", label: "Support Assist API" }],
  capabilities: [
    {
      id: "agentReport.list",
      version: "1.0.0",
      purpose: "List generated agent reports.",
      kind: "query",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { page: { type: "integer" } },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["status", "total_reports"],
        properties: {
          status: { type: "string" },
          total_reports: { type: "integer" },
        },
      },
      output: { dataTypeId: "AgentReport", shape: "entity" },
      requiredSessionKeys: [],
      sourceIds: ["support-api"],
      policy: { authentication: "public" },
    },
  ],
  relationships: [],
};

/** Shaped exactly like the review UI's `server-bindings.json` export. */
const approvedBindings = {
  "agentReport.list": {
    capabilityId: "agentReport.list",
    method: "GET",
    path: "/api/v1/agent-report",
    contentParameters: ["page"],
    exposeFields: ["status", "total_reports"],
  },
};

test("publishing an approved catalog produces a planner-safe manifest and executable runtimes", () => {
  const store = createCapabilityCatalogStore();
  const registered = store.publish({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    runtime: { baseUrl: "http://127.0.0.1:9" },
    now: () => new Date("2026-08-03T00:00:00.000Z"),
  });

  assert.equal(registered.catalogId, "support-assist");
  assert.equal(registered.publishedAt, "2026-08-03T00:00:00.000Z");
  // A runtime exists for the approved capability, so the executor can run it.
  assert.equal(registered.runtimes.has("agentReport.list"), true);
  // The planner manifest is derived, not supplied — and must stay planner-safe.
  assert.equal(registered.plannerManifest.catalogId, "support-assist");
  assert.equal(registered.plannerManifest.catalogHash, registered.catalogHash);
  const plannerJson = JSON.stringify(registered.plannerManifest);
  assert.equal(plannerJson.includes("/api/v1/agent-report"), false);
  assert.equal(plannerJson.includes("Support Assist API"), false);
  // Retrievable for a later planner request.
  assert.equal(store.get("support-assist")?.catalogHash, registered.catalogHash);
});

test("a published catalog rejects invalid input rather than trusting the UI", () => {
  const store = createCapabilityCatalogStore();
  assert.throws(
    () => store.publish({ catalog: { schemaVersion: "1.0", id: "" }, bindings: {} }),
    /Invalid capability catalog/,
  );
});

test("capabilities with no binding are reported rather than silently stubbed", () => {
  const { runtimes, unbound } = createRuntimesFromBindings(approvedCatalog, {});
  assert.equal(runtimes.size, 0);
  assert.deepEqual(unbound, ["agentReport.list"]);
});

test("a binding filed under an id it does not name is refused at registration", () => {
  // Both sides of this agreement exist here. The executor does catch it —
  // `runtime.capabilityId !== capability.id` fails closed with
  // RUNTIME_NOT_FOUND — but only once a visitor asks for the capability, so a
  // typo in host config published cleanly and surfaced in production.
  const mismatched = {
    "agentReport.list": { ...approvedBindings["agentReport.list"], capabilityId: "agentReport.other" },
  };

  assert.throws(
    () => createRuntimesFromBindings(approvedCatalog, mismatched),
    /declares capabilityId agentReport\.other/,
  );

  // And through the store, which is the path a host actually takes.
  const store = createCapabilityCatalogStore();
  assert.throws(
    () =>
      store.publish({
        catalog: approvedCatalog,
        bindings: mismatched,
        runtime: { baseUrl: "http://127.0.0.1:9" },
      }),
    /must be filed under the id it names/,
  );
});

test("a published catalog executes end to end against a live endpoint", async () => {
  let observedUrl;
  const server = await startServer((req, res) => {
    observedUrl = req.url;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 7 }));
  });
  try {
    const store = createCapabilityCatalogStore();
    const registered = store.publish({
      catalog: approvedCatalog,
      bindings: approvedBindings,
      runtime: { baseUrl: server.baseUrl },
    });

    // Exactly the call a planner-produced request makes, using only what the
    // registry supplied — no hand-written runtime map anywhere.
    const result = await executeDataRequest({
      request: {
        requestId: "reports",
        capabilityId: "agentReport.list",
        params: { page: 1 },
      },
      dataCatalog: {
        id: registered.catalogId,
        version: registered.version,
        hash: registered.catalogHash,
      },
      catalog: registered.catalog,
      runtimes: registered.runtimes,
      session: {},
      host: {
        isAuthenticated: () => true,
        hasPermission: () => true,
        getSessionValue: () => undefined,
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { status: "ok", total_reports: 7 });
    assert.equal(result.provenance.sources[0].sourceId, "support-api");
    assert.equal(observedUrl, "/api/v1/agent-report?page=1");
  } finally {
    await server.close();
  }
});

test("a reviewed GraphQL catalog publishes and executes through the same registry", async () => {
  const schema = `
    type Product {
      id: ID!
      name: String!
      stock: Int!
    }

    type Query {
      products(maxStock: Int): [Product!]!
    }
  `;
  const draft = createGraphQlCatalogInventory({
    schema,
    catalog: {
      id: "product-graph",
      version: "1.0.0",
      description: "Approved product graph reads.",
    },
    source: { id: "product-graph-api", label: "Product GraphQL API" },
    queries: [
      {
        fieldName: "products",
        capabilityId: "products.search",
        purpose: "Find products within an approved stock limit.",
        dataTypeId: "Product",
        resultShape: "collection",
      },
    ],
  });
  const compiled = compileApprovedGraphQlCatalog(schema, draft, {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    queries: [
      {
        capabilityId: "products.search",
        approvedVisitorArguments: ["maxStock"],
        identityArguments: {},
        approvedOutputFields: ["id", "name", "stock"],
        requiredOutputFields: ["id"],
        policy: {
          authentication: "public",
          maximumRows: 20,
          timeoutMs: 2_000,
        },
        limits: {
          maximumSelectionDepth: 2,
          maximumSelectedFields: 10,
        },
      },
    ],
  });
  let observedRequest;
  const store = createCapabilityCatalogStore();
  const registered = store.publish({
    bindingKind: "graphql",
    catalog: compiled.catalog,
    bindings: Object.fromEntries(compiled.bindings),
    runtime: {
      schema,
      transport: async (request) => {
        observedRequest = request;
        return {
          data: {
            products: [{ id: "p-1", name: "Printer paper", stock: 4 }],
          },
        };
      },
      resolveProvenance: () => ({
        sources: [{ sourceId: "product-graph-api" }],
        freshness: { asOf: "2026-08-03T00:00:00.000Z" },
      }),
    },
  });

  const result = await executeDataRequest({
    request: {
      requestId: "low-stock",
      capabilityId: "products.search",
      params: { maxStock: 9 },
    },
    dataCatalog: {
      id: registered.catalogId,
      version: registered.version,
      hash: registered.catalogHash,
    },
    catalog: registered.catalog,
    runtimes: registered.runtimes,
    session: {},
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
    },
  });

  assert.equal(registered.bindingKind, "graphql");
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, [{ id: "p-1", name: "Printer paper", stock: 4 }]);
  assert.equal(observedRequest.variables.maxStock, 9);
  assert.match(observedRequest.document, /query View_products_search/);
  assert.match(observedRequest.document, /products\(maxStock:/);
});

test("a declared ordering reaches the upstream through the published registry", async () => {
  // The seam the two unit suites cannot cover between them: the catalog resolves
  // the grammar onto a binding, the registry builds a runtime from that binding,
  // and the executor has to read the declaration off that runtime before it
  // decides what to push. A break anywhere along it looks like a correct answer
  // over the wrong rows, so it is worth one wired test.
  const schema = `
    type Product { id: ID!, name: String!, stock: Int! }
    type Products { docs: [Product!]!, hasNextPage: Boolean!, totalDocs: Int! }
    type Query { products(sort: String, limit: Int, page: Int): Products }
  `;
  const draft = createGraphQlCatalogInventory({
    schema,
    catalog: { id: "product-graph", version: "1.0.0", description: "Approved reads." },
    source: { id: "product-graph-api", label: "Product GraphQL API" },
    queries: [
      {
        fieldName: "products",
        capabilityId: "products.search",
        purpose: "Find products by stock on hand.",
        dataTypeId: "Product",
        resultShape: "collection",
        listEnvelope: {
          rowsField: "docs",
          hasNextPageField: "hasNextPage",
          totalCountField: "totalDocs",
          pageSizeArgument: "limit",
          pageArguments: ["page"],
        },
      },
    ],
  });
  const compiled = compileApprovedGraphQlCatalog(schema, draft, {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    queries: [
      {
        capabilityId: "products.search",
        // `sort` is deliberately absent here: declaring the grammar hands the
        // writing to the runtime, and the compile refuses to leave it with both.
        approvedVisitorArguments: ["limit", "page"],
        identityArguments: {},
        orderingArgument: {
          name: "sort",
          ascending: "{field}",
          descending: "-{field}",
          separator: ",",
        },
        approvedOutputFields: ["id", "name", "stock"],
        requiredOutputFields: ["id"],
        policy: { authentication: "public", maximumRows: 20, timeoutMs: 2_000 },
        limits: { maximumSelectionDepth: 2, maximumSelectedFields: 10 },
      },
    ],
  });

  const inventory = [
    { id: "p-1", name: "Printer paper", stock: 4 },
    { id: "p-2", name: "Stapler", stock: 31 },
    { id: "p-3", name: "Whiteboard marker", stock: 12 },
    { id: "p-4", name: "Desk lamp", stock: 27 },
    { id: "p-5", name: "Notebook", stock: 8 },
  ];
  let observedRequest;
  const store = createCapabilityCatalogStore();
  const registered = store.publish({
    bindingKind: "graphql",
    catalog: compiled.catalog,
    bindings: Object.fromEntries(compiled.bindings),
    runtime: {
      schema,
      // An upstream that understands the grammar its host declared, and pages
      // only after ordering — which is the ordering-then-limit that makes a
      // top-N correct in the first place.
      transport: async (request) => {
        observedRequest = request;
        const expression = request.variables.sort;
        const rows = [...inventory];
        if (typeof expression === "string") {
          for (const term of expression.split(",").reverse()) {
            const descending = term.startsWith("-");
            const field = descending ? term.slice(1) : term;
            rows.sort((left, right) =>
              descending ? right[field] - left[field] : left[field] - right[field],
            );
          }
        }
        const limit = request.variables.limit ?? 10;
        return {
          data: {
            products: {
              docs: rows.slice(0, limit),
              hasNextPage: limit < rows.length,
              totalDocs: rows.length,
            },
          },
        };
      },
      resolveProvenance: () => ({
        sources: [{ sourceId: "product-graph-api" }],
        freshness: { asOf: "2026-08-03T00:00:00.000Z" },
      }),
    },
  });

  const result = await executeDataRequest({
    request: {
      requestId: "best-stocked",
      capabilityId: "products.search",
      params: {},
      query: { sort: [{ field: "stock", direction: "desc" }], limit: 2 },
    },
    dataCatalog: {
      id: registered.catalogId,
      version: registered.version,
      hash: registered.catalogHash,
    },
    catalog: registered.catalog,
    runtimes: registered.runtimes,
    session: {},
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
    },
  });

  assert.equal(result.ok, true);
  // The grammar was rendered and sent, and the plan's limit went with it.
  assert.equal(observedRequest.variables.sort, "-stock");
  assert.equal(observedRequest.variables.limit, 2);
  assert.match(observedRequest.document, /\$sort: String/);
  // The real prize: the top two of all five, not the top two of a page. Both
  // rows are ones a page-bounded sort of the first two would have missed.
  assert.deepEqual(
    result.data.map((row) => row.id),
    ["p-2", "p-4"],
  );
  // And the answer is reported complete: more rows exist upstream, but nothing
  // was narrowed here after the fetch.
  assert.equal(result.provenance.narrowedAfterFetch, undefined);
});
