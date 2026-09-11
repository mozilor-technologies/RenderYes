import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import {
  createViewServer,
  createViewHttpHandler,
  createMemoryViewStore,
} from "../dist/index.js";
import {
  compileApprovedGraphQlCatalog,
  createGraphQlCatalogInventory,
} from "@renderyes/capability-catalog/graphql";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  field,
  toSiteManifest,
} from "@renderyes/site-sdk";

/**
 * A failed data request's message is written by whichever upstream produced it
 * — joined GraphQL errors, validator field names, interpolated params — and
 * the compose envelope goes to a browser. These tests pin the boundary: only a
 * code-derived sentence crosses it, on the batch envelope, its `reason`, and
 * every streamed frame alike. TIMEOUT and GRAPHQL_TRANSPORT_ERROR are the two
 * deliberate pass-throughs, so their exact strings are pinned too.
 */

const SENTINEL = "SECRET_RESOLVER_DETAIL param=xyz";

async function startUpstream(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const ReportCard = defineComponent({
  id: "ReportCard",
  version: "1.0.0",
  description: "Shows one report.",
  props: defineProps({ title: field.string({ default: "Report" }) }),
  renderer: { component: "ReportCard", props: { report: { path: "/report" } } },
  dataSlots: { report: { accepts: [{ dataTypeId: "AgentReport", shapes: ["entity"] }] } },
});

const siteFor = (id) =>
  defineSite({
    id,
    name: "Support Assist",
    version: "1.0.0",
    catalogId: "https://support.example.com/catalog.json",
    components: [ReportCard],
    surfaces: [
      defineSurface({ id: "main", description: "Main.", componentIds: ["ReportCard"], maxComponents: 1 }),
    ],
  });

const provider = (plan) => () => ({
  id: "stub",
  async generatePlan() {
    return { modelId: "m", value: plan };
  },
});

const planFor = (capabilityId) => ({
  status: "ready",
  dataRequests: [{ requestId: "r1", capabilityId, params: {} }],
  nodes: [
    {
      nodeId: "n1",
      componentId: "ReportCard",
      props: {},
      dataBindings: { report: { requestId: "r1" } },
    },
  ],
});

function reviewedGraphQlCatalog() {
  const schema = `
    type AgentReport {
      status: String!
      total_reports: Int!
    }

    type Query {
      agentReport(agentId: ID!): AgentReport!
    }
  `;
  const draft = createGraphQlCatalogInventory({
    schema,
    catalog: {
      id: "support-graph",
      version: "1.0.0",
      description: "Approved report graph reads.",
    },
    source: { id: "report-graph", label: "Report GraphQL API" },
    queries: [
      {
        fieldName: "agentReport",
        capabilityId: "agentReport.get",
        purpose: "Read the current agent's approved report summary.",
        dataTypeId: "AgentReport",
        resultShape: "entity",
        fields: {
          status: { label: "Status", semanticType: "status" },
          total_reports: { label: "Total reports", semanticType: "quantity" },
        },
      },
    ],
  });
  const compiled = compileApprovedGraphQlCatalog(schema, draft, {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    queries: [
      {
        capabilityId: "agentReport.get",
        approvedVisitorArguments: [],
        identityArguments: { agentId: "agentId" },
        approvedOutputFields: ["status", "total_reports"],
        requiredOutputFields: ["status", "total_reports"],
        policy: {
          authentication: "session",
          requiredPermissions: ["reports:read"],
          maximumRows: 1,
          timeoutMs: 2_000,
        },
        limits: { maximumSelectionDepth: 2, maximumSelectedFields: 5 },
      },
    ],
  });
  return {
    schema,
    catalog: compiled.catalog,
    bindings: Object.fromEntries(compiled.bindings),
  };
}

async function graphQlServerAgainst(upstreamBaseUrl, extra = {}) {
  const reviewed = reviewedGraphQlCatalog();
  const server = createViewServer({
    host: {
      isAuthenticated: (session) => Boolean(session.agentId),
      hasPermission: (session, permission) => session.permissions.has(permission),
      getSessionValue: (session, key) => session[key],
    },
    resolveSession: () => ({
      agentId: "AG-1",
      permissions: new Set(["reports:read"]),
    }),
    allowedUpstreamOrigins: [new URL(upstreamBaseUrl).origin],
    graphql: {
      resolveHeaders: () => ({}),
      resolveProvenance: ({ sourceId }) => ({
        sources: [{ sourceId }],
        freshness: { asOf: "2026-08-10T00:00:00.000Z" },
      }),
    },
    ...extra,
  });
  await server.publishReviewedCatalog({
    bindingKind: "graphql",
    catalog: reviewed.catalog,
    bindings: reviewed.bindings,
    schema: reviewed.schema,
    endpoint: `${upstreamBaseUrl}/graphql`,
  });
  await server.publishUiCatalog({ manifest: toSiteManifest(siteFor("support-graph")) });
  return server;
}

const composeGraph = (server, onEvent) =>
  server.composeAgainstPublishedCatalogs({
    catalogId: "support-graph",
    prompt: "show my report summary",
    request: {},
    createProvider: provider(planFor("agentReport.get")),
    ...(onEvent ? { onEvent } : {}),
  });

test("an upstream-authored error message never reaches the compose envelope or its frames", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ data: { agentReport: null }, errors: [{ message: SENTINEL }] }),
    );
  });
  try {
    const server = await graphQlServerAgainst(upstream.baseUrl);
    const events = [];
    const result = await composeGraph(server, (event) => events.push(event));

    assert.equal(result.ok, false);
    assert.equal(result.kind, "data-unavailable");
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].ok, false);
    // The code survives — hosts branch on it — while the message is replaced
    // by the sentence derived from it.
    assert.equal(result.requests[0].errorCode, "GRAPHQL_EXECUTION_ERROR");
    assert.equal(result.requests[0].error, "The data request failed.");
    assert.equal(result.reason, "The data request failed.");
    assert.ok(!JSON.stringify(result).includes(SENTINEL));
    // The streamed path serializes these events verbatim into SSE frames, so
    // the sentinel must be absent from every frame, not only the envelope.
    assert.ok(events.length > 0);
    assert.ok(!JSON.stringify(events).includes(SENTINEL));
    const end = events.find((event) => event.type === "TOOL_CALL_END");
    assert.equal(end.errorMessage, "The data request failed.");
  } finally {
    await upstream.close();
  }
});

test("a reopened saved view gets the same redaction as a fresh compose", async () => {
  let failing = false;
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      failing
        ? JSON.stringify({ data: { agentReport: null }, errors: [{ message: SENTINEL }] })
        : JSON.stringify({ data: { agentReport: { status: "ok", total_reports: 3 } } }),
    );
  });
  try {
    const server = await graphQlServerAgainst(upstream.baseUrl, {
      viewStore: createMemoryViewStore(),
      resolveViewOwner: (session) => session.agentId,
    });
    const composed = await composeGraph(server);
    assert.equal(composed.ok, true);
    const saved = await server.saveComposedView({
      catalogId: "support-graph",
      planId: composed.planId,
      request: {},
    });
    assert.equal(saved.ok, true);

    failing = true;
    const reopened = await server.reopenSavedView({ viewId: saved.viewId, request: {} });
    assert.equal(reopened.requests.length, 1);
    assert.equal(reopened.requests[0].ok, false);
    assert.equal(reopened.requests[0].errorCode, "GRAPHQL_EXECUTION_ERROR");
    assert.equal(reopened.requests[0].error, "The data request failed.");
    assert.ok(!JSON.stringify(reopened).includes(SENTINEL));
  } finally {
    await upstream.close();
  }
});

test("GRAPHQL_TRANSPORT_ERROR keeps its exact message — hosts match on it", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ errors: [{ message: "nope" }] }));
  });
  try {
    const server = await graphQlServerAgainst(upstream.baseUrl);
    const result = await composeGraph(server);

    assert.equal(result.ok, false);
    assert.equal(result.requests[0].errorCode, "GRAPHQL_TRANSPORT_ERROR");
    assert.equal(
      result.requests[0].error,
      "GraphQL upstream failed to handle the request (HTTP 500)",
    );
    assert.equal(result.reason, result.requests[0].error);
  } finally {
    await upstream.close();
  }
});

// ─── the REST fixture, for TIMEOUT and the catalog-enumeration boundary ──────

const restCatalog = (id) => ({
  schemaVersion: "1.0",
  id,
  version: "1.0.0",
  description: "Approved reads.",
  dataTypes: [
    {
      id: "AgentReport",
      version: "1.0.0",
      description: "A report.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { type: "string" } },
      },
      fields: { status: { label: "Status", semanticType: "status" } },
    },
  ],
  sources: [{ id: "support-api", label: "Support API" }],
  capabilities: [
    {
      id: "agentReport.list",
      version: "1.0.0",
      purpose: "List reports.",
      kind: "query",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { type: "string" } },
      },
      output: { dataTypeId: "AgentReport", shape: "entity" },
      requiredSessionKeys: [],
      sourceIds: ["support-api"],
      // The smallest budget the schema admits, so the upstream's delay below
      // reliably overruns it.
      policy: { authentication: "public", timeoutMs: 50 },
    },
  ],
  relationships: [],
});

const restBindings = {
  "agentReport.list": {
    capabilityId: "agentReport.list",
    method: "GET",
    path: "/api/v1/agent-report",
    contentParameters: [],
    exposeFields: ["status"],
  },
};

function restServer(baseUrl) {
  return createViewServer({
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
    },
    resolveSession: () => ({}),
    allowedUpstreamOrigins: [new URL(baseUrl).origin],
  });
}

test("TIMEOUT keeps its exact message — hosts match on it", async () => {
  const upstream = await startUpstream((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    }, 500);
  });
  try {
    const server = restServer(upstream.baseUrl);
    await server.publishReviewedCatalog({
      catalog: restCatalog("support-assist"),
      bindings: restBindings,
      baseUrl: upstream.baseUrl,
    });
    await server.publishUiCatalog({ manifest: toSiteManifest(siteFor("support-assist")) });

    const result = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show reports",
      request: {},
      createProvider: provider(planFor("agentReport.list")),
    });

    assert.equal(result.ok, false);
    assert.equal(result.requests[0].errorCode, "TIMEOUT");
    assert.equal(result.requests[0].error, "The data request timed out");
    assert.equal(result.reason, "The data request timed out");
  } finally {
    await upstream.close();
  }
});

test("an unknown catalog and an unpublished one are indistinguishable to compose", async () => {
  const server = restServer("http://127.0.0.1:9");
  // Fully published, so its id is the secret the response must not give up.
  await server.publishReviewedCatalog({
    catalog: restCatalog("support-assist"),
    bindings: restBindings,
    baseUrl: "http://127.0.0.1:9",
  });
  await server.publishUiCatalog({ manifest: toSiteManifest(siteFor("support-assist")) });
  // Capability catalog only — exists, but not servable.
  await server.publishReviewedCatalog({
    catalog: restCatalog("half-published"),
    bindings: restBindings,
    baseUrl: "http://127.0.0.1:9",
  });

  const handler = createViewHttpHandler(server, { requireAdmin: () => false });
  const composeBody = async (catalogId) => {
    const response = await handler(
      new Request("http://localhost/api/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catalogId, prompt: "show reports" }),
      }),
    );
    return { status: response.status, text: await response.text() };
  };

  const missing = await composeBody("does-not-exist");
  const unpublished = await composeBody("half-published");

  // Byte-identical, or the difference is an oracle over which ids exist.
  assert.equal(missing.status, unpublished.status);
  assert.equal(missing.text, unpublished.text);
  assert.ok(missing.text.includes("This catalog is not available."));
  // And no listing: the one published id must not ride along.
  assert.ok(!missing.text.includes("support-assist"));
  assert.ok(!unpublished.text.includes("support-assist"));
});
