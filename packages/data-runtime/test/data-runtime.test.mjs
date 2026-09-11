import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlannerManifest,
  hashCapabilityCatalog,
} from "@renderyes/capability-catalog";
import {
  createDataPlanningContract,
  executeDataRequest,
  executePlanDataRequests,
  validateDataRequestQuery,
} from "../dist/index.js";
import {
  applyValidatedQuery,
  firstOrderingViolation,
  projectRow,
} from "../dist/query.js";
import { DEFAULT_MAX_ROWS } from "../dist/index.js";

const restaurantSchema = {
  type: "array",
  items: {
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
};

const catalog = {
  schemaVersion: "1.0",
  id: "swiggy-food-data",
  version: "0.1.0",
  description: "Approved restaurant discovery data.",
  dataTypes: [
    {
      id: "RestaurantSearchResult",
      version: "1.0.0",
      description: "A nearby restaurant result.",
      schema: restaurantSchema.items,
      fields: {
        restaurantId: {
          label: "Restaurant ID",
          semanticType: "identifier",
        },
        name: { label: "Restaurant", semanticType: "text" },
        diet: {
          label: "Diet",
          description: "Approved dietary choice for this restaurant.",
          semanticType: "status",
        },
        distanceKm: {
          label: "Distance",
          semanticType: "quantity",
          unit: "km",
        },
      },
      matchKey: "restaurantId",
    },
  ],
  sources: [
    {
      id: "swiggy-restaurants",
      label: "Swiggy restaurant service",
    },
  ],
  capabilities: [
    {
      id: "restaurants.search",
      version: "1.0.0",
      purpose: "Find nearby restaurants matching an approved diet.",
      kind: "query",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["diet", "radiusKm"],
        properties: {
          diet: { enum: ["veg", "non-veg"] },
          radiusKm: {
            type: "number",
            minimum: 1,
            maximum: 20,
          },
        },
      },
      outputSchema: restaurantSchema,
      output: {
        dataTypeId: "RestaurantSearchResult",
        shape: "search-results",
      },
      requiredSessionKeys: ["deliveryLocationId"],
      sourceIds: ["swiggy-restaurants"],
      supports: {
        filterFields: ["diet", "name", "distanceKm"],
        sortFields: ["distanceKm"],
        groupFields: ["diet"],
        aggregates: ["count", "sum", "average", "minimum", "maximum"],
      },
      policy: {
        authentication: "session",
        requiredPermissions: ["restaurants.read"],
        maximumRows: 20,
        timeoutMs: 100,
      },
    },
  ],
  relationships: [],
};

const dataCatalog = {
  id: catalog.id,
  version: catalog.version,
  hash: hashCapabilityCatalog(catalog),
};

const request = {
  requestId: "nearby-non-veg",
  capabilityId: "restaurants.search",
  params: {
    diet: "non-veg",
    radiusKm: 5,
  },
};

const session = {
  viewerId: "viewer-123",
  deliveryLocationId: "saved-address-456",
  permissions: new Set(["restaurants.read"]),
  accessToken: "secret-token",
  cookie: "private-cookie",
};

function successfulResult() {
  return {
    ok: true,
    data: [
      {
        restaurantId: "restaurant-1",
        name: "Spice Kitchen",
        diet: "non-veg",
        distanceKm: 1.2,
      },
    ],
    provenance: {
      sources: [{ sourceId: "swiggy-restaurants" }],
      freshness: {
        asOf: "2026-07-28T00:00:00.000Z",
        staleAt: "2026-07-28T00:05:00.000Z",
      },
    },
  };
}

function createHarness(overrides = {}) {
  let runtimeCalls = 0;
  let runtimeInput;
  let runtimeContext;
  const auditEvents = [];
  const requestedSessionKeys = [];

  const runtime = {
    capabilityId: "restaurants.search",
    inputSchema: {},
    outputSchema: {},
    async execute(input, context) {
      runtimeCalls++;
      runtimeInput = input;
      runtimeContext = context;
      return successfulResult();
    },
    ...overrides.runtime,
  };
  const host = {
    isAuthenticated: (candidate) => candidate.viewerId !== undefined,
    hasPermission: (candidate, permission) => candidate.permissions.has(permission),
    getSessionValue(candidate, key) {
      requestedSessionKeys.push(key);
      return candidate[key];
    },
    allowExecution: () => true,
    audit(event) {
      auditEvents.push(event);
    },
    ...overrides.host,
  };

  return {
    runtimes: new Map([["restaurants.search", runtime]]),
    host,
    auditEvents,
    requestedSessionKeys,
    runtimeCalls: () => runtimeCalls,
    runtimeInput: () => runtimeInput,
    runtimeContext: () => runtimeContext,
  };
}

function execute(harness, overrides = {}) {
  return executeDataRequest({
    request,
    dataCatalog,
    catalog,
    runtimes: harness.runtimes,
    session,
    host: harness.host,
    ...overrides,
  });
}

test("executes with validated params and only required trusted identity", async () => {
  const harness = createHarness();
  const result = await execute(harness);

  assert.equal(result.ok, true);
  assert.deepEqual(harness.runtimeInput(), request.params);
  assert.deepEqual(harness.requestedSessionKeys, ["deliveryLocationId"]);
  assert.deepEqual(harness.runtimeContext().identity, {
    deliveryLocationId: "saved-address-456",
  });
  assert.equal("accessToken" in harness.runtimeContext().identity, false);
  assert.equal("permissions" in harness.runtimeContext().identity, false);
  assert.equal(harness.runtimeCalls(), 1);
  assert.equal(harness.auditEvents.length, 1);
  assert.equal(harness.auditEvents[0].outcome, "succeeded");
  assert.equal("params" in harness.auditEvents[0], false);
  assert.equal("identity" in harness.auditEvents[0], false);
});

test("rejects unauthenticated and unauthorized sessions before runtime", async () => {
  const unauthenticated = createHarness({
    host: { isAuthenticated: () => false },
  });
  const unauthenticatedResult = await execute(unauthenticated);
  assert.equal(unauthenticatedResult.error.code, "AUTHENTICATION_REQUIRED");
  assert.equal(unauthenticated.runtimeCalls(), 0);

  const unauthorized = createHarness({
    host: { hasPermission: () => false },
  });
  const unauthorizedResult = await execute(unauthorized);
  assert.equal(unauthorizedResult.error.code, "PERMISSION_DENIED");
  assert.equal(unauthorized.runtimeCalls(), 0);
});

test("rejects missing trusted identity and invalid content params", async () => {
  const missingIdentity = createHarness({
    host: { getSessionValue: () => undefined },
  });
  const missingIdentityResult = await execute(missingIdentity);
  assert.equal(missingIdentityResult.error.code, "MISSING_IDENTITY");
  assert.equal(missingIdentity.runtimeCalls(), 0);

  const invalidParams = createHarness();
  const invalidParamsResult = await execute(invalidParams, {
    request: {
      ...request,
      params: { diet: "anything", radiusKm: 500 },
    },
  });
  assert.equal(invalidParamsResult.error.code, "INVALID_PARAMS");
  assert.equal(invalidParams.runtimeCalls(), 0);
});

test("rejects catalog, capability, runtime, and rate-limit failures", async () => {
  const catalogMismatch = createHarness();
  const catalogMismatchResult = await execute(catalogMismatch, {
    dataCatalog: { ...dataCatalog, hash: "sha256:different" },
  });
  assert.equal(catalogMismatchResult.error.code, "DATA_CATALOG_MISMATCH");

  const unknownCapability = createHarness();
  const unknownCapabilityResult = await execute(unknownCapability, {
    request: { ...request, capabilityId: "restaurants.unapproved" },
  });
  assert.equal(unknownCapabilityResult.error.code, "UNKNOWN_CAPABILITY");

  const missingRuntime = createHarness();
  missingRuntime.runtimes.clear();
  const missingRuntimeResult = await execute(missingRuntime);
  assert.equal(missingRuntimeResult.error.code, "RUNTIME_NOT_FOUND");

  const rateLimited = createHarness({
    host: { allowExecution: () => false },
  });
  const rateLimitedResult = await execute(rateLimited);
  assert.equal(rateLimitedResult.error.code, "RATE_LIMITED");
  assert.equal(rateLimited.runtimeCalls(), 0);
});

test("rejects invalid runtime data, provenance, and row limits", async () => {
  const invalidData = createHarness({
    runtime: {
      async execute() {
        return {
          ...successfulResult(),
          data: [{ restaurantId: "missing-required-fields" }],
        };
      },
    },
  });
  const invalidDataResult = await execute(invalidData);
  assert.equal(invalidDataResult.error.code, "INVALID_RUNTIME_RESULT");

  const invalidSource = createHarness({
    runtime: {
      async execute() {
        const result = successfulResult();
        result.provenance.sources = [{ sourceId: "unapproved-source" }];
        return result;
      },
    },
  });
  const invalidSourceResult = await execute(invalidSource);
  assert.equal(invalidSourceResult.error.code, "INVALID_RUNTIME_RESULT");

  const tooManyRows = createHarness({
    runtime: {
      async execute() {
        const result = successfulResult();
        result.data = Array.from({ length: 21 }, (_, index) => ({
          restaurantId: `restaurant-${index}`,
          name: `Restaurant ${index}`,
          diet: "non-veg",
          distanceKm: 1,
        }));
        return result;
      },
    },
  });
  const tooManyRowsResult = await execute(tooManyRows);
  assert.equal(tooManyRowsResult.error.code, "INVALID_RUNTIME_RESULT");
});

test("preserves approved runtime failures and sanitizes thrown errors", async () => {
  const approvedFailure = createHarness({
    runtime: {
      async execute() {
        return {
          ok: false,
          error: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "Restaurant service unavailable",
            retryable: true,
          },
        };
      },
    },
  });
  const approvedFailureResult = await execute(approvedFailure);
  assert.deepEqual(approvedFailureResult, {
    ok: false,
    error: {
      code: "UPSTREAM_UNAVAILABLE",
      message: "Restaurant service unavailable",
      retryable: true,
    },
  });

  const thrown = createHarness({
    runtime: {
      async execute() {
        throw new Error("secret upstream host and token");
      },
    },
  });
  const thrownResult = await execute(thrown);
  assert.equal(thrownResult.error.code, "RUNTIME_ERROR");
  assert.equal(thrownResult.error.message, "Capability execution failed");
  assert.doesNotMatch(thrownResult.error.message, /secret|token/);
});

test("enforces timeout and external cancellation", async () => {
  const neverCompletes = () =>
    new Promise(() => {
      // The executor's AbortSignal and Promise.race enforce the boundary.
    });

  const timedOut = createHarness({
    runtime: { execute: neverCompletes },
  });
  const timedOutResult = await execute(timedOut, {
    options: { defaultTimeoutMs: 5, maximumTimeoutMs: 5 },
  });
  assert.equal(timedOutResult.error.code, "TIMEOUT");

  const cancelled = createHarness({
    runtime: { execute: neverCompletes },
  });
  const controller = new AbortController();
  controller.abort();
  const cancelledResult = await execute(cancelled, {
    signal: controller.signal,
  });
  assert.equal(cancelledResult.error.code, "ABORTED");
});

test("executes every request in an Plan 3.1 result map", async () => {
  const harness = createHarness();
  const plan = {
    schemaVersion: "3.1",
    planId: "swiggy-plan",
    siteId: "swiggy",
    catalog: {
      id: "swiggy-ui",
      version: "1.0.0",
      fingerprint: "ui-fingerprint",
    },
    dataCatalog,
    dataRequests: [request],
    surfaces: [],
    generation: {
      providerId: "hand-authored",
      modelId: "none",
      createdAt: "2026-07-28T00:00:00.000Z",
      repairCount: 0,
    },
  };
  const executed = await executePlanDataRequests({
    plan,
    catalog,
    runtimes: harness.runtimes,
    session,
    host: harness.host,
  });

  assert.equal(executed.planId, "swiggy-plan");
  assert.equal(executed.results["nearby-non-veg"].ok, true);
});

test("builds a model-facing query contract only from the planner-safe manifest", () => {
  const manifest = createPlannerManifest(catalog);
  const contract = createDataPlanningContract(manifest);
  const serialized = JSON.stringify(contract);
  const requestVariant = contract.jsonSchema.properties.dataRequests.items.anyOf[0];

  assert.equal(requestVariant.properties.capabilityId.const, "restaurants.search");
  assert.deepEqual(
    requestVariant.properties.query.properties.filter.properties.conditions.items.oneOf[0]
      .oneOf[0].properties.field.enum,
    ["diet", "name", "distanceKm"],
  );
  // A nested group is an allowed filter node (recursive tree).
  assert.equal(
    requestVariant.properties.query.properties.filter.properties.conditions.items.oneOf[1].properties.combine.enum.includes(
      "none",
    ),
    true,
  );
  assert.deepEqual(
    requestVariant.properties.query.properties.sort.items.properties.field.enum,
    ["distanceKm"],
  );
  assert.deepEqual(requestVariant.properties.query.properties.project.items.enum, [
    "restaurantId",
    "name",
    "diet",
    "distanceKm",
  ]);
  assert.equal(requestVariant.properties.query.properties.limit.maximum, 20);
  assert.match(serialized, /Approved dietary choice/);
  assert.match(serialized, /allowedValues.*non-veg/);
  assert.doesNotMatch(serialized, /deliveryLocationId|restaurants\.read/);
  assert.doesNotMatch(serialized, /accessToken|cookie|canonicalUrl/);
});

test("validates model-selected fields and limits against the planner manifest", () => {
  const manifest = createPlannerManifest(catalog);
  const valid = validateDataRequestQuery(manifest, {
    ...request,
    query: {
      filter: {
        combine: "all",
        conditions: [{ field: "diet", operator: "eq", value: "non-veg" }],
      },
      sort: [{ field: "distanceKm", direction: "asc" }],
      project: ["restaurantId", "name", "distanceKm"],
      limit: 5,
    },
  });
  assert.deepEqual(valid, { ok: true });

  const invalid = validateDataRequestQuery(manifest, {
    ...request,
    query: {
      filter: {
        combine: "all",
        conditions: [{ field: "internalScore", operator: "gt", value: 1 }],
      },
      sort: [{ field: "secretRank", direction: "asc" }],
      project: ["name", "contactEmail"],
      limit: 21,
    },
  });
  assert.equal(invalid.ok, false);
  assert.deepEqual(
    invalid.issues.map((issue) => issue.path),
    [
      "query.filter.conditions.0.field",
      "query.sort.0.field",
      "query.project.1",
      "query.limit",
    ],
  );
});

test("executes validated filter, stable sort, limit, and projection deterministically", async () => {
  const sourceRows = [
    {
      restaurantId: "restaurant-1",
      name: "Spice Kitchen",
      diet: "non-veg",
      distanceKm: 3.2,
    },
    {
      restaurantId: "restaurant-2",
      name: "Garden Spice",
      diet: "veg",
      distanceKm: 1.1,
    },
    {
      restaurantId: "restaurant-3",
      name: "Spice Route",
      diet: "non-veg",
      distanceKm: 1.1,
    },
    {
      restaurantId: "restaurant-4",
      name: "Spice Yard",
      diet: "non-veg",
      distanceKm: 2.4,
    },
    {
      restaurantId: "restaurant-5",
      name: "Spice Bay",
      diet: "non-veg",
      distanceKm: 1.1,
    },
  ];
  const harness = createHarness({
    runtime: {
      async execute() {
        return {
          ...successfulResult(),
          data: sourceRows,
        };
      },
    },
  });
  const result = await execute(harness, {
    request: {
      ...request,
      query: {
        filter: {
          combine: "all",
          conditions: [
            { field: "diet", operator: "eq", value: "non-veg" },
            { field: "name", operator: "contains", value: "Spice" },
            { field: "distanceKm", operator: "lte", value: 3 },
          ],
        },
        sort: [{ field: "distanceKm", direction: "asc" }],
        limit: 2,
        project: ["restaurantId", "name", "distanceKm"],
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, [
    {
      restaurantId: "restaurant-3",
      name: "Spice Route",
      distanceKm: 1.1,
    },
    {
      restaurantId: "restaurant-5",
      name: "Spice Bay",
      distanceKm: 1.1,
    },
  ]);
  assert.deepEqual(result.provenance, successfulResult().provenance);
  assert.equal("diet" in sourceRows[2], true);
});

const dietRows = [
  { restaurantId: "r1", name: "Spice Kitchen", diet: "non-veg", distanceKm: 3.2 },
  { restaurantId: "r2", name: "Garden Spice", diet: "veg", distanceKm: 1.1 },
  { restaurantId: "r3", name: "Spice Route", diet: "non-veg", distanceKm: 1.1 },
];

function rowsHarness(rows) {
  return createHarness({
    runtime: {
      async execute() {
        return { ...successfulResult(), data: rows };
      },
    },
  });
}

test("executes a nested AND/OR/NOT filter tree", async () => {
  const result = await execute(rowsHarness(dietRows), {
    request: {
      ...request,
      query: {
        filter: {
          combine: "all",
          conditions: [
            { field: "diet", operator: "eq", value: "non-veg" },
            {
              combine: "none",
              conditions: [{ field: "distanceKm", operator: "gt", value: 2 }],
            },
          ],
        },
        project: ["restaurantId"],
      },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, [{ restaurantId: "r3" }]);
});

test("executes a between range filter", async () => {
  const result = await execute(rowsHarness(dietRows), {
    request: {
      ...request,
      query: {
        filter: {
          combine: "all",
          conditions: [{ field: "distanceKm", operator: "between", value: [1, 2] }],
        },
        project: ["restaurantId"],
      },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, [{ restaurantId: "r2" }, { restaurantId: "r3" }]);
});

test("null and missing fields: is-null matches, value operators do not", () => {
  const rows = [
    { id: "a", note: "hi" },
    { id: "b" }, // missing note
    { id: "c", note: null },
  ];
  const isNull = applyValidatedQuery(rows, {
    filter: { combine: "all", conditions: [{ field: "note", operator: "is-null" }] },
    project: ["id"],
  });
  assert.deepEqual(isNull, [{ id: "b" }, { id: "c" }]);

  const equals = applyValidatedQuery(rows, {
    filter: {
      combine: "all",
      conditions: [{ field: "note", operator: "eq", value: "hi" }],
    },
    project: ["id"],
  });
  assert.deepEqual(equals, [{ id: "a" }]);
});

test("text filters normalize case, surrounding whitespace, and Unicode compatibility", () => {
  const rows = [
    {
      id: "match",
      owner: "Priya",
      priority: "Urgent",
      subject: "  Payment Failed  ",
      tags: ["VIP", "Escalated"],
      code: "ＡＢＣ-123",
    },
    {
      id: "other",
      owner: "Maya",
      priority: "High",
      subject: "Password reset",
      tags: ["Routine"],
      code: "XYZ-999",
    },
  ];

  const result = applyValidatedQuery(rows, {
    filter: {
      combine: "all",
      conditions: [
        { field: "owner", operator: "eq", value: " priya " },
        { field: "priority", operator: "in", value: ["urgent", "high"] },
        { field: "subject", operator: "contains", value: "PAYMENT" },
        { field: "subject", operator: "starts-with", value: "payment" },
        { field: "subject", operator: "ends-with", value: "FAILED" },
        { field: "tags", operator: "contains", value: "vip" },
        { field: "code", operator: "eq", value: "abc-123" },
        { field: "owner", operator: "not-eq", value: "maya" },
        { field: "owner", operator: "not-in", value: ["jon", "maya"] },
      ],
    },
    project: ["id"],
  });

  assert.deepEqual(result, [{ id: "match" }]);
});

test("normalized text filtering does not coerce or loosen non-string equality", () => {
  const rows = [
    { id: "number", value: 1 },
    { id: "text", value: "1" },
    { id: "boolean", value: true },
    { id: "array", value: ["A"] },
  ];

  const numeric = applyValidatedQuery(rows, {
    filter: {
      combine: "all",
      conditions: [{ field: "value", operator: "eq", value: 1 }],
    },
    project: ["id"],
  });
  assert.deepEqual(numeric, [{ id: "number" }]);

  const text = applyValidatedQuery(rows, {
    filter: {
      combine: "all",
      conditions: [{ field: "value", operator: "eq", value: " 1 " }],
    },
    project: ["id"],
  });
  assert.deepEqual(text, [{ id: "text" }]);

  const array = applyValidatedQuery(rows, {
    filter: {
      combine: "all",
      conditions: [{ field: "value", operator: "eq", value: ["a"] }],
    },
    project: ["id"],
  });
  assert.deepEqual(array, []);
});

test("groups rows and computes count/average/min/max", () => {
  const rows = [
    { diet: "veg", distanceKm: 1 },
    { diet: "veg", distanceKm: 3 },
    { diet: "non-veg", distanceKm: 2 },
  ];
  const result = applyValidatedQuery(rows, {
    groupBy: ["diet"],
    aggregates: [
      { op: "count", as: "n" },
      { op: "average", field: "distanceKm", as: "avg" },
      { op: "minimum", field: "distanceKm", as: "min" },
      { op: "maximum", field: "distanceKm", as: "max" },
    ],
  });
  assert.deepEqual(result, [
    { diet: "veg", n: 2, avg: 2, min: 1, max: 3 },
    { diet: "non-veg", n: 1, avg: 2, min: 2, max: 2 },
  ]);
});

test("ungrouped aggregates produce a single summary row", () => {
  const rows = [{ distanceKm: 1 }, { distanceKm: 2 }, { distanceKm: 3 }];
  const result = applyValidatedQuery(rows, {
    aggregates: [
      { op: "count", as: "total" },
      { op: "sum", field: "distanceKm", as: "sum" },
    ],
  });
  assert.deepEqual(result, [{ total: 3, sum: 6 }]);
});

test("sorts and projects over aggregated output columns", () => {
  const rows = [
    { diet: "veg", distanceKm: 1 },
    { diet: "veg", distanceKm: 3 },
    { diet: "non-veg", distanceKm: 2 },
  ];
  const result = applyValidatedQuery(rows, {
    groupBy: ["diet"],
    aggregates: [{ op: "count", as: "n" }],
    sort: [{ field: "n", direction: "desc" }],
    project: ["diet", "n"],
  });
  assert.deepEqual(result, [
    { diet: "veg", n: 2 },
    { diet: "non-veg", n: 1 },
  ]);
});

test("validates grouping/aggregates against the manifest and field types", () => {
  const manifest = createPlannerManifest(catalog);
  const valid = validateDataRequestQuery(manifest, {
    ...request,
    query: {
      groupBy: ["diet"],
      aggregates: [
        { op: "count", as: "n" },
        { op: "average", field: "distanceKm", as: "avg" },
      ],
      sort: [{ field: "n", direction: "desc" }],
      project: ["diet", "n"],
    },
  });
  assert.deepEqual(valid, { ok: true });

  const badType = validateDataRequestQuery(manifest, {
    ...request,
    query: { aggregates: [{ op: "sum", field: "name", as: "s" }] },
  });
  assert.equal(badType.ok, false);
  assert.equal(badType.issues[0].path, "query.aggregates.0.field");

  const badGroup = validateDataRequestQuery(manifest, {
    ...request,
    query: { groupBy: ["name"], aggregates: [{ op: "count", as: "n" }] },
  });
  assert.equal(badGroup.ok, false);
  assert.equal(
    badGroup.issues.some((i) => i.path === "query.groupBy.0"),
    true,
  );

  const badSort = validateDataRequestQuery(manifest, {
    ...request,
    query: {
      groupBy: ["diet"],
      aggregates: [{ op: "count", as: "n" }],
      sort: [{ field: "distanceKm", direction: "asc" }],
    },
  });
  assert.equal(badSort.ok, false);
  assert.equal(badSort.issues[0].path, "query.sort.0.field");
});

test("applies offset then limit after sorting", () => {
  const rows = [
    { restaurantId: "r1" },
    { restaurantId: "r2" },
    { restaurantId: "r3" },
    { restaurantId: "r4" },
  ];
  const page = applyValidatedQuery(rows, {
    sort: [{ field: "restaurantId", direction: "asc" }],
    offset: 1,
    limit: 2,
  });
  assert.deepEqual(
    page.map((row) => row.restaurantId),
    ["r2", "r3"],
  );
});

test("gates offset on the capability's pagination support", () => {
  const noPaging = validateDataRequestQuery(createPlannerManifest(catalog), {
    ...request,
    query: { offset: 2, limit: 2 },
  });
  assert.equal(noPaging.ok, false);
  assert.equal(noPaging.issues[0].path, "query.offset");

  const paged = structuredClone(catalog);
  paged.capabilities[0].supports.pagination = true;
  const ok = validateDataRequestQuery(createPlannerManifest(paged), {
    ...request,
    query: { offset: 2, limit: 2 },
  });
  assert.deepEqual(ok, { ok: true });
});

test("rejects an aggregate operator the capability does not advertise", () => {
  const countOnly = structuredClone(catalog);
  countOnly.capabilities[0].supports.aggregates = ["count"];
  const manifest = createPlannerManifest(countOnly);
  const result = validateDataRequestQuery(manifest, {
    ...request,
    query: { aggregates: [{ op: "sum", field: "distanceKm", as: "x" }] },
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((i) => i.path === "query.aggregates.0.op"),
    true,
  );
});

test("rejects operators incompatible with the field's semantic type", () => {
  const manifest = createPlannerManifest(catalog);
  // contains on a quantity field
  const textOnNumber = validateDataRequestQuery(manifest, {
    ...request,
    query: {
      filter: {
        combine: "all",
        conditions: [{ field: "distanceKm", operator: "contains", value: "x" }],
      },
    },
  });
  assert.equal(textOnNumber.ok, false);
  assert.equal(textOnNumber.issues[0].path, "query.filter.conditions.0.operator");

  // between on a status field, nested — proves recursive type-aware validation
  const rangeOnStatus = validateDataRequestQuery(manifest, {
    ...request,
    query: {
      filter: {
        combine: "any",
        conditions: [
          {
            combine: "all",
            conditions: [{ field: "diet", operator: "between", value: ["a", "b"] }],
          },
        ],
      },
    },
  });
  assert.equal(rangeOnStatus.ok, false);
  assert.equal(
    rangeOnStatus.issues[0].path,
    "query.filter.conditions.0.conditions.0.operator",
  );
});

test("rejects unsupported or malformed queries before calling the runtime", async () => {
  const unsupported = createHarness();
  const unsupportedResult = await execute(unsupported, {
    request: {
      ...request,
      query: {
        filter: {
          combine: "all",
          conditions: [{ field: "privateRank", operator: "gt", value: 1 }],
        },
      },
    },
  });
  assert.equal(unsupportedResult.error.code, "INVALID_QUERY");
  assert.equal(unsupported.runtimeCalls(), 0);

  const malformed = createHarness();
  const malformedResult = await execute(malformed, {
    request: {
      ...request,
      query: {
        filter: {
          combine: "all",
          conditions: [{ field: "diet", operator: "in", value: "non-veg" }],
        },
      },
    },
  });
  assert.equal(malformedResult.error.code, "INVALID_QUERY");
  assert.equal(malformed.runtimeCalls(), 0);
});

test("bounds how many capability requests run at once, preserving result mapping", async () => {
  let inFlight = 0;
  let peakInFlight = 0;
  const harness = createHarness({
    runtime: {
      execute: async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return {
          data: [],
          provenance: { sourceId: "s", asOf: "2026-01-01T00:00:00.000Z" },
        };
      },
    },
  });

  const dataRequests = Array.from({ length: 12 }, (_, index) => ({
    ...request,
    requestId: `r${index}`,
  }));
  const plan = {
    schemaVersion: "3.1",
    planId: "concurrency-plan",
    siteId: "swiggy",
    catalog: { id: "swiggy-ui", version: "1.0.0", fingerprint: "ui-fingerprint" },
    dataCatalog,
    dataRequests,
    surfaces: [],
    generation: {
      providerId: "hand-authored",
      modelId: "none",
      createdAt: "2026-07-28T00:00:00.000Z",
      repairCount: 0,
    },
  };

  const executed = await executePlanDataRequests({
    plan,
    catalog,
    runtimes: harness.runtimes,
    session,
    host: harness.host,
    options: { maxConcurrentRequests: 3 },
  });

  // The point of the bound: a 12-capability plan must not open 12 upstream
  // connections at once.
  assert.ok(peakInFlight <= 3, `peak concurrency was ${peakInFlight}, expected <= 3`);
  // Completion order must not scramble which result belongs to which request.
  assert.equal(Object.keys(executed.results).length, 12);
  for (let index = 0; index < 12; index += 1) {
    assert.ok(executed.results[`r${index}`], `missing result for r${index}`);
  }
});

test("projection rebuilds a nested list from parallel dotted fields", () => {
  // The drop-off funnel case. A capability whose approved fields are
  // `stages.key`/`stages.label`/`stages.count` used to project to three
  // unrelated top-level keys, so a component declaring
  // `stages: [{ key, label, count }]` received nothing renderable — the data
  // was fetched and then flattened away on the way out.
  const row = {
    total: 128,
    stages: [
      { key: "signup", label: "Signed up", step: 1, count: 80 },
      { key: "kyc", label: "Identity check", step: 2, count: 34 },
      { key: "payout", label: "Payout setup", step: 3, count: 14 },
    ],
  };

  const projected = projectRow(row, [
    "total",
    "stages.key",
    "stages.label",
    "stages.count",
  ]);

  assert.deepEqual(projected, {
    total: 128,
    stages: [
      { key: "signup", label: "Signed up", count: 80 },
      { key: "kyc", label: "Identity check", count: 34 },
      { key: "payout", label: "Payout setup", count: 14 },
    ],
  });
  // `step` was not approved, so it must not survive projection even though it
  // sits alongside fields that did.
  assert.ok(projected.stages.every((stage) => !("step" in stage)));
});

test("projection rebuilds a nested object without inventing array structure", () => {
  const projected = projectRow({ total: { open: 62, closed: 9 }, unrelated: "x" }, [
    "total.open",
    "total.closed",
  ]);
  assert.deepEqual(projected, { total: { open: 62, closed: 9 } });
});

test("a genuine top-level key containing a dot is projected literally", () => {
  // `readField` gives a real own-property priority over path traversal, and
  // projection has to agree with it or the two disagree about what the field
  // even names.
  const projected = projectRow({ "total.open": 5, total: { open: 99 } }, ["total.open"]);
  assert.deepEqual(projected, { "total.open": 5 });
});

test("projection drops a dotted field the row does not carry", () => {
  const projected = projectRow({ stages: [{ key: "signup" }] }, [
    "stages.key",
    "stages.missing",
  ]);
  assert.deepEqual(projected, { stages: [{ key: "signup" }] });
});

/** A runtime that hands back more rows than any plan asked for. */
function floodingHarness(rowCount) {
  return createHarness({
    runtime: {
      async execute() {
        return {
          ok: true,
          data: Array.from({ length: rowCount }, (_unused, index) => ({
            restaurantId: `restaurant-${index}`,
            name: `Place ${index}`,
            diet: "non-veg",
            distanceKm: 1.2,
          })),
          provenance: {
            sources: [{ sourceId: "swiggy-restaurants" }],
            freshness: { asOf: "2026-07-28T00:00:00.000Z" },
          },
        };
      },
    },
  });
}

test("truncates an oversized result to the row budget and says so", async () => {
  // The planner's `limit` bounds what a plan may ask for, which is not what an
  // upstream returns. A capability that ignores paging hands back everything it
  // has, and that payload crosses the wire to a browser and gets rendered.
  // 15 rows, not 500: the fixture capability declares `maximumRows: 20`, and
  // exceeding that is rejected by result validation before truncation is ever
  // reached. Staying under it is what makes this test measure the budget
  // rather than the validator.
  const harness = floodingHarness(15);
  const result = await execute(harness, { options: { maxRowsPerRequest: 10 } });

  assert.equal(result.ok, true);
  assert.equal(result.data.length, 10);
  // Reported, not silent: a truncated collection presented as a whole one is a
  // wrong answer, not a smaller one.
  assert.equal(result.provenance.truncated, true);
  assert.equal(result.provenance.totalRowsBeforeTruncation, 15);
  // The rows kept are the first N, not an arbitrary window.
  assert.equal(result.data[0].restaurantId, "restaurant-0");
  assert.equal(result.data[9].restaurantId, "restaurant-9");
});

test("a result inside the budget is untouched and carries no truncation flag", async () => {
  const harness = floodingHarness(3);
  const result = await execute(harness, { options: { maxRowsPerRequest: 10 } });
  assert.equal(result.data.length, 3);
  assert.equal(result.provenance.truncated, undefined);
  assert.equal(result.provenance.totalRowsBeforeTruncation, undefined);
});

test("the row budget applies with no query on the request at all", async () => {
  // The case with nothing else bounding it: no `limit` to validate against.
  const harness = floodingHarness(15);
  const result = await execute(harness, {
    request: { ...request, query: undefined },
    options: { maxRowsPerRequest: 10 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 10);
  assert.equal(result.provenance.truncated, true);
  assert.equal(result.provenance.totalRowsBeforeTruncation, 15);
});

test("the row budget still bounds a result when the host omits the option", async () => {
  // Every other budget test passes `maxRowsPerRequest: 10`, so the default was
  // never exercised: replacing DEFAULT_MAX_ROWS with Number.MAX_SAFE_INTEGER
  // left the whole suite green. The omitted-option path is the one most hosts
  // actually run, and unbounded rows here cross the wire into a browser.
  const uncapped = structuredClone(catalog);
  // The fixture's own maximumRows: 20 would be rejected by result validation
  // long before the budget is reached, so it has to go for this to measure the
  // budget rather than the validator.
  delete uncapped.capabilities[0].policy.maximumRows;

  const harness = floodingHarness(DEFAULT_MAX_ROWS + 5);
  const result = await execute(harness, {
    catalog: uncapped,
    // The hash travels with the catalog, so editing one without the other trips
    // DATA_CATALOG_MISMATCH before the budget is ever consulted.
    dataCatalog: { id: uncapped.id, version: uncapped.version, hash: hashCapabilityCatalog(uncapped) },
    request: { ...request, query: undefined },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.length, DEFAULT_MAX_ROWS);
  assert.equal(result.provenance.truncated, true);
  assert.equal(result.provenance.totalRowsBeforeTruncation, DEFAULT_MAX_ROWS + 5);
});

test("the planner contract caps limit even when a capability declares no maximumRows", async () => {
  // `limit: { minimum: 1 }` with no maximum made `limit: 1000000` a
  // schema-legal plan. A capability that legitimately serves more overrides
  // this by declaring `maximumRows`.
  const manifest = createPlannerManifest(catalog);
  const contract = createDataPlanningContract(manifest);
  const limit =
    contract.jsonSchema.properties.dataRequests.items.anyOf[0].properties.query.properties
      .limit;
  assert.equal(limit.minimum, 1);
  // This fixture declares maximumRows: 20, so its own ceiling wins. What
  // matters is that a maximum is always present — the default only applies
  // where a capability declares none, and that case used to be unbounded.
  assert.equal(limit.maximum, 20);
  // And the case the fix is actually for: a capability declaring no ceiling of
  // its own now inherits the default instead of being unbounded.
  // Cloned from the manifest rather than the catalog: the contract reads
  // `constraints.maximumRows` off the planner manifest, and the catalog object
  // does not survive a structural clone intact.
  const unbounded = structuredClone(manifest);
  delete unbounded.capabilities[0].constraints.maximumRows;
  const unboundedLimit =
    createDataPlanningContract(unbounded).jsonSchema.properties.dataRequests.items
      .anyOf[0].properties.query.properties.limit;
  assert.equal(unboundedLimit.maximum, DEFAULT_MAX_ROWS);
});

test("rejects a limit above the default ceiling when the capability declares no maximumRows", () => {
  // Same fixture with the row cap removed, which is what most real
  // capabilities look like.
  const uncapped = structuredClone(catalog);
  delete uncapped.capabilities[0].policy.maximumRows;
  const manifest = createPlannerManifest(uncapped);

  const tooMany = validateDataRequestQuery(manifest, {
    ...request,
    query: { limit: DEFAULT_MAX_ROWS + 1 },
  });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.issues[0].path, "query.limit");
  assert.match(tooMany.issues[0].message, /default maximum of 1000 rows/);

  // The contract advertises this ceiling as the `limit` maximum, so validation
  // has to accept everything up to it — otherwise a plan the model was told was
  // legal gets rejected.
  const atCeiling = validateDataRequestQuery(manifest, {
    ...request,
    query: { limit: DEFAULT_MAX_ROWS },
  });
  assert.equal(atCeiling.ok, true);
});

test("a limit within the declared maximum is still accepted, and above it still names the capability's own bound", () => {
  const manifest = createPlannerManifest(catalog);
  assert.equal(
    validateDataRequestQuery(manifest, { ...request, query: { limit: 20 } }).ok,
    true,
  );
  const over = validateDataRequestQuery(manifest, { ...request, query: { limit: 21 } });
  assert.equal(over.ok, false);
  assert.match(over.issues[0].message, /exceeds capability maximum 20/);
});

test("rejects a filter value the field's declared enum does not allow", () => {
  const manifest = createPlannerManifest(catalog);

  // `diet` is `enum: ["veg", "non-veg"]`. "Vegan" executes happily against a
  // real upstream and matches nothing, and an empty result is indistinguishable
  // from a correct answer — the visitor reads "no restaurants" and believes it.
  const wrongValue = validateDataRequestQuery(manifest, {
    ...request,
    query: {
      filter: {
        combine: "all",
        conditions: [{ field: "diet", operator: "eq", value: "Vegan" }],
      },
    },
  });
  assert.equal(wrongValue.ok, false);
  assert.equal(wrongValue.issues[0].path, "query.filter.conditions.0.value");
  assert.match(wrongValue.issues[0].message, /not an allowed value for field "diet"/);
  // The message lists what is legal, so a repair attempt has what it needs.
  assert.match(wrongValue.issues[0].message, /"veg", "non-veg"/);

  const allowed = validateDataRequestQuery(manifest, {
    ...request,
    query: {
      filter: {
        combine: "all",
        conditions: [{ field: "diet", operator: "eq", value: "veg" }],
      },
    },
  });
  assert.equal(allowed.ok, true);
});

test("enum checking covers every member of an in-list and leaves substring operators alone", () => {
  const manifest = createPlannerManifest(catalog);

  const oneBadMember = validateDataRequestQuery(manifest, {
    ...request,
    query: {
      filter: {
        combine: "all",
        conditions: [{ field: "diet", operator: "in", value: ["veg", "Vegan"] }],
      },
    },
  });
  assert.equal(oneBadMember.ok, false);
  assert.match(oneBadMember.issues[0].message, /"Vegan" is not an allowed value/);

  // `contains` takes a substring, and a substring of an enum member is a
  // legitimate query — enforcing membership here would reject valid plans.
  const substring = validateDataRequestQuery(manifest, {
    ...request,
    query: {
      filter: {
        combine: "all",
        conditions: [{ field: "diet", operator: "contains", value: "veg" }],
      },
    },
  });
  assert.equal(substring.ok, true);

  // A field with no declared enum is unconstrained, as before.
  const freeText = validateDataRequestQuery(manifest, {
    ...request,
    query: {
      filter: {
        combine: "all",
        conditions: [{ field: "name", operator: "eq", value: "anything at all" }],
      },
    },
  });
  assert.equal(freeText.ok, true);
});

test("refuses an identity-scoped capability whose runtime cannot forward identity", async () => {
  // `restaurants.search` declares `requiredSessionKeys: ["deliveryLocationId"]`,
  // which reads as "these results belong to this delivery location". A runtime
  // that cannot forward identity would call the upstream unscoped and return
  // every row it serves — under the name of a capability the catalog says is
  // scoped. Answering an over-broad question looks exactly like answering the
  // right one, so the request is refused instead.
  const result = await executeDataRequest({
    request,
    dataCatalog,
    catalog,
    runtimes: new Map([
      [
        "restaurants.search",
        {
          capabilityId: "restaurants.search",
          forwardsIdentity: false,
          execute: async () => {
            throw new Error("must not be executed");
          },
        },
      ],
    ]),
    session,
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: (_session, key) => session[key],
      allowExecution: () => true,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CONFIGURATION_ERROR");
  assert.match(result.error.message, /cannot forward them/);
  // Not retryable: no session and no retry can fix the deployment's wiring.
  assert.equal(result.error.retryable, false);
});

test("a runtime that does not declare forwardsIdentity is presumed capable", async () => {
  // A hand-written runtime receives `identity` as an argument and is presumed to
  // use it. The flag exists so an adapter can admit it cannot, not to make every
  // runtime prove it can — defaulting the other way would break every existing
  // manual capability with session keys.
  let sawIdentity;
  const result = await executeDataRequest({
    request,
    dataCatalog,
    catalog,
    runtimes: new Map([
      [
        "restaurants.search",
        {
          capabilityId: "restaurants.search",
          execute: async (_input, context) => {
            sawIdentity = context.identity;
            return successfulResult();
          },
        },
      ],
    ]),
    session,
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: (_session, key) => session[key],
      allowExecution: () => true,
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(sawIdentity, { deliveryLocationId: "saved-address-456" });
});

/**
 * A caller who passes the wrong key — `runtime` instead of `runtimes`, easy to
 * do from JS — used to reach `input.runtimes.get(...)` on undefined. The
 * TypeError hit the broad catch that turns any throw into RUNTIME_ERROR, so a
 * call that can never succeed was reported as a data failure worth retrying,
 * and a host's retry logic would repeat it.
 */
test("a missing runtimes map is a caller mistake, not a retryable data failure", async () => {
  const harness = createHarness();
  const result = await execute(harness, { runtimes: undefined });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "RUNTIME_NOT_FOUND");
  assert.equal(result.error.retryable, false);
  assert.match(result.error.message, /must be a Map/);
  // Nothing ran, so nothing should claim to have run.
  assert.equal(harness.runtimeCalls(), 0);
});

/**
 * A host that resolves permissions by asking its own API resolves *none* when
 * the visitor's credential is rejected — an expired token is still an
 * authenticated session, just an empty one. The bare message is true about the
 * resolved session and a false lead about the cause, and in one integration it
 * cost a day.
 */
test("a denied permission names the credential as a possible cause", async () => {
  const harness = createHarness({ host: { hasPermission: () => false } });
  const result = await execute(harness);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PERMISSION_DENIED");
  // The permission is still named — this adds a cause, it does not replace the fact.
  assert.match(result.error.message, /Missing required permission/);
  assert.match(result.error.message, /still authenticates upstream/);
  assert.equal(result.error.retryable, false);
});

test("refuses to aggregate a truncated result instead of answering from one page", async () => {
  // The one failure class in this executor that produces a clean number which
  // looks exactly like the answer: "count by status" over the single page a
  // capped upstream returned reports the page's counts as the dataset's. A
  // four-day evaluation shipped `FULFILLED: 52` where the true figure was
  // 1391 of 2500 — enabled by declaring aggregates, exactly as documented.
  const harness = createHarness({
    runtime: {
      async execute() {
        return {
          ...successfulResult(),
          data: [
            { restaurantId: "restaurant-1", name: "A", diet: "veg", distanceKm: 1 },
            { restaurantId: "restaurant-2", name: "B", diet: "non-veg", distanceKm: 2 },
          ],
          provenance: {
            sources: [{ sourceId: "swiggy-restaurants" }],
            freshness: { asOf: "2026-07-28T00:00:00.000Z" },
            truncated: true,
            moreAvailable: true,
            totalRowsBeforeTruncation: 2500,
          },
        };
      },
    },
  });
  const result = await execute(harness, {
    request: {
      ...request,
      query: {
        groupBy: ["diet"],
        aggregates: [{ op: "count", as: "n" }],
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TRUNCATED_AGGREGATION");
  // The refusal names the scale of the wrongness and what to do instead.
  assert.match(result.error.message, /2500/);
  assert.match(result.error.message, /filter/);
  assert.equal(result.error.retryable, false);
});

test("still aggregates when the rows are complete for what was asked", async () => {
  // `moreAvailable` alone must not trip the refusal: a plan that asked for
  // these rows and got all of them may summarize them. Only `truncated` — the
  // answer itself cut short — poisons an aggregate.
  const harness = createHarness({
    runtime: {
      async execute() {
        return {
          ...successfulResult(),
          data: [
            { restaurantId: "restaurant-1", name: "A", diet: "veg", distanceKm: 1 },
            { restaurantId: "restaurant-2", name: "B", diet: "non-veg", distanceKm: 2 },
            { restaurantId: "restaurant-3", name: "C", diet: "veg", distanceKm: 3 },
          ],
          provenance: {
            sources: [{ sourceId: "swiggy-restaurants" }],
            freshness: { asOf: "2026-07-28T00:00:00.000Z" },
            moreAvailable: true,
          },
        };
      },
    },
  });
  const result = await execute(harness, {
    request: {
      ...request,
      query: { groupBy: ["diet"], aggregates: [{ op: "count", as: "n" }] },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, [
    { diet: "veg", n: 2 },
    { diet: "non-veg", n: 1 },
  ]);
});

/** A page of rows plus provenance saying whether the collection goes on. */
function pagedHarness(rows, provenanceExtra = {}) {
  // Overriding `execute` replaces createHarness's own context capture, so
  // record it here — these tests assert on what limit reached the fetch.
  let lastContext;
  const harness = createHarness({
    runtime: {
      async execute(_input, context) {
        lastContext = context;
        return {
          ok: true,
          data: rows,
          provenance: {
            sources: [{ sourceId: "swiggy-restaurants" }],
            freshness: { asOf: "2026-07-28T00:00:00.000Z" },
            ...provenanceExtra,
          },
        };
      },
    },
  });
  return { ...harness, runtimeContext: () => lastContext };
}

function pageRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    restaurantId: `restaurant-${index}`,
    name: `Place ${index}`,
    diet: index % 2 === 0 ? "veg" : "non-veg",
    distanceKm: index + 1,
  }));
}

test("a filtered lookup no longer bounds the fetch by the plan's limit", async () => {
  // `filter: name == "Place 7", limit: 1` used to fetch ONE row (whatever the
  // upstream returns first) and filter it — any record outside that row was
  // reported as nonexistent with ok:true. The limit applies to the *filtered*
  // set, so the fetch must not be bounded by it.
  const harness = pagedHarness(pageRows(10));
  const result = await execute(harness, {
    request: {
      ...request,
      query: {
        filter: {
          combine: "all",
          conditions: [{ field: "name", operator: "eq", value: "Place 7" }],
        },
        limit: 1,
      },
    },
  });
  assert.equal(result.ok, true);
  // The fetch was not narrowed to the plan's limit.
  assert.equal(harness.runtimeContext().limit, undefined);
  // Filter ran before limit: the match at row 7 of the page was found.
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].restaurantId, "restaurant-7");
});

test("a bare limit is still pushed into the fetch", async () => {
  const harness = pagedHarness(pageRows(3));
  const result = await execute(harness, {
    request: { ...request, query: { limit: 3 } },
  });
  assert.equal(result.ok, true);
  assert.equal(harness.runtimeContext().limit, 3);
});

test("a filter over a provably incomplete fetch marks the result narrowed", async () => {
  // The page satisfied its own ask — no `truncated` — but the dataset goes on,
  // so a plan-level filter may have missed every matching row in the pages
  // never fetched. The result must not be reportable as complete.
  const harness = pagedHarness(pageRows(10), { moreAvailable: true });
  const result = await execute(harness, {
    request: {
      ...request,
      query: {
        filter: {
          combine: "all",
          conditions: [{ field: "diet", operator: "eq", value: "veg" }],
        },
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.provenance.narrowedAfterFetch, true);
  assert.equal(result.provenance.rowsBeforeNarrowing, 10);
  assert.equal(result.provenance.moreAvailable, true);
});

test("a filter that empties an incomplete page is narrowed, not a confident zero", async () => {
  // The worst case live: "which warehouse holds stock for X" matched nothing
  // in the fetched page of 584 and reported 0 rows as complete. The answer
  // lived outside the page.
  const harness = pagedHarness(pageRows(10), { moreAvailable: true });
  const result = await execute(harness, {
    request: {
      ...request,
      query: {
        filter: {
          combine: "all",
          conditions: [{ field: "name", operator: "eq", value: "No Such Place" }],
        },
      },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, []);
  assert.equal(result.provenance.narrowedAfterFetch, true);
  assert.equal(result.provenance.rowsBeforeNarrowing, 10);
});

test("narrowing never clears the fetch's own truncation provenance", async () => {
  const harness = pagedHarness(pageRows(10), {
    truncated: true,
    moreAvailable: true,
    totalRowsBeforeTruncation: 2500,
  });
  const result = await execute(harness, {
    request: {
      ...request,
      query: {
        filter: {
          combine: "all",
          conditions: [{ field: "diet", operator: "eq", value: "veg" }],
        },
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.provenance.truncated, true);
  assert.equal(result.provenance.moreAvailable, true);
  assert.equal(result.provenance.totalRowsBeforeTruncation, 2500);
  assert.equal(result.provenance.narrowedAfterFetch, true);
});

test("a post-fetch operation over a provably complete fetch stays un-narrowed", async () => {
  // The control case from the live evaluation: the server narrowed to 55 rows
  // and the plan sorted them. Sorting the complete set is the whole answer.
  const harness = pagedHarness(pageRows(5));
  const result = await execute(harness, {
    request: {
      ...request,
      query: {
        filter: {
          combine: "all",
          conditions: [{ field: "diet", operator: "eq", value: "veg" }],
        },
        sort: [{ field: "distanceKm", direction: "desc" }],
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.provenance.narrowedAfterFetch, undefined);
  assert.equal(result.provenance.rowsBeforeNarrowing, undefined);
});

test("a sort over an incomplete fetch is narrowed — its top N is the page's, not the dataset's", async () => {
  const harness = pagedHarness(pageRows(10), { moreAvailable: true });
  const result = await execute(harness, {
    request: {
      ...request,
      query: { sort: [{ field: "distanceKm", direction: "desc" }], limit: 3 },
    },
  });
  assert.equal(result.ok, true);
  // Sort blocks the limit pushdown too: fetching only 3 rows and sorting them
  // is "the 3 newest, rearranged", not the top 3.
  assert.equal(harness.runtimeContext().limit, undefined);
  assert.equal(result.provenance.narrowedAfterFetch, true);
});

test("moreAvailable alone on a met bare limit keeps meaning answer-complete", async () => {
  // "Top 5 of a big dataset": the fetch honoured the limit and the collection
  // goes on. Nothing was narrowed after the fetch, so the answer is complete
  // and only `moreAvailable` rides along.
  const harness = pagedHarness(pageRows(5), { moreAvailable: true });
  const result = await execute(harness, {
    request: { ...request, query: { limit: 5 } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.provenance.narrowedAfterFetch, undefined);
  assert.equal(result.provenance.moreAvailable, true);
  assert.equal(result.provenance.truncated, undefined);
});

test("an offset window running off the end of an incomplete fetch is narrowed", async () => {
  // The fixture capability does not advertise pagination; the window case
  // needs one that does.
  const pagingCatalog = structuredClone(catalog);
  pagingCatalog.capabilities[0].supports.pagination = true;
  const harness = pagedHarness(pageRows(10), { moreAvailable: true });
  const result = await execute(harness, {
    catalog: pagingCatalog,
    dataCatalog: {
      id: pagingCatalog.id,
      version: pagingCatalog.version,
      hash: hashCapabilityCatalog(pagingCatalog),
    },
    request: { ...request, query: { offset: 8, limit: 5 } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 2);
  assert.equal(result.provenance.narrowedAfterFetch, true);
});

test("query.limit validates against the page cap when the contract states one", () => {
  // Two ceilings used to disagree: policy.maximumRows and the transport page
  // cap the compiled contract puts on a connection's paging argument. A limit
  // between them passed validation against a page that can never hold it.
  const cappedCatalog = structuredClone(catalog);
  cappedCatalog.capabilities[0].inputSchema.properties.first = {
    type: "integer",
    minimum: 1,
    maximum: 5,
  };
  const manifest = createPlannerManifest(cappedCatalog);
  const over = validateDataRequestQuery(manifest, {
    ...request,
    query: { limit: 10 },
  });
  assert.equal(over.ok, false);
  // The one actionable sentence names the effective ceiling — the smaller of
  // the two — not the row budget the page can never reach.
  assert.match(over.issues[0].message, /exceeds capability maximum 5/);

  const within = validateDataRequestQuery(manifest, {
    ...request,
    query: { limit: 5 },
  });
  assert.equal(within.ok, true);

  // The contract advertises the same effective ceiling it validates.
  const contract = createDataPlanningContract(manifest);
  const contractText = JSON.stringify(contract.jsonSchema);
  assert.match(contractText, /"maximum":5/);
});

test("a zero-capability catalog is refused at publish", async () => {
  const { createCapabilityCatalogStore } = await import("../dist/registry.js");
  const store = createCapabilityCatalogStore();
  const empty = { ...catalog, capabilities: [], relationships: [] };
  assert.throws(
    () => store.publish({ catalog: empty, bindings: {} }),
    /declares no capabilities/,
  );
});

test("the contract offers is-null and states the null-comparison rule", () => {
  // Execution has always treated null as failing every comparison (covered
  // above); the planner owns the other half — absence-means-unbounded needs an
  // explicit is-null branch, and the contract must both offer the operator and
  // say when to reach for it. Motivating case: "promotions running now"
  // filtered endDate >= today and nulled out every promotion with no end date.
  const manifest = createPlannerManifest(catalog);
  const contract = createDataPlanningContract(manifest);
  const schemaText = JSON.stringify(contract.jsonSchema);
  assert.match(schemaText, /"is-null"/);
  assert.match(schemaText, /"is-not-null"/);
  assert.match(contract.systemPrompt, /null field value fails every comparison/);
  assert.match(contract.systemPrompt, /is-null/);
  assert.match(contract.systemPrompt, /unbounded or open-ended/);
});

/**
 * Ordering pushed to the source.
 *
 * The behaviour these cover is not "the sort argument gets rendered" — that is
 * the catalog's test. It is what the executor decides *around* a pushed
 * ordering: that the plan's limit becomes safe to push, that the answer stops
 * being reported as page-bounded, and that a source which ignored the ordering
 * is refused rather than believed. Each of the three is wrong in a different
 * direction if the executor gets it backwards.
 */

const ORDERING = {
  argument: "sort",
  ascending: "{field}",
  descending: "-{field}",
  list: false,
};

const BY_DISTANCE_DESC = [{ field: "distanceKm", direction: "desc" }];

function orderedRows(distances) {
  return distances.map((distanceKm, index) => ({
    restaurantId: `restaurant-${index + 1}`,
    name: `Spice Kitchen ${index + 1}`,
    diet: "non-veg",
    distanceKm,
  }));
}

function pagedResult(distances) {
  return {
    ok: true,
    data: orderedRows(distances),
    provenance: {
      sources: [{ sourceId: "swiggy-restaurants" }],
      freshness: {
        asOf: "2026-07-28T00:00:00.000Z",
        staleAt: "2026-07-28T00:05:00.000Z",
      },
      // The whole point of the exercise: more rows exist than came back, so
      // an ordering applied here would be an ordering of a fragment.
      moreAvailable: true,
    },
  };
}

test("a declared ordering is sent as typed terms, and the plan's limit rides with it", async () => {
  const harness = createHarness({
    runtime: {
      ordering: ORDERING,
      async execute() {
        return pagedResult([9.4, 8.1]);
      },
    },
  });
  // The override above replaces execute, so the harness's own recorder is gone;
  // read the context through a second wrapper instead.
  let seen;
  harness.runtimes.set("restaurants.search", {
    ...harness.runtimes.get("restaurants.search"),
    async execute(input, context) {
      seen = context;
      return pagedResult([9.4, 8.1]);
    },
  });

  const result = await execute(harness, {
    request: { ...request, query: { sort: BY_DISTANCE_DESC, limit: 2 } },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(seen.sort, BY_DISTANCE_DESC);
  // Pushed only because the ordering was: the source's first two rows are the
  // plan's top two exactly when the source ordered them.
  assert.equal(seen.limit, 2);
  // And the answer is complete for what was asked, so it must not be labelled
  // as narrowed after the fetch.
  assert.equal(result.provenance.narrowedAfterFetch, undefined);
});

test("with no declared ordering nothing is pushed and the answer says it is page-bounded", async () => {
  let seen;
  const harness = createHarness({
    runtime: {
      async execute(input, context) {
        seen = context;
        return pagedResult([2.2, 9.4, 8.1]);
      },
    },
  });

  const result = await execute(harness, {
    request: { ...request, query: { sort: BY_DISTANCE_DESC, limit: 2 } },
  });

  assert.equal(result.ok, true);
  assert.equal(seen.sort, undefined);
  // Unchanged from before ordering push-down existed: sorting here means the
  // limit bounds a derived set, so it cannot bound the fetch.
  assert.equal(seen.limit, undefined);
  assert.equal(result.provenance.narrowedAfterFetch, true);
  assert.equal(result.provenance.rowsBeforeNarrowing, 3);
});

test("a source that ignored the ordering it was sent is refused, not returned", async () => {
  const harness = createHarness({
    runtime: {
      ordering: ORDERING,
      async execute() {
        // What an upstream does with an ordering expression it cannot parse:
        // answers in its own default order and says nothing.
        return pagedResult([2.2, 9.4]);
      },
    },
  });

  const result = await execute(harness, {
    request: { ...request, query: { sort: BY_DISTANCE_DESC, limit: 2 } },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ORDERING_NOT_APPLIED");
  assert.match(result.error.message, /did not apply the ordering it was sent/);
  assert.match(result.error.message, /distanceKm/);
  // Names the declaration a host would have to fix, and says why the rows are
  // not simply handed back in a corrected order.
  assert.match(result.error.message, /orderingArgument/);
  assert.match(result.error.message, /they are different rows/);
  assert.equal(result.error.retryable, false);
});

test("equal values are not read as an ignored ordering", async () => {
  // The check has to tolerate every ordering an upstream might legitimately
  // apply. Rows that tie on the ordering field may come back in any order, and
  // judging that as a failure would refuse correct answers.
  const harness = createHarness({
    runtime: {
      ordering: ORDERING,
      async execute() {
        return pagedResult([9.4, 9.4, 8.1]);
      },
    },
  });

  const result = await execute(harness, {
    request: { ...request, query: { sort: BY_DISTANCE_DESC } },
  });

  assert.equal(result.ok, true);
});

test("a row missing the ordering field is skipped, not judged", () => {
  // Null placement is the upstream's own convention — first, last, or by
  // collation — so disagreeing with ours is not evidence the ordering was
  // dropped. Exercised directly because a null in this field fails the
  // capability's own output contract long before the ordering check runs.
  const missingInTheMiddle = [
    { distanceKm: 9.4 },
    { distanceKm: null },
    { distanceKm: 8.1 },
  ];
  assert.equal(
    firstOrderingViolation(missingInTheMiddle, BY_DISTANCE_DESC),
    undefined,
  );
  // The comparison every ordering agrees on is still caught.
  assert.deepEqual(
    firstOrderingViolation([{ distanceKm: 8.1 }, { distanceKm: 9.4 }], BY_DISTANCE_DESC),
    { index: 1, field: "distanceKm" },
  );
  // A tie on the first term is decided by the second, not waved through.
  assert.deepEqual(
    firstOrderingViolation(
      [
        { diet: "veg", distanceKm: 1 },
        { diet: "veg", distanceKm: 2 },
      ],
      [
        { field: "diet", direction: "asc" },
        { field: "distanceKm", direction: "desc" },
      ],
    ),
    { index: 1, field: "distanceKm" },
  );
});
