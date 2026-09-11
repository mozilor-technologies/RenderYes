import assert from "node:assert/strict";
import test from "node:test";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  matchCatalogToComponents,
} from "../dist/index.js";

/**
 * The host-visible answer to "why did my prompt return nothing" — before
 * this existed, an approved capability with no matching component was
 * simply never selectable by the planner, with no signal pointing at a
 * missing renderer as the cause.
 */
const GenericTable = defineComponent({
  id: "GenericTable",
  version: "1.0.0",
  description: "Renders any collection as a table.",
  props: defineProps({}),
  renderer: { component: "GenericTable", props: { rows: { path: "/rows" } } },
  dataSlots: { rows: { accepts: [{ shape: "collection" }] } },
});

const PinnedEntityCard = defineComponent({
  id: "PinnedEntityCard",
  version: "1.0.0",
  description: "Renders one specific host data type.",
  props: defineProps({}),
  renderer: { component: "PinnedEntityCard", props: { item: { path: "/item" } } },
  dataSlots: {
    item: { accepts: [{ dataTypeId: "AgentReport", shapes: ["entity"] }] },
  },
});

const site = defineSite({
  id: "coverage-site",
  name: "Coverage site",
  version: "1.0.0",
  catalogId: "https://example.com/renderyes/catalog.json",
  components: [GenericTable, PinnedEntityCard],
  surfaces: [
    defineSurface({
      id: "main",
      description: "Main.",
      componentIds: ["GenericTable", "PinnedEntityCard"],
      maxComponents: 2,
    }),
  ],
});

const plannerManifest = {
  schemaVersion: "1.0",
  catalogId: "example-host",
  catalogVersion: "1.0.0",
  catalogHash: "sha256:example-host",
  description: "Example host capabilities.",
  dataTypes: [
    {
      id: "AgentReport",
      version: "1.0.0",
      description: "x",
      schema: { type: "object" },
      fields: {},
    },
    {
      id: "TimeSeriesPoint",
      version: "1.0.0",
      description: "x",
      schema: { type: "object" },
      fields: {},
    },
  ],
  capabilities: [
    {
      id: "reports.list",
      version: "1.0.0",
      purpose: "List reports as a collection.",
      inputSchema: { type: "object", additionalProperties: false },
      output: { dataTypeId: "AgentReport", shape: "collection" },
      constraints: { authentication: "public" },
    },
    {
      id: "reports.get",
      version: "1.0.0",
      purpose: "Get one report.",
      inputSchema: { type: "object", additionalProperties: false },
      output: { dataTypeId: "AgentReport", shape: "entity" },
      constraints: { authentication: "public" },
    },
    {
      id: "metrics.timeseries",
      version: "1.0.0",
      purpose: "A time series with no registered renderer.",
      inputSchema: { type: "object", additionalProperties: false },
      output: { dataTypeId: "TimeSeriesPoint", shape: "time-series" },
      constraints: { authentication: "public" },
    },
  ],
  relationships: [],
};

test("reports every produced (dataTypeId, shape) with its matching components", () => {
  const coverage = matchCatalogToComponents(plannerManifest, site);
  assert.equal(coverage.length, 3);

  const reportsCollection = coverage.find(
    (c) => c.dataTypeId === "AgentReport" && c.shape === "collection",
  );
  assert.deepEqual(reportsCollection.producedByCapabilityIds, ["reports.list"]);
  assert.deepEqual(reportsCollection.matchingComponentIds, ["GenericTable"]);
  assert.equal(reportsCollection.unrenderable, false);

  const reportsEntity = coverage.find(
    (c) => c.dataTypeId === "AgentReport" && c.shape === "entity",
  );
  assert.deepEqual(reportsEntity.matchingComponentIds, ["PinnedEntityCard"]);
  assert.equal(reportsEntity.unrenderable, false);
});

test("flags a produced data type with no matching component as unrenderable, rather than dropping it", () => {
  const coverage = matchCatalogToComponents(plannerManifest, site);
  const timeSeries = coverage.find((c) => c.dataTypeId === "TimeSeriesPoint");
  assert.ok(
    timeSeries,
    "the time-series capability must still be reported, not silently dropped",
  );
  assert.deepEqual(timeSeries.producedByCapabilityIds, ["metrics.timeseries"]);
  assert.deepEqual(timeSeries.matchingComponentIds, []);
  assert.equal(timeSeries.unrenderable, true);
});

test("two capabilities producing the identical (dataTypeId, shape) are merged into one coverage row", () => {
  const manifestWithDuplicateOutput = {
    ...plannerManifest,
    capabilities: [
      ...plannerManifest.capabilities,
      {
        id: "reports.listArchived",
        version: "1.0.0",
        purpose: "List archived reports — same shape as reports.list.",
        inputSchema: { type: "object", additionalProperties: false },
        output: { dataTypeId: "AgentReport", shape: "collection" },
        constraints: { authentication: "public" },
      },
    ],
  };
  const coverage = matchCatalogToComponents(manifestWithDuplicateOutput, site);
  const merged = coverage.filter(
    (c) => c.dataTypeId === "AgentReport" && c.shape === "collection",
  );
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].producedByCapabilityIds, [
    "reports.list",
    "reports.listArchived",
  ]);
});

test("a grouped-only chart slot counts as coverage only when a producer can group", () => {
  // Chart-matches-everything used to inflate coverage: a raw collection type
  // counted as chart-renderable while the compose validator (now) rejects the
  // binding. The report reuses the same matcher, so the two cannot disagree.
  const Chart = defineComponent({
    id: "Chart",
    version: "1.0.0",
    description: "Chart over grouped data.",
    props: defineProps({}),
    renderer: { component: "Chart", props: { rows: { path: "/rows" } } },
    dataSlots: {
      rows: { accepts: [{ shape: "collection", requiresGrouping: true }] },
    },
  });
  const chartSite = defineSite({
    id: "chart-coverage-site",
    name: "Chart coverage site",
    version: "1.0.0",
    catalogId: "https://example.com/renderyes/catalog.json",
    components: [Chart],
    surfaces: [
      defineSurface({
        id: "main",
        description: "Main.",
        componentIds: ["Chart"],
        maxComponents: 1,
      }),
    ],
  });
  const dataType = (id) => ({
    id,
    version: "1.0.0",
    description: id,
    schema: { type: "object", properties: { status: { type: "string" } } },
    fields: { status: { label: "Status", semanticType: "status" } },
  });
  const capability = (id, dataTypeId, supports) => ({
    id,
    version: "1.0.0",
    purpose: id,
    inputSchema: { type: "object", additionalProperties: false },
    output: { dataTypeId, shape: "collection" },
    ...(supports ? { supports } : {}),
    constraints: { authentication: "public" },
  });
  const manifest = {
    schemaVersion: "1.0",
    catalogId: "chart-host",
    catalogVersion: "1.0.0",
    catalogHash: "sha256:chart-host",
    description: "Chart host capabilities.",
    dataTypes: [dataType("RawOrder"), dataType("GroupableOrder")],
    capabilities: [
      capability("orders.raw", "RawOrder", { filterFields: ["status"] }),
      capability("orders.groupable", "GroupableOrder", {
        groupFields: ["status"],
        aggregates: ["count"],
      }),
    ],
    relationships: [],
  };

  const coverage = matchCatalogToComponents(manifest, chartSite);
  const byType = Object.fromEntries(coverage.map((entry) => [entry.dataTypeId, entry]));
  // No producer of RawOrder can serve a grouped request, so the chart is not
  // a match and the type is honestly unrenderable on this site.
  assert.deepEqual(byType.RawOrder.matchingComponentIds, []);
  assert.equal(byType.RawOrder.unrenderable, true);
  // GroupableOrder's producer supports grouping, so a legal grouped plan
  // exists and the chart counts.
  assert.deepEqual(byType.GroupableOrder.matchingComponentIds, ["Chart"]);
  assert.equal(byType.GroupableOrder.unrenderable, false);
});
