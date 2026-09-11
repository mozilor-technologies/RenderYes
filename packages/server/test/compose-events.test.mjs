import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createViewServer, createViewHttpHandler } from "../dist/index.js";
import {
  applyDataModelPatch,
  createComposeEventParser,
  isTerminalComposeEvent,
} from "@renderyes/core";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  field,
  toSiteManifest,
} from "@renderyes/site-sdk";

/**
 * A streamed compose and a batch compose are the same compose. These cover the
 * two things that make that claim true rather than aspirational: the events
 * describe a run faithfully (order, one pair per request, a terminal event
 * always), and replaying every frame reconstructs exactly the data model the
 * batch response carries.
 *
 * The last one is the load-bearing test. Without it the two paths drift, and
 * the drift shows up as a view that renders differently depending on which
 * transport fetched it — the hardest possible bug to attribute.
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
  capabilities: ["one", "two"].map((slug) => ({
    id: `agentReport.${slug}`,
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
  })),
  relationships: [],
};

const bindings = Object.fromEntries(
  ["one", "two"].map((slug) => [
    `agentReport.${slug}`,
    {
      capabilityId: `agentReport.${slug}`,
      method: "GET",
      path: `/api/v1/${slug}`,
      contentParameters: [],
      exposeFields: ["status"],
    },
  ]),
);

const ReportCard = defineComponent({
  id: "ReportCard",
  version: "1.0.0",
  description: "Shows one report.",
  props: defineProps({ title: field.string({ default: "Report" }) }),
  renderer: {
    component: "ReportCard",
    props: { report: { path: "/report" }, state: { path: "/state" } },
  },
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
      maxComponents: 4,
    }),
  ],
});

/** Upstream that can be told to stall one path, so ordering is observable. */
async function startUpstream({ delayMs = {}, failing = [] } = {}) {
  const server = http.createServer(async (req, res) => {
    const slug = (req.url ?? "").split("/").pop();
    const delay = delayMs[slug] ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (failing.includes(slug)) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `${slug} is down` }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: `ok-${slug}` }));
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

const planWith = (slugs) => ({
  status: "ready",
  dataRequests: slugs.map((slug, index) => ({
    requestId: `r${index + 1}`,
    capabilityId: `agentReport.${slug}`,
    params: {},
  })),
  nodes: slugs.map((_, index) => ({
    nodeId: `n${index + 1}`,
    componentId: "ReportCard",
    props: {},
    dataBindings: { report: { requestId: `r${index + 1}` } },
  })),
});

const provider = (plan) => () => ({
  id: "stub",
  async generatePlan() {
    return { modelId: "m", value: plan };
  },
});

const compose = (server, onEvent, plan = planWith(["one", "two"])) =>
  server.composeAgainstPublishedCatalogs({
    catalogId: "support-assist",
    prompt: "show me reports",
    request: {},
    createProvider: provider(plan),
    ...(onEvent ? { onEvent } : {}),
  });

const dataModelOf = (messages) =>
  messages.find((message) => message.updateDataModel)?.updateDataModel?.value ?? {};

test("a run reports its lifecycle in order and ends with exactly one terminal event", async () => {
  const upstream = await startUpstream();
  try {
    const events = [];
    const server = await serverWith(upstream.baseUrl);
    const result = await compose(server, (event) => events.push(event));

    assert.equal(result.ok, true);
    const types = events.map((event) => event.type);
    assert.equal(types[0], "RUN_STARTED");
    assert.equal(types.at(-1), "RUN_FINISHED");
    assert.equal(events.filter(isTerminalComposeEvent).length, 1);

    // The skeleton frame must precede execution: it is the whole point.
    assert.ok(
      types.indexOf("STATE_SNAPSHOT") < types.indexOf("TOOL_CALL_START"),
      "components must be described before their data is fetched",
    );
    assert.ok(types.indexOf("STEP_FINISHED") < types.indexOf("STATE_SNAPSHOT"));
    assert.equal(new Set(events.map((event) => event.runId)).size, 1);
  } finally {
    await upstream.close();
  }
});

test("every data request gets exactly one start and one end", async () => {
  const upstream = await startUpstream();
  try {
    const events = [];
    const server = await serverWith(upstream.baseUrl);
    await compose(server, (event) => events.push(event));

    const starts = events.filter((event) => event.type === "TOOL_CALL_START");
    const ends = events.filter((event) => event.type === "TOOL_CALL_END");
    assert.deepEqual(
      starts.map((event) => event.requestId).sort(),
      ["r1", "r2"],
    );
    assert.deepEqual(
      ends.map((event) => event.requestId).sort(),
      ["r1", "r2"],
    );
    for (const end of ends) {
      assert.equal(end.state, "ready");
      assert.equal(typeof end.durationMs, "number");
      assert.ok(end.capabilityId.startsWith("agentReport."));
    }
  } finally {
    await upstream.close();
  }
});

test("a fast request is delivered without waiting for a slow one beside it", async () => {
  // This is the behaviour the whole feature exists for: batch delivery made
  // every slot as slow as the slowest.
  const upstream = await startUpstream({ delayMs: { one: 300 } });
  try {
    const events = [];
    const server = await serverWith(upstream.baseUrl);
    await compose(server, (event) => events.push(event));

    const order = events
      .filter((event) => event.type === "TOOL_CALL_END")
      .map((event) => event.requestId);
    assert.deepEqual(order, ["r2", "r1"], "the quick request settles first");

    // And its data reached the client before the slow one settled.
    const firstDelta = events.findIndex((event) => event.type === "STATE_DELTA");
    const slowEnd = events.findIndex(
      (event) => event.type === "TOOL_CALL_END" && event.requestId === "r1",
    );
    assert.ok(firstDelta !== -1 && firstDelta < slowEnd);
  } finally {
    await upstream.close();
  }
});

test("replaying every frame reconstructs the batch data model exactly", async () => {
  const upstream = await startUpstream({ delayMs: { one: 50 } });
  try {
    const events = [];
    const server = await serverWith(upstream.baseUrl);
    const streamed = await compose(server, (event) => events.push(event));

    const snapshot = events.find((event) => event.type === "STATE_SNAPSHOT");
    assert.ok(snapshot, "a snapshot frame is required to start from");

    let model = dataModelOf(snapshot.messages);
    for (const event of events) {
      if (event.type === "STATE_DELTA") model = applyDataModelPatch(model, event.patch);
    }

    assert.deepEqual(model, dataModelOf(streamed.messages));
  } finally {
    await upstream.close();
  }
});

test("the skeleton frame describes every component with its slots pending", async () => {
  const upstream = await startUpstream({ delayMs: { one: 100, two: 100 } });
  try {
    const events = [];
    const server = await serverWith(upstream.baseUrl);
    await compose(server, (event) => events.push(event));

    const snapshot = events.find((event) => event.type === "STATE_SNAPSHOT");
    const components = snapshot.messages.find((message) => message.updateComponents)
      ?.updateComponents?.components;
    // Both cards plus the root container the compiler always emits.
    const cards = components.filter((component) => component.component === "ReportCard");
    assert.equal(cards.length, 2, "both components are known before any data is");

    const states = JSON.stringify(dataModelOf(snapshot.messages));
    assert.match(states, /"pending"/, "slots report pending, not empty or ready");
  } finally {
    await upstream.close();
  }
});

test("a failed request ends its own slot without ending the run", async () => {
  const upstream = await startUpstream();
  await upstream.close(); // every request now fails to connect
  const events = [];
  const server = await serverWith(upstream.baseUrl);
  await compose(server, (event) => events.push(event));

  const ends = events.filter((event) => event.type === "TOOL_CALL_END");
  assert.equal(ends.length, 2);
  for (const end of ends) {
    assert.equal(end.state, "error");
    assert.equal(typeof end.errorMessage, "string");
  }
  // The run still finishes: a view with failed slots is a view.
  assert.equal(events.at(-1).type, "RUN_FINISHED");
});

test("a batch compose carries each failed request's reason, not just ok:false", async () => {
  // The seam the live evaluation caught: the executor classifies its failures
  // and writes a message meant to be shown, and the request summary dropped it
  // — a caller saw `ok: false`, an error-state slot, and no explanation, while
  // the real reason sat in server memory. The streamed path already carried it
  // in TOOL_CALL_END; the batch shape (plain compose, refine, reopen) is what
  // reported nothing.
  const upstream = await startUpstream();
  await upstream.close(); // every request now fails to connect
  const server = await serverWith(upstream.baseUrl);
  const result = await compose(server); // no onEvent: the batch shape

  // `ok` is false because nothing was delivered — this assertion used to
  // require `true`, which is the envelope defect stated as an expectation.
  // The subject of this test is the line below it: a failed request explains
  // itself. That was always right, and is unaffected.
  assert.equal(result.ok, false);
  assert.equal(result.kind, "data-unavailable");
  assert.equal(result.requests.length, 2);
  for (const request of result.requests) {
    assert.equal(request.ok, false);
    assert.equal(typeof request.error, "string");
    assert.ok(request.error.length > 0, "a failed request must say why");
    assert.equal(typeof request.errorCode, "string");
  }
});

test("a refused refine crosses the wire with `error`, not only `reason`", async () => {
  // Domain failures said {ok:false, kind, reason}; every transport failure
  // says {ok:false, error}. A caller reading `.error` — the name every other
  // failure taught them — got undefined and reported an empty message.
  const upstream = await startUpstream();
  try {
    const server = await serverWith(upstream.baseUrl, {
      resolveViewOwner: (session) => session.agentId,
    });
    const handler = createViewHttpHandler(server, { requireAdmin: () => true });
    const composed = await compose(server);
    assert.equal(composed.ok, true);

    const response = await handler(
      new Request("http://localhost:4200/api/refine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          catalogId: "support-assist",
          planId: composed.planId,
          operations: [{ kind: "removeNode", nodeId: "no-such-node" }],
        }),
      }),
    );
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(typeof body.reason, "string");
    assert.ok(body.reason.length > 0);
    assert.equal(body.error, body.reason, "error must alias reason on every failure body");
  } finally {
    await upstream.close();
  }
});

test("an unsupported prompt ends the run as an error, not a finish", async () => {
  const upstream = await startUpstream();
  try {
    const events = [];
    const server = await serverWith(upstream.baseUrl);
    const result = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "do something impossible",
      request: {},
      onEvent: (event) => events.push(event),
      createProvider: () => ({
        id: "stub",
        async generatePlan() {
          return {
            modelId: "m",
            value: { status: "unsupported", reason: "No approved data covers that." },
          };
        },
      }),
    });

    assert.equal(result.ok, false);
    const terminal = events.at(-1);
    assert.equal(terminal.type, "RUN_ERROR");
    assert.equal(terminal.kind, "unsupported");
    assert.match(terminal.reason, /approved data/);
  } finally {
    await upstream.close();
  }
});

test("a throwing observer cannot fail a compose", async () => {
  // Same rule the metrics sink follows: a visitor's view is not lost because
  // something watching it broke.
  const upstream = await startUpstream();
  try {
    const server = await serverWith(upstream.baseUrl);
    const result = await compose(server, () => {
      throw new Error("observer exploded");
    });
    assert.equal(result.ok, true);
  } finally {
    await upstream.close();
  }
});

test("a compose with no observer emits nothing and returns the same view", async () => {
  const upstream = await startUpstream();
  try {
    const server = await serverWith(upstream.baseUrl);
    const withObserver = [];
    const streamed = await compose(server, (event) => withObserver.push(event));
    const batch = await compose(server, undefined);

    assert.ok(withObserver.length > 0);
    assert.equal(batch.ok, streamed.ok);
    // Two composes are two plans fetched at two moments, so the plan id and the
    // provenance timestamps legitimately differ; nothing else may.
    const normalize = (value) =>
      JSON.parse(
        JSON.stringify(value, (key, inner) =>
          key === "planId" || key === "asOf" || key === "staleAt" ? "<normalized>" : inner,
        ),
      );
    assert.deepEqual(
      normalize(dataModelOf(batch.messages)),
      normalize(dataModelOf(streamed.messages)),
    );
  } finally {
    await upstream.close();
  }
});

test("POST /api/compose streams when the caller accepts an event stream", async () => {
  const upstream = await startUpstream();
  try {
    const server = await serverWith(upstream.baseUrl, {
      planProviders: [],
    });
    const handler = createViewHttpHandler(server, { requireAdmin: () => true });

    const response = await handler(
      new Request("http://localhost/api/compose", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ catalogId: "support-assist", prompt: "show reports" }),
      }),
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    // An intermediary that buffers would undo the whole feature.
    assert.match(response.headers.get("cache-control"), /no-transform/);

    const parser = createComposeEventParser();
    const events = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      events.push(...parser.push(decoder.decode(value, { stream: true })));
    }
    events.push(...parser.end());

    assert.equal(events[0]?.type, "RUN_STARTED");
    assert.ok(isTerminalComposeEvent(events.at(-1)));
  } finally {
    await upstream.close();
  }
});

test("the same route still answers with JSON when no stream is asked for", async () => {
  const upstream = await startUpstream();
  try {
    // Over HTTP there is no `createProvider` — that is a library-only argument
    // — so a host exercising their own mount configures the plans instead.
    // This is the seam that replaced the offline mock: the plan is the
    // caller's, so what passes here says something about this install.
    const server = await serverWith(upstream.baseUrl, {
      planProviders: [{ id: "scripted", plans: [planWith(["one", "two"])] }],
    });
    const handler = createViewHttpHandler(server, { requireAdmin: () => true });

    const response = await handler(
      new Request("http://localhost/api/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catalogId: "support-assist", prompt: "show reports" }),
      }),
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    const payload = await response.json();
    assert.ok("ok" in payload);
  } finally {
    await upstream.close();
  }
});

test("a rejected streamed compose reports the failure inside the stream", async () => {
  // Headers are already sent by the time anything can throw, so a status code
  // is no longer available to say it with.
  const upstream = await startUpstream();
  try {
    const server = await serverWith(upstream.baseUrl);
    const handler = createViewHttpHandler(server, { requireAdmin: () => true });

    const response = await handler(
      new Request("http://localhost/api/compose", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ catalogId: "no-such-catalog", prompt: "hello" }),
      }),
    );

    assert.equal(response.status, 200);
    const text = await new Response(response.body).text();
    const parser = createComposeEventParser();
    const events = [...parser.push(text), ...parser.end()];
    assert.equal(events.at(-1).type, "RUN_ERROR");
    // The neutral sentence, never a listing: compose answers before any
    // credential is resolved, so a reason that names ids — the requested one
    // included — is an unauthenticated oracle over what this server knows.
    assert.equal(events.at(-1).reason, "This catalog is not available.");
    assert.doesNotMatch(events.at(-1).reason, /support-assist/);
  } finally {
    await upstream.close();
  }
});

test("an unauthenticated compose is rejected before the planner is called", async () => {
  // It used to run a full model call and fail on the way out, so a caller with
  // no credential could spend the host's model budget.
  const upstream = await startUpstream();
  try {
    let planCalls = 0;
    const server = createViewServer({
      host: {
        isAuthenticated: () => true,
        hasPermission: () => true,
        getSessionValue: () => undefined,
      },
      resolveSession: () => {
        throw new Error("No session token present");
      },
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
    });
    await server.publishReviewedCatalog({ catalog, bindings, baseUrl: upstream.baseUrl });
    await server.publishUiCatalog({ manifest: toSiteManifest(site) });

    await assert.rejects(
      server.composeAgainstPublishedCatalogs({
        catalogId: "support-assist",
        prompt: "show me reports",
        request: {},
        createProvider: () => ({
          id: "counting",
          async generatePlan() {
            planCalls += 1;
            return { modelId: "m", value: planWith(["one"]) };
          },
        }),
      }),
      /No session token present/,
    );
    assert.equal(planCalls, 0, "no model call may be made for a rejected request");
  } finally {
    await upstream.close();
  }
});

test("a denied allowCompose gate rejects before any model call, and HTTP answers 429", async () => {
  const upstream = await startUpstream();
  try {
    let providerCalls = 0;
    let gateCalls = 0;
    const decisions = [true, false];
    const s = await serverWith(upstream.baseUrl, {
      allowCompose: ({ session, catalogId }) => {
        gateCalls += 1;
        assert.equal(catalogId, "support-assist");
        assert.equal(session.agentId, "alice");
        return decisions.shift();
      },
    });
    const countingProvider = () => ({
      id: "stub",
      async generatePlan() {
        providerCalls += 1;
        return { modelId: "m", value: planWith(["one"]) };
      },
    });

    const first = await s.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me reports",
      request: {},
      createProvider: countingProvider,
    });
    assert.equal(first.ok, true);
    assert.equal(providerCalls, 1);

    // Denied: rejected before the planner, so the model bills nothing.
    await assert.rejects(
      () =>
        s.composeAgainstPublishedCatalogs({
          catalogId: "support-assist",
          prompt: "show me reports again",
          request: {},
          createProvider: countingProvider,
        }),
      (error) => {
        assert.equal(error.name, "ComposeRateLimitedError");
        assert.match(error.message, /Too many requests/);
        return true;
      },
    );
    assert.equal(providerCalls, 1, "the denied compose made no model call");
    assert.equal(gateCalls, 2);

    // And over HTTP the same denial is a 429, the one status a client retries.
    const handler = createViewHttpHandler(s, { requireAdmin: () => true });
    const response = await handler(
      new Request("http://localhost:4200/api/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catalogId: "support-assist", prompt: "again" }),
      }),
    );
    assert.equal(response.status, 429);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /Too many requests/);
  } finally {
    await upstream.close();
  }
});

test("no allowCompose gate means no gating — the default stays open", async () => {
  const upstream = await startUpstream();
  try {
    const s = await serverWith(upstream.baseUrl, {});
    const result = await compose(s, undefined, planWith(["one"]));
    assert.equal(result.ok, true);
  } finally {
    await upstream.close();
  }
});

// ─── the envelope's account of what the visitor got ──────────────────────────
//
// One rule, three states: `ok` says whether the view carries data, and it is
// never true over a view that carries none. Measured on one production install before
// this existed — six identical prompts, five `ok: true`, three rendered views.

test("a compose whose slots all delivered is a plain success", async () => {
  const upstream = await startUpstream();
  try {
    const server = await serverWith(upstream.baseUrl);
    const result = await compose(server);
    assert.equal(result.ok, true);
    assert.equal(result.partial, undefined, "nothing is missing, so nothing is flagged");
    assert.deepEqual(
      result.requests.map((request) => request.ok),
      [true, true],
    );
  } finally {
    await upstream.close();
  }
});

test("a compose that delivered some of its slots says so instead of claiming all", async () => {
  const upstream = await startUpstream({ failing: ["two"] });
  try {
    const server = await serverWith(upstream.baseUrl);
    const result = await compose(server);
    // Still a success: one panel of two carries real data, and taking the
    // whole view away would be a worse answer than showing what arrived.
    assert.equal(result.ok, true);
    assert.equal(result.partial, true);
    const failed = result.requests.filter((request) => !request.ok);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].capabilityId, "agentReport.two");
    assert.ok(failed[0].error, "and the failed one explains itself");
  } finally {
    await upstream.close();
  }
});

test("a compose that delivered nothing is not reported as ok", async () => {
  const upstream = await startUpstream({ failing: ["one", "two"] });
  try {
    const events = [];
    const server = await serverWith(upstream.baseUrl);
    const result = await compose(server, (event) => events.push(event));

    assert.equal(result.ok, false, "this is the assertion the old envelope failed");
    assert.equal(result.kind, "data-unavailable");
    assert.match(result.reason, /\S/);

    // The view still travels, because the per-slot errors are the most useful
    // thing the visitor can be shown — and every slot says so.
    assert.ok(Array.isArray(result.messages) && result.messages.length > 0);
    const model = dataModelOf(result.messages);
    const states = Object.entries(model)
      .filter(([key]) => key.endsWith("state") || key === "state")
      .map(([, value]) => value);
    assert.ok(
      JSON.stringify(model).includes("error"),
      `every bound slot is in error: ${JSON.stringify(states)}`,
    );

    // And the run's own terminal event agrees with the envelope.
    const terminal = events.at(-1);
    assert.equal(terminal.kind, "data-unavailable");
  } finally {
    await upstream.close();
  }
});

// ─── planning is opt-in ──────────────────────────────────────────────────────

test("planning with no provider configured refuses, and says what is wired up", async () => {
  const upstream = await startUpstream();
  try {
    const server = await serverWith(upstream.baseUrl);
    // No `createProvider`, no `planProviders`: the state a host is in before
    // they have chosen a model. This used to compose successfully against a
    // mock that returned the first approved capability with empty params and
    // never read the prompt — a working-looking view built by a non-planner.
    await assert.rejects(
      () =>
        server.composeAgainstPublishedCatalogs({
          catalogId: "support-assist",
          prompt: "show me reports",
          request: {},
        }),
      (error) => {
        assert.equal(error.name, "PlanProviderNotConfiguredError");
        assert.match(error.message, /planProviders/);
        // The refusal carries the check that is actually useful, and verifies
        // more of an install than the mock ever did.
        assert.equal(error.wiring.capabilityCatalogPublished, true);
        assert.equal(error.wiring.uiCatalogPublished, true);
        assert.equal(error.wiring.capabilityCount, 2);
        assert.deepEqual(error.wiring.componentIds, ["ReportCard"]);
        assert.deepEqual(error.wiring.configuredProviderIds, []);
        return true;
      },
    );
  } finally {
    await upstream.close();
  }
});

test("a configured scripted provider plans without a model, and is not reported as one", async () => {
  const upstream = await startUpstream();
  try {
    const plan = planWith(["one"]);
    const server = await serverWith(upstream.baseUrl, {
      planProviders: [{ id: "rehearsal", plans: [plan] }],
    });
    const result = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me reports",
      request: {},
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.requests.map((request) => request.capabilityId),
      ["agentReport.one"],
      "the plan is the host's, not one this package invented",
    );
    // Named as scripted on the providers endpoint. Reporting it as an
    // available model would rebuild the mock's failure one level up: a host
    // reading `available: true` would believe a model answered.
    assert.deepEqual(server.listPlanProviders(), [
      { id: "rehearsal", model: "scripted", available: true },
    ]);
  } finally {
    await upstream.close();
  }
});

test("a host with no visitor identity refuses saved-view actions with a kind, not just prose", async () => {
  const upstream = await startUpstream();
  try {
    // No `resolveViewOwner`: a legitimate configuration — a site that composes
    // statelessly has no identity to file a saved view under.
    const server = await serverWith(upstream.baseUrl, {
      planProviders: [{ id: "scripted", plans: [planWith(["one"])] }],
    });
    const handler = createViewHttpHandler(server, { requireAdmin: () => true });
    const composed = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me reports",
      request: {},
    });

    const response = await handler(
      new Request("http://localhost/api/refine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          catalogId: "support-assist",
          planId: composed.planId,
          operations: [{ kind: "setLimit", requestId: "r1", limit: 5 }],
        }),
      }),
    );
    const payload = await response.json();
    assert.equal(payload.ok, false);
    // The point of the whole change: a client can now tell "this host does not
    // do saved views" from "your request failed", which it could not do when
    // both arrived as a 400 carrying different sentences.
    assert.equal(payload.kind, "visitor-identity-required");
    assert.match(payload.error, /resolveViewOwner/);
  } finally {
    await upstream.close();
  }
});

// ─── one budget for the request ──────────────────────────────────────────────

test("a compose is bounded end to end, not just through its repair loop", async () => {
  // `planDeadlineMs` capped the repair loop only, so nothing capped the
  // request. Measured on one production install: a compose reported "Planning exceeded its
  // 40000ms budget" and took 48,970ms — both true, because execution ran
  // afterwards on its own time.
  const upstream = await startUpstream({ delayMs: { one: 3_000, two: 3_000 } });
  try {
    const server = await serverWith(upstream.baseUrl, {
      planProviders: [{ id: "scripted", plans: [planWith(["one", "two"])] }],
      composeDeadlineMs: 600,
    });
    const startedAt = Date.now();
    const result = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me reports",
      request: {},
    });
    const elapsed = Date.now() - startedAt;

    // Cut off well before the upstream would have answered.
    assert.ok(elapsed < 2_500, `compose ran ${elapsed}ms against a 600ms budget`);
    // And it says so rather than reporting an empty success — the budget
    // expiring is a delivery failure, which is what B1's envelope reports.
    assert.equal(result.ok, false);
    assert.equal(result.kind, "data-unavailable");
  } finally {
    await upstream.close();
  }
});

test("the plan budget cannot exceed the request budget it sits inside", async () => {
  const upstream = await startUpstream();
  try {
    // A host who set the plan deadline high and the compose deadline low means
    // the lower one: two budgets that could sum past the request is the defect,
    // not a configuration to honour.
    const server = await serverWith(upstream.baseUrl, {
      planProviders: [{ id: "scripted", plans: [planWith(["one"])] }],
      planDeadlineMs: 90_000,
      composeDeadlineMs: 5_000,
    });
    const result = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me reports",
      request: {},
    });
    assert.equal(result.ok, true);
    // Reported, so a client arms its own timeout from this rather than from a
    // constant of its own that can disagree.
    assert.equal(result.deadlineMs, 5_000);
  } finally {
    await upstream.close();
  }
});

test("a streaming client learns the budget on the first frame", async () => {
  const upstream = await startUpstream();
  try {
    const events = [];
    const server = await serverWith(upstream.baseUrl, {
      planProviders: [{ id: "scripted", plans: [planWith(["one"])] }],
      composeDeadlineMs: 12_345,
    });
    await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me reports",
      request: {},
      onEvent: (event) => events.push(event),
    });
    const started = events.find((event) => event.type === "RUN_STARTED");
    // Before any model call: the client can arm its timeout immediately rather
    // than discovering the budget in the response it may already have abandoned.
    assert.equal(started.deadlineMs, 12_345);
  } finally {
    await upstream.close();
  }
});
