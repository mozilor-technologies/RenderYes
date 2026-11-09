/**
 * What a view was built from, and asking for what is missing — through the
 * server, against a catalog shaped like the CookieYes demo: privacy laws
 * filtered by a list field of regions (`items.enum`), and install guides keyed
 * by a required `platform` argument with declared values.
 *
 * The visitor-facing half of both features is plain code over a validated
 * plan, so every case here runs with a scripted planner and no model.
 */
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import {
  createMemoryViewStore,
  createSystemOnePlanProvider,
  createViewServer,
} from "@renderyes/server";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  field,
  toSiteManifest,
} from "@renderyes/site-sdk";

const REGIONS = ["Germany", "France", "California", "United States", "Utah", "Brazil"];
const PLATFORMS = ["shopify", "wordpress", "html"];

const LAWS = [
  { id: "gdpr", name: "GDPR", regions: ["Germany", "France"] },
  { id: "ccpa", name: "CCPA", regions: ["California", "United States"] },
  { id: "ucpa", name: "UCPA", regions: ["Utah", "United States"] },
  { id: "lgpd", name: "LGPD", regions: ["Brazil"] },
];

const LAW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "regions"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    regions: { type: "array", items: { type: "string", enum: REGIONS } },
  },
};
const GUIDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["platform", "steps"],
  properties: {
    platform: { type: "string", enum: PLATFORMS },
    steps: { type: "array", items: { type: "string" } },
  },
};

const catalog = {
  schemaVersion: "1.0",
  id: "consent",
  version: "1.0.0",
  description: "Which privacy laws apply, and how to install a consent banner.",
  dataTypes: [
    {
      id: "PrivacyLaw",
      version: "1.0.0",
      description: "One privacy law.",
      schema: LAW_SCHEMA,
      matchKey: "id",
      fields: {
        id: { label: "Id", semanticType: "identifier" },
        name: { label: "Law", semanticType: "text" },
        regions: { label: "Visitors from", semanticType: "text" },
      },
    },
    {
      id: "InstallGuide",
      version: "1.0.0",
      description: "How to install on one platform.",
      schema: GUIDE_SCHEMA,
      fields: {
        platform: { label: "Platform", semanticType: "identifier" },
        steps: { label: "Steps", semanticType: "unknown" },
      },
    },
  ],
  sources: [{ id: "api", label: "Consent content" }],
  capabilities: [
    {
      id: "laws.list",
      version: "1.0.0",
      purpose: "Which privacy laws apply to visitors from a region.",
      kind: "query",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: { type: "array", items: LAW_SCHEMA },
      output: { dataTypeId: "PrivacyLaw", shape: "collection" },
      requiredSessionKeys: [],
      sourceIds: ["api"],
      supports: { filterFields: ["regions", "name"], sortFields: ["name"] },
      policy: { authentication: "public", maximumRows: 50 },
    },
    {
      id: "install.guide",
      version: "1.0.0",
      purpose: "How to install the banner on one website platform.",
      kind: "query",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["platform"],
        properties: { platform: { type: "string", title: "Platform", enum: PLATFORMS } },
      },
      outputSchema: GUIDE_SCHEMA,
      output: { dataTypeId: "InstallGuide", shape: "entity" },
      requiredSessionKeys: [],
      sourceIds: ["api"],
      policy: { authentication: "public", maximumRows: 1 },
    },
  ],
  relationships: [],
};

const bindings = {
  "laws.list": {
    capabilityId: "laws.list",
    method: "GET",
    path: "/laws",
    contentParameters: [],
    exposeFields: ["id", "name", "regions"],
  },
  "install.guide": {
    capabilityId: "install.guide",
    method: "GET",
    path: "/install",
    contentParameters: ["platform"],
    exposeFields: ["platform", "steps"],
  },
};

const LawList = defineComponent({
  id: "LawList",
  version: "1.0.0",
  description: "The laws that apply.",
  props: defineProps({ heading: field.string({ default: "Laws" }) }),
  renderer: { component: "LawList", props: { laws: { path: "/laws" } } },
  dataSlots: { laws: { accepts: [{ dataTypeId: "PrivacyLaw", shapes: ["collection"] }] } },
});
const InstallGuide = defineComponent({
  id: "InstallGuide",
  version: "1.0.0",
  description: "How to install.",
  props: defineProps({ heading: field.string({ default: "Install" }) }),
  renderer: { component: "InstallGuide", props: { guide: { path: "/guide" } } },
  dataSlots: { guide: { accepts: [{ dataTypeId: "InstallGuide", shapes: ["entity"] }] } },
});
const site = defineSite({
  id: "consent",
  name: "Consent",
  version: "1.0.0",
  catalogId: "consent",
  components: [LawList, InstallGuide],
  surfaces: [
    defineSurface({
      id: "main",
      description: "Laws and install guides.",
      componentIds: ["LawList", "InstallGuide"],
      maxComponents: 2,
    }),
  ],
});

async function startUpstream() {
  const fetched = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://upstream");
    fetched.push(url.pathname + url.search);
    res.writeHead(200, { "content-type": "application/json" });
    if (url.pathname === "/install") {
      const platform = url.searchParams.get("platform");
      return res.end(JSON.stringify({ platform, steps: [`Install on ${platform}`] }));
    }
    res.end(JSON.stringify(LAWS));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    fetched,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The draft gpt-4o wrote for the pasted Texas note, verbatim in shape. */
const TEXAS_DRAFT = {
  status: "ready",
  dataRequests: [
    {
      requestId: "r1",
      capabilityId: "laws.list",
      params: {},
      query: {
        filter: {
          combine: "any",
          conditions: [
            {
              field: "regions",
              operator: "in",
              value: ["Germany", "France", "California", "Texas"],
            },
          ],
        },
      },
    },
    { requestId: "r2", capabilityId: "install.guide", params: { platform: "shopify" } },
  ],
  nodes: [
    { nodeId: "n1", componentId: "LawList", props: {}, dataBindings: { laws: { requestId: "r1" } } },
    {
      nodeId: "n2",
      componentId: "InstallGuide",
      props: {},
      dataBindings: { guide: { requestId: "r2" } },
    },
  ],
};

/** The same draft with no platform: what a planner writes when none was stated. */
const NO_PLATFORM_DRAFT = {
  status: "ready",
  dataRequests: [{ requestId: "r1", capabilityId: "install.guide", params: {} }],
  nodes: [
    {
      nodeId: "n1",
      componentId: "InstallGuide",
      props: {},
      dataBindings: { guide: { requestId: "r1" } },
    },
  ],
};

async function fixture({ owner = true } = {}) {
  const upstream = await startUpstream();
  let calls = 0;
  const server = createViewServer({
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: (session, key) => session[key],
    },
    resolveSession: (request) => ({ visitorId: request.visitor ?? "v1" }),
    ...(owner ? { resolveViewOwner: (session) => session.visitorId } : {}),
    viewStore: createMemoryViewStore(),
    allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
  });
  await server.publishReviewedCatalog({ catalog, bindings, baseUrl: upstream.baseUrl });
  await server.publishUiCatalog({ manifest: toSiteManifest(site), catalogId: "consent" });
  const compose = (prompt, draft, extra = {}) =>
    server.composeAgainstPublishedCatalogs({
      catalogId: "consent",
      prompt,
      request: {},
      createProvider: () => ({
        id: "scripted",
        async generatePlan() {
          calls += 1;
          return { modelId: "scripted-1", value: structuredClone(draft) };
        },
      }),
      ...extra,
    });
  const refine = (planId, operations, request = {}) =>
    server.refineComposedView({ catalogId: "consent", planId, operations, request });
  return { server, upstream, compose, refine, calls: () => calls };
}

const envelopeOf = (result) =>
  result.messages
    .flatMap((message) => (message.updateDataModel ? [message.updateDataModel] : []))
    .map((update) => update.value?.__renderyes)
    .find(Boolean);

const regionsOf = (result) => result.understood.find((entry) => entry.name === "regions");

/* -------------------------------------------------------- B1: the summary */

test("the Texas case: a named region the catalog does not list is reported as not found, not dropped", async () => {
  const { upstream, compose } = await fixture();
  try {
    const result = await compose("customers in Germany, France, California and Texas", TEXAS_DRAFT);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    assert.deepEqual(result.understood, [
      {
        requestId: "r1",
        capabilityId: "laws.list",
        kind: "filter",
        name: "regions",
        label: "Visitors from",
        multiple: true,
        required: false,
        values: ["Germany", "France", "California"],
        notFound: ["Texas"],
        options: REGIONS,
        editable: true,
      },
      {
        requestId: "r2",
        capabilityId: "install.guide",
        kind: "param",
        name: "platform",
        label: "Platform",
        multiple: false,
        required: true,
        values: ["shopify"],
        notFound: [],
        options: PLATFORMS,
        editable: true,
      },
    ]);
    // The browser reads the same list from the data-model envelope.
    assert.deepEqual(envelopeOf(result).understood, result.understood);
  } finally {
    await upstream.close();
  }
});

test("editing a value re-runs the request in code: no model call, validated values only", async () => {
  const { upstream, compose, refine, calls } = await fixture();
  try {
    const composed = await compose("customers in Germany and Texas", TEXAS_DRAFT);
    const before = calls();
    const edited = await refine(composed.planId, [
      {
        kind: "setInput",
        requestId: "r1",
        input: "filter",
        name: "regions",
        values: ["Germany", "Utah"],
      },
    ]);
    assert.equal(edited.ok, true, edited.ok ? "" : edited.reason);
    assert.equal(calls(), before, "an edit makes no model call");
    const regions = regionsOf(edited);
    assert.deepEqual(regions.values, ["Germany", "Utah"]);
    // Texas still matched nothing, and is still said to have matched nothing.
    assert.deepEqual(regions.notFound, ["Texas"]);

    const platform = await refine(edited.planId, [
      { kind: "setInput", requestId: "r2", input: "param", name: "platform", values: ["wordpress"] },
    ]);
    assert.equal(platform.ok, true, platform.ok ? "" : platform.reason);
    assert.deepEqual(
      platform.understood.find((entry) => entry.name === "platform").values,
      ["wordpress"],
    );
    assert.ok(upstream.fetched.includes("/install?platform=wordpress"));

    // Clearing every declared value removes the condition, not-found terms with it.
    const cleared = await refine(platform.planId, [
      { kind: "setInput", requestId: "r1", input: "filter", name: "regions", values: [] },
    ]);
    assert.equal(cleared.ok, true, cleared.ok ? "" : cleared.reason);
    assert.equal(regionsOf(cleared), undefined);
  } finally {
    await upstream.close();
  }
});

test("adversarial: an injected value outside the declared set is refused, for a filter and for a param", async () => {
  const { upstream, compose, refine } = await fixture();
  try {
    const composed = await compose("Germany", TEXAS_DRAFT);
    const fetchedBefore = upstream.fetched.length;
    const texas = await refine(composed.planId, [
      { kind: "setInput", requestId: "r1", input: "filter", name: "regions", values: ["Texas"] },
    ]);
    assert.equal(texas.ok, false);
    assert.equal(texas.kind, "invalid");
    assert.match(texas.reason, /"Texas" is not a value this site lists for Visitors from/);

    const spelled = await refine(composed.planId, [
      { kind: "setInput", requestId: "r2", input: "param", name: "platform", values: ["Shopify"] },
    ]);
    assert.equal(spelled.ok, false, "declared values are matched in the catalog's own spelling");

    const injected = await refine(composed.planId, [
      {
        kind: "setInput",
        requestId: "r2",
        input: "param",
        name: "platform",
        values: ["shopify\" OR 1=1"],
      },
    ]);
    assert.equal(injected.ok, false);
    assert.equal(upstream.fetched.length, fetchedBefore, "a refused edit fetches nothing");
  } finally {
    await upstream.close();
  }
});

test("adversarial: an edit naming an identity or session parameter, or any undeclared input, is refused", async () => {
  const { upstream, compose, refine } = await fixture();
  try {
    const composed = await compose("Germany", TEXAS_DRAFT);
    for (const name of ["visitorId", "accountId", "__proto__"]) {
      const refused = await refine(composed.planId, [
        { kind: "setInput", requestId: "r2", input: "param", name, values: ["shopify"] },
      ]);
      assert.equal(refused.ok, false, name);
      assert.match(refused.reason, /is not an input a visitor can change on install\.guide/);
    }
    // A field approved for filtering but with no declared values is not editable either.
    const free = await refine(composed.planId, [
      { kind: "setInput", requestId: "r1", input: "filter", name: "name", values: ["GDPR"] },
    ]);
    assert.equal(free.ok, false);
    // Nor is a plan someone else composed.
    await assert.rejects(
      refine(
        composed.planId,
        [{ kind: "setInput", requestId: "r2", input: "param", name: "platform", values: ["html"] }],
        { visitor: "mallory" },
      ),
      /No recently composed plan/,
    );
  } finally {
    await upstream.close();
  }
});

/* ------------------------------------------- B2: ask only for what is missing */

test("a missing required input is asked for with its declared values, and nothing is fetched until it is answered", async () => {
  const { server, upstream, compose, refine, calls } = await fixture();
  try {
    const asked = await compose("how do I install the banner?", NO_PLATFORM_DRAFT);
    assert.equal(asked.ok, false);
    assert.equal(asked.kind, "needs-clarification");
    assert.equal(asked.question, "Which platform?");
    assert.deepEqual(asked.options, PLATFORMS);
    assert.deepEqual(
      { ...asked.input, planId: undefined },
      {
        planId: undefined,
        requestId: "r1",
        capabilityId: "install.guide",
        kind: "param",
        name: "platform",
        label: "Platform",
        options: PLATFORMS,
      },
    );
    assert.equal(typeof asked.input.planId, "string");
    assert.equal(asked.messages, undefined);
    assert.deepEqual(upstream.fetched, [], "nothing is fetched before the answer");

    // The held plan is a question, not a view: it cannot be saved, revised,
    // refined some other way, or answered with a value outside the set.
    await assert.rejects(
      server.saveComposedView({ catalogId: "consent", planId: asked.input.planId, request: {} }),
      /waiting for the answer/,
    );
    const sorted = await refine(asked.input.planId, [{ kind: "setLimit", requestId: "r1", limit: 1 }]);
    assert.equal(sorted.ok, false);
    const wrong = await refine(asked.input.planId, [
      { kind: "setInput", requestId: "r1", input: "param", name: "platform", values: ["wix"] },
    ]);
    assert.equal(wrong.ok, false);
    assert.deepEqual(upstream.fetched, []);

    const before = calls();
    const answered = await refine(asked.input.planId, [
      { kind: "setInput", requestId: "r1", input: "param", name: "platform", values: ["html"] },
    ]);
    assert.equal(answered.ok, true, answered.ok ? "" : answered.reason);
    assert.equal(calls(), before, "answering makes no model call");
    assert.deepEqual(upstream.fetched, ["/install?platform=html"]);
    // The answered view is an ordinary view from here on.
    const saved = await server.saveComposedView({
      catalogId: "consent",
      planId: answered.planId,
      request: {},
    });
    assert.equal(saved.ok, true);
  } finally {
    await upstream.close();
  }
});

test("without a view owner there is nothing to hold a plan for: the question still arrives, without `input`", async () => {
  const { upstream, compose } = await fixture({ owner: false });
  try {
    const asked = await compose("how do I install the banner?", NO_PLATFORM_DRAFT);
    assert.equal(asked.kind, "needs-clarification");
    assert.equal(asked.question, "Which platform?");
    assert.deepEqual(asked.options, PLATFORMS);
    assert.equal(asked.input, undefined);
  } finally {
    await upstream.close();
  }
});

test("the streamed question carries the same input on RUN_ERROR", async () => {
  const { upstream, compose } = await fixture();
  try {
    const events = [];
    await compose("how do I install it?", NO_PLATFORM_DRAFT, {
      onEvent: (event) => events.push(event),
    });
    const terminal = events.at(-1);
    assert.equal(terminal.type, "RUN_ERROR");
    assert.equal(terminal.kind, "needs-clarification");
    assert.equal(terminal.input.name, "platform");
    assert.deepEqual(terminal.input.options, PLATFORMS);
  } finally {
    await upstream.close();
  }
});

test("System One with no language model asks for the platform instead of deferring", async () => {
  const upstream = await startUpstream();
  try {
    const decisionFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          capability: { choice: "install.guide", answer_confidence: 0.99 },
          in_scope: { noul: 0.99 },
        },
      }),
    });
    const server = createViewServer({
      host: {
        isAuthenticated: () => true,
        hasPermission: () => true,
        getSessionValue: () => undefined,
      },
      resolveSession: () => ({ visitorId: "v1" }),
      resolveViewOwner: (session) => session.visitorId,
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
    });
    await server.publishReviewedCatalog({ catalog, bindings, baseUrl: upstream.baseUrl });
    await server.publishUiCatalog({ manifest: toSiteManifest(site), catalogId: "consent" });
    const provider = createSystemOnePlanProvider({
      id: "system-one",
      url: "http://127.0.0.1:1/v1/systemone",
      model: "renderyes",
      fetchImpl: decisionFetch,
    });
    const asked = await server.composeAgainstPublishedCatalogs({
      catalogId: "consent",
      prompt: "how do I install the banner on my website?",
      request: {},
      createProvider: () => provider,
    });
    assert.equal(asked.kind, "needs-clarification", asked.reason);
    assert.equal(asked.input?.name, "platform");
    assert.deepEqual(upstream.fetched, []);
  } finally {
    await upstream.close();
  }
});
