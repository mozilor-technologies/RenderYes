import assert from "node:assert/strict";
import test from "node:test";
import { createPlanContract } from "../dist/index.js";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  field,
  scopeManifestToSurface,
  validatePlanDataBindings,
} from "@renderyes/site-sdk";

/**
 * Two things are pinned here:
 *
 * - The contract advertises only capabilities this surface can bind. Components
 *   were always scoped by `surface.componentIds`; capabilities were not, so
 *   every approved operation entered every surface's contract.
 * - The system prompt no longer restates what the enforced JSON Schema already
 *   carries. `props.jsonSchema` was being serialized into the prompt *and*
 *   supplied as the structured-output constraint.
 */

const ReportTable = defineComponent({
  id: "ReportTable",
  version: "1.0.0",
  description: "Shows approved reports.",
  props: defineProps({
    density: field.enum(["comfortable", "compact"], { default: "comfortable" }),
  }),
  renderer: {
    component: "ResponsiveDataTable",
    props: { rows: { path: "/reports/rows" } },
  },
  dataSlots: {
    rows: {
      accepts: [{ dataTypeId: "AgentReport", shapes: ["collection"] }],
    },
  },
});

const site = defineSite({
  id: "scope-demo",
  name: "Scope demo",
  version: "1.0.0",
  catalogId: "scope-demo-components",
  components: [ReportTable],
  surfaces: [
    defineSurface({
      id: "reports",
      description: "Report results.",
      componentIds: ["ReportTable"],
      maxComponents: 1,
    }),
  ],
});

const dataType = (id) => ({
  id,
  version: "1.0.0",
  description: id,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { id: { type: "string" } },
  },
  fields: { id: { label: "ID", semanticType: "identifier" } },
});

const manifest = {
  schemaVersion: "1.0",
  catalogId: "scope-data",
  catalogVersion: "1.0.0",
  catalogHash: "sha256:scope-data",
  description: "Scope demo capabilities.",
  dataTypes: [dataType("AgentReport"), dataType("Metric")],
  capabilities: [
    {
      id: "reports.list",
      version: "1.0.0",
      purpose: "List approved reports.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      output: { dataTypeId: "AgentReport", shape: "collection" },
      supports: { filterFields: ["id"], sortFields: ["id"] },
      constraints: { authentication: "session", maximumRows: 20 },
    },
    {
      id: "metrics.timeseries",
      version: "1.0.0",
      purpose: "A time series nothing on this surface renders.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      output: { dataTypeId: "Metric", shape: "time-series" },
      constraints: { authentication: "session" },
    },
  ],
  relationships: [],
};

test("advertises only the capabilities this surface can bind", () => {
  const contract = createPlanContract(site, manifest, { surfaceId: "reports" });
  assert.deepEqual(contract.capabilityIds, ["reports.list"]);
  assert.doesNotMatch(
    contract.systemPrompt,
    /metrics\.timeseries/,
    "an unbindable capability must not reach the prompt at all",
  );
  const requestVariants =
    contract.jsonSchema.oneOf[0].properties.dataRequests.items.anyOf;
  assert.equal(requestVariants.length, 1);
  assert.equal(requestVariants[0].properties.capabilityId.const, "reports.list");
});

test("scopeCapabilitiesToSurface: false restores the whole manifest for diagnosis", () => {
  const contract = createPlanContract(site, manifest, {
    surfaceId: "reports",
    scopeCapabilitiesToSurface: false,
  });
  assert.deepEqual(contract.capabilityIds, ["metrics.timeseries", "reports.list"]);
  assert.match(contract.systemPrompt, /metrics\.timeseries/);
});

test("states slot acceptance, which no JSON Schema can express", () => {
  const contract = createPlanContract(site, manifest, { surfaceId: "reports" });
  // The schema can only say a binding is `{ requestId }`. That the requestId
  // must name a capability producing AgentReport as a collection exists nowhere
  // in it, so the model has to be told here.
  assert.match(
    contract.systemPrompt,
    /data slot "rows" accepts AgentReport as collection/,
  );
  assert.match(contract.systemPrompt, /- ReportTable: Shows approved reports\./);
});

test("does not restate the component props schema the model is already constrained by", () => {
  const contract = createPlanContract(site, manifest, { surfaceId: "reports" });
  // The prop *name* stays (cheap, and useful for planning); its schema does not.
  assert.match(contract.systemPrompt, /props: density/);
  assert.doesNotMatch(
    contract.systemPrompt,
    /"jsonSchema"/,
    "props.jsonSchema is supplied as the structured-output constraint; restating it is paid for twice",
  );
  // But it is still enforced.
  const nodeSchema = contract.jsonSchema.oneOf[0].properties.nodes.items.oneOf[0];
  assert.deepEqual(nodeSchema.properties.props.properties.density.enum, [
    "comfortable",
    "compact",
  ]);
});

test("drops query capabilities from the prompt that the request schema already encodes", () => {
  const contract = createPlanContract(site, manifest, { surfaceId: "reports" });
  // filterFields/sortFields/maximumRows became enums and bounds in the schema.
  assert.doesNotMatch(contract.systemPrompt, /filterFields|sortFields/);
  const query =
    contract.jsonSchema.oneOf[0].properties.dataRequests.items.anyOf[0].properties.query;
  assert.deepEqual(query.properties.sort.items.properties.field.enum, ["id"]);
  assert.equal(query.properties.limit.maximum, 20);
});

test("keeps setOperations in the prompt, which the per-capability schema cannot state", () => {
  const composable = {
    ...manifest,
    capabilities: manifest.capabilities.map((capability) =>
      capability.id === "reports.list"
        ? {
            ...capability,
            supports: { ...capability.supports, setOperations: ["union"] },
          }
        : capability,
    ),
  };
  const contract = createPlanContract(site, composable, { surfaceId: "reports" });
  // The composition schema advertises one global operation enum, so *which*
  // capability supports union exists only in the prompt.
  assert.match(contract.systemPrompt, /setOperations/);
});

test("still leaks no renderer path, endpoint, or trusted context", () => {
  const contract = createPlanContract(site, manifest, { surfaceId: "reports" });
  const serialized = JSON.stringify(contract);
  assert.doesNotMatch(serialized, /reports\/rows/);
  assert.doesNotMatch(serialized, /ResponsiveDataTable/);
});

/** Every object schema reachable in the contract, with the path that reached it. */
function objectSchemas(schema, path = "$", found = []) {
  if (!schema || typeof schema !== "object") return found;
  if (Array.isArray(schema)) {
    schema.forEach((entry, index) => objectSchemas(entry, `${path}[${index}]`, found));
    return found;
  }
  if (schema.type === "object" || schema.properties !== undefined) {
    found.push({ path, schema });
  }
  for (const [key, value] of Object.entries(schema)) {
    if (value && typeof value === "object") objectSchemas(value, `${path}.${key}`, found);
  }
  return found;
}

test("every object in the generated contract is closed", () => {
  // This is the first of the three barriers against untrusted provider output,
  // and it had no test: flipping all 14 `additionalProperties: false` in
  // contract.ts to `true` left the whole suite green. It is also the schema sent
  // to the model as its decoding constraint, so an open object is both a
  // validation hole and a wider space for the model to wander into.
  const contract = createPlanContract(site, manifest, { surfaceId: "reports" });
  const open = objectSchemas(contract.jsonSchema)
    .filter(({ schema }) => schema.additionalProperties !== false)
    .map(({ path }) => path);

  assert.deepEqual(open, [], `these object schemas are not closed: ${open.join(", ")}`);
});

test("the contract is closed with the clarification branch omitted too", () => {
  // The branch is conditional, so closure has to hold for both shapes of the
  // contract — an answering compose is served the no-ask schema.
  const contract = createPlanContract(site, manifest, {
    surfaceId: "reports",
    allowClarification: false,
  });
  const open = objectSchemas(contract.jsonSchema)
    .filter(({ schema }) => schema.additionalProperties !== false)
    .map(({ path }) => path);

  assert.deepEqual(open, [], `these object schemas are not closed: ${open.join(", ")}`);
});

/**
 * A metric capability, and a component that accepts one, both reach the
 * contract.
 *
 * F9 made the metric shape *producible* from a GraphQL catalog and proved the
 * planner could select the card — and then nothing pinned the seam, so "metric
 * components are unreachable" stayed a live suspicion through two evaluations.
 * Measured here instead: advertised capability, prompt mention, request
 * variant, node variant. If a metric capability ever stops reaching a surface
 * whose component accepts it, this is where that becomes a failing test rather
 * than a report.
 */
const MetricCard = defineComponent({
  id: "MetricCard",
  version: "1.0.0",
  description: "Summary metric panel. One figure as a labeled stat tile.",
  props: defineProps({ heading: field.string({ default: "Summary" }) }),
  renderer: { component: "MetricCard", props: { metric: { path: "/metric" } } },
  // Structural, not nominal: the card takes any metric, from any catalog.
  dataSlots: { metric: { accepts: [{ shape: "metric" }] } },
});

const metricSite = defineSite({
  id: "metric-demo",
  name: "Metric demo",
  version: "1.0.0",
  catalogId: "metric-demo-components",
  components: [ReportTable, MetricCard],
  surfaces: [
    defineSurface({
      id: "overview",
      description: "Reports and one headline figure.",
      componentIds: ["ReportTable", "MetricCard"],
    }),
  ],
});

const metricManifest = {
  ...manifest,
  dataTypes: [...manifest.dataTypes, dataType("Total")],
  capabilities: [
    ...manifest.capabilities,
    {
      id: "reports.total",
      version: "1.0.0",
      purpose: "How many reports there are in total.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      output: { dataTypeId: "Total", shape: "metric" },
      constraints: { authentication: "session" },
    },
  ],
};

test("a metric capability and a metric-accepting component both reach the contract", () => {
  const contract = createPlanContract(metricSite, metricManifest, {
    surfaceId: "overview",
  });

  assert.ok(
    contract.capabilityIds.includes("reports.total"),
    "the metric capability must be advertised, or the card can never be chosen",
  );
  assert.match(contract.systemPrompt, /reports\.total/);
  assert.match(contract.systemPrompt, /MetricCard/);

  const requestVariants =
    contract.jsonSchema.oneOf[0].properties.dataRequests.items.anyOf;
  assert.ok(
    requestVariants.some((variant) => variant.properties.capabilityId.const === "reports.total"),
    "the schema must permit requesting it",
  );
  const nodeVariants = contract.jsonSchema.oneOf[0].properties.nodes.items.oneOf;
  assert.ok(
    nodeVariants.some((variant) => variant.properties.componentId.const === "MetricCard"),
    "the schema must permit rendering it",
  );

  // Reachability is not selection: both were reachable and neither was chosen,
  // because a single-figure question also looks answerable by aggregating a
  // collection. The preference is stated, and stated as being about
  // correctness — an aggregate is bounded by a row limit, a metric is not.
  assert.match(contract.systemPrompt, /already returns the figure/);
  assert.match(contract.systemPrompt, /Aggregate a collection only when no metric capability/);
});

test("distinguishes source narrowing from post-fetch filtering, in facts and in rule", () => {
  const narrowing = {
    ...manifest,
    capabilities: manifest.capabilities.map((capability) =>
      capability.id === "reports.list"
        ? {
            ...capability,
            supports: {
              ...capability.supports,
              sourceNarrowingArguments: ["filter", "search"],
            },
          }
        : capability,
    ),
  };
  const contract = createPlanContract(site, narrowing, { surfaceId: "reports" });
  // The fact: which params the source applies over the whole dataset. The
  // params schema shows an argument's shape but cannot say when it runs.
  assert.match(contract.systemPrompt, /"sourceNarrowingArguments":\["filter","search"\]/);
  // The rule: prefer them, and know what a query filter actually covers.
  assert.match(contract.systemPrompt, /narrow(s)? over the whole dataset before anything is fetched/);
  assert.match(contract.systemPrompt, /query\.filter narrows no more than the fetched page/);
  // The old undirected instruction must not survive alongside the new rule —
  // "use query for filtering" was the sentence that taught page-filtering.
  assert.doesNotMatch(
    contract.systemPrompt,
    /Use params for capability inputs and query for filtering/,
  );
});

test("a capability with no source-narrowing params advertises none", () => {
  const contract = createPlanContract(site, manifest, { surfaceId: "reports" });
  // The rule sentence names the key generically; no capability entry may carry
  // it — an empty list would read as "the source narrows on nothing", which is
  // true here but must come from absence, not from an invented fact.
  assert.doesNotMatch(contract.systemPrompt, /"sourceNarrowingArguments":/);
});

test("a grouped-only slot states its requirement in the prompt", () => {
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
    id: "chart-scope",
    name: "Chart scope",
    version: "1.0.0",
    catalogId: "chart-scope-components",
    components: [Chart],
    surfaces: [
      defineSurface({
        id: "reports",
        description: "Report results.",
        componentIds: ["Chart"],
        maxComponents: 1,
      }),
    ],
  });
  // The capability must support grouping or scoping drops it entirely.
  const groupable = {
    ...manifest,
    capabilities: [
      {
        ...manifest.capabilities[0],
        supports: {
          ...manifest.capabilities[0].supports,
          groupFields: ["id"],
          aggregates: ["count"],
        },
      },
    ],
  };
  const contract = createPlanContract(chartSite, groupable, { surfaceId: "reports" });
  // The schema cannot express the grouping requirement, so the prompt must —
  // otherwise every aggregation prompt lands in the repair loop.
  assert.match(
    contract.systemPrompt,
    /grouped data only: the bound request must set query\.groupBy\/aggregates/,
  );
});

test("scoping drops a capability a grouped-only surface can never bind", () => {
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
    id: "chart-scope-2",
    name: "Chart scope 2",
    version: "1.0.0",
    catalogId: "chart-scope-components",
    components: [Chart],
    surfaces: [
      defineSurface({
        id: "reports",
        description: "Report results.",
        componentIds: ["Chart"],
        maxComponents: 1,
      }),
    ],
  });
  // reports.list supports filter/sort but no grouping: no legal plan can feed
  // the chart, so the capability leaves the contract and an aggregation prompt
  // is refused rather than drawn from raw rows — the intended outcome.
  const contract = createPlanContract(chartSite, manifest, { surfaceId: "reports" });
  assert.deepEqual(contract.capabilityIds, []);
});

/**
 * A capability nothing on the surface can render is absent from every bindable
 * part of the contract — which is right, and which used to make the model
 * report the *catalog* as the blocker. Measured: a `hierarchy` type refused as
 * data the catalog "does not provide", then rendered the moment a component
 * accepting that shape was registered. These pin the fact reaching the prompt,
 * the wording that uses it, and the safety property that must survive it.
 */
test("the scope names what it dropped, compactly and deduplicated", () => {
  const scope = scopeManifestToSurface(manifest, site, "reports");
  assert.deepEqual(scope.excludedCapabilityIds, ["metrics.timeseries"]);
  // (dataTypeId, shape) only — this travels into the prompt, where contract
  // size is a live cost, and a refusal needs no more than what to name.
  assert.deepEqual(scope.unrenderableOutputs, [
    { dataTypeId: "Metric", shape: "time-series" },
  ]);
});

test("unrenderable outputs reach the contract, marked not bindable", () => {
  const contract = createPlanContract(site, manifest, { surfaceId: "reports" });
  assert.match(contract.systemPrompt, /Approved data this surface cannot display/);
  // Grouped `type (shape)` rather than JSON: the same facts, less than half
  // the tokens, on every attempt. Asserted on the line itself — the capability
  // list further down legitimately carries JSON `dataTypeId` keys.
  const unrenderableLine = contract.systemPrompt
    .split("\n")
    .find((line) => line.startsWith("Approved data this surface cannot display"));
  assert.match(unrenderableLine, /Metric \(time-series\)/);
  assert.doesNotMatch(unrenderableLine, /"dataTypeId"/);
  assert.match(contract.systemPrompt, /These are NOT bindable/);
  // The capability id itself must not appear: naming it is how a planner
  // learns to call something the surface cannot render.
  assert.doesNotMatch(contract.systemPrompt, /metrics\.timeseries/);
});

test("the refusal rule tells the model which blocker to name", () => {
  const contract = createPlanContract(site, manifest, { surfaceId: "reports" });
  assert.match(
    contract.systemPrompt,
    /this surface has no component that can present it/,
  );
  // The misattribution is ruled out explicitly, with the reason: the owner's
  // next action differs, and only one of the two is "approve more fields".
  assert.match(contract.systemPrompt, /Do not say the catalog lacks the data/);
  assert.match(contract.systemPrompt, /no approval fixes a missing component/);
});

test("nothing is emitted when the surface can render everything", () => {
  const everything = {
    ...manifest,
    capabilities: manifest.capabilities.filter(
      (capability) => capability.id === "reports.list",
    ),
  };
  const contract = createPlanContract(site, everything, { surfaceId: "reports" });
  assert.doesNotMatch(contract.systemPrompt, /cannot display/);
  assert.doesNotMatch(contract.systemPrompt, /NOT bindable/);
});

test("stating an unrenderable output does not make it bindable", () => {
  // The safety property. Telling the model a data type exists so it can refuse
  // accurately must never become a way to request it: a bound unrenderable
  // capability is precisely the silent-wrong-answer class this work is about.
  const contract = createPlanContract(site, manifest, { surfaceId: "reports" });
  const requestVariants =
    contract.jsonSchema.oneOf[0].properties.dataRequests.items.anyOf;
  assert.deepEqual(
    requestVariants.map((variant) => variant.properties.capabilityId.const),
    ["reports.list"],
  );

  // And a hand-built plan that names it anyway fails binding validation.
  const smuggled = {
    schemaVersion: "3.1",
    planId: "smuggled",
    siteId: site.id,
    sourcePrompt: "chart the series",
    catalog: {
      id: site.catalog.id,
      version: site.catalog.version,
      fingerprint: site.catalog.fingerprint,
    },
    dataCatalog: {
      id: manifest.catalogId,
      version: manifest.catalogVersion,
      hash: manifest.catalogHash,
    },
    dataRequests: [
      { requestId: "r1", capabilityId: "metrics.timeseries", params: {} },
    ],
    surfaces: [
      {
        id: "reports",
        nodes: [
          {
            nodeId: "n1",
            componentId: "ReportTable",
            props: {},
            dataBindings: { rows: { requestId: "r1" } },
          },
        ],
      },
    ],
    generation: {
      providerId: "hand-authored",
      modelId: "none",
      createdAt: "2026-08-24T00:00:00.000Z",
      repairCount: 0,
    },
  };
  const validated = validatePlanDataBindings(site, smuggled, manifest);
  assert.equal(validated.ok, false);
  assert.equal(validated.issues[0].code, "incompatible-data-slot");
});

test("clarification fires for ambiguity, and not for questions no answer can settle", () => {
  const contract = createPlanContract(site, manifest, { surfaceId: "reports" });
  // Half one: the trigger names the case that was never reached — a vague
  // superlative mapping to several producible readings ("best products" was
  // guessed as relevance ranking and rejected upstream).
  assert.match(contract.systemPrompt, /vague superlative or comparative/);
  assert.match(contract.systemPrompt, /name the concrete alternatives/);
  // Half two: the guard against asking badly — a question about calendar
  // months against a catalog that could not aggregate by month either way
  // ended in the same refusal one round trip later.
  assert.match(contract.systemPrompt, /Check what is producible before asking/);
  assert.match(
    contract.systemPrompt,
    /a question whose every answer leads to the same refusal/,
  );
  // The clause that used to rule out asking about "sorting" outright — the one
  // that instructed the guess — must be gone, replaced by the stated/unstated
  // distinction.
  assert.doesNotMatch(
    contract.systemPrompt,
    /Do not ask about anything the visitor could adjust on the view afterwards/,
  );
  assert.match(
    contract.systemPrompt,
    /an unstated choice of which metric or capability answers the question is not that/,
  );
});

test("the clarification rules vanish with the branch, guard included", () => {
  const contract = createPlanContract(site, manifest, {
    surfaceId: "reports",
    allowClarification: false,
  });
  assert.doesNotMatch(contract.systemPrompt, /vague superlative/);
  assert.doesNotMatch(contract.systemPrompt, /Check what is producible/);
  assert.match(contract.systemPrompt, /you may not ask another/);
});
