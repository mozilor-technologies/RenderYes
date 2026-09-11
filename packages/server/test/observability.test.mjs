import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createViewServer, createOtlpModelObserver } from "../dist/index.js";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  field,
  toSiteManifest,
} from "@renderyes/site-sdk";

/**
 * These cover the two properties that make tracing safe to turn on in
 * someone else's backend: every model call is observed (a missing span makes
 * the bill look smaller than it is), and nothing about tracing can fail a
 * request or leak content the host didn't opt into sending.
 */

const catalog = {
  schemaVersion: "1.0",
  id: "support-assist",
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
      policy: { authentication: "public" },
    },
  ],
  relationships: [],
};

const bindings = {
  "agentReport.list": {
    capabilityId: "agentReport.list",
    method: "GET",
    path: "/api/v1/agent-report",
    contentParameters: [],
    exposeFields: ["status"],
  },
};

const ReportCard = defineComponent({
  id: "ReportCard",
  version: "1.0.0",
  description: "Shows one report.",
  props: defineProps({ title: field.string({ default: "Report" }) }),
  renderer: { component: "ReportCard", props: { report: { path: "/report" } } },
  dataSlots: { report: { accepts: [{ dataTypeId: "AgentReport", shapes: ["entity"] }] } },
});

const site = defineSite({
  id: "support-assist",
  name: "Support Assist",
  version: "1.0.0",
  catalogId: "https://support.example.com/catalog.json",
  components: [ReportCard],
  surfaces: [
    defineSurface({
      id: "main",
      description: "Main.",
      componentIds: ["ReportCard"],
      maxComponents: 1,
    }),
  ],
});

async function startUpstream() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function serverWith(baseUrl, extra) {
  const s = createViewServer({
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
    },
    resolveSession: () => ({ agentId: "alice", permissions: new Set() }),
    allowedUpstreamOrigins: [new URL(baseUrl).origin],
    ...extra,
  });
  await s.publishReviewedCatalog({ catalog, bindings, baseUrl });
  await s.publishUiCatalog({ manifest: toSiteManifest(site) });
  return s;
}

const goodPlan = {
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

test("every model call is observed, including each repair attempt, under one trace", async () => {
  // A repair is a whole extra billed call. Reporting only the last one is how
  // a three-attempt compose came to look like a one-attempt compose.
  const upstream = await startUpstream();
  try {
    const events = [];
    const server = await serverWith(upstream.baseUrl, { onModelCall: (e) => events.push(e) });
    let call = 0;
    const result = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me reports",
      request: {},
      createProvider: () => ({
        id: "flaky",
        async generatePlan() {
          call += 1;
          if (call < 3) {
            return {
              modelId: "m",
              value: { status: "ready", dataRequests: [], nodes: [] },
            };
          }
          return {
            modelId: "m",
            value: goodPlan,
            usage: { inputTokens: 10, outputTokens: 4, calls: 1 },
          };
        },
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(events.length, 3, "one event per provider round trip");
    // Attempts are numbered so a repair loop is readable, not three mysteries.
    assert.deepEqual(
      events.map((e) => e.attempt),
      [0, 1, 2],
    );
    // All in one trace.
    assert.equal(new Set(events.map((e) => e.traceId)).size, 1);
    assert.ok(events.every((e) => e.outcome === "ok"));
    assert.equal(events[2].inputTokens, 10);
    assert.equal(events[2].catalogId, "support-assist");
    assert.ok(events.every((e) => typeof e.durationMs === "number"));
  } finally {
    await upstream.close();
  }
});

test("a host-supplied provider is traced too", async () => {
  // Instrumenting the built-in adapters would have traced only the calls we
  // happen to own; the wrapper sits at the one point every path passes.
  const upstream = await startUpstream();
  try {
    const events = [];
    const server = await serverWith(upstream.baseUrl, { onModelCall: (e) => events.push(e) });
    await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me reports",
      request: {},
      createProvider: () => ({
        id: "someone-elses-provider",
        async generatePlan() {
          return { modelId: "their-model", value: goodPlan };
        },
      }),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].providerId, "someone-elses-provider");
    assert.equal(events[0].modelId, "their-model");
  } finally {
    await upstream.close();
  }
});

test("prompts are withheld unless the host opts in", async () => {
  // The user prompt is the visitor's words; the system prompt carries the
  // host's whole catalog. Turning on tracing must not start shipping either.
  const upstream = await startUpstream();
  try {
    const off = [];
    const on = [];
    const provider = () => ({
      id: "p",
      async generatePlan() {
        return { modelId: "m", value: goodPlan };
      },
    });

    await (await serverWith(upstream.baseUrl, {
      onModelCall: (e) => off.push(e),
    })).composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "a visitor's private question",
      request: {},
      createProvider: provider,
    });
    assert.equal(off[0].userPrompt, undefined);
    assert.equal(off[0].systemPrompt, undefined);
    assert.equal(off[0].completion, undefined);

    await (await serverWith(upstream.baseUrl, {
      onModelCall: (e) => on.push(e),
      captureModelPrompts: true,
    })).composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "a visitor's private question",
      request: {},
      createProvider: provider,
    });
    assert.equal(on[0].userPrompt, "a visitor's private question");
    assert.ok(on[0].systemPrompt.includes("ReportCard"));
    assert.ok(on[0].completion.includes("agentReport.list"));
  } finally {
    await upstream.close();
  }
});

test("a failing model call is traced with a redacted error, then still throws", async () => {
  const upstream = await startUpstream();
  try {
    const events = [];
    const server = await serverWith(upstream.baseUrl, { onModelCall: (e) => events.push(e) });
    const result = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me reports",
      request: {},
      createProvider: () => ({
        id: "p",
        async generatePlan() {
          throw new Error("upstream said Bearer sk-secret-value is invalid");
        },
      }),
    });

    assert.equal(result.ok, false);
    assert.ok(events.length > 0);
    assert.equal(events[0].outcome, "error");
    // Some providers echo the failing request back, and this string is on its
    // way to a third-party backend.
    assert.ok(!events[0].error.includes("sk-secret-value"));
    assert.match(events[0].error, /Bearer \[redacted\]/);
  } finally {
    await upstream.close();
  }
});

test("a throwing observer cannot fail a compose", async () => {
  const upstream = await startUpstream();
  try {
    const server = await serverWith(upstream.baseUrl, {
      onModelCall: () => {
        throw new Error("tracing backend is down");
      },
    });
    const result = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me reports",
      request: {},
      createProvider: () => ({
        id: "p",
        async generatePlan() {
          return { modelId: "m", value: goodPlan };
        },
      }),
    });
    assert.equal(result.ok, true, "telemetry must never break the product");
  } finally {
    await upstream.close();
  }
});

test("the OTLP observer emits GenAI-convention spans an OTLP backend accepts", async () => {
  const posted = [];
  const observer = createOtlpModelObserver({
    endpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
    headers: { authorization: "Basic cGs6c2s=" },
    flushIntervalMs: 5,
    fetchImpl: async (url, init) => {
      posted.push({
        url: String(url),
        headers: init.headers,
        body: JSON.parse(init.body),
      });
      return { ok: true, status: 202 };
    },
  });

  observer.observe({
    operation: "plan",
    traceId: "0123456789abcdef0123456789abcdef",
    providerId: "gemini",
    modelId: "gemini-3.6-flash",
    attempt: 1,
    startedAt: 1_700_000_000_000,
    durationMs: 1_250,
    inputTokens: 900,
    outputTokens: 120,
    httpCalls: 2,
    outcome: "ok",
    catalogId: "support-assist",
  });
  await observer.flush();

  assert.equal(posted.length, 1);
  assert.equal(posted[0].headers.authorization, "Basic cGs6c2s=");
  const span = posted[0].body.resourceSpans[0].scopeSpans[0].spans[0];
  const byKey = Object.fromEntries(
    span.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.intValue]),
  );

  // The convention names are what make this portable — Langfuse, a collector,
  // or any other OTLP backend reads the same keys.
  assert.equal(byKey["gen_ai.system"], "gcp.gemini");
  assert.equal(byKey["gen_ai.request.model"], "gemini-3.6-flash");
  assert.equal(byKey["gen_ai.usage.input_tokens"], "900");
  assert.equal(byKey["gen_ai.usage.output_tokens"], "120");
  // The two numbers that explain this system's cost, which the conventions
  // have no field for.
  assert.equal(byKey["renderyes.attempt"], "1");
  assert.equal(byKey["renderyes.http_calls"], "2");
  // OTLP id widths.
  assert.equal(span.traceId.length, 32);
  assert.equal(span.spanId.length, 16);
  assert.equal(span.status.code, 1);
  assert.equal(span.endTimeUnixNano, "1700000001250000000");
});

test("prompts reach the OTLP span only when captured", async () => {
  const posted = [];
  const observer = createOtlpModelObserver({
    endpoint: "https://collector.example/v1/traces",
    flushIntervalMs: 5,
    fetchImpl: async (_url, init) => {
      posted.push(JSON.parse(init.body));
      return { ok: true, status: 202 };
    },
  });
  observer.observe({
    operation: "plan",
    traceId: "0123456789abcdef0123456789abcdef",
    providerId: "openai",
    attempt: 0,
    startedAt: 1_700_000_000_000,
    durationMs: 10,
    outcome: "ok",
  });
  await observer.flush();
  const keys = posted[0].resourceSpans[0].scopeSpans[0].spans[0].attributes.map(
    (a) => a.key,
  );
  assert.ok(!keys.includes("gen_ai.prompt"));
  assert.ok(!keys.includes("gen_ai.completion"));
});

test("an export failure is reported, never thrown at the caller", async () => {
  const failures = [];
  const observer = createOtlpModelObserver({
    endpoint: "https://collector.example/v1/traces",
    flushIntervalMs: 5,
    fetchImpl: async () => {
      throw new Error("connection refused");
    },
    onExportError: (error) => failures.push(error),
  });
  observer.observe({
    operation: "plan",
    traceId: "0123456789abcdef0123456789abcdef",
    providerId: "openai",
    attempt: 0,
    startedAt: 1,
    durationMs: 1,
    outcome: "ok",
  });
  await observer.flush();
  assert.equal(failures.length, 1);
});
