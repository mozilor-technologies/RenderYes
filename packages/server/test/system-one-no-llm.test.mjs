import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import {
  appendDraft,
  componentKind,
  createSystemOnePlanProvider,
  createViewServer,
  isPresentationOnly,
  presentationCue,
  searchTermsFrom,
  splitCompound,
} from "../dist/index.js";
import { composeDataPlan } from "@renderyes/planner";
import { createPlannerManifest } from "@renderyes/capability-catalog";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  field,
  toSiteManifest,
} from "@renderyes/site-sdk";

/**
 * What a site with no language model at all gets from System One, measured
 * on a Stack Overflow dashboard and a newspaper in November 2026 and moved
 * here from their gateways: a typed refinement adds a panel to the view on
 * screen; "as a table" re-renders the last panel; a compound prompt becomes
 * one panel per part; a search capability takes the visitor's words; a
 * capability the catalog cannot draft a value for asks instead of refusing;
 * the model server is kept warm; and a host's own rules correct the
 * decision model on its own vocabulary, recorded rather than silent.
 */

/* ---------------------------------------------------------------- fixtures */

const TAGS = ["python", "javascript", "react"];

const catalog = {
  schemaVersion: "1.0",
  id: "pulse",
  version: "1.0.0",
  description: "a dashboard of public questions and answers",
  dataTypes: [
    {
      id: "Question",
      version: "1.0.0",
      description: "One question.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "createdAt"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          createdAt: { type: "string" },
        },
      },
      fields: {
        id: { label: "Id", semanticType: "identifier" },
        title: { label: "Title", semanticType: "text" },
        createdAt: { label: "Asked", semanticType: "date-time" },
      },
    },
    {
      id: "TagCount",
      version: "1.0.0",
      description: "A tag and how many questions carry it.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["tag", "count"],
        properties: { tag: { type: "string" }, count: { type: "integer" } },
      },
      fields: {
        tag: { label: "Tag", semanticType: "text" },
        count: { label: "Questions", semanticType: "quantity" },
      },
    },
    {
      id: "QuestionCount",
      version: "1.0.0",
      description: "How many questions there are.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["total"],
        properties: { total: { type: "integer" } },
      },
      fields: { total: { label: "Questions", semanticType: "quantity" } },
    },
    {
      id: "Answerer",
      version: "1.0.0",
      description: "One person who answers questions.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "score"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          score: { type: "integer" },
        },
      },
      fields: {
        id: { label: "Id", semanticType: "identifier" },
        name: { label: "Name", semanticType: "text" },
        score: { label: "Score", semanticType: "quantity" },
      },
    },
  ],
  sources: [{ id: "api", label: "Public API" }],
  capabilities: [
    {
      id: "pulse.questions.list",
      version: "1.0.0",
      purpose:
        "The latest questions, optionally for one tag. Use for recent questions about a topic.",
      kind: "query",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          tagged: { enum: TAGS },
          pagesize: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
      outputSchema: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "title", "createdAt"],
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            createdAt: { type: "string" },
          },
        },
      },
      output: { dataTypeId: "Question", shape: "collection" },
      requiredSessionKeys: [],
      sourceIds: ["api"],
      supports: { filterFields: ["title"], sortFields: ["createdAt"] },
      policy: { authentication: "public", maximumRows: 50 },
    },
    {
      id: "pulse.questions.search",
      version: "1.0.0",
      purpose:
        "Search questions by free text: a pasted title, an error message, any phrase. Use for find, search, questions mentioning.",
      kind: "query",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["q"],
        properties: {
          q: { type: "string", maxLength: 200 },
          pagesize: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
      outputSchema: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "title", "createdAt"],
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            createdAt: { type: "string" },
          },
        },
      },
      output: { dataTypeId: "Question", shape: "collection" },
      requiredSessionKeys: [],
      sourceIds: ["api"],
      supports: { filterFields: ["title"], sortFields: ["createdAt"] },
      policy: { authentication: "public", maximumRows: 50 },
    },
    {
      id: "pulse.tags.top",
      version: "1.0.0",
      purpose:
        "The most used tags, ranked by question count. Use for top tags, popular topics.",
      kind: "query",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { pagesize: { type: "integer", minimum: 1, maximum: 30 } },
      },
      outputSchema: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["tag", "count"],
          properties: { tag: { type: "string" }, count: { type: "integer" } },
        },
      },
      output: { dataTypeId: "TagCount", shape: "collection" },
      requiredSessionKeys: [],
      sourceIds: ["api"],
      supports: { filterFields: ["tag"], sortFields: ["count"] },
      policy: { authentication: "public", maximumRows: 30 },
    },
    {
      id: "pulse.questions.count",
      version: "1.0.0",
      purpose: "How many questions there are, optionally for one tag. A single number.",
      kind: "query",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { tagged: { enum: TAGS } },
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["total"],
        properties: { total: { type: "integer" } },
      },
      output: { dataTypeId: "QuestionCount", shape: "metric" },
      requiredSessionKeys: [],
      sourceIds: ["api"],
      policy: { authentication: "public", maximumRows: 1 },
    },
    {
      id: "pulse.answerers.top",
      version: "1.0.0",
      purpose: "The top answerers for one tag. Use for who answers, experts on a topic.",
      kind: "query",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tagged"],
        properties: { tagged: { enum: TAGS } },
      },
      outputSchema: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "score"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            score: { type: "integer" },
          },
        },
      },
      output: { dataTypeId: "Answerer", shape: "collection" },
      requiredSessionKeys: [],
      sourceIds: ["api"],
      supports: { filterFields: ["name"], sortFields: ["score"] },
      policy: { authentication: "public", maximumRows: 20 },
    },
  ],
  relationships: [],
};

const bindings = {
  "pulse.questions.list": {
    capabilityId: "pulse.questions.list",
    method: "GET",
    path: "/api/questions",
    contentParameters: ["tagged", "pagesize"],
    exposeFields: ["id", "title", "createdAt"],
  },
  "pulse.questions.search": {
    capabilityId: "pulse.questions.search",
    method: "GET",
    path: "/api/questions/search",
    contentParameters: ["q", "pagesize"],
    exposeFields: ["id", "title", "createdAt"],
  },
  "pulse.tags.top": {
    capabilityId: "pulse.tags.top",
    method: "GET",
    path: "/api/tags",
    contentParameters: ["pagesize"],
    exposeFields: ["tag", "count"],
  },
  "pulse.questions.count": {
    capabilityId: "pulse.questions.count",
    method: "GET",
    path: "/api/questions/count",
    contentParameters: ["tagged"],
    exposeFields: ["total"],
  },
  "pulse.answerers.top": {
    capabilityId: "pulse.answerers.top",
    method: "GET",
    path: "/api/answerers",
    contentParameters: ["tagged"],
    exposeFields: ["id", "name", "score"],
  },
};

const QuestionTable = defineComponent({
  id: "QuestionTable",
  version: "1.0.0",
  description: "A table of questions.",
  props: defineProps({ heading: field.string({ default: "Questions" }) }),
  renderer: { component: "QuestionTable", props: { rows: { path: "/rows" } } },
  dataSlots: { rows: { accepts: [{ dataTypeId: "Question", shapes: ["collection"] }] } },
});

const TagBarChart = defineComponent({
  id: "TagBarChart",
  version: "1.0.0",
  description: "A bar chart of tag counts.",
  props: defineProps({ heading: field.string({ default: "Tags" }) }),
  renderer: { component: "TagBarChart", props: { rows: { path: "/rows" } } },
  dataSlots: { rows: { accepts: [{ dataTypeId: "TagCount", shapes: ["collection"] }] } },
});

const TagTable = defineComponent({
  id: "TagTable",
  version: "1.0.0",
  description: "A breakdown table of tag counts.",
  props: defineProps({ heading: field.string({ default: "Breakdown" }) }),
  renderer: { component: "TagTable", props: { rows: { path: "/rows" } } },
  dataSlots: { rows: { accepts: [{ dataTypeId: "TagCount", shapes: ["collection"] }] } },
});

const CountCard = defineComponent({
  id: "CountCard",
  version: "1.0.0",
  description: "One number.",
  props: defineProps({ heading: field.string() }),
  renderer: { component: "CountCard", props: { metric: { path: "/metric" } } },
  dataSlots: { metric: { accepts: [{ shape: "metric" }] } },
});

const AnswererList = defineComponent({
  id: "AnswererList",
  version: "1.0.0",
  description: "A list of answerers.",
  props: defineProps({ heading: field.string({ default: "Answerers" }) }),
  renderer: { component: "AnswererList", props: { rows: { path: "/rows" } } },
  dataSlots: { rows: { accepts: [{ dataTypeId: "Answerer", shapes: ["collection"] }] } },
});

const site = defineSite({
  id: "pulse",
  name: "Pulse",
  version: "1.0.0",
  catalogId: "https://pulse.example.com/catalog.json",
  components: [QuestionTable, TagBarChart, TagTable, CountCard, AnswererList],
  surfaces: [
    defineSurface({
      id: "main",
      description: "Main.",
      componentIds: [
        "QuestionTable",
        "TagBarChart",
        "TagTable",
        "CountCard",
        "AnswererList",
      ],
      maxComponents: 4,
    }),
  ],
});

const plannerManifest = createPlannerManifest(catalog);

/** A scripted decision endpoint; records every request body, never touches the network. */
function scriptedDecisions(table, { delayMs = 0 } = {}) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body, at: Date.now() });
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const decision = table[body.state.request] ?? {
        choice: "none",
        confidence: 0.5,
        inScope: 0.5,
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          answers: {
            capability: {
              choice: decision.choice,
              answer_confidence: decision.confidence,
              ...(decision.probabilities
                ? { probabilities: decision.probabilities }
                : {}),
            },
            in_scope: { noul: decision.inScope ?? 0.9 },
          },
        }),
      };
    },
  };
}

const sure = (choice, prompts) =>
  Object.fromEntries(
    prompts.map((prompt) => [prompt, { choice, confidence: 0.96, inScope: 0.95 }]),
  );

const DECISIONS = {
  ...sure("pulse.questions.list", [
    "python questions",
    "latest react questions",
    "delete python questions",
  ]),
  ...sure("pulse.tags.top", [
    "top tags",
    "the top tags",
    "top tags as a table",
    "top five tags",
  ]),
  ...sure("pulse.questions.count", ["how many questions", "how many python questions"]),
  ...sure("pulse.answerers.top", ["top answerers", "top python answerers"]),
  ...sure("pulse.questions.search", [
    "find questions about useTransition behaving differently",
    "find something interesting",
  ]),
};

/** A provider that also records what it classified, for assertions on the `classify` block. */
function systemOne(decisions, extra = {}) {
  const provider = createSystemOnePlanProvider({
    id: "system-one",
    url: "http://127.0.0.1:8000/v1/systemone",
    model: "renderyes",
    fetchImpl: decisions.fetchImpl,
    ...extra,
  });
  const classified = [];
  return {
    id: provider.id,
    classified,
    close: () => provider.close(),
    async generatePlan(request) {
      const result = await provider.generatePlan(request);
      classified.push(result.classification);
      return result;
    },
  };
}

function compose(provider, prompt, extra = {}) {
  return composeDataPlan({
    site,
    plannerManifest,
    surfaceId: "main",
    prompt,
    provider,
    ...extra,
  });
}

const nodesOf = (plan) => plan.surfaces[0].nodes;
const requestsOf = (plan) => plan.dataRequests;

/* ---------------------------------------------- revisions without a model */

test("a typed refinement with no language model adds its panel to the view on screen", async () => {
  const decisions = scriptedDecisions(DECISIONS);
  const provider = systemOne(decisions);
  const first = await compose(provider, "python questions");
  assert.equal(first.ok, true, first.ok ? "" : first.reason);
  assert.equal(nodesOf(first.plan).length, 1);

  const second = await compose(provider, "top tags", { previousPlan: first.plan });
  assert.equal(second.ok, true, second.ok ? "" : second.reason);
  assert.deepEqual(
    nodesOf(second.plan).map((node) => node.componentId),
    ["QuestionTable", "TagBarChart"],
  );
  assert.deepEqual(
    requestsOf(second.plan).map((request) => request.capabilityId),
    ["pulse.questions.list", "pulse.tags.top"],
  );
  // Ids are renumbered past the plan on screen, never colliding with it.
  const nodeIds = nodesOf(second.plan).map((node) => node.nodeId);
  assert.equal(new Set(nodeIds).size, nodeIds.length);
  const requestIds = requestsOf(second.plan).map((request) => request.requestId);
  assert.equal(new Set(requestIds).size, requestIds.length);
  // And every panel still binds a request that exists.
  for (const node of nodesOf(second.plan)) {
    for (const binding of Object.values(node.dataBindings)) {
      assert.ok(requestIds.includes(binding.requestId), binding.requestId);
    }
  }
  // Recorded as a revision the rules made, after one decision.
  assert.equal(provider.classified[1].stage, "revision");
  assert.equal(provider.classified[1].path, "fast");
  assert.equal(decisions.requests.length, 2);
});

test("the view is bounded by the surface's maxComponents: the oldest panel is dropped, and its request with it", async () => {
  const provider = systemOne(scriptedDecisions(DECISIONS));
  let plan = (await compose(provider, "python questions")).plan;
  for (const prompt of [
    "top tags",
    "how many questions",
    "latest react questions",
    "top five tags",
  ]) {
    const next = await compose(provider, prompt, { previousPlan: plan });
    assert.equal(next.ok, true, next.ok ? "" : next.reason);
    plan = next.plan;
  }
  assert.equal(nodesOf(plan).length, 4);
  assert.deepEqual(
    nodesOf(plan).map((node) => node.componentId),
    ["TagBarChart", "CountCard", "QuestionTable", "TagBarChart"],
  );
  assert.equal(requestsOf(plan).length, 4);
  const bound = new Set(
    nodesOf(plan).flatMap((node) =>
      Object.values(node.dataBindings).map((b) => b.requestId),
    ),
  );
  assert.deepEqual(
    requestsOf(plan)
      .map((request) => request.requestId)
      .sort(),
    [...bound].sort(),
  );
});

test("appendDraft joins a plan with any ids at all — a language model's — without a collision", () => {
  const base = {
    dataRequests: [
      { requestId: "stories", capabilityId: "x.list", params: {} },
      { requestId: "total", capabilityId: "x.count", params: {} },
    ],
    nodes: [
      {
        nodeId: "a",
        componentId: "List",
        props: {},
        dataBindings: { rows: { requestId: "stories" } },
      },
      {
        nodeId: "n1",
        componentId: "Card",
        props: {},
        dataBindings: { metric: { requestId: "total" } },
      },
    ],
  };
  const draft = {
    status: "ready",
    dataRequests: [{ requestId: "r1", capabilityId: "x.tags", params: {} }],
    nodes: [
      {
        nodeId: "n1",
        componentId: "Bars",
        props: {},
        dataBindings: { rows: { requestId: "r1" } },
      },
    ],
  };
  const merged = appendDraft(base, draft, 4);
  assert.deepEqual(
    merged.nodes.map((node) => node.nodeId),
    ["a", "n1", "n3"],
  );
  assert.equal(
    merged.nodes[2].dataBindings.rows.requestId,
    merged.dataRequests[2].requestId,
  );
  assert.notEqual(merged.dataRequests[2].requestId, "r1");
  // The cap drops from the front and drops the request nothing binds any more.
  const capped = appendDraft(base, draft, 2);
  assert.deepEqual(
    capped.nodes.map((node) => node.componentId),
    ["Card", "Bars"],
  );
  assert.deepEqual(
    capped.dataRequests.map((request) => request.capabilityId),
    ["x.count", "x.tags"],
  );
});

test("a revision that only names a presentation re-renders the last panel with no decision call", async () => {
  const decisions = scriptedDecisions(DECISIONS);
  const provider = systemOne(decisions);
  const chart = (await compose(provider, "top tags")).plan;
  assert.equal(nodesOf(chart)[0].componentId, "TagBarChart");
  const before = decisions.requests.length;

  const table = await compose(provider, "as a table", { previousPlan: chart });
  assert.equal(table.ok, true, table.ok ? "" : table.reason);
  assert.equal(nodesOf(table.plan).length, 1);
  assert.equal(nodesOf(table.plan)[0].componentId, "TagTable");
  // Same request, same heading: only the component changed.
  assert.deepEqual(requestsOf(table.plan), requestsOf(chart));
  assert.equal(nodesOf(table.plan)[0].props.heading, nodesOf(chart)[0].props.heading);
  assert.equal(decisions.requests.length, before, "no decision asked");
  assert.equal(provider.classified.at(-1).reason, "presentation");
  assert.equal(provider.classified.at(-1).durationMs, 0);

  // And back again, in the visitor's other words.
  const again = await compose(provider, "show it as a chart", {
    previousPlan: table.plan,
  });
  assert.equal(again.ok, true, again.ok ? "" : again.reason);
  assert.equal(nodesOf(again.plan)[0].componentId, "TagBarChart");
  assert.equal(decisions.requests.length, before);
});

test("a presentation the surface has no component for is refused with a reason, not guessed", async () => {
  const provider = systemOne(scriptedDecisions(DECISIONS));
  const questions = (await compose(provider, "python questions")).plan;
  const result = await compose(provider, "as a chart", { previousPlan: questions });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "unsupported");
  assert.match(result.reason, /no other way to show/);
  assert.equal(provider.classified.at(-1).reason, "no-presentation");
});

test("a presentation named on a fresh prompt picks among the accepting components", async () => {
  const provider = systemOne(scriptedDecisions(DECISIONS));
  const chart = await compose(provider, "top tags");
  assert.equal(nodesOf(chart.plan)[0].componentId, "TagBarChart");
  const table = await compose(provider, "top tags as a table");
  assert.equal(table.ok, true, table.ok ? "" : table.reason);
  assert.equal(nodesOf(table.plan)[0].componentId, "TagTable");
});

test("presentation cues and component kinds are read from words, never inferred", () => {
  assert.equal(presentationCue("top tags as a table"), "table");
  assert.equal(presentationCue("show it as a chart"), "chart");
  assert.equal(presentationCue("top tags"), undefined);
  assert.equal(isPresentationOnly("as a table"), true);
  assert.equal(isPresentationOnly("show it as a chart instead"), true);
  assert.equal(isPresentationOnly("top tags as a table"), false);
  assert.equal(isPresentationOnly("python"), false);
  assert.equal(componentKind(site.getComponent("TagBarChart")), "chart");
  assert.equal(componentKind(site.getComponent("TagTable")), "table");
  assert.equal(componentKind(site.getComponent("AnswererList")), "table");
  assert.equal(componentKind(site.getComponent("CountCard")), undefined);
});

/* --------------------------------------------- compound prompts, by parts */

test("a compound prompt with no language model becomes one panel per part, each decided on its own", async () => {
  const decisions = scriptedDecisions(DECISIONS);
  const provider = systemOne(decisions);
  const result = await compose(provider, "python questions and the top tags");
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  assert.deepEqual(
    nodesOf(result.plan).map((node) => node.componentId),
    ["QuestionTable", "TagBarChart"],
  );
  assert.deepEqual(
    requestsOf(result.plan).map((request) => request.capabilityId),
    ["pulse.questions.list", "pulse.tags.top"],
  );
  assert.equal(requestsOf(result.plan)[0].params.tagged, "python");
  // The whole prompt was decided once, then each part: three decisions.
  assert.deepEqual(
    decisions.requests.map((request) => request.body.state.request),
    ["python questions and the top tags", "python questions", "the top tags"],
  );
  const classified = provider.classified.at(-1);
  assert.equal(classified.reason, "compound-by-parts");
  assert.equal(classified.parts, 2);
});

test("a compound prompt with a part the rules cannot answer is refused whole, never half-answered", async () => {
  const provider = systemOne(scriptedDecisions(DECISIONS));
  const result = await compose(provider, "python questions and the reader polls");
  assert.equal(result.ok, false);
  assert.equal(result.kind, "unsupported");
  assert.match(result.reason, /several things at once/);
  assert.equal(provider.classified.at(-1).reason, "compound-prompt");
});

test("splitting is conservative: two or three parts of at least two words", () => {
  assert.deepEqual(splitCompound("python questions and the top tags"), [
    "python questions",
    "the top tags",
  ]);
  assert.deepEqual(splitCompound("how many questions, the top tags and top answerers"), [
    "how many questions",
    "the top tags",
    "top answerers",
  ]);
  assert.equal(splitCompound("python questions and more"), undefined);
  assert.equal(splitCompound("python questions"), undefined);
  assert.equal(splitCompound("a and b and c and d"), undefined);
});

/* ------------------------------------------------- free-text search terms */

test("a required search argument takes the visitor's words with the asking trimmed off", async () => {
  const provider = systemOne(scriptedDecisions(DECISIONS));
  const result = await compose(
    provider,
    "find questions about useTransition behaving differently",
  );
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  const [request] = requestsOf(result.plan);
  assert.equal(request.capabilityId, "pulse.questions.search");
  assert.equal(request.params.q, "useTransition behaving differently");
  assert.equal(nodesOf(result.plan)[0].componentId, "QuestionTable");
});

test("search terms: only filler leaves nothing to search for", () => {
  assert.equal(searchTermsFrom("find questions about react hooks"), "react hooks");
  assert.equal(
    searchTermsFrom("has anyone seen 'Cannot read properties of undefined'?"),
    "Cannot read properties of undefined",
  );
  assert.equal(searchTermsFrom("find something interesting"), undefined);
  assert.equal(searchTermsFrom("show me"), undefined);
});

/* -------------------------------------- no draft: ask, with the others */

test("a capability the catalog cannot draft a value for becomes a question with the other capabilities", async () => {
  const provider = systemOne(scriptedDecisions(DECISIONS));
  // The answerers need a tag the prompt does not name.
  const asked = await compose(provider, "top answerers");
  assert.equal(asked.ok, false);
  assert.equal(asked.kind, "needs-clarification");
  const offered = asked.candidates.map((candidate) => candidate.capabilityId);
  assert.ok(offered.length >= 2 && offered.length <= 4, String(offered));
  assert.ok(
    !offered.includes("pulse.answerers.top"),
    "the undraftable one is not offered",
  );
  assert.equal(provider.classified.at(-1).path, "clarify");
  assert.equal(provider.classified.at(-1).reason, "no-draft");

  // Nothing to search for either: the same question, without search.
  const vague = await compose(provider, "find something interesting");
  assert.equal(vague.kind, "needs-clarification");
  assert.ok(
    !vague.candidates.some(
      (candidate) => candidate.capabilityId === "pulse.questions.search",
    ),
  );

  // Name the tag and it is a view.
  const named = await compose(provider, "top python answerers");
  assert.equal(named.ok, true, named.ok ? "" : named.reason);
  assert.equal(requestsOf(named.plan)[0].params.tagged, "python");
});

/* --------------------------------------------------------------- keep warm */

test("keepWarmMs pings the endpoint on a timer, never while a decision is in flight, and close() stops it", async () => {
  const decisions = scriptedDecisions(DECISIONS, { delayMs: 40 });
  const provider = systemOne(decisions, { keepWarmMs: 5 });
  const pings = () =>
    decisions.requests.filter((request) => request.body.state.request === "keep warm");
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(pings().length >= 2, `expected pings, got ${pings().length}`);
    const ping = pings()[0].body;
    assert.deepEqual(Object.keys(ping.questions.capability.criteria), ["none"]);

    const startedAt = Date.now();
    const result = await compose(provider, "python questions");
    const endedAt = Date.now();
    assert.equal(result.ok, true);
    const during = pings().filter(
      (request) => request.at > startedAt && request.at < endedAt,
    );
    assert.equal(during.length, 0, "no ping while a decision is in flight");
  } finally {
    provider.close();
  }
  const after = pings().length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pings().length, after, "no ping after close");
  assert.throws(
    () =>
      createSystemOnePlanProvider({
        id: "s1",
        url: "http://127.0.0.1:8000/v1/systemone",
        model: "renderyes",
        keepWarmMs: 0,
      }),
    /keepWarmMs/,
  );
});

/* -------------------------------------------------------------- host rules */

test("hostRules.override sends a prompt where the host says, recorded on the classification", async () => {
  // The model reads a short tagged prompt as a search: the host knows better.
  const decisions = scriptedDecisions({
    ...DECISIONS,
    "python questions": {
      choice: "pulse.questions.search",
      confidence: 0.9,
      inScope: 0.95,
    },
  });
  const override = ({ prompt, decision }) =>
    decision.capabilityId === "pulse.questions.search" && prompt.split(/\s+/).length <= 5
      ? { capabilityId: "pulse.questions.list", reason: "tag-list-not-search" }
      : undefined;
  const provider = systemOne(decisions, { hostRules: { override } });
  const result = await compose(provider, "python questions");
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  assert.equal(requestsOf(result.plan)[0].capabilityId, "pulse.questions.list");
  assert.equal(requestsOf(result.plan)[0].params.tagged, "python");
  const classified = provider.classified.at(-1);
  assert.equal(classified.reason, "host-override");
  assert.equal(classified.hostRule, "tag-list-not-search");
  assert.equal(
    classified.capabilityId,
    "pulse.questions.search",
    "the model's own pick is kept",
  );

  // A guard still wins over the host: an action is refused whatever the rule says.
  const guarded = await compose(provider, "delete python questions");
  assert.equal(guarded.ok, false);
  assert.equal(provider.classified.at(-1).reason, "action-verb");

  // An id the surface does not advertise is ignored, and the decision stands.
  const stray = systemOne(decisions, {
    hostRules: { override: () => ({ capabilityId: "pulse.secrets", reason: "x" }) },
  });
  const kept = await compose(stray, "python questions");
  assert.equal(kept.ok, true, kept.ok ? "" : kept.reason);
  assert.equal(requestsOf(kept.plan)[0].capabilityId, "pulse.questions.search");
  assert.equal(stray.classified.at(-1).hostRule, undefined);
});

test("hostRules.draft plans a capability the host would rather plan itself, through the same validation", async () => {
  const draft = ({ prompt, capabilityId }) =>
    capabilityId === "pulse.questions.list"
      ? {
          status: "ready",
          dataRequests: [
            { requestId: "r1", capabilityId, params: { tagged: "python", pagesize: 5 } },
          ],
          nodes: [
            {
              nodeId: "n1",
              componentId: "QuestionTable",
              props: { heading: `Latest python questions (${prompt.length} chars)` },
              dataBindings: { rows: { requestId: "r1" } },
            },
          ],
        }
      : undefined;
  const provider = systemOne(scriptedDecisions(DECISIONS), { hostRules: { draft } });
  const result = await compose(provider, "python questions");
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  assert.equal(
    nodesOf(result.plan)[0].props.heading,
    "Latest python questions (16 chars)",
  );
  assert.equal(requestsOf(result.plan)[0].params.pagesize, 5);
  // Other capabilities still go through the catalog rules.
  const tags = await compose(provider, "top tags");
  assert.equal(nodesOf(tags.plan)[0].componentId, "TagBarChart");
  // A host draft that binds a component the surface does not offer fails validation like any other.
  const bad = systemOne(scriptedDecisions(DECISIONS), {
    hostRules: {
      draft: () => ({
        status: "ready",
        dataRequests: [
          { requestId: "r1", capabilityId: "pulse.questions.list", params: {} },
        ],
        nodes: [
          {
            nodeId: "n1",
            componentId: "Nope",
            props: {},
            dataBindings: { rows: { requestId: "r1" } },
          },
        ],
      }),
    },
  });
  const rejected = await compose(bad, "python questions", { maxRetries: 0 });
  assert.equal(rejected.ok, false);
});

/* ------------------------------------------------------- through the server */

async function startUpstream() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.startsWith("/api/questions/count"))
      return res.end(JSON.stringify({ total: 3 }));
    if (req.url.startsWith("/api/tags"))
      return res.end(JSON.stringify([{ tag: "python", count: 2 }]));
    if (req.url.startsWith("/api/answerers"))
      return res.end(JSON.stringify([{ id: "a1", name: "Ada", score: 9 }]));
    res.end(
      JSON.stringify([{ id: "q1", title: "One", createdAt: "2026-01-01T00:00:00Z" }]),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("through the server: a revise with no language model adds a panel, and a presentation revise asks no decision", async () => {
  const upstream = await startUpstream();
  try {
    const decisions = scriptedDecisions(DECISIONS);
    const classified = [];
    const server = createViewServer({
      host: {
        isAuthenticated: () => true,
        hasPermission: () => true,
        getSessionValue: () => undefined,
      },
      resolveSession: () => ({ visitorId: "v1" }),
      resolveViewOwner: (session) => session.visitorId,
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
      planProviders: [
        {
          id: "system-one",
          url: "http://127.0.0.1:8000/v1/systemone",
          model: "renderyes",
          fetchImpl: decisions.fetchImpl,
        },
      ],
      onModelCall: (event) => {
        if (event.operation === "classify") classified.push(event.classification);
      },
    });
    await server.publishReviewedCatalog({ catalog, bindings, baseUrl: upstream.baseUrl });
    await server.publishUiCatalog({ manifest: toSiteManifest(site) });

    const first = await server.composeAgainstPublishedCatalogs({
      catalogId: "pulse",
      prompt: "top tags",
      request: {},
    });
    assert.equal(first.ok, true, first.ok ? "" : first.reason);
    assert.equal(first.requests.length, 1);

    const second = await server.composeAgainstPublishedCatalogs({
      catalogId: "pulse",
      prompt: "python questions",
      previousPlanId: first.planId,
      request: {},
    });
    assert.equal(second.ok, true, second.ok ? "" : second.reason);
    assert.deepEqual(
      second.requests.map((request) => request.capabilityId),
      ["pulse.tags.top", "pulse.questions.list"],
    );
    // The decision saw the visitor's words, not the server's revision summary.
    assert.equal(decisions.requests.at(-1).body.state.request, "python questions");
    assert.equal(classified.at(-1).stage, "revision");

    const before = decisions.requests.length;
    const third = await server.composeAgainstPublishedCatalogs({
      catalogId: "pulse",
      prompt: "as a table",
      previousPlanId: second.planId,
      request: {},
    });
    assert.equal(third.ok, true, third.ok ? "" : third.reason);
    assert.equal(third.requests.length, 2);
    assert.equal(decisions.requests.length, before, "no decision for a presentation");
    assert.equal(classified.at(-1).reason, "presentation");
  } finally {
    await upstream.close();
  }
});
