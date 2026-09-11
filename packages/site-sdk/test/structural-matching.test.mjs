import assert from "node:assert/strict";
import test from "node:test";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  validatePlanDataBindings,
} from "../dist/index.js";

/**
 * Structural acceptance ({shape, requires?, minFields?}) lets a component
 * accept ANY host's data type that satisfies a shape/semantic requirement,
 * instead of naming one host-specific `dataTypeId`. This is what makes a
 * prebuilt, catalog-agnostic component library possible at all.
 */
const GenericTable = defineComponent({
  id: "GenericTable",
  version: "1.0.0",
  description: "Renders any collection of records as a sortable table.",
  props: defineProps({}),
  renderer: {
    component: "GenericTable",
    props: { rows: { path: "/rows" } },
  },
  dataSlots: {
    rows: { accepts: [{ shape: "collection" }] },
  },
});

const MoneyCard = defineComponent({
  id: "MoneyCard",
  version: "1.0.0",
  description: "Renders any entity that has at least one money field.",
  props: defineProps({}),
  renderer: {
    component: "MoneyCard",
    props: { item: { path: "/item" } },
  },
  dataSlots: {
    item: {
      accepts: [{ shape: "entity", requires: [{ semanticType: "money" }] }],
    },
  },
});

const site = defineSite({
  id: "generic-site",
  name: "Generic site",
  version: "1.0.0",
  catalogId: "https://example.com/renderyes/catalog.json",
  components: [GenericTable, MoneyCard],
  surfaces: [
    defineSurface({
      id: "main",
      description: "Main surface.",
      componentIds: ["GenericTable", "MoneyCard"],
      maxComponents: 2,
    }),
  ],
});

function plannerManifestWith(dataType, output) {
  return {
    schemaVersion: "1.0",
    catalogId: "any-host",
    catalogVersion: "1.0.0",
    catalogHash: "sha256:any-host",
    description: "Any host's capabilities.",
    dataTypes: [dataType],
    capabilities: [
      {
        id: "any.list",
        version: "1.0.0",
        purpose: "List anything.",
        inputSchema: { type: "object", additionalProperties: false },
        output,
        constraints: { authentication: "public" },
      },
    ],
    relationships: [],
  };
}

function planFor(componentId, nodeId) {
  return {
    schemaVersion: "3.1",
    planId: "structural-plan",
    siteId: site.id,
    catalog: {
      id: site.catalog.id,
      version: site.catalog.version,
      fingerprint: site.catalog.fingerprint,
    },
    dataCatalog: { id: "any-host", version: "1.0.0", hash: "sha256:any-host" },
    dataRequests: [{ requestId: "r1", capabilityId: "any.list", params: {} }],
    surfaces: [
      {
        id: "main",
        nodes: [
          {
            nodeId,
            componentId,
            props: {},
            dataBindings: {
              [componentId === "GenericTable" ? "rows" : "item"]: { requestId: "r1" },
            },
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

test("a structurally-accepting component matches a data type it has never heard of, by shape alone", () => {
  // "WidgetOrder" is a data type this component's author never saw — the
  // whole point of structural acceptance.
  const plannerManifest = plannerManifestWith(
    {
      id: "WidgetOrder",
      version: "1.0.0",
      description: "A widget order.",
      schema: { type: "object", properties: { id: { type: "string" } } },
      fields: { id: { label: "Order id", semanticType: "identifier" } },
    },
    { dataTypeId: "WidgetOrder", shape: "collection" },
  );
  const result = validatePlanDataBindings(
    site,
    planFor("GenericTable", "table-1"),
    plannerManifest,
  );
  assert.equal(result.ok, true);
});

test("structural acceptance rejects a shape mismatch with a specific reason", () => {
  const plannerManifest = plannerManifestWith(
    {
      id: "WidgetOrder",
      version: "1.0.0",
      description: "A widget order.",
      schema: { type: "object" },
      fields: {},
    },
    { dataTypeId: "WidgetOrder", shape: "entity" },
  );
  const result = validatePlanDataBindings(
    site,
    planFor("GenericTable", "table-1"),
    plannerManifest,
  );
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /expects shape collection, got entity/);
});

test("requires rejects a data type lacking the needed semantic field", () => {
  const plannerManifest = plannerManifestWith(
    {
      id: "Widget",
      version: "1.0.0",
      description: "A widget with no money field.",
      schema: { type: "object" },
      fields: { name: { label: "Name", semanticType: "text" } },
    },
    { dataTypeId: "Widget", shape: "entity" },
  );
  const result = validatePlanDataBindings(
    site,
    planFor("MoneyCard", "card-1"),
    plannerManifest,
  );
  assert.equal(result.ok, false);
  assert.match(result.issues[0].message, /needs a money field; Widget has none/);
});

test("requires accepts a data type that declares the needed semantic field", () => {
  const plannerManifest = plannerManifestWith(
    {
      id: "Invoice",
      version: "1.0.0",
      description: "An invoice with an amount.",
      schema: { type: "object" },
      fields: {
        amount: { label: "Amount", semanticType: "money" },
      },
    },
    { dataTypeId: "Invoice", shape: "entity" },
  );
  const result = validatePlanDataBindings(
    site,
    planFor("MoneyCard", "card-1"),
    plannerManifest,
  );
  assert.equal(result.ok, true);
});

test("nominal acceptance (dataTypeId + shapes) is unaffected and still works", () => {
  const PinnedCard = defineComponent({
    id: "PinnedCard",
    version: "1.0.0",
    description: "Pinned to one host-specific data type.",
    props: defineProps({}),
    renderer: { component: "PinnedCard", props: { item: { path: "/item" } } },
    dataSlots: {
      item: { accepts: [{ dataTypeId: "AgentReport", shapes: ["entity"] }] },
    },
  });
  const pinnedSite = defineSite({
    id: "pinned-site",
    name: "Pinned site",
    version: "1.0.0",
    catalogId: "https://example.com/renderyes/catalog.json",
    components: [PinnedCard],
    surfaces: [
      defineSurface({
        id: "main",
        description: "Main.",
        componentIds: ["PinnedCard"],
        maxComponents: 1,
      }),
    ],
  });
  const plannerManifest = plannerManifestWith(
    {
      id: "AgentReport",
      version: "1.0.0",
      description: "An agent report.",
      schema: { type: "object" },
      fields: {},
    },
    { dataTypeId: "AgentReport", shape: "entity" },
  );
  const plan = {
    schemaVersion: "3.1",
    planId: "nominal-plan",
    siteId: pinnedSite.id,
    catalog: {
      id: pinnedSite.catalog.id,
      version: pinnedSite.catalog.version,
      fingerprint: pinnedSite.catalog.fingerprint,
    },
    dataCatalog: { id: "any-host", version: "1.0.0", hash: "sha256:any-host" },
    dataRequests: [{ requestId: "r1", capabilityId: "any.list", params: {} }],
    surfaces: [
      {
        id: "main",
        nodes: [
          {
            nodeId: "card-1",
            componentId: "PinnedCard",
            props: {},
            dataBindings: { item: { requestId: "r1" } },
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
  const result = validatePlanDataBindings(pinnedSite, plan, plannerManifest);
  assert.equal(result.ok, true);
});

test("defineComponent rejects a structural acceptance with an unknown shape", () => {
  assert.throws(
    () =>
      defineComponent({
        id: "BadShape",
        version: "1.0.0",
        description: "x",
        props: defineProps({}),
        renderer: { component: "BadShape", props: { rows: { path: "/rows" } } },
        dataSlots: { rows: { accepts: [{ shape: "not-a-real-shape" }] } },
      }),
    /unknown result shape/,
  );
});

test("defineComponent rejects a structural acceptance with an unknown semantic type", () => {
  assert.throws(
    () =>
      defineComponent({
        id: "BadSemantic",
        version: "1.0.0",
        description: "x",
        props: defineProps({}),
        renderer: { component: "BadSemantic", props: { rows: { path: "/rows" } } },
        dataSlots: {
          rows: {
            accepts: [
              { shape: "collection", requires: [{ semanticType: "not-a-real-type" }] },
            ],
          },
        },
      }),
    /unknown semantic type/,
  );
});

test("defineComponent rejects a non-positive-integer minFields", () => {
  assert.throws(
    () =>
      defineComponent({
        id: "BadMinFields",
        version: "1.0.0",
        description: "x",
        props: defineProps({}),
        renderer: { component: "BadMinFields", props: { rows: { path: "/rows" } } },
        dataSlots: { rows: { accepts: [{ shape: "collection", minFields: 0 }] } },
      }),
    /minFields must be a positive integer/,
  );
});

/**
 * `requiresGrouping` — the acceptance flag that stopped raw order rows from
 * binding to charts. A grouped-only slot binds a collection only when the
 * feeding request grouped and aggregated it; a time-series output qualifies
 * as already aggregated.
 */
const GroupedChart = defineComponent({
  id: "GroupedChart",
  version: "1.0.0",
  description: "Chart over grouped data.",
  props: defineProps({}),
  renderer: {
    component: "GroupedChart",
    props: { rows: { path: "/rows" } },
  },
  dataSlots: {
    rows: {
      accepts: [{ shape: "collection", requiresGrouping: true }, { shape: "time-series" }],
    },
  },
});

const chartSite = defineSite({
  id: "chart-site",
  name: "Chart site",
  version: "1.0.0",
  catalogId: "https://example.com/renderyes/catalog.json",
  components: [GroupedChart],
  surfaces: [
    defineSurface({
      id: "main",
      description: "Main surface.",
      componentIds: ["GroupedChart"],
      maxComponents: 1,
    }),
  ],
});

function chartPlan(query) {
  return {
    schemaVersion: "3.1",
    planId: "chart-plan",
    siteId: chartSite.id,
    catalog: {
      id: chartSite.catalog.id,
      version: chartSite.catalog.version,
      fingerprint: chartSite.catalog.fingerprint,
    },
    dataCatalog: { id: "any-host", version: "1.0.0", hash: "sha256:any-host" },
    dataRequests: [
      {
        requestId: "r1",
        capabilityId: "any.list",
        params: {},
        ...(query ? { query } : {}),
      },
    ],
    surfaces: [
      {
        id: "main",
        nodes: [
          {
            nodeId: "chart-1",
            componentId: "GroupedChart",
            props: {},
            dataBindings: { rows: { requestId: "r1" } },
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

const orderCollectionManifest = plannerManifestWith(
  {
    id: "WidgetOrder",
    version: "1.0.0",
    description: "A widget order.",
    schema: { type: "object", properties: { status: { type: "string" } } },
    fields: { status: { label: "Status", semanticType: "status" } },
  },
  { dataTypeId: "WidgetOrder", shape: "collection" },
);

test("an ungrouped collection fails to bind a grouped-only chart slot at validation", () => {
  // The measured failure: 100 raw order rows drawn as a "revenue trend". The
  // plan must fail where unsupported plans fail — validation — not at render.
  const result = validatePlanDataBindings(
    chartSite,
    chartPlan(undefined),
    orderCollectionManifest,
  );
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "incompatible-data-slot");
  assert.match(result.issues[0].message, /requires grouped data/);
});

test("a request that groups and aggregates binds the same chart slot", () => {
  const result = validatePlanDataBindings(
    chartSite,
    chartPlan({
      groupBy: ["status"],
      aggregates: [{ op: "count", as: "n" }],
    }),
    orderCollectionManifest,
  );
  assert.equal(result.ok, true);
});

test("a time-series output satisfies the grouping requirement inherently", () => {
  const timeSeriesManifest = plannerManifestWith(
    {
      id: "SignupSeries",
      version: "1.0.0",
      description: "Signups over time.",
      schema: { type: "object", properties: { dates: { type: "array" } } },
      fields: { dates: { label: "Dates", semanticType: "date" } },
    },
    { dataTypeId: "SignupSeries", shape: "time-series" },
  );
  const result = validatePlanDataBindings(
    chartSite,
    chartPlan(undefined),
    timeSeriesManifest,
  );
  assert.equal(result.ok, true);
});
