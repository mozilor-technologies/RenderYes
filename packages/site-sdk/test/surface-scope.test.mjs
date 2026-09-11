import assert from "node:assert/strict";
import test from "node:test";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  scopeManifestToSurface,
} from "../dist/index.js";

/**
 * Components were already scoped by `surface.componentIds`, but capabilities
 * were not: every approved operation entered every surface's planner contract.
 * These tests pin the four ways a capability can qualify — and in particular
 * that a join's right-hand capability survives, since its output is never bound
 * to a slot and a naive slot-acceptance filter would silently drop it.
 */

const ReportTable = defineComponent({
  id: "ReportTable",
  version: "1.0.0",
  description: "Renders AgentReport collections.",
  props: defineProps({}),
  renderer: { component: "ReportTable", props: { rows: { path: "/rows" } } },
  dataSlots: {
    rows: { accepts: [{ dataTypeId: "AgentReport", shapes: ["collection"] }] },
  },
});

const InvoiceCard = defineComponent({
  id: "InvoiceCard",
  version: "1.0.0",
  description: "Renders one Invoice.",
  props: defineProps({}),
  renderer: { component: "InvoiceCard", props: { item: { path: "/item" } } },
  dataSlots: {
    item: { accepts: [{ dataTypeId: "Invoice", shapes: ["entity"] }] },
  },
});

const site = defineSite({
  id: "scope-site",
  name: "Scope site",
  version: "1.0.0",
  catalogId: "https://example.com/renderyes/catalog.json",
  components: [ReportTable, InvoiceCard],
  surfaces: [
    defineSurface({
      id: "reports",
      description: "Reports only.",
      componentIds: ["ReportTable"],
    }),
    defineSurface({
      id: "everything",
      description: "Both components.",
      componentIds: ["ReportTable", "InvoiceCard"],
      maxComponents: 2,
    }),
  ],
});

const dataType = (id) => ({
  id,
  version: "1.0.0",
  description: id,
  schema: { type: "object" },
  fields: {},
});

const capability = (id, dataTypeId, shape, extra = {}) => ({
  id,
  version: "1.0.0",
  purpose: id,
  inputSchema: { type: "object", additionalProperties: false },
  output: { dataTypeId, shape },
  constraints: { authentication: "public" },
  ...extra,
});

const manifest = {
  schemaVersion: "1.0",
  catalogId: "example-host",
  catalogVersion: "1.0.0",
  catalogHash: "sha256:example-host",
  description: "Example host capabilities.",
  dataTypes: [dataType("AgentReport"), dataType("Invoice"), dataType("Metric")],
  capabilities: [
    capability("reports.list", "AgentReport", "collection"),
    capability("invoices.get", "Invoice", "entity"),
    capability("metrics.timeseries", "Metric", "time-series"),
  ],
  relationships: [],
};

test("excludes capabilities no component on the surface can accept", () => {
  const scope = scopeManifestToSurface(manifest, site, "reports");
  assert.deepEqual(scope.capabilityIds, ["reports.list"]);
  assert.deepEqual(scope.excludedCapabilityIds, ["invoices.get", "metrics.timeseries"]);
});

test("a broader surface widens the scope without any host configuration", () => {
  const scope = scopeManifestToSurface(manifest, site, "everything");
  assert.deepEqual(scope.capabilityIds, ["invoices.get", "reports.list"]);
  // Still excluded: nothing renders a time series.
  assert.deepEqual(scope.excludedCapabilityIds, ["metrics.timeseries"]);
});

test("includes a capability only usable as a composition input", () => {
  // Its own output is `search-results`, which no slot accepts. But it advertises
  // a set operation, and a composition delivers a collection — which ReportTable
  // does accept.
  const withComposable = {
    ...manifest,
    capabilities: [
      ...manifest.capabilities,
      capability("reports.search", "AgentReport", "search-results", {
        supports: { setOperations: ["union"] },
      }),
    ],
  };
  const scope = scopeManifestToSurface(withComposable, site, "reports");
  assert.ok(
    scope.capabilityIds.includes("reports.search"),
    "a composition-eligible capability must stay in scope even though no slot accepts its own shape",
  );
});

test("keeps a join's right-hand capability, whose output is never bound to a slot", () => {
  // This is the case a naive slot-acceptance filter breaks. `Invoice` as an
  // entity is not accepted by anything on the `reports` surface, yet the join
  // reports -> invoice is legal and needs an Invoice-producing request.
  const withRelationship = {
    ...manifest,
    relationships: [
      {
        id: "report.invoice",
        description: "The invoice a report belongs to.",
        fromDataTypeId: "AgentReport",
        toDataTypeId: "Invoice",
        cardinality: "many-to-one",
      },
    ],
  };
  const scope = scopeManifestToSurface(withRelationship, site, "reports");
  assert.deepEqual(scope.capabilityIds, ["invoices.get", "reports.list"]);
  assert.deepEqual(scope.excludedCapabilityIds, ["metrics.timeseries"]);
});

test("does not keep a join right side when the relationship's left side is unrenderable", () => {
  // Relationship starts at Metric, which nothing on this surface can render as
  // a collection, so no join can be formed and Invoice earns no reprieve.
  const unusableRelationship = {
    ...manifest,
    relationships: [
      {
        id: "metric.invoice",
        description: "Unusable here.",
        fromDataTypeId: "Metric",
        toDataTypeId: "Invoice",
        cardinality: "many-to-one",
      },
    ],
  };
  const scope = scopeManifestToSurface(unusableRelationship, site, "reports");
  assert.deepEqual(scope.capabilityIds, ["reports.list"]);
});

test("ignores a many-to-many relationship, matching the to-one-only runtime", () => {
  const manyToMany = {
    ...manifest,
    relationships: [
      {
        id: "report.invoices",
        description: "Not executable as a join.",
        fromDataTypeId: "AgentReport",
        toDataTypeId: "Invoice",
        cardinality: "many-to-many",
      },
    ],
  };
  const scope = scopeManifestToSurface(manyToMany, site, "reports");
  assert.deepEqual(scope.capabilityIds, ["reports.list"]);
});

test("throws on an unknown surface rather than silently scoping to nothing", () => {
  assert.throws(
    () => scopeManifestToSurface(manifest, site, "nope"),
    /Unknown site surface: nope/,
  );
});

/**
 * A themeless site round-trips. `defineSite` never validated a theme and the
 * runtime always worked without one, but `SiteDefinition.theme` was typed as
 * required — a mismatch invisible here because every test in this workspace is
 * `.mjs`. It surfaced only when a TypeScript host outside the workspace compiled
 * against the published `.d.ts`.
 */
test("registers and round-trips a site with no theme", async () => {
  const { toSiteManifest, defineSiteFromManifest, themeToCssVariables } =
    await import("../dist/index.js");

  const themeless = defineSite({
    id: "themeless",
    name: "Themeless",
    version: "1.0.0",
    catalogId: "https://example.com/renderyes/catalog.json",
    components: [ReportTable],
    surfaces: [
      defineSurface({
        id: "only",
        description: "Only surface.",
        componentIds: ["ReportTable"],
      }),
    ],
  });

  assert.equal(themeless.theme, undefined);
  assert.deepEqual(themeToCssVariables(themeless.theme), {});

  const siteManifest = toSiteManifest(themeless);
  assert.equal(
    "theme" in siteManifest,
    false,
    "no theme key at all, rather than an explicit undefined",
  );

  // Must survive the JSON hop a host makes when publishing a UI catalog.
  const restored = defineSiteFromManifest(JSON.parse(JSON.stringify(siteManifest)));
  assert.equal(restored.theme, undefined);
  assert.equal(restored.getComponent("ReportTable").id, "ReportTable");

  // And surface scoping still works against it.
  assert.deepEqual(scopeManifestToSurface(manifest, themeless, "only").capabilityIds, [
    "reports.list",
  ]);
});

test("reports what the excluded capabilities produce, one entry per type and shape", () => {
  // The scope always knew this and dropped it, so the planner saw a manifest
  // with the capability simply absent and named the catalog as the blocker.
  const scope = scopeManifestToSurface(manifest, site, "reports");
  assert.deepEqual(scope.unrenderableOutputs, [
    { dataTypeId: "Invoice", shape: "entity" },
    { dataTypeId: "Metric", shape: "time-series" },
  ]);
});

test("two excluded capabilities producing the same pair collapse to one entry", () => {
  // What reaches the prompt is what cannot be displayed, not how many
  // capabilities produce it — the second copy would be pure contract cost.
  const withDuplicate = {
    ...manifest,
    capabilities: [
      ...manifest.capabilities,
      capability("metrics.other", "Metric", "time-series"),
    ],
  };
  const scope = scopeManifestToSurface(withDuplicate, site, "reports");
  assert.deepEqual(scope.excludedCapabilityIds, [
    "invoices.get",
    "metrics.other",
    "metrics.timeseries",
  ]);
  assert.deepEqual(scope.unrenderableOutputs, [
    { dataTypeId: "Invoice", shape: "entity" },
    { dataTypeId: "Metric", shape: "time-series" },
  ]);
});

test("a surface that renders everything reports nothing unrenderable", () => {
  const renderable = {
    ...manifest,
    capabilities: manifest.capabilities.filter(
      (entry) => entry.id === "reports.list",
    ),
  };
  const scope = scopeManifestToSurface(renderable, site, "reports");
  assert.deepEqual(scope.excludedCapabilityIds, []);
  assert.deepEqual(scope.unrenderableOutputs, []);
});
