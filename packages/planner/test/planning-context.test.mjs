import assert from "node:assert/strict";
import test from "node:test";
import { composeDataPlan } from "../dist/index.js";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  field,
} from "@renderyes/site-sdk";

/**
 * Every provider request carries the planning context as data — the
 * visitor's own prompt, the stage, the manifest and the site — beside the
 * rendered prompts. A provider that cannot read prose (a classifier) depends
 * on it; one that can ignores it. These pin that the context is present on
 * every attempt and says the right thing about each.
 */

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

const plannerManifest = {
  schemaVersion: "1.0",
  catalogId: "support-assist",
  catalogVersion: "1.0.0",
  catalogHash: "abc123",
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
  capabilities: [
    {
      id: "agentReport.get",
      version: "1.0.0",
      purpose: "One report.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      output: { dataTypeId: "AgentReport", shape: "entity" },
      constraints: { authentication: "public" },
    },
    {
      id: "agentReport.unrenderable",
      version: "1.0.0",
      purpose: "A list no component here renders.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      output: { dataTypeId: "AgentReport", shape: "collection" },
      constraints: { authentication: "public" },
    },
  ],
  relationships: [],
};

const goodDraft = {
  status: "ready",
  dataRequests: [{ requestId: "r1", capabilityId: "agentReport.get", params: {} }],
  nodes: [
    {
      nodeId: "n1",
      componentId: "ReportCard",
      props: {},
      dataBindings: { report: { requestId: "r1" } },
    },
  ],
};

function recordingProvider(drafts) {
  const requests = [];
  let call = 0;
  return {
    requests,
    provider: {
      id: "recording",
      async generatePlan(request) {
        requests.push(request);
        const draft = drafts[Math.min(call, drafts.length - 1)];
        call += 1;
        return { modelId: "m", value: draft };
      },
    },
  };
}

test("an initial compose states the prompt, the surface, the scoped ids and the site", async () => {
  const { provider, requests } = recordingProvider([goodDraft]);
  const result = await composeDataPlan({
    site,
    plannerManifest,
    surfaceId: "main",
    prompt: "show my report",
    provider,
  });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  const { planning } = requests[0];
  assert.equal(planning.prompt, "show my report");
  assert.equal(planning.surfaceId, "main");
  assert.equal(planning.stage, "initial");
  assert.equal(planning.attempt, 0);
  assert.equal(planning.site, site);
  assert.equal(planning.plannerManifest, plannerManifest);
  // Surface scoping applies: the collection no slot accepts is not advertised.
  assert.deepEqual(planning.capabilityIds, ["agentReport.get"]);
  // The rendered prompts are still there, unchanged, for a provider that reads them.
  assert.equal(requests[0].userPrompt, "show my report");
  assert.match(requests[0].systemPrompt, /You compose one RenderYes surface/);
});

test("a repair attempt is marked as one, with the attempt number, and keeps the original prompt", async () => {
  const { provider, requests } = recordingProvider([
    { status: "ready", dataRequests: [], nodes: [] },
    goodDraft,
  ]);
  const result = await composeDataPlan({
    site,
    plannerManifest,
    surfaceId: "main",
    prompt: "show my report",
    provider,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    requests.map((request) => [request.planning.stage, request.planning.attempt]),
    [
      ["initial", 0],
      ["repair", 1],
    ],
  );
  assert.equal(
    requests[1].planning.prompt,
    "show my report",
    "the visitor's words, not the repair transcript",
  );
  assert.match(requests[1].userPrompt, /rejected by deterministic validation/);
});

test("a revision and a clarification answer are each named for what they are", async () => {
  const revised = recordingProvider([goodDraft]);
  const first = await composeDataPlan({
    site,
    plannerManifest,
    surfaceId: "main",
    prompt: "show my report",
    provider: revised.provider,
  });
  await composeDataPlan({
    site,
    plannerManifest,
    surfaceId: "main",
    prompt: "make it the open one",
    previousPlan: first.plan,
    provider: revised.provider,
  });
  assert.equal(revised.requests[1].planning.stage, "revision");
  assert.equal(revised.requests[1].planning.prompt, "make it the open one");

  const answered = recordingProvider([goodDraft]);
  await composeDataPlan({
    site,
    plannerManifest,
    surfaceId: "main",
    prompt: "the open one",
    allowClarification: false,
    provider: answered.provider,
  });
  assert.equal(answered.requests[0].planning.stage, "clarification-answer");
});
