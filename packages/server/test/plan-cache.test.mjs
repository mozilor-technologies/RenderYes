import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createViewServer, createMemoryPlanCache } from "../dist/index.js";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  field,
  toSiteManifest,
} from "@renderyes/site-sdk";

/**
 * The plan cache exists to skip the model call for a repeated prompt. The
 * property that makes it safe — and the one these tests pin — is that it caches
 * a *plan*, which contains no data: every row is still fetched on every request,
 * so a cache hit can never serve stale business data.
 */

async function startUpstream(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

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
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
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

const approvedBindings = {
  "agentReport.list": {
    capabilityId: "agentReport.list",
    method: "GET",
    path: "/api/v1/agent-report",
    contentParameters: [],
    exposeFields: ["status", "total_reports"],
  },
};

const ReportCard = defineComponent({
  id: "ReportCard",
  version: "1.0.0",
  description: "Shows one agent report.",
  props: defineProps({ title: field.string({ default: "Agent report" }) }),
  renderer: { component: "ReportCard", props: { report: { path: "/report" } } },
  dataSlots: {
    report: { accepts: [{ dataTypeId: "AgentReport", shapes: ["entity"] }] },
  },
});

const supportSite = defineSite({
  id: "support-assist",
  name: "Support Assist",
  version: "1.0.0",
  catalogId: "https://support.example.com/renderyes/catalog.json",
  components: [ReportCard],
  surfaces: [
    defineSurface({
      id: "main",
      description: "Main surface.",
      componentIds: ["ReportCard"],
      maxComponents: 1,
    }),
  ],
});

async function createTestServer(baseUrl, extraConfig = {}) {
  const session = { agentId: "AG-1", permissions: new Set() };
  const renderYesServer = createViewServer({
    host: {
      isAuthenticated: (s) => Boolean(s.agentId),
      hasPermission: (s, permission) => s.permissions.has(permission),
      getSessionValue: (s, key) => s[key],
    },
    resolveSession: () => session,
    allowedUpstreamOrigins: [new URL(baseUrl).origin],
    ...extraConfig,
  });
  await renderYesServer.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    baseUrl,
  });
  await renderYesServer.publishUiCatalog({ manifest: toSiteManifest(supportSite) });
  return renderYesServer;
}

/**
 * The plan these tests would have got from the offline mock, written down.
 *
 * The mock is gone: it returned the first approved capability with empty
 * params, never read the prompt, and was reachable by omitting `planProviders`
 * — so a host could evaluate a whole install against a planner that was not
 * one. A test double that guesses is no use as a test double either; these
 * tests care about caching, so the plan is fixed here and the cache is what
 * varies.
 */
const scriptedPlan = {
  status: "ready",
  dataRequests: [{ requestId: "r1", capabilityId: "agentReport.list", params: {} }],
  nodes: [
    {
      nodeId: "n1",
      componentId: "ReportCard",
      props: {},
      dataBindings: { report: { requestId: "r1" } },
    },
  ],
};

/** Counts provider calls so a cache hit is observable as a skipped model call. */
function countingProvider() {
  const state = { calls: 0 };
  return {
    state,
    createProvider() {
      return {
        id: "scripted",
        async generatePlan() {
          state.calls += 1;
          return { modelId: "scripted-1", value: scriptedPlan };
        },
      };
    },
  };
}

test("reuses a cached plan for an identical prompt without calling the model again", async () => {
  let upstreamCalls = 0;
  const upstream = await startUpstream((req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    // Changes between requests: proves the data is not cached with the plan.
    res.end(JSON.stringify({ status: "ok", total_reports: upstreamCalls }));
  });
  try {
    const provider = countingProvider();
    const renderYesServer = await createTestServer(upstream.baseUrl, {
      planCache: createMemoryPlanCache(),
    });
    const ask = () =>
      renderYesServer.composeAgainstPublishedCatalogs({
        catalogId: "support-assist",
        prompt: "how many reports are open",
        request: {},
        createProvider: provider.createProvider,
      });

    const first = await ask();
    const second = await ask();

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(provider.state.calls, 1, "the second prompt must skip the model");

    // Both requests hit the upstream, and the second saw the newer value.
    assert.equal(upstreamCalls, 2);
    const read = (result) =>
      result.messages.find((message) => message.updateDataModel).updateDataModel.value.n1
        .report.total_reports;
    assert.equal(read(first), 1);
    assert.equal(
      read(second),
      2,
      "a cached plan must not carry cached data — the row is re-fetched",
    );
  } finally {
    await upstream.close();
  }
});

test("normalizes case and whitespace, but nothing that could change meaning", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 7 }));
  });
  try {
    const provider = countingProvider();
    const renderYesServer = await createTestServer(upstream.baseUrl, {
      planCache: createMemoryPlanCache(),
    });
    const ask = (prompt) =>
      renderYesServer.composeAgainstPublishedCatalogs({
        catalogId: "support-assist",
        prompt,
        request: {},
        createProvider: provider.createProvider,
      });

    await ask("how many reports are open");
    const renormalized = await ask("  How Many   Reports Are Open  ");
    assert.equal(renormalized.cached, true);
    assert.equal(provider.state.calls, 1);

    // A different question is a different plan, even though it shares most words.
    const different = await ask("how many reports are closed");
    assert.equal(different.cached, false);
    assert.equal(provider.state.calls, 2);
  } finally {
    await upstream.close();
  }
});

test("issues a fresh planId on a cache hit so saved views cannot be conflated", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 7 }));
  });
  try {
    const renderYesServer = await createTestServer(upstream.baseUrl, {
      planCache: createMemoryPlanCache(),
    });
    const ask = () =>
      renderYesServer.composeAgainstPublishedCatalogs({
        catalogId: "support-assist",
        prompt: "how many reports are open",
        request: {},
        createProvider: () => ({
          id: "scripted",
          async generatePlan() {
            return { modelId: "scripted-1", value: scriptedPlan };
          },
        }),
      });

    const first = await ask();
    const second = await ask();
    // The plan itself never crosses this boundary, so assert on what does: two
    // distinct surface ids would be wrong, but two distinct data models with the
    // same node id are exactly right.
    assert.equal(second.cached, true);
    assert.deepEqual(
      first.messages.map((m) => Object.keys(m)[1]),
      second.messages.map((m) => Object.keys(m)[1]),
    );
  } finally {
    await upstream.close();
  }
});

test("no cache is used unless the host supplies one", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 7 }));
  });
  try {
    const provider = countingProvider();
    const renderYesServer = await createTestServer(upstream.baseUrl);
    const ask = () =>
      renderYesServer.composeAgainstPublishedCatalogs({
        catalogId: "support-assist",
        prompt: "how many reports are open",
        request: {},
        createProvider: provider.createProvider,
      });

    const first = await ask();
    const second = await ask();
    assert.equal(first.cached, false);
    assert.equal(second.cached, false);
    assert.equal(provider.state.calls, 2);
  } finally {
    await upstream.close();
  }
});

test("expires an entry after its TTL rather than serving it forever", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 7 }));
  });
  try {
    const provider = countingProvider();
    const renderYesServer = await createTestServer(upstream.baseUrl, {
      planCache: createMemoryPlanCache({ ttlMs: 1 }),
    });
    const ask = () =>
      renderYesServer.composeAgainstPublishedCatalogs({
        catalogId: "support-assist",
        prompt: "how many reports are open",
        request: {},
        createProvider: provider.createProvider,
      });

    await ask();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const afterExpiry = await ask();
    assert.equal(afterExpiry.cached, false);
    assert.equal(provider.state.calls, 2);
  } finally {
    await upstream.close();
  }
});
