import assert from "node:assert/strict";
import test from "node:test";
import { composeDataPlan, createPlanContract } from "../dist/index.js";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  defineTheme,
  field,
} from "@renderyes/site-sdk";

const restaurantTable = defineComponent({
  id: "RestaurantTable",
  version: "1.0.0",
  description: "Shows approved nearby restaurant results.",
  props: defineProps({
    density: field.enum(["comfortable", "compact"], {
      default: "comfortable",
    }),
  }),
  renderer: {
    component: "ResponsiveDataTable",
    props: {
      rows: { path: "/restaurants/rows" },
    },
  },
  dataSlots: {
    rows: {
      accepts: [
        {
          dataTypeId: "RestaurantSearchResult",
          shapes: ["search-results", "collection"],
        },
      ],
    },
  },
});

const site = defineSite({
  id: "food-demo",
  name: "Food demo",
  version: "1.0.0",
  catalogId: "food-demo-components",
  components: [restaurantTable],
  surfaces: [
    defineSurface({
      id: "results",
      description: "Nearby restaurant results.",
      componentIds: ["RestaurantTable"],
      maxComponents: 1,
    }),
  ],
  theme: defineTheme({
    id: "food-theme",
    tokens: { primary: "#ef5b25" },
  }),
});

const plannerManifest = {
  schemaVersion: "1.0",
  catalogId: "food-data",
  catalogVersion: "0.1.0",
  catalogHash: "8ad39c21",
  description: "Approved restaurant discovery data.",
  dataTypes: [
    {
      id: "RestaurantSearchResult",
      version: "1.0.0",
      description: "A nearby restaurant.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["restaurantId", "name", "diet", "distanceKm"],
        properties: {
          restaurantId: { type: "string" },
          name: { type: "string" },
          diet: { enum: ["veg", "non-veg"] },
          distanceKm: { type: "number" },
        },
      },
      fields: {
        restaurantId: {
          label: "Restaurant ID",
          semanticType: "identifier",
        },
        name: { label: "Restaurant", semanticType: "text" },
        diet: { label: "Diet", semanticType: "status" },
        distanceKm: {
          label: "Distance",
          semanticType: "quantity",
          unit: "km",
        },
      },
      matchKey: "restaurantId",
    },
  ],
  capabilities: [
    {
      id: "restaurants.search",
      version: "1.0.0",
      purpose: "Find nearby restaurants matching an approved diet.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["diet", "radiusKm"],
        properties: {
          diet: { enum: ["veg", "non-veg"] },
          radiusKm: { type: "number", minimum: 1, maximum: 20 },
        },
      },
      output: {
        dataTypeId: "RestaurantSearchResult",
        shape: "search-results",
      },
      supports: {
        filterFields: ["diet", "distanceKm"],
        sortFields: ["distanceKm"],
      },
      constraints: {
        authentication: "session",
        maximumRows: 20,
      },
    },
  ],
  relationships: [],
};

function readyDraft(overrides = {}) {
  return {
    status: "ready",
    dataRequests: [
      {
        requestId: "nearby-non-veg",
        capabilityId: "restaurants.search",
        params: { diet: "non-veg", radiusKm: 5 },
        query: {
          sort: [{ field: "distanceKm", direction: "asc" }],
          limit: 10,
        },
      },
    ],
    nodes: [
      {
        nodeId: "restaurants-1",
        componentId: "RestaurantTable",
        props: {},
        dataBindings: {
          rows: { requestId: "nearby-non-veg" },
        },
      },
    ],
    ...overrides,
  };
}

const compositionManifest = {
  ...plannerManifest,
  capabilities: plannerManifest.capabilities
    .map((capability) => ({
      ...capability,
      supports: {
        ...capability.supports,
        setOperations: ["union", "intersection", "difference"],
      },
    }))
    .concat({
      id: "restaurants.saved",
      version: "1.0.0",
      purpose: "Load the visitor's approved saved restaurants.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        dataTypeId: "RestaurantSearchResult",
        shape: "search-results",
      },
      supports: {
        setOperations: ["union", "intersection", "difference"],
        sortFields: ["distanceKm"],
      },
      constraints: { authentication: "session", maximumRows: 20 },
    }),
};

function compositionDraft(overrides = {}) {
  return readyDraft({
    dataRequests: [
      {
        requestId: "nearby",
        capabilityId: "restaurants.search",
        params: { diet: "non-veg", radiusKm: 5 },
      },
      {
        requestId: "saved",
        capabilityId: "restaurants.saved",
        params: {},
      },
    ],
    dataCompositions: [
      {
        compositionId: "nearby-and-saved",
        operation: "intersection",
        inputs: ["nearby", "saved"],
        query: {
          sort: [{ field: "distanceKm", direction: "asc" }],
          project: ["restaurantId", "name", "diet", "distanceKm"],
          limit: 10,
        },
      },
    ],
    nodes: [
      {
        nodeId: "restaurants-1",
        componentId: "RestaurantTable",
        props: {},
        dataBindings: {
          rows: { compositionId: "nearby-and-saved" },
        },
      },
    ],
    ...overrides,
  });
}

// A second data type + capability + approved to-one relationship so the model
// can request a join. Join keys (from/to fields) never appear in the manifest.
const joinManifest = {
  ...plannerManifest,
  dataTypes: [
    ...plannerManifest.dataTypes,
    {
      id: "Courier",
      version: "1.0.0",
      description: "An approved delivery courier.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["courierId", "name", "zone"],
        properties: {
          courierId: { type: "string" },
          name: { type: "string" },
          zone: { type: "string" },
        },
      },
      fields: {
        courierId: { label: "Courier ID", semanticType: "identifier" },
        name: { label: "Courier", semanticType: "text" },
        zone: { label: "Zone", semanticType: "text" },
      },
      matchKey: "courierId",
    },
  ],
  capabilities: [
    ...plannerManifest.capabilities,
    {
      id: "couriers.list",
      version: "1.0.0",
      purpose: "List approved delivery couriers.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: { dataTypeId: "Courier", shape: "collection" },
      constraints: { authentication: "session", maximumRows: 20 },
    },
  ],
  relationships: [
    {
      id: "restaurant-courier",
      description: "The courier assigned to each restaurant.",
      fromDataTypeId: "RestaurantSearchResult",
      toDataTypeId: "Courier",
      cardinality: "many-to-one",
    },
  ],
};

function joinDraft(overrides = {}) {
  return readyDraft({
    dataRequests: [
      {
        requestId: "nearby",
        capabilityId: "restaurants.search",
        params: { diet: "non-veg", radiusKm: 5 },
      },
      {
        requestId: "couriers",
        capabilityId: "couriers.list",
        params: {},
      },
    ],
    dataJoins: [
      {
        joinId: "nearby-with-courier",
        relationshipId: "restaurant-courier",
        left: "nearby",
        right: "couriers",
        as: "courier",
      },
    ],
    nodes: [
      {
        nodeId: "restaurants-1",
        componentId: "RestaurantTable",
        props: {},
        dataBindings: {
          rows: { joinId: "nearby-with-courier" },
        },
      },
    ],
    ...overrides,
  });
}

function composeJoin(provider, overrides = {}) {
  return composeDataPlan({
    site,
    plannerManifest: joinManifest,
    surfaceId: "results",
    prompt: "Show nearby restaurants with their courier",
    provider,
    createId: () => "plan-join-1",
    now: () => new Date("2026-07-29T00:00:00.000Z"),
    ...overrides,
  });
}

class QueueProvider {
  id = "mock-provider";
  requests = [];

  constructor(outputs) {
    this.outputs = [...outputs];
  }

  async generatePlan(request) {
    this.requests.push(request);
    const output = this.outputs.shift();
    if (output instanceof Error) throw output;
    return {
      value: output,
      modelId: "mock-model",
    };
  }
}

function compose(provider, overrides = {}) {
  return composeDataPlan({
    site,
    plannerManifest,
    surfaceId: "results",
    prompt: "Show non-veg food near me",
    provider,
    createId: () => "plan-food-1",
    now: () => new Date("2026-07-29T00:00:00.000Z"),
    ...overrides,
  });
}

function composeComposition(provider, overrides = {}) {
  return composeDataPlan({
    site,
    plannerManifest: compositionManifest,
    surfaceId: "results",
    prompt: "Show restaurants that are both nearby and saved",
    provider,
    createId: () => "plan-composition-1",
    now: () => new Date("2026-07-29T00:00:00.000Z"),
    ...overrides,
  });
}

test("builds a planner-safe contract without renderer paths or trusted context", () => {
  const contract = createPlanContract(site, plannerManifest, {
    surfaceId: "results",
  });
  const serialized = JSON.stringify(contract);

  assert.match(serialized, /restaurants\.search/);
  assert.match(serialized, /RestaurantTable/);
  assert.doesNotMatch(serialized, /\/restaurants\/rows/);
  assert.doesNotMatch(serialized, /ResponsiveDataTable/);
  assert.doesNotMatch(serialized, /deliveryLocationId/);
  assert.doesNotMatch(serialized, /accessToken|private-cookie|saved-address/);
  assert.match(serialized, /unsupported/);
});

test("offers composition bindings only when the catalog advertises compatible set inputs", () => {
  const contract = createPlanContract(site, compositionManifest, {
    surfaceId: "results",
  });
  const ready = contract.jsonSchema.oneOf[0];
  const bindingVariants =
    ready.properties.nodes.items.oneOf[0].properties.dataBindings.properties.rows.oneOf;

  assert.equal("dataCompositions" in ready.properties, true);
  assert.equal(
    bindingVariants.some((variant) => "compositionId" in variant.properties),
    true,
  );
  assert.match(contract.systemPrompt, /compositionId/);
  assert.doesNotMatch(JSON.stringify(contract), /deliveryLocationId/);
});

test("composes a provider-selected intersection bound to one trusted table", async () => {
  const provider = new QueueProvider([compositionDraft()]);
  const result = await composeComposition(provider);

  assert.equal(result.ok, true);
  assert.equal(result.plan.dataCompositions?.[0].operation, "intersection");
  assert.deepEqual(result.plan.dataCompositions?.[0].inputs, ["nearby", "saved"]);
  assert.deepEqual(result.plan.surfaces[0].nodes[0].dataBindings.rows, {
    compositionId: "nearby-and-saved",
  });
});

test("repairs an invalid composition operation before accepting a plan", async () => {
  const invalid = compositionDraft();
  invalid.dataCompositions[0].operation = "union";
  invalid.dataCompositions[0].inputs = ["nearby", "not-a-request"];
  const provider = new QueueProvider([invalid, compositionDraft()]);
  const result = await composeComposition(provider);

  assert.equal(result.ok, true);
  assert.equal(result.plan.generation.repairCount, 1);
  assert.equal(provider.requests.length, 2);
});

test("composes a validated Plan 3.1 and applies prop defaults", async () => {
  const provider = new QueueProvider([readyDraft()]);
  const result = await compose(provider);

  assert.equal(result.ok, true);
  assert.equal(result.plan.schemaVersion, "3.1");
  assert.equal(result.plan.planId, "plan-food-1");
  assert.equal(result.plan.dataCatalog.id, "food-data");
  assert.equal(result.plan.dataRequests[0].capabilityId, "restaurants.search");
  assert.deepEqual(result.plan.surfaces[0].nodes[0].props, {
    density: "comfortable",
  });
  assert.equal(result.plan.generation.repairCount, 0);
  assert.equal(provider.requests.length, 1);
});

test("repairs a semantically invalid query before accepting the plan", async () => {
  const invalid = readyDraft();
  invalid.dataRequests[0].query = {
    filter: {
      combine: "all",
      conditions: [
        {
          field: "distanceKm",
          operator: "contains",
          value: "1",
        },
      ],
    },
  };
  const provider = new QueueProvider([invalid, readyDraft()]);
  const result = await compose(provider);

  assert.equal(result.ok, true);
  assert.equal(result.plan.generation.repairCount, 1);
  assert.equal(provider.requests.length, 2);
  assert.match(
    provider.requests[1].userPrompt,
    /Operator "contains" is not valid for quantity field "distanceKm"/,
  );
});

test("rejects invalid capability params even when a provider ignores the schema", async () => {
  const invalid = readyDraft();
  invalid.dataRequests[0].params.radiusKm = 500;
  const provider = new QueueProvider([invalid]);
  const result = await compose(provider, { maxRetries: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "invalid");
  assert.match(result.reason, /must be <= 20/);
});

test("fails closed when a data request is not bound to trusted UI", async () => {
  const draft = readyDraft({
    dataRequests: [
      ...readyDraft().dataRequests,
      {
        requestId: "unused",
        capabilityId: "restaurants.search",
        params: { diet: "veg", radiusKm: 2 },
      },
    ],
  });
  const provider = new QueueProvider([draft]);
  const result = await compose(provider, { maxRetries: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "invalid");
  assert.match(result.reason, /Data request unused is not bound to a component/);
});

test("returns a structured unsupported result without retrying", async () => {
  const provider = new QueueProvider([
    {
      status: "unsupported",
      reason: "No approved component can represent a map.",
    },
  ]);
  const result = await compose(provider);

  assert.equal(result.ok, false);
  assert.equal(result.kind, "unsupported");
  assert.match(result.reason, /represent a map/);
  assert.equal(provider.requests.length, 1);
});

test("offers join bindings only when the catalog advertises a qualifying to-one relationship", () => {
  const withoutJoins = createPlanContract(site, plannerManifest, {
    surfaceId: "results",
  });
  assert.equal("dataJoins" in withoutJoins.jsonSchema.oneOf[0].properties, false);

  const contract = createPlanContract(site, joinManifest, {
    surfaceId: "results",
  });
  const ready = contract.jsonSchema.oneOf[0];
  const bindingVariants =
    ready.properties.nodes.items.oneOf[0].properties.dataBindings.properties.rows.oneOf;

  assert.equal("dataJoins" in ready.properties, true);
  assert.deepEqual(ready.properties.dataJoins.items.properties.relationshipId.enum, [
    "restaurant-courier",
  ]);
  assert.equal(
    bindingVariants.some((variant) => "joinId" in variant.properties),
    true,
  );
  assert.match(contract.systemPrompt, /joinId/);
  // The model sees only the relationship id (an enum). Its internal structure —
  // the joined data types, cardinality, and owner-controlled join keys — stays
  // server-side and must never appear in the contract.
  const serialized = JSON.stringify(contract);
  assert.doesNotMatch(serialized, /fromDataTypeId|toDataTypeId|cardinality/);
});

test("composes a provider-selected relationship join bound to one trusted table", async () => {
  const provider = new QueueProvider([joinDraft()]);
  const result = await composeJoin(provider);

  assert.equal(result.ok, true);
  assert.equal(result.plan.dataJoins?.[0].relationshipId, "restaurant-courier");
  assert.deepEqual(
    { left: result.plan.dataJoins?.[0].left, right: result.plan.dataJoins?.[0].right },
    { left: "nearby", right: "couriers" },
  );
  assert.deepEqual(result.plan.surfaces[0].nodes[0].dataBindings.rows, {
    joinId: "nearby-with-courier",
  });
});

test("repairs an unknown relationship before accepting a join plan", async () => {
  const invalid = joinDraft();
  invalid.dataJoins[0].relationshipId = "restaurant-courier";
  // Force a semantic mismatch the closed schema cannot catch: swap the sides so
  // the left request produces the wrong data type for the relationship.
  invalid.dataJoins[0].left = "couriers";
  invalid.dataJoins[0].right = "nearby";
  const provider = new QueueProvider([invalid, joinDraft()]);
  const result = await composeJoin(provider);

  assert.equal(result.ok, true);
  assert.equal(result.plan.generation.repairCount, 1);
  assert.equal(provider.requests.length, 2);
  assert.match(
    provider.requests[1].userPrompt,
    /relationship restaurant-courier requires/i,
  );
});

test("never advertises or accepts a to-many relationship (runtime is to-one only)", async () => {
  const toManyManifest = {
    ...joinManifest,
    relationships: [
      {
        id: "restaurant-couriers",
        description: "The couriers serving each restaurant.",
        fromDataTypeId: "RestaurantSearchResult",
        toDataTypeId: "Courier",
        cardinality: "one-to-many",
      },
    ],
  };

  // (a) The contract must not advertise a to-many relationship at all.
  const contract = createPlanContract(site, toManyManifest, {
    surfaceId: "results",
  });
  assert.equal("dataJoins" in contract.jsonSchema.oneOf[0].properties, false);
  const bindingVariants =
    contract.jsonSchema.oneOf[0].properties.nodes.items.oneOf[0].properties.dataBindings
      .properties.rows.oneOf;
  assert.equal(
    bindingVariants.some((variant) => "joinId" in variant.properties),
    false,
  );

  // (b) Even if a provider forces the to-many relationship, compose rejects it
  // fail-closed. Because the relationship is never advertised, the closed schema
  // (the unadvertised `dataJoins` key and `joinId` binding variant) blocks it
  // before execution — a to-many join can never reach the runtime.
  const forced = joinDraft();
  forced.dataJoins[0].relationshipId = "restaurant-couriers";
  const provider = new QueueProvider([forced]);
  const result = await composeDataPlan({
    site,
    plannerManifest: toManyManifest,
    surfaceId: "results",
    prompt: "Show nearby restaurants with their couriers",
    provider,
    createId: () => "plan-join-many-1",
    now: () => new Date("2026-07-29T00:00:00.000Z"),
    maxRetries: 0,
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "invalid");
});

test("fails closed when a join is not bound to trusted UI", async () => {
  const draft = joinDraft({
    nodes: [
      {
        nodeId: "restaurants-1",
        componentId: "RestaurantTable",
        props: {},
        dataBindings: { rows: { requestId: "nearby" } },
      },
    ],
  });
  const provider = new QueueProvider([draft]);
  const result = await composeJoin(provider, { maxRetries: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "invalid");
  assert.match(
    result.reason,
    /Data join nearby-with-courier is not bound to a component/,
  );
});

// A container that declares a child slot, so the planner may nest an approved
// leaf component inside it. Reuses restaurantTable as the leaf so the test
// proves the general recursive mechanism (nested data-bound children), not a
// new leaf type.
const dashboard = defineComponent({
  id: "Dashboard",
  version: "1.0.0",
  description: "A dashboard container for approved child components.",
  props: defineProps({}),
  renderer: { component: "Column", props: {} },
  slots: {
    children: {
      description: "Approved components shown in this dashboard.",
      cardinality: "many",
      accepts: ["RestaurantTable"],
    },
  },
});

const nestedSite = defineSite({
  id: "food-demo-nested",
  name: "Food demo (nested)",
  version: "1.0.0",
  catalogId: "food-demo-nested-components",
  components: [restaurantTable, dashboard],
  surfaces: [
    defineSurface({
      id: "nested-results",
      description: "A dashboard of nearby restaurant results.",
      componentIds: ["Dashboard", "RestaurantTable"],
      maxComponents: 1,
    }),
  ],
  theme: defineTheme({ id: "food-nested-theme", tokens: { primary: "#ef5b25" } }),
});

function nestedDraft(overrides = {}) {
  return {
    status: "ready",
    dataRequests: [
      {
        requestId: "nearby",
        capabilityId: "restaurants.search",
        params: { diet: "non-veg", radiusKm: 5 },
      },
    ],
    nodes: [
      {
        nodeId: "dash-1",
        componentId: "Dashboard",
        props: {},
        slots: {
          children: [
            {
              nodeId: "restaurants-1",
              componentId: "RestaurantTable",
              props: {},
              dataBindings: { rows: { requestId: "nearby" } },
            },
          ],
        },
      },
    ],
    ...overrides,
  };
}

function composeNested(provider, overrides = {}) {
  return composeDataPlan({
    site: nestedSite,
    plannerManifest,
    surfaceId: "nested-results",
    prompt: "Show a dashboard of nearby restaurants",
    provider,
    createId: () => "plan-nested-1",
    now: () => new Date("2026-07-29T00:00:00.000Z"),
    ...overrides,
  });
}

test("offers slot bindings only when an approved component declares a slot", () => {
  const flat = createPlanContract(site, plannerManifest, { surfaceId: "results" });
  assert.equal("$defs" in flat.jsonSchema, false);
  const flatNodeSchema = flat.jsonSchema.oneOf[0].properties.nodes.items.oneOf[0];
  assert.equal("slots" in flatNodeSchema.properties, false);

  const nested = createPlanContract(nestedSite, plannerManifest, {
    surfaceId: "nested-results",
  });
  assert.equal("$defs" in nested.jsonSchema, true);
  const dashboardVariant = nested.jsonSchema.oneOf[0].properties.nodes.items.oneOf.find(
    (variant) => variant.properties.componentId.const === "Dashboard",
  );
  assert.equal(
    dashboardVariant.properties.slots.properties.children.items.$ref,
    "#/$defs/node",
  );
  assert.match(nested.systemPrompt, /slot/);
});

test("composes a provider-selected nested dashboard with a data-bound child", async () => {
  const provider = new QueueProvider([nestedDraft()]);
  const result = await composeNested(provider);

  assert.equal(result.ok, true);
  const dashboardNode = result.plan.surfaces[0].nodes[0];
  assert.equal(dashboardNode.componentId, "Dashboard");
  const child = dashboardNode.slots.children[0];
  assert.equal(child.componentId, "RestaurantTable");
  assert.deepEqual(child.dataBindings.rows, { requestId: "nearby" });
});

test("repairs a nested plan whose child violates the parent's declared slot accepts", async () => {
  const invalid = nestedDraft();
  invalid.nodes[0].slots.children[0].componentId = "Dashboard";
  delete invalid.nodes[0].slots.children[0].dataBindings;
  const provider = new QueueProvider([invalid, nestedDraft()]);
  const result = await composeNested(provider);

  assert.equal(result.ok, true);
  assert.equal(result.plan.generation.repairCount, 1);
  assert.equal(provider.requests.length, 2);
});

test("composes two instances of the same data-bound component nested on one surface", async () => {
  // RestaurantTable's renderer path (/restaurants/rows) is fixed per component
  // definition, not per instance — so two instances bound to different requests
  // used to be rejected here, since both would target that one immutable path.
  // Projection now scopes every executor-written path by the owning node id
  // (`scopedDataPath` in site-sdk), so each instance gets its own subtree and
  // this is a valid plan. It is also the only way to express a side-by-side
  // comparison ("veg vs non-veg nearby"), which is a thing visitors ask for.
  const draft = nestedDraft({
    dataRequests: [
      {
        requestId: "nearby",
        capabilityId: "restaurants.search",
        params: { diet: "non-veg", radiusKm: 5 },
      },
      {
        requestId: "nearby-veg",
        capabilityId: "restaurants.search",
        params: { diet: "veg", radiusKm: 5 },
      },
    ],
    nodes: [
      {
        nodeId: "dash-1",
        componentId: "Dashboard",
        props: {},
        slots: {
          children: [
            {
              nodeId: "restaurants-1",
              componentId: "RestaurantTable",
              props: {},
              dataBindings: { rows: { requestId: "nearby" } },
            },
            {
              nodeId: "restaurants-2",
              componentId: "RestaurantTable",
              props: {},
              dataBindings: { rows: { requestId: "nearby-veg" } },
            },
          ],
        },
      },
    ],
  });
  const provider = new QueueProvider([draft]);
  const result = await composeNested(provider, { maxRetries: 0 });

  assert.equal(result.ok, true);
  const children = result.plan.surfaces[0].nodes[0].slots.children;
  assert.deepEqual(
    children.map((child) => child.componentId),
    ["RestaurantTable", "RestaurantTable"],
  );
  // Each instance keeps its own request — the whole point of allowing this.
  assert.deepEqual(children[0].dataBindings.rows, { requestId: "nearby" });
  assert.deepEqual(children[1].dataBindings.rows, { requestId: "nearby-veg" });
});

test("composes two different components whose data slots share a renderer path", async () => {
  // Two *different* components declaring the same renderer path used to be
  // rejected too. Node-scoped projection makes it harmless: each instance
  // writes under its own node id, so the shared declared path never becomes a
  // shared data-model location.
  const decoyTable = defineComponent({
    id: "DecoyTable",
    version: "1.0.0",
    description: "A second component sharing RestaurantTable's renderer path.",
    props: defineProps({}),
    renderer: {
      component: "ResponsiveDataTable",
      props: { rows: { path: "/restaurants/rows" } },
    },
    dataSlots: {
      rows: {
        accepts: [
          {
            dataTypeId: "RestaurantSearchResult",
            shapes: ["search-results", "collection"],
          },
        ],
      },
    },
  });
  const overlapSite = defineSite({
    id: "food-demo-overlap",
    name: "Food demo (overlap)",
    version: "1.0.0",
    catalogId: "food-demo-overlap-components",
    components: [restaurantTable, decoyTable, dashboard],
    surfaces: [
      defineSurface({
        id: "overlap-results",
        description: "Nearby restaurant results.",
        // Flat, two top-level nodes: Dashboard's `children` slot only accepts
        // RestaurantTable, so nesting DecoyTable there would be rejected by
        // the slot-accepts rule for an unrelated reason and wouldn't exercise
        // the shared-renderer-path case this test is about.
        componentIds: ["RestaurantTable", "DecoyTable"],
        maxComponents: 2,
      }),
    ],
    theme: defineTheme({ id: "food-overlap-theme", tokens: { primary: "#ef5b25" } }),
  });
  const draft = nestedDraft({
    dataRequests: [
      {
        requestId: "nearby",
        capabilityId: "restaurants.search",
        params: { diet: "non-veg", radiusKm: 5 },
      },
      {
        requestId: "nearby-veg",
        capabilityId: "restaurants.search",
        params: { diet: "veg", radiusKm: 5 },
      },
    ],
    nodes: [
      {
        nodeId: "restaurants-1",
        componentId: "RestaurantTable",
        props: {},
        dataBindings: { rows: { requestId: "nearby" } },
      },
      {
        nodeId: "restaurants-2",
        componentId: "DecoyTable",
        props: {},
        dataBindings: { rows: { requestId: "nearby-veg" } },
      },
    ],
  });
  const provider = new QueueProvider([draft]);
  const result = await composeDataPlan({
    site: overlapSite,
    plannerManifest,
    surfaceId: "overlap-results",
    prompt: "Show a dashboard of nearby restaurants",
    provider,
    createId: () => "plan-overlap-1",
    now: () => new Date("2026-07-29T00:00:00.000Z"),
    maxRetries: 0,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.plan.surfaces[0].nodes.map((node) => node.componentId),
    ["RestaurantTable", "DecoyTable"],
  );
});

test("fails closed when a nested child's data slot is not bound", async () => {
  // RestaurantTable declares a data slot, so the closed node schema itself
  // requires dataBindings at every depth — this is caught before compose.ts's
  // own recursive dataBindings check ever runs, which is the stronger outcome.
  const draft = nestedDraft();
  delete draft.nodes[0].slots.children[0].dataBindings;
  const provider = new QueueProvider([draft]);
  const result = await composeNested(provider, { maxRetries: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "invalid");
  assert.match(result.reason, /dataBindings/);
});

test("returns the previous plan after controlled provider failure", async () => {
  const previousResult = await compose(new QueueProvider([readyDraft()]));
  assert.equal(previousResult.ok, true);
  const provider = new QueueProvider([new Error("private provider detail")]);
  const result = await compose(provider, {
    previousPlan: previousResult.plan,
    maxRetries: 0,
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "provider-error");
  assert.equal(result.fallbackPlan, previousResult.plan);
  assert.doesNotMatch(result.reason, /private provider detail/);
});

/** Like QueueProvider, but each call burns wall-clock so a deadline can bite. */
class SlowQueueProvider extends QueueProvider {
  constructor(outputs, delayMs) {
    super(outputs);
    this.delayMs = delayMs;
  }

  async generatePlan(request) {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return super.generatePlan(request);
  }
}

test("stops repairing once the planning deadline has passed", async () => {
  // The budget used to multiply out: a per-call timeout, times a
  // structured-schema retry inside one call, times three repair attempts —
  // roughly six minutes of server work against a browser that stops listening
  // after 45 seconds. Every second past that point is spend with no recipient.
  const invalid = { status: "ready", dataRequests: [], nodes: [] };
  const provider = new SlowQueueProvider([invalid, invalid, invalid], 40);
  const result = await compose(provider, { deadlineMs: 30 });

  assert.equal(result.ok, false);
  assert.match(result.reason, /exceeded its 30ms budget/);
  // One call was made and paid for; the deadline stopped the second from
  // starting rather than aborting work already in flight.
  assert.equal(provider.requests.length, 1);
});

test("a deadline that is not reached does not interfere with repair", async () => {
  const invalid = compositionDraft();
  invalid.dataCompositions[0].operation = "union";
  invalid.dataCompositions[0].inputs = ["nearby", "not-a-request"];
  const provider = new QueueProvider([invalid, compositionDraft()]);
  const result = await composeComposition(provider, { deadlineMs: 60_000 });

  assert.equal(result.ok, true);
  assert.equal(result.plan.generation.repairCount, 1);
  assert.equal(provider.requests.length, 2);
});

test("no deadline configured leaves the retry behaviour unchanged", async () => {
  const invalid = compositionDraft();
  invalid.dataCompositions[0].operation = "union";
  invalid.dataCompositions[0].inputs = ["nearby", "not-a-request"];
  const provider = new QueueProvider([invalid, compositionDraft()]);
  const result = await composeComposition(provider);

  assert.equal(result.ok, true);
  assert.equal(provider.requests.length, 2);
});

/**
 * The previous plan was carried into `composeDataPlan` and used only as
 * `fallbackPlan` — the thing to return when planning fails. The model never saw
 * it, so a revision was a fresh compose with the old view held in reserve:
 * "now just the open ones" was planned with no knowledge of what was on screen
 * and worked only when the new sentence happened to be self-sufficient.
 * Preserving what the visitor did not mention, and adding to a view rather than
 * replacing it, were impossible for the same reason.
 */
test("a revision shows the model the view it is revising", async () => {
  const provider = new QueueProvider([readyDraft()]);
  const first = await compose(provider);
  assert.equal(first.ok, true);

  const revisionProvider = new QueueProvider([readyDraft()]);
  await compose(revisionProvider, {
    prompt: "show them as cards instead",
    previousPlan: first.plan,
  });

  const sent = revisionProvider.requests[0].userPrompt;
  // The visitor's words are still there...
  assert.match(sent, /show them as cards instead/);
  // ...alongside the structure of what they are looking at.
  assert.match(sent, /already on screen/);
  assert.match(sent, /nearby-non-veg/);
  assert.match(sent, /restaurants\.search/);
  // Both instructions, because each fixes a different half: without "keep" the
  // model rewrites from the new sentence alone, and without "add" it treats
  // every revision as a replacement and loses the table.
  assert.match(sent, /Keep anything the visitor did not ask to change/);
  assert.match(sent, /add to the view/);
});

test("a revision never carries the fetched rows back to the model", async () => {
  const provider = new QueueProvider([readyDraft()]);
  const first = await compose(provider);

  const revisionProvider = new QueueProvider([readyDraft()]);
  await compose(revisionProvider, {
    prompt: "only the close ones",
    previousPlan: first.plan,
  });

  // Structure, never content. The model decides what to render, not what the
  // data says, and re-admitting fetched rows would put customer data back
  // through the provider on every refinement.
  const sent = revisionProvider.requests[0].userPrompt;
  assert.ok(!sent.includes("resolvedRows"), "no resolved data in the revision prompt");
  assert.ok(!sent.includes("provenance"), "no provenance in the revision prompt");
});

test("a first compose is unchanged — no previous plan, no revision framing", async () => {
  const provider = new QueueProvider([readyDraft()]);
  await compose(provider);
  const sent = provider.requests[0].userPrompt;
  assert.equal(sent, "Show non-veg food near me");
});

test("a refusal that echoes the contract's placeholder is repaired, not shown", async () => {
  const provider = new QueueProvider([
    {
      status: "unsupported",
      reason:
        "<one sentence naming what this request needs that the catalogs lack, in the visitor's terms>",
    },
    {
      status: "unsupported",
      reason: "No approved capability returns weather forecasts.",
    },
  ]);
  const result = await compose(provider);

  assert.equal(result.ok, false);
  assert.equal(result.kind, "unsupported");
  assert.match(result.reason, /weather forecasts/);
  // The echo cost one repair round instead of reaching the visitor.
  assert.equal(provider.requests.length, 2);
  assert.match(provider.requests[1].userPrompt, /restated the contract's placeholder/);
});

test("a refusal still carrying bracketed template text after every retry ends invalid", async () => {
  const echo = {
    status: "unsupported",
    reason: "No approved capability returns <the thing the visitor asked for>.",
  };
  const provider = new QueueProvider([echo, echo, echo]);
  const result = await compose(provider);

  assert.equal(result.ok, false);
  assert.equal(result.kind, "invalid");
  assert.equal(provider.requests.length, 3);
});

test("the contract carries the identifier rule and no realistic refusal sample", () => {
  const contract = createPlanContract(site, plannerManifest, {
    surfaceId: "results",
  });
  assert.match(contract.systemPrompt, /Identifier arguments are pass-through, never invented/);
  // The narrowing now states where it runs: at the source when a param can
  // carry it, and only otherwise as a post-fetch query filter.
  assert.match(contract.systemPrompt, /narrowed on the field they actually named/);
  assert.match(contract.systemPrompt, /source-narrowing param when one can carry it/);
  assert.match(contract.systemPrompt, /Missing an id is never by itself a reason to refuse/);
  // The old sample sentence must never reappear anywhere a model could copy it.
  assert.doesNotMatch(contract.systemPrompt, /driver locations/);

  // The rule used to offer `order #482` as an example of a token to pass
  // straight into an id-taking capability, so "open order 2486" did exactly
  // that and the upstream answered `Invalid ID: 2486`. The prompt must never
  // again present a human-facing number as a value to pass through: the split
  // is by what the argument is, not by what the visitor's words look like.
  assert.doesNotMatch(contract.systemPrompt, /use the id-taking capability with exactly that value/);
  assert.match(contract.systemPrompt, /only a value that came back in this session/);
  assert.match(contract.systemPrompt, /order 2486" is an order number, not the id/);
});

/**
 * The clarification branch: the planner may answer with a question instead of
 * guessing between two views the catalog could equally produce.
 *
 * The risk this feature carries is not that the model never asks — it is that
 * it asks too much, and that it asks forever. A model handed a "you may ask"
 * branch will reach for it, because asking is always locally safer than
 * committing, and a system that answers a prompt with a question is worse than
 * one that guesses and lets the visitor refine. Both halves are pinned here.
 */
test("a question comes back as a question, not as a failure to repair", async () => {
  const provider = new QueueProvider([
    {
      status: "needs-clarification",
      question: "Do you mean restaurants near you now, or near your saved address?",
      options: ["Near me now", "My saved address"],
    },
  ]);
  const result = await compose(provider);

  assert.equal(result.ok, false);
  assert.equal(result.kind, "needs-clarification");
  assert.equal(
    result.question,
    "Do you mean restaurants near you now, or near your saved address?",
  );
  assert.deepEqual(result.options, ["Near me now", "My saved address"]);
  // `reason` carries the question so a consumer that only knows the older
  // failure shape still shows the visitor something true.
  assert.equal(result.reason, result.question);
  // One call, not three. A question is a valid answer; sending the whole
  // contract back to argue with it would cost two more full model calls to
  // arrive exactly here.
  assert.equal(provider.requests.length, 1);
});

test("a question with no options is still a question", async () => {
  const provider = new QueueProvider([
    { status: "needs-clarification", question: "Which city?" },
  ]);
  const result = await compose(provider);
  assert.equal(result.kind, "needs-clarification");
  assert.equal(result.options, undefined);
});

test("answering removes the branch from the contract, so it cannot ask twice", async () => {
  // The loop guard, and the reason it is structural rather than a prompt
  // instruction: a model that keeps finding the request ambiguous can ask
  // indefinitely, and the visitor's only exit is reloading the page.
  const asking = new QueueProvider([
    { status: "needs-clarification", question: "Which city?" },
  ]);
  await compose(asking, { allowClarification: false });

  const schema = asking.requests[0].jsonSchema;
  const statuses = schema.oneOf.map((variant) => variant.properties.status.const);
  assert.deepEqual(statuses, ["ready", "unsupported"]);
  assert.ok(
    asking.requests[0].systemPrompt.includes("you may not ask another"),
    "the prompt says why the branch is gone",
  );
});

test("the branch is present by default, and the two schemas are cached apart", async () => {
  // Same site and surface, different contract. The cache is keyed on the flag
  // because serving the with-branch schema to an answering compose would
  // reopen the loop the flag exists to close.
  const asking = new QueueProvider([readyDraft()]);
  await compose(asking);
  const withBranch = asking.requests[0].jsonSchema.oneOf.map(
    (variant) => variant.properties.status.const,
  );
  assert.deepEqual(withBranch, ["ready", "unsupported", "needs-clarification"]);

  const answering = new QueueProvider([readyDraft()]);
  await compose(answering, { allowClarification: false });
  assert.equal(answering.requests[0].jsonSchema.oneOf.length, 2);

  // And back again, to prove the first entry was not evicted or overwritten.
  const askingAgain = new QueueProvider([readyDraft()]);
  await compose(askingAgain);
  assert.equal(askingAgain.requests[0].jsonSchema.oneOf.length, 3);
});

test("a malformed question is rejected by the schema like any other draft", async () => {
  // `question` is required. A model emitting the status with no question would
  // otherwise put an empty prompt in front of a visitor.
  const provider = new QueueProvider([
    { status: "needs-clarification" },
    { status: "needs-clarification" },
    { status: "needs-clarification" },
  ]);
  const result = await compose(provider);
  assert.equal(result.kind, "invalid");
});
