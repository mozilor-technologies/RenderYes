import assert from "node:assert/strict";
import test from "node:test";
import {
  compilePlanDataSurfaceMessages,
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  field,
  projectPlanDataModel,
  validatePlanDataBindings,
} from "../dist/index.js";

/**
 * Two nodes of the SAME registered component, bound to DIFFERENT requests
 * (e.g. "urgent tickets" vs "low priority tickets" side by side), used to
 * throw at projection time even though validation passed — because the
 * write path was resolved from the *component* (static), not the *node*
 * (per-instance).
 */
const TicketQueue = defineComponent({
  id: "TicketQueue",
  version: "1.0.0",
  description: "An approved support ticket queue.",
  props: defineProps({
    density: field.enum(["comfortable", "compact"], { default: "comfortable" }),
  }),
  renderer: {
    component: "ResponsiveDataTable",
    props: {
      rows: { path: "/tickets/rows" },
      state: { path: "/tickets/state" },
    },
  },
  dataSlots: {
    rows: { accepts: [{ dataTypeId: "SupportTicket", shapes: ["search-results"] }] },
  },
});

const twoInstanceSite = defineSite({
  id: "support-ops-two-instance",
  name: "Support operations",
  version: "1.0.0",
  catalogId: "https://support.example.com/renderyes/catalog.json",
  components: [TicketQueue],
  surfaces: [
    defineSurface({
      id: "support-main",
      description: "Main support workspace.",
      componentIds: ["TicketQueue"],
      maxComponents: 2,
    }),
  ],
});

const plannerManifest = {
  schemaVersion: "1.0",
  catalogId: "support-data",
  catalogVersion: "0.1.0",
  catalogHash: "sha256:support-data",
  description: "Support data capabilities.",
  dataTypes: [],
  capabilities: [
    {
      id: "tickets.search",
      version: "1.0.0",
      purpose: "Find support tickets.",
      inputSchema: { type: "object", additionalProperties: false },
      output: { dataTypeId: "SupportTicket", shape: "search-results" },
      supports: { filterFields: ["priority"] },
      constraints: { authentication: "session", maximumRows: 50 },
    },
  ],
  relationships: [],
};

function twoInstancePlan() {
  return {
    schemaVersion: "3.1",
    planId: "support-data-plan",
    siteId: twoInstanceSite.id,
    catalog: {
      id: twoInstanceSite.catalog.id,
      version: twoInstanceSite.catalog.version,
      fingerprint: twoInstanceSite.catalog.fingerprint,
    },
    dataCatalog: {
      id: plannerManifest.catalogId,
      version: plannerManifest.catalogVersion,
      hash: plannerManifest.catalogHash,
    },
    dataRequests: [
      {
        requestId: "urgent",
        capabilityId: "tickets.search",
        params: { priority: "urgent" },
      },
      { requestId: "low", capabilityId: "tickets.search", params: { priority: "low" } },
    ],
    surfaces: [
      {
        id: "support-main",
        nodes: [
          {
            nodeId: "queue-urgent",
            componentId: "TicketQueue",
            props: {},
            dataBindings: { rows: { requestId: "urgent" } },
          },
          {
            nodeId: "queue-low",
            componentId: "TicketQueue",
            props: {},
            dataBindings: { rows: { requestId: "low" } },
          },
        ],
      },
    ],
    generation: {
      providerId: "hand-authored",
      modelId: "none",
      createdAt: "2026-07-28T00:00:00.000Z",
      repairCount: 0,
    },
  };
}

const provenance = {
  sources: [{ sourceId: "support-api" }],
  freshness: { asOf: "2026-07-28T00:00:00.000Z" },
};

function executedDataFor(plan) {
  return {
    planId: plan.planId,
    results: {
      urgent: { ok: true, data: [{ ticket: "SUP-1", priority: "Urgent" }], provenance },
      low: { ok: true, data: [{ ticket: "SUP-9", priority: "Low" }], provenance },
    },
  };
}

test("defineComponent rejects two renderer props bound to the identical path", () => {
  assert.throws(
    () =>
      defineComponent({
        id: "BrokenCard",
        version: "1.0.0",
        description: "Two props pointed at the same path.",
        props: defineProps({}),
        renderer: {
          component: "BrokenCard",
          props: {
            rows: { path: "/x" },
            state: { path: "/x" },
          },
        },
        dataSlots: {
          rows: { accepts: [{ dataTypeId: "SupportTicket", shapes: ["collection"] }] },
        },
      }),
    /renderer props "rows" and "state" both bind path \/x/,
  );
});

test("validation accepts two instances of one component bound to different requests", () => {
  const result = validatePlanDataBindings(
    twoInstanceSite,
    twoInstancePlan(),
    plannerManifest,
  );
  assert.equal(result.ok, true);
});

test("projecting two instances of one component no longer collides, and each keeps its own data", () => {
  const plan = twoInstancePlan();
  const projected = projectPlanDataModel(twoInstanceSite, {
    plan,
    plannerManifest,
    executedData: executedDataFor(plan),
    baseDataModel: {},
    scopeDataPathsByInstance: true,
  });

  assert.deepEqual(projected["queue-urgent"].tickets.rows, [
    { ticket: "SUP-1", priority: "Urgent" },
  ]);
  assert.deepEqual(projected["queue-low"].tickets.rows, [
    { ticket: "SUP-9", priority: "Low" },
  ]);
  assert.equal(projected["queue-urgent"].tickets.state, "ready");
  assert.equal(projected["queue-low"].tickets.state, "ready");
});

test("two instances bound to the SAME request still both project without conflict", () => {
  const plan = twoInstancePlan();
  plan.surfaces[0].nodes[1].dataBindings = { rows: { requestId: "urgent" } };
  const projected = projectPlanDataModel(twoInstanceSite, {
    plan,
    plannerManifest,
    executedData: executedDataFor(plan),
    baseDataModel: {},
    scopeDataPathsByInstance: true,
  });
  assert.deepEqual(projected["queue-urgent"].tickets.rows, [
    { ticket: "SUP-1", priority: "Urgent" },
  ]);
  assert.deepEqual(projected["queue-low"].tickets.rows, [
    { ticket: "SUP-1", priority: "Urgent" },
  ]);
});

test("compiled A2UI component paths agree exactly with the projected data model paths", () => {
  const plan = twoInstancePlan();
  const messages = compilePlanDataSurfaceMessages(twoInstanceSite, {
    plan,
    plannerManifest,
    executedData: executedDataFor(plan),
    baseDataModel: {},
    surfaceId: "support-main",
    a2uiCatalogId: "support-ops-two-instance:ui",
  });

  const updateComponents = messages.find((message) => message.updateComponents);
  const updateDataModel = messages.find((message) => message.updateDataModel);
  const emittedPaths = updateComponents.updateComponents.components
    .filter((component) => component.id !== "root")
    .flatMap((component) => [component.rows.path, component.state.path]);

  for (const path of emittedPaths) {
    const segments = path.slice(1).split("/");
    let cursor = updateDataModel.updateDataModel.value;
    for (const segment of segments) {
      assert.notEqual(
        cursor,
        undefined,
        `path ${path} does not exist in the projected data model`,
      );
      cursor = cursor[segment];
    }
    assert.notEqual(cursor, undefined, `path ${path} resolves to undefined`);
  }
});
