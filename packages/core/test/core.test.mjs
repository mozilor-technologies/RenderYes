import assert from "node:assert/strict";
import test from "node:test";
import {
  composePlan,
  createCatalog,
  defineCatalog,
  defineComponent,
  defineRegistry,
  migrateV1Layout,
  toA2UICatalogDefinition,
  validatePlan,
} from "../dist/index.js";

function objectProps(jsonSchema, validate) {
  return {
    jsonSchema,
    safeParse(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { success: false, issues: [{ path: [], message: "Expected object" }] };
      }
      return validate(value);
    },
  };
}

const registry = defineRegistry({
  id: "finance-demo",
  version: "3.0.0",
  components: [
    defineComponent({
      id: "Stack",
      version: "1.0.0",
      description: "Groups related widgets",
      props: objectProps(
        {
          type: "object",
          required: ["title"],
          properties: { title: { type: "string" } },
          additionalProperties: false,
        },
        (value) =>
          typeof value.title === "string"
            ? { success: true, data: { title: value.title } }
            : {
                success: false,
                issues: [{ path: ["title"], message: "Expected string" }],
              },
      ),
      slots: {
        content: {
          description: "Widgets in the stack",
          cardinality: "many",
          accepts: ["Portfolio", "News"],
        },
      },
    }),
    defineComponent({
      id: "Portfolio",
      version: "1.0.0",
      description: "Shows the visitor portfolio",
      props: objectProps(
        {
          type: "object",
          properties: { compact: { type: "boolean", default: false } },
          additionalProperties: false,
        },
        (value) =>
          value.compact === undefined || typeof value.compact === "boolean"
            ? { success: true, data: { compact: value.compact ?? false } }
            : {
                success: false,
                issues: [{ path: ["compact"], message: "Expected boolean" }],
              },
      ),
      policy: { maxInstances: 1 },
    }),
    defineComponent({
      id: "News",
      version: "1.0.0",
      description: "Shows selected news",
      props: objectProps(
        {
          type: "object",
          required: ["category"],
          properties: { category: { enum: ["markets", "crypto"] } },
          additionalProperties: false,
        },
        (value) =>
          value.category === "markets" || value.category === "crypto"
            ? { success: true, data: { category: value.category } }
            : {
                success: false,
                issues: [{ path: ["category"], message: "Expected markets or crypto" }],
              },
      ),
    }),
  ],
});

function plan() {
  return {
    schemaVersion: "3.0",
    planId: "plan-1",
    siteId: "finance-demo",
    sourcePrompt: "Only show my portfolio",
    catalog: {
      id: registry.id,
      version: registry.version,
      fingerprint: registry.fingerprint,
    },
    surfaces: [
      {
        id: "main",
        nodes: [
          {
            nodeId: "stack-1",
            componentId: "Stack",
            props: { title: "My money" },
            slots: {
              content: [
                {
                  nodeId: "portfolio-1",
                  componentId: "Portfolio",
                  props: {},
                },
              ],
            },
          },
        ],
      },
    ],
    generation: {
      providerId: "mock",
      modelId: "mock-1",
      createdAt: "2026-07-24T00:00:00.000Z",
      repairCount: 0,
    },
  };
}

function dataAwarePlan() {
  const candidate = plan();
  candidate.schemaVersion = "3.1";
  candidate.dataCatalog = {
    id: "renderyes.support",
    version: "0.1.0",
    hash: "sha256:catalog-review-example",
  };
  candidate.dataRequests = [
    {
      requestId: "support-volume",
      capabilityId: "trends.volume",
      params: { dateRange: "last30days" },
    },
  ];
  candidate.surfaces[0].nodes[0].dataBindings = {
    rows: { requestId: "support-volume" },
  };
  return candidate;
}

test("validates registered components and applies prop defaults", () => {
  const result = validatePlan(plan(), registry);
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.surfaces[0].nodes[0].slots.content[0].props, {
    compact: false,
  });
});

test("accepts Plan 3.1 capability requests and request-id bindings", () => {
  const result = validatePlan(dataAwarePlan(), registry);
  assert.equal(result.ok, true);
  assert.equal(result.plan.schemaVersion, "3.1");
  assert.equal(result.plan.dataRequests[0].capabilityId, "trends.volume");
  assert.equal(
    result.plan.surfaces[0].nodes[0].dataBindings.rows.requestId,
    "support-volume",
  );
});

test("accepts a closed model-selectable query on an Plan 3.1 request", () => {
  const candidate = dataAwarePlan();
  candidate.dataRequests[0].query = {
    filter: {
      combine: "all",
      conditions: [
        { field: "status", operator: "in", value: ["open", "pending"] },
        { field: "assignee", operator: "is-not-null" },
      ],
    },
    sort: [{ field: "priority", direction: "desc" }],
    project: ["ticketId", "status", "priority"],
    limit: 10,
  };

  const result = validatePlan(candidate, registry);
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.dataRequests[0].query, candidate.dataRequests[0].query);
});

test("rejects malformed or executable query content", () => {
  const candidate = dataAwarePlan();
  candidate.dataRequests[0].query = {
    filter: {
      combine: "all",
      conditions: [
        { field: "status", operator: "in", value: "open" },
        { field: "assignee", operator: "is-null", value: "attacker" },
      ],
    },
    sort: [{ field: "priority", direction: "sideways" }],
    project: ["ticketId", "ticketId"],
    limit: 0,
    javascript: "return process.env",
  };

  const result = validatePlan(candidate, registry);
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((issue) => issue.path === "dataRequests.0.query.javascript"),
    true,
  );
  assert.equal(
    result.issues.some((issue) => issue.path === "dataRequests.0.query.limit"),
    true,
  );
  assert.equal(
    result.issues.some((issue) => issue.path === "dataRequests.0.query.project.1"),
    true,
  );
  assert.equal(
    result.issues.some(
      (issue) => issue.path === "dataRequests.0.query.filter.conditions.0.value",
    ),
    true,
  );
});

test("rejects duplicate Plan 3.1 request ids", () => {
  const candidate = dataAwarePlan();
  candidate.dataRequests.push({ ...candidate.dataRequests[0] });
  const result = validatePlan(candidate, registry);

  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "duplicate-data-request"),
    true,
  );
});

test("rejects unknown Plan 3.1 binding request references", () => {
  const candidate = dataAwarePlan();
  candidate.surfaces[0].nodes[0].dataBindings.rows.requestId = "missing";
  const result = validatePlan(candidate, registry);

  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "unknown-data-request"),
    true,
  );
});

function filterPlan(filter) {
  const candidate = dataAwarePlan();
  candidate.dataRequests[0].query = { filter };
  return candidate;
}

test("accepts a nested all/any/none filter tree", () => {
  const result = validatePlan(
    filterPlan({
      combine: "any",
      conditions: [
        { field: "priority", operator: "in", value: ["Urgent", "High"] },
        {
          combine: "none",
          conditions: [{ field: "owner", operator: "eq", value: "Unassigned" }],
        },
      ],
    }),
    registry,
  );
  assert.equal(result.ok, true);
});

test("accepts a between range and rejects a malformed one", () => {
  assert.equal(
    validatePlan(
      filterPlan({
        combine: "all",
        conditions: [{ field: "change", operator: "between", value: [0, 10] }],
      }),
      registry,
    ).ok,
    true,
  );
  const bad = validatePlan(
    filterPlan({
      combine: "all",
      conditions: [{ field: "change", operator: "between", value: [1] }],
    }),
    registry,
  );
  assert.equal(bad.ok, false);
  assert.equal(
    bad.issues.some((issue) => issue.path.endsWith(".value")),
    true,
  );
});

test("rejects a filter nested beyond the depth budget", () => {
  let node = { field: "priority", operator: "eq", value: "Urgent" };
  for (let i = 0; i < 6; i++) node = { combine: "all", conditions: [node] };
  const result = validatePlan(filterPlan(node), registry);
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "filter-too-deep"),
    true,
  );
});

test("rejects a filter over the total-condition budget with a single issue", () => {
  const conditions = Array.from({ length: 40 }, () => ({
    field: "priority",
    operator: "eq",
    value: "Urgent",
  }));
  const result = validatePlan(filterPlan({ combine: "any", conditions }), registry);
  assert.equal(result.ok, false);
  const tooLarge = result.issues.filter((issue) => issue.code === "filter-too-large");
  assert.equal(tooLarge.length, 1);
});

test("still accepts a flat all/any filter (backward compatible)", () => {
  const result = validatePlan(
    filterPlan({
      combine: "all",
      conditions: [{ field: "priority", operator: "eq", value: "Urgent" }],
    }),
    registry,
  );
  assert.equal(result.ok, true);
});

function queryPlan(query) {
  const candidate = dataAwarePlan();
  candidate.dataRequests[0].query = query;
  return candidate;
}

test("accepts groupBy with count and numeric aggregates", () => {
  const result = validatePlan(
    queryPlan({
      groupBy: ["priority"],
      aggregates: [
        { op: "count", as: "total" },
        { op: "average", field: "score", as: "avgScore" },
      ],
    }),
    registry,
  );
  assert.equal(result.ok, true);
});

test("rejects aggregate field misuse and duplicate output names", () => {
  const missingField = validatePlan(
    queryPlan({ aggregates: [{ op: "sum", as: "s" }] }),
    registry,
  );
  assert.equal(missingField.ok, false);
  assert.equal(
    missingField.issues.some((i) => i.path === "dataRequests.0.query.aggregates.0.field"),
    true,
  );

  const countWithField = validatePlan(
    queryPlan({ aggregates: [{ op: "count", field: "x", as: "c" }] }),
    registry,
  );
  assert.equal(countWithField.ok, false);

  const duplicateAs = validatePlan(
    queryPlan({
      groupBy: ["owner"],
      aggregates: [{ op: "count", as: "owner" }],
    }),
    registry,
  );
  assert.equal(duplicateAs.ok, false);
  assert.equal(
    duplicateAs.issues.some((i) => i.path === "dataRequests.0.query.aggregates.0.as"),
    true,
  );

  // Two aggregates sharing an output name (the asNames-collision half).
  const collidingAggregates = validatePlan(
    queryPlan({
      aggregates: [
        { op: "count", as: "n" },
        { op: "sum", field: "score", as: "n" },
      ],
    }),
    registry,
  );
  assert.equal(collidingAggregates.ok, false);
  assert.equal(
    collidingAggregates.issues.some(
      (i) => i.path === "dataRequests.0.query.aggregates.1.as",
    ),
    true,
  );
});

test("accepts a non-negative offset and rejects a negative one", () => {
  assert.equal(validatePlan(queryPlan({ offset: 2, limit: 2 }), registry).ok, true);
  const bad = validatePlan(queryPlan({ offset: -1 }), registry);
  assert.equal(bad.ok, false);
  assert.equal(
    bad.issues.some((i) => i.path === "dataRequests.0.query.offset"),
    true,
  );
});

function compositionPlan() {
  const candidate = dataAwarePlan();
  candidate.dataRequests = [
    { requestId: "movers", capabilityId: "market.topMovers", params: {} },
    { requestId: "watchlist", capabilityId: "market.watchlist", params: {} },
  ];
  candidate.dataCompositions = [
    {
      compositionId: "movers-in-watchlist",
      operation: "intersection",
      inputs: ["movers", "watchlist"],
      query: { sort: [{ field: "change", direction: "desc" }], limit: 20 },
    },
  ];
  candidate.surfaces[0].nodes[0].dataBindings = {
    rows: { compositionId: "movers-in-watchlist" },
  };
  return candidate;
}

test("accepts an Plan 3.1 composition and composition binding", () => {
  const result = validatePlan(compositionPlan(), registry);
  assert.equal(result.ok, true);
  assert.equal(result.plan.dataCompositions[0].operation, "intersection");
  assert.equal(
    result.plan.surfaces[0].nodes[0].dataBindings.rows.compositionId,
    "movers-in-watchlist",
  );
});

test("rejects a composition with fewer than two inputs", () => {
  const candidate = compositionPlan();
  candidate.dataCompositions[0].inputs = ["movers"];
  const result = validatePlan(candidate, registry);
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "composition-too-few-inputs"),
    true,
  );
});

test("rejects a composition input that references an unknown request", () => {
  const candidate = compositionPlan();
  candidate.dataCompositions[0].inputs = ["movers", "missing"];
  const result = validatePlan(candidate, registry);
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "unknown-composition-input"),
    true,
  );
});

test("rejects a composition id that collides with a request id", () => {
  const candidate = compositionPlan();
  candidate.dataCompositions[0].compositionId = "movers";
  const result = validatePlan(candidate, registry);
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "duplicate-data-composition"),
    true,
  );
});

test("rejects a filter in a composition query (deferred to the query language)", () => {
  const candidate = compositionPlan();
  candidate.dataCompositions[0].query = {
    filter: {
      combine: "all",
      conditions: [{ field: "change", operator: "gt", value: 0 }],
    },
  };
  const result = validatePlan(candidate, registry);
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "composition-filter-unsupported"),
    true,
  );
});

test("rejects a binding that references an unknown composition", () => {
  const candidate = compositionPlan();
  candidate.surfaces[0].nodes[0].dataBindings.rows.compositionId = "missing";
  const result = validatePlan(candidate, registry);
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "unknown-data-composition"),
    true,
  );
});

test("rejects a data binding that names both a request and a composition", () => {
  const candidate = compositionPlan();
  candidate.surfaces[0].nodes[0].dataBindings.rows = {
    requestId: "movers",
    compositionId: "movers-in-watchlist",
  };
  const result = validatePlan(candidate, registry);
  assert.equal(result.ok, false);
});

test("does not allow data compositions on an Plan 3.0", () => {
  const candidate = plan();
  candidate.dataCompositions = [];
  const result = validatePlan(candidate, registry);
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((issue) => issue.path === "dataCompositions"),
    true,
  );
});

function joinPlan() {
  const candidate = dataAwarePlan();
  candidate.dataRequests = [
    { requestId: "tickets", capabilityId: "tickets.search", params: {} },
    { requestId: "agents", capabilityId: "agents.list", params: {} },
  ];
  candidate.dataJoins = [
    {
      joinId: "tickets-with-agent",
      relationshipId: "ticket-owner-agent",
      left: "tickets",
      right: "agents",
      as: "agent",
    },
  ];
  candidate.surfaces[0].nodes[0].dataBindings = {
    rows: { joinId: "tickets-with-agent" },
  };
  return candidate;
}

test("accepts an Plan 3.1 join and join binding", () => {
  const result = validatePlan(joinPlan(), registry);
  assert.equal(result.ok, true);
  assert.equal(result.plan.dataJoins[0].relationshipId, "ticket-owner-agent");
  assert.equal(
    result.plan.surfaces[0].nodes[0].dataBindings.rows.joinId,
    "tickets-with-agent",
  );
});

test("rejects join inputs referencing unknown requests and self-joins", () => {
  const unknownInput = joinPlan();
  unknownInput.dataJoins[0].right = "missing";
  const unknown = validatePlan(unknownInput, registry);
  assert.equal(unknown.ok, false);
  assert.equal(
    unknown.issues.some((i) => i.code === "unknown-join-input"),
    true,
  );

  const selfJoin = joinPlan();
  selfJoin.dataJoins[0].right = "tickets";
  const self = validatePlan(selfJoin, registry);
  assert.equal(self.ok, false);
});

test("rejects a binding referencing an unknown join", () => {
  const candidate = joinPlan();
  candidate.surfaces[0].nodes[0].dataBindings.rows.joinId = "missing";
  const result = validatePlan(candidate, registry);
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((i) => i.code === "unknown-data-join"),
    true,
  );
});

test("keeps data identity and runtime details outside the 3.1 request envelope", () => {
  const candidate = dataAwarePlan();
  candidate.dataRequests[0].identity = { viewerId: "visitor-1" };
  const result = validatePlan(candidate, registry);

  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some(
      (issue) =>
        issue.path === "dataRequests.0.identity" && issue.code === "invalid-plan",
    ),
    true,
  );
});

test("keeps Plan 3.1 as a closed wire contract", () => {
  const candidate = dataAwarePlan();
  candidate.session = { cookie: "not-allowed" };
  candidate.surfaces[0].nodes[0].a2uiPath = "/attacker/selected/path";
  const result = validatePlan(candidate, registry);

  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((issue) => issue.path === "session"),
    true,
  );
  assert.equal(
    result.issues.some((issue) => issue.path === "surfaces.0.nodes.0.a2uiPath"),
    true,
  );
});

test("does not silently add 3.1 data fields to Plan 3.0", () => {
  const candidate = plan();
  candidate.dataRequests = [];
  candidate.surfaces[0].nodes[0].dataBindings = {};
  const result = validatePlan(candidate, registry);

  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((issue) => issue.path === "dataRequests"),
    true,
  );
  assert.equal(
    result.issues.some((issue) => issue.path === "surfaces.0.nodes.0.dataBindings"),
    true,
  );
});

test("rejects slot component violations", () => {
  const candidate = plan();
  candidate.surfaces[0].nodes[0].slots.content.push({
    nodeId: "bad",
    componentId: "Stack",
    props: { title: "Nested" },
  });
  const result = validatePlan(candidate, registry);
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "slot-component"),
    true,
  );
});

test("binds A2UI-style catalog definitions to trusted renderers", () => {
  const definitions = defineCatalog({
    catalogId: "https://example.com/catalogs/finance/v1/catalog.json",
    version: "1.0.0",
    components: registry.components,
  });
  const renderers = createCatalog(definitions, {
    Stack: () => "stack",
    Portfolio: () => "portfolio",
    News: () => "news",
  });
  const document = toA2UICatalogDefinition(definitions);

  assert.equal(renderers.getRenderer("Portfolio")(), "portfolio");
  assert.equal(document.catalogId, definitions.catalogId);
  assert.equal(document.components.Stack.properties.content.type, "array");
  assert.equal(document.components.Surface.properties.children.type, "array");
});

test("migrates v1 flattened children when a component has one slot", () => {
  const migrated = migrateV1Layout(
    {
      schemaVersion: "1.0",
      layoutId: "old-plan",
      generatedAt: "2026-07-24T00:00:00.000Z",
      regions: [
        {
          id: "main",
          nodes: [
            {
              nodeId: "stack",
              componentId: "Stack",
              props: { title: "Old" },
              children: [
                {
                  nodeId: "portfolio",
                  componentId: "Portfolio",
                  props: {},
                },
              ],
            },
          ],
        },
      ],
      meta: { providerId: "mock", modelId: "v1" },
    },
    registry,
    { siteId: "finance-demo" },
  );

  assert.equal(migrated.schemaVersion, "3.0");
  assert.equal(migrated.surfaces[0].nodes[0].slots.content[0].componentId, "Portfolio");
});

test("repairs an invalid provider draft and returns a validated plan", async () => {
  const responses = [
    {
      surfaces: [
        {
          id: "main",
          nodes: [{ nodeId: "bad", componentId: "Unknown", props: {} }],
        },
      ],
    },
    {
      surfaces: [
        {
          id: "main",
          nodes: [
            { nodeId: "portfolio", componentId: "Portfolio", props: { compact: true } },
          ],
        },
      ],
    },
  ];
  const prompts = [];
  const provider = {
    id: "mock",
    async generatePlan(request) {
      prompts.push(request.userPrompt);
      return { value: responses.shift(), modelId: "mock-model" };
    },
  };

  const result = await composePlan({
    siteId: "finance-demo",
    prompt: "Only show my portfolio",
    surfaceIds: ["main"],
    registry,
    provider,
    createId: () => "plan-2",
    now: () => new Date("2026-07-24T00:00:00.000Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.plan.generation.repairCount, 1);
  assert.equal(result.plan.surfaces[0].nodes[0].componentId, "Portfolio");
  assert.match(prompts[1], /Unknown component/);
});

test("generation may carry constrainedDecoding, and only as a boolean", () => {
  const withFlag = plan();
  withFlag.generation.constrainedDecoding = false;
  assert.equal(validatePlan(withFlag, registry).ok, true);

  const withBadFlag = plan();
  withBadFlag.generation.constrainedDecoding = "yes";
  const rejected = validatePlan(withBadFlag, registry);
  assert.equal(rejected.ok, false);
  assert.ok(
    rejected.issues.some((issue) => issue.path.includes("constrainedDecoding")),
  );

  // Absent stays legal — a custom provider is not forced to report it.
  assert.equal(validatePlan(plan(), registry).ok, true);
});

// The plan<->registry agreement check had no test: replacing the whole guard
// with `if (false)` left the suite green. Each term is covered separately
// because the fingerprint term is the one that fires in the ordinary case — a
// component re-registered without a version bump — and dropping just that term
// also went unnoticed.

test("a plan naming a different catalog id is rejected", () => {
  const candidate = plan();
  candidate.catalog.id = "someone-elses-catalog";
  const result = validatePlan(candidate, registry);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "catalog-mismatch"));
});

test("a plan naming a different catalog version is rejected", () => {
  const candidate = plan();
  candidate.catalog.version = "9.9.9";
  const result = validatePlan(candidate, registry);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "catalog-mismatch"));
});

test("a plan whose fingerprint drifted is rejected, and the message names the fingerprint", () => {
  const candidate = plan();
  candidate.catalog.fingerprint = "sha256:stale-registration";
  const result = validatePlan(candidate, registry);
  assert.equal(result.ok, false);

  const issue = result.issues.find((entry) => entry.code === "catalog-mismatch");
  assert.ok(issue, "a fingerprint drift must produce catalog-mismatch");
  // id and version match here, so a message built only from `id@version` would
  // read "x@3.0.0 does not match x@3.0.0" and name nothing that differs.
  assert.match(issue.message, /fingerprint/);
  assert.match(issue.message, /sha256:stale-registration/);
});

test("allowCatalogMismatch is the only way past the agreement check", () => {
  const candidate = plan();
  candidate.catalog.fingerprint = "sha256:stale-registration";
  assert.equal(validatePlan(candidate, registry).ok, false);
  assert.equal(
    validatePlan(candidate, registry, { allowCatalogMismatch: true }).ok,
    true,
  );
});

function nestedPlan(levels) {
  const candidate = plan();
  let node = candidate.surfaces[0].nodes[0];
  for (let i = 0; i < levels; i++) {
    const child = {
      nodeId: `nested-${i}`,
      componentId: "Stack",
      props: { title: `level ${i}` },
      slots: { content: [] },
    };
    node.slots = { content: [child] };
    node = child;
  }
  return candidate;
}

test("a plan nested past the semantic limit reports max-depth and stops descending", () => {
  // The max-depth issue used to be recorded without returning, so the limit
  // bounded the report but not the walk.
  const result = validatePlan(nestedPlan(20), registry, { maxDepth: 5 });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "max-depth"));

  // One issue, not one per level below the limit — proof the walk actually stops.
  assert.equal(result.issues.filter((issue) => issue.code === "max-depth").length, 1);
});

test("a pathologically nested plan returns issues rather than throwing RangeError", () => {
  // validatePlan's contract is to return issues, and callers treat it as total:
  // on the server this surfaced as HTTP 400 with the body "Maximum call stack
  // size exceeded". The overflow was in the *structural* parse, which runs
  // before any option-driven depth limit applies, so bounding the semantic walk
  // alone did not fix it.
  const result = validatePlan(nestedPlan(5000), registry);
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some((issue) => /structural limit/.test(issue.message)),
    "the structural bound should be what rejects it",
  );
});

test("the structural cap is a safety bound, not a depth policy", () => {
  // Nesting within the cap must not be rejected *by the cap*. This registry's
  // Stack accepts only Portfolio and News, so a 30-deep Stack chain does fail —
  // on slot acceptance. What matters is that neither depth bound is what fires.
  const result = validatePlan(nestedPlan(30), registry, { maxDepth: 50 });
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some(
      (issue) => issue.code === "max-depth" || /structural limit/.test(issue.message),
    ),
    false,
  );
});
