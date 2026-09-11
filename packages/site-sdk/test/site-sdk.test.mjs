import assert from "node:assert/strict";
import test from "node:test";
import {
  compilePlanDataSurfaceMessages,
  compileSurfaceMessages,
  createSiteCatalogStore,
  defineComponent,
  defineProps,
  defineSite,
  defineSiteFromManifest,
  defineSource,
  defineSurface,
  defineTheme,
  field,
  resolveSource,
  resolveSourceSync,
  projectPlanDataModel,
  DEFAULT_VISITOR_ERROR_MESSAGE,
  themeToCssVariables,
  toSiteManifest,
  validatePlanDataBindings,
} from "../dist/index.js";

const TicketQueue = defineComponent({
  id: "TicketQueue",
  version: "1.0.0",
  description: "An approved support ticket queue.",
  props: defineProps({
    density: field.enum(["comfortable", "compact"], {
      default: "comfortable",
    }),
    maxRows: field.number({
      integer: true,
      minimum: 1,
      maximum: 50,
      default: 20,
    }),
  }),
  renderer: {
    component: "ResponsiveDataTable",
    props: {
      title: { path: "/tickets/title" },
      caption: { path: "/tickets/caption" },
      columns: { path: "/tickets/columns" },
      rows: { path: "/tickets/rows" },
      state: { path: "/tickets/state" },
      emptyMessage: { path: "/tickets/emptyMessage" },
      errorMessage: { path: "/tickets/errorMessage" },
    },
  },
  dataSlots: {
    rows: {
      accepts: [
        {
          dataTypeId: "SupportTicket",
          shapes: ["collection", "search-results"],
        },
      ],
    },
  },
});

const supportSite = defineSite({
  id: "support-ops",
  name: "Support operations",
  version: "1.0.0",
  catalogId: "https://support.example.com/renderyes/catalog.json",
  components: [TicketQueue],
  surfaces: [
    defineSurface({
      id: "support-main",
      description: "Main support workspace.",
      componentIds: ["TicketQueue"],
      maxComponents: 1,
    }),
  ],
  theme: defineTheme({
    id: "support-theme",
    tokens: {
      primary: "#6d28d9",
      ink: "#261849",
      radius: 16,
    },
  }),
});

test("applies prop defaults and rejects unknown props", () => {
  const valid = TicketQueue.props.safeParse({});
  assert.equal(valid.success, true);
  assert.deepEqual(valid.data, { density: "comfortable", maxRows: 20 });

  const invalid = TicketQueue.props.safeParse({ sql: "select *" });
  assert.equal(invalid.success, false);
  assert.equal(invalid.issues[0].message, "Unknown property");
});

test("validates surfaces against registered components", () => {
  assert.throws(
    () =>
      defineSite({
        id: "broken-site",
        name: "Broken",
        version: "1.0.0",
        catalogId: "https://example.com/broken.json",
        components: [TicketQueue],
        surfaces: [
          defineSurface({
            id: "main",
            description: "Broken surface.",
            componentIds: ["UnknownComponent"],
          }),
        ],
        theme: supportSite.theme,
      }),
    /references unknown component/,
  );
});

test("compiles only allowed registered instances into A2UI messages", () => {
  const messages = compileSurfaceMessages(supportSite, {
    surfaceId: "support-main",
    a2uiCatalogId: "https://renderyes.dev/catalogs/standard/v1",
    instances: [
      {
        id: "ticket-queue",
        componentId: "TicketQueue",
        props: { density: "compact", maxRows: 12 },
      },
    ],
    dataModel: {
      tickets: {
        title: "Priority queue",
        caption: "Approved tickets",
        columns: [],
        rows: [],
        state: "empty",
        emptyMessage: "No tickets",
        errorMessage: "Unavailable",
      },
    },
  });

  assert.equal(messages.length, 3);
  assert.equal(
    messages[1].updateComponents.components[1].component,
    "ResponsiveDataTable",
  );
  assert.equal(messages[1].updateComponents.components[1].density, "compact");
  assert.deepEqual(messages[1].updateComponents.components[1].rows, {
    path: "/tickets/rows",
  });
});

const StatCard = defineComponent({
  id: "StatCard",
  version: "1.0.0",
  description: "A small approved stat display.",
  props: defineProps({}),
  renderer: { component: "Text", props: { text: { path: "/stat/label" } } },
});

// A container with a cardinality "one" slot under a non-"children" name, so
// the nested-compile mechanism is exercised on a different shape than the
// demo's cardinality "many" / slot-named-"children" dashboard.
const SummaryPanel = defineComponent({
  id: "SummaryPanel",
  version: "1.0.0",
  description: "A container with a single named headline slot.",
  props: defineProps({}),
  renderer: { component: "Column", props: {} },
  slots: {
    headline: {
      description: "The single stat shown at the top of the panel.",
      cardinality: "one",
      accepts: ["StatCard"],
    },
  },
});

const nestedSite = defineSite({
  id: "nested-demo",
  name: "Nested demo",
  version: "1.0.0",
  catalogId: "https://example.com/nested/catalog.json",
  components: [StatCard, SummaryPanel],
  surfaces: [
    defineSurface({
      id: "panel-surface",
      description: "A panel workspace.",
      componentIds: ["SummaryPanel", "StatCard"],
      maxComponents: 1,
    }),
  ],
  theme: defineTheme({ id: "nested-theme", tokens: { primary: "#111827" } }),
});

test("compiles a nested cardinality-one slot to a single child id", () => {
  const messages = compileSurfaceMessages(nestedSite, {
    surfaceId: "panel-surface",
    a2uiCatalogId: "https://renderyes.dev/catalogs/standard/v1",
    instances: [
      {
        id: "panel",
        componentId: "SummaryPanel",
        props: {},
        slots: {
          headline: [{ id: "stat-1", componentId: "StatCard", props: {} }],
        },
      },
    ],
    dataModel: {},
  });

  const components = messages[1].updateComponents.components;
  // Root wraps only the top-level instance; the nested child is not a root child.
  assert.deepEqual(components[0].children, ["panel"]);
  const panel = components.find((component) => component.id === "panel");
  const stat = components.find((component) => component.id === "stat-1");
  assert.ok(panel && stat);
  // Cardinality "one" compiles to a single id, not an array.
  assert.equal(panel.headline, "stat-1");
  assert.equal(stat.component, "Text");
});

test("throws rather than silently emitting a bogus prop for an undeclared slot", () => {
  assert.throws(
    () =>
      compileSurfaceMessages(nestedSite, {
        surfaceId: "panel-surface",
        a2uiCatalogId: "https://renderyes.dev/catalogs/standard/v1",
        instances: [
          {
            id: "panel",
            componentId: "SummaryPanel",
            props: {},
            slots: {
              // "footnote" is not a slot SummaryPanel declares.
              footnote: [{ id: "stat-1", componentId: "StatCard", props: {} }],
            },
          },
        ],
        dataModel: {},
      }),
    /SummaryPanel does not declare slot footnote/,
  );
});

test("validatePlanDataBindings rejects a nested plan that violates slot cardinality or accepts", () => {
  const plannerManifest = {
    schemaVersion: "1.0",
    catalogId: "nested-data",
    catalogVersion: "0.1.0",
    catalogHash: "h",
    description: "x",
    dataTypes: [],
    capabilities: [],
    relationships: [],
  };
  const basePlan = (slots) => ({
    schemaVersion: "3.1",
    planId: "p1",
    siteId: nestedSite.id,
    catalog: {
      id: nestedSite.catalog.id,
      version: nestedSite.catalog.version,
      fingerprint: nestedSite.catalog.fingerprint,
    },
    dataCatalog: { id: "nested-data", version: "0.1.0", hash: "h" },
    dataRequests: [],
    surfaces: [
      {
        id: "panel-surface",
        nodes: [{ nodeId: "panel", componentId: "SummaryPanel", props: {}, slots }],
      },
    ],
    generation: {
      providerId: "test",
      modelId: "test",
      createdAt: "2026-07-29T00:00:00.000Z",
      repairCount: 0,
    },
  });

  // Over cardinality: "one" allows at most one child.
  const overCardinality = validatePlanDataBindings(
    nestedSite,
    basePlan({
      headline: [
        { nodeId: "s1", componentId: "StatCard", props: {} },
        { nodeId: "s2", componentId: "StatCard", props: {} },
      ],
    }),
    plannerManifest,
  );
  assert.equal(overCardinality.ok, false);

  // Wrong child: SummaryPanel only accepts StatCard in `headline`.
  const wrongChild = validatePlanDataBindings(
    nestedSite,
    basePlan({
      headline: [{ nodeId: "s1", componentId: "SummaryPanel", props: {} }],
    }),
    plannerManifest,
  );
  assert.equal(wrongChild.ok, false);

  // A valid nested plan passes.
  const valid = validatePlanDataBindings(
    nestedSite,
    basePlan({
      headline: [{ nodeId: "s1", componentId: "StatCard", props: {} }],
    }),
    plannerManifest,
  );
  assert.equal(valid.ok, true);
});

test("rejects invalid model-selected instance props", () => {
  assert.throws(
    () =>
      compileSurfaceMessages(supportSite, {
        surfaceId: "support-main",
        a2uiCatalogId: "https://renderyes.dev/catalogs/standard/v1",
        instances: [
          {
            id: "ticket-queue",
            componentId: "TicketQueue",
            props: { density: "microscopic" },
          },
        ],
        dataModel: {},
      }),
    /Invalid props for TicketQueue/,
  );
});

test("rejects component props that collide with trusted renderer bindings", () => {
  assert.throws(
    () =>
      defineComponent({
        id: "UnsafeQueue",
        version: "1.0.0",
        description: "A component with an unsafe binding collision.",
        props: defineProps({
          rows: field.stringArray(),
        }),
        renderer: {
          component: "ResponsiveDataTable",
          props: {
            rows: { path: "/trusted/rows" },
          },
        },
      }),
    /prop rows conflicts with a registered renderer binding/,
  );
});

test("defends against runtime prop contracts overriding renderer bindings", () => {
  const unsafeContractComponent = defineComponent({
    id: "RuntimeUnsafeQueue",
    version: "1.0.0",
    description: "A component whose custom contract hides its prop names.",
    props: {
      jsonSchema: {
        type: "object",
        additionalProperties: false,
      },
      safeParse() {
        return {
          success: true,
          data: {
            rows: ["model-authored-override"],
          },
        };
      },
    },
    renderer: {
      component: "ResponsiveDataTable",
      props: {
        rows: { path: "/trusted/rows" },
      },
    },
  });
  const unsafeSite = defineSite({
    id: "runtime-unsafe",
    name: "Runtime unsafe",
    version: "1.0.0",
    catalogId: "https://example.com/runtime-unsafe.json",
    components: [unsafeContractComponent],
    surfaces: [
      defineSurface({
        id: "main",
        description: "Runtime collision test.",
        componentIds: ["RuntimeUnsafeQueue"],
      }),
    ],
    theme: supportSite.theme,
  });

  assert.throws(
    () =>
      compileSurfaceMessages(unsafeSite, {
        surfaceId: "main",
        a2uiCatalogId: "https://renderyes.dev/catalogs/standard/v1",
        instances: [
          {
            id: "unsafe",
            componentId: "RuntimeUnsafeQueue",
          },
        ],
        dataModel: {
          trusted: {
            rows: [],
          },
        },
      }),
    /cannot override its registered renderer binding/,
  );
});

test("accepts only caller-created JSON data models", () => {
  const trustedDataModel = {
    tickets: {
      title: "Trusted queue",
      rows: [],
    },
  };
  const messages = compileSurfaceMessages(supportSite, {
    surfaceId: "support-main",
    a2uiCatalogId: "https://renderyes.dev/catalogs/standard/v1",
    instances: [
      {
        id: "ticket-queue",
        componentId: "TicketQueue",
      },
    ],
    dataModel: trustedDataModel,
  });

  assert.deepEqual(messages[2].updateDataModel.value, trustedDataModel);
  assert.throws(
    () =>
      compileSurfaceMessages(supportSite, {
        surfaceId: "support-main",
        a2uiCatalogId: "https://renderyes.dev/catalogs/standard/v1",
        instances: [
          {
            id: "ticket-queue",
            componentId: "TicketQueue",
          },
        ],
        dataModel: {
          tickets: {
            load: () => [],
          },
        },
      }),
    /data model must be JSON-compatible/,
  );
});

test("exports a deterministic customer manifest and CSS variables", () => {
  const manifest = toSiteManifest(supportSite);
  const repeated = toSiteManifest(
    defineSite({
      id: "support-ops",
      name: "Support operations",
      version: "1.0.0",
      catalogId: "https://support.example.com/renderyes/catalog.json",
      components: [TicketQueue],
      surfaces: supportSite.surfaces,
      theme: supportSite.theme,
    }),
  );

  assert.equal(
    manifest.catalog.registrationFingerprint,
    repeated.catalog.registrationFingerprint,
  );
  assert.equal(manifest.components[0].rendererComponent, "ResponsiveDataTable");
  assert.deepEqual(manifest.components[0].dataSlots.rows.accepts, [
    {
      dataTypeId: "SupportTicket",
      shapes: ["collection", "search-results"],
    },
  ]);
  assert.equal(Object.isFrozen(TicketQueue.dataSlots), true);
  assert.equal(Object.isFrozen(TicketQueue.dataSlots.rows.accepts), true);
  assert.deepEqual(themeToCssVariables(supportSite.theme), {
    "--persona-primary": "#6d28d9",
    "--persona-ink": "#261849",
    "--persona-radius": "16",
  });
});

const supportPlannerManifest = {
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
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      output: {
        dataTypeId: "SupportTicket",
        shape: "search-results",
      },
      supports: {
        filterFields: ["priority"],
      },
      constraints: {
        authentication: "session",
        maximumRows: 50,
      },
    },
  ],
  relationships: [],
};

function dataBindingPlan() {
  return {
    schemaVersion: "3.1",
    planId: "support-data-plan",
    siteId: supportSite.id,
    catalog: {
      id: supportSite.catalog.id,
      version: supportSite.catalog.version,
      fingerprint: supportSite.catalog.fingerprint,
    },
    dataCatalog: {
      id: supportPlannerManifest.catalogId,
      version: supportPlannerManifest.catalogVersion,
      hash: supportPlannerManifest.catalogHash,
    },
    dataRequests: [
      {
        requestId: "tickets",
        capabilityId: "tickets.search",
        params: { priority: "urgent" },
      },
    ],
    surfaces: [
      {
        id: "support-main",
        nodes: [
          {
            nodeId: "ticket-queue",
            componentId: "TicketQueue",
            props: {},
            dataBindings: {
              rows: { requestId: "tickets" },
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

test("validates request outputs against component data slots only", () => {
  const result = validatePlanDataBindings(
    supportSite,
    dataBindingPlan(),
    supportPlannerManifest,
  );

  assert.equal(result.ok, true);
});

function compositionBindingPlan() {
  const candidate = dataBindingPlan();
  candidate.dataRequests = [
    { requestId: "tickets", capabilityId: "tickets.search", params: {} },
    { requestId: "tickets2", capabilityId: "tickets.search", params: {} },
  ];
  candidate.dataCompositions = [
    { compositionId: "combo", operation: "union", inputs: ["tickets", "tickets2"] },
  ];
  candidate.surfaces[0].nodes[0].dataBindings = {
    rows: { compositionId: "combo" },
  };
  return candidate;
}

test("accepts a composition bound to a slot that takes the shared type as a collection", () => {
  const result = validatePlanDataBindings(
    supportSite,
    compositionBindingPlan(),
    supportPlannerManifest,
  );
  assert.equal(result.ok, true);
});

test("projects a composed result to the component's immutable renderer path", () => {
  const composedRows = [
    {
      ticket: "SUP-1",
      customer: "Acme",
      subject: "SSO",
      priority: "Urgent",
      status: "Open",
      age: "1m",
      owner: "Maya",
    },
    {
      ticket: "SUP-2",
      customer: "Kite",
      subject: "Invoice",
      priority: "High",
      status: "Open",
      age: "2m",
      owner: "Maya",
    },
  ];
  const provenance = {
    sources: [{ sourceId: "a" }, { sourceId: "b" }],
    freshness: { asOf: "2026-07-28T00:00:00.000Z" },
  };
  const executedData = {
    planId: "support-data-plan",
    results: {
      tickets: { ok: true, data: [composedRows[0]], provenance },
      tickets2: { ok: true, data: [composedRows[1]], provenance },
    },
    compositions: {
      combo: {
        ok: true,
        compositionId: "combo",
        operation: "union",
        data: composedRows,
        provenance,
      },
    },
  };

  const dataModel = projectPlanDataModel(supportSite, {
    plan: compositionBindingPlan(),
    plannerManifest: supportPlannerManifest,
    executedData,
    baseDataModel: {},
  });

  // The composed rows land at the component's fixed renderer path.
  assert.deepEqual(dataModel.tickets.rows, composedRows);
  assert.equal(dataModel.tickets.state, "ready");
  // A composition envelope is recorded in the reserved metadata channel.
  assert.equal(dataModel.__renderyes.compositions[0].compositionId, "combo");
  assert.equal(dataModel.__renderyes.compositions[0].operation, "union");
  assert.equal(dataModel.__renderyes.compositions[0].rowCount, 2);
});

function joinBindingPlan() {
  const candidate = dataBindingPlan();
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

test("accepts a join bound to a slot that takes the left type as a collection", () => {
  const result = validatePlanDataBindings(
    supportSite,
    joinBindingPlan(),
    supportPlannerManifest,
  );
  assert.equal(result.ok, true);
});

test("rejects a join bound to a slot that does not accept the left type", () => {
  const manifest = structuredClone(supportPlannerManifest);
  manifest.capabilities[0].output.dataTypeId = "AuditEvent";
  const result = validatePlanDataBindings(supportSite, joinBindingPlan(), manifest);
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((item) => item.code === "incompatible-join-slot"),
    true,
  );
});

test("projects a joined result to the component's renderer path", () => {
  const enriched = [
    { ticket: "SUP-1", owner: "Maya", "agent.team": "Billing" },
    { ticket: "SUP-2", owner: "Ghost" },
  ];
  const dataModel = projectPlanDataModel(supportSite, {
    plan: joinBindingPlan(),
    plannerManifest: supportPlannerManifest,
    executedData: {
      planId: "support-data-plan",
      results: {
        tickets: {
          ok: true,
          data: [],
          provenance: { sources: [], freshness: { asOf: "2026-07-28T00:00:00.000Z" } },
        },
        agents: {
          ok: true,
          data: [],
          provenance: { sources: [], freshness: { asOf: "2026-07-28T00:00:00.000Z" } },
        },
      },
      joins: {
        "tickets-with-agent": {
          ok: true,
          joinId: "tickets-with-agent",
          data: enriched,
          provenance: { sources: [], freshness: { asOf: "2026-07-28T00:00:00.000Z" } },
        },
      },
    },
    baseDataModel: {},
  });
  assert.deepEqual(dataModel.tickets.rows, enriched);
  assert.equal(dataModel.tickets.state, "ready");
  assert.equal(dataModel.__renderyes.joins[0].joinId, "tickets-with-agent");
});

test("rejects a composition whose inputs have different data types", () => {
  const manifest = structuredClone(supportPlannerManifest);
  manifest.capabilities.push({
    ...structuredClone(manifest.capabilities[0]),
    id: "audits.search",
    output: { dataTypeId: "AuditEvent", shape: "search-results" },
  });
  const candidate = compositionBindingPlan();
  candidate.dataRequests[1] = {
    requestId: "tickets2",
    capabilityId: "audits.search",
    params: {},
  };
  const result = validatePlanDataBindings(supportSite, candidate, manifest);
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((item) => item.code === "composition-input-type-mismatch"),
    true,
  );
});

test("rejects incompatible data shapes and unknown component data slots", () => {
  const incompatibleManifest = structuredClone(supportPlannerManifest);
  incompatibleManifest.capabilities[0].output.shape = "metric";
  const incompatible = validatePlanDataBindings(
    supportSite,
    dataBindingPlan(),
    incompatibleManifest,
  );
  assert.equal(incompatible.ok, false);
  assert.equal(
    incompatible.issues.some((item) => item.code === "incompatible-data-slot"),
    true,
  );

  const unknownSlotPlan = dataBindingPlan();
  unknownSlotPlan.surfaces[0].nodes[0].dataBindings = {
    chart: { requestId: "tickets" },
  };
  const unknownSlot = validatePlanDataBindings(
    supportSite,
    unknownSlotPlan,
    supportPlannerManifest,
  );
  assert.equal(unknownSlot.ok, false);
  assert.equal(
    unknownSlot.issues.some((item) => item.code === "unknown-data-slot"),
    true,
  );
});

test("rejects mismatched data catalogs and capabilities outside the manifest", () => {
  const catalogMismatchPlan = dataBindingPlan();
  catalogMismatchPlan.dataCatalog.hash = "sha256:different";
  const catalogMismatch = validatePlanDataBindings(
    supportSite,
    catalogMismatchPlan,
    supportPlannerManifest,
  );
  assert.equal(catalogMismatch.ok, false);
  assert.equal(
    catalogMismatch.issues.some((item) => item.code === "data-catalog-mismatch"),
    true,
  );

  const unknownCapabilityPlan = dataBindingPlan();
  unknownCapabilityPlan.dataRequests[0].capabilityId = "tickets.unapproved";
  const unknownCapability = validatePlanDataBindings(
    supportSite,
    unknownCapabilityPlan,
    supportPlannerManifest,
  );
  assert.equal(unknownCapability.ok, false);
  assert.equal(
    unknownCapability.issues.some((item) => item.code === "unknown-capability"),
    true,
  );
});

test("does not allow components to declare capability operations", () => {
  assert.throws(
    () =>
      defineComponent({
        id: "OperationRestrictedQueue",
        version: "1.0.0",
        description: "Invalid component-owned operation policy.",
        props: defineProps({}),
        renderer: {
          component: "ResponsiveDataTable",
          props: {
            rows: { path: "/trusted/rows" },
          },
        },
        dataSlots: {
          rows: {
            accepts: [
              {
                dataTypeId: "SupportTicket",
                shapes: ["collection"],
              },
            ],
            operations: ["filter"],
          },
        },
      }),
    /may declare only accepts/,
  );
});

test("requires every data slot to use a fixed owner renderer path", () => {
  assert.throws(
    () =>
      defineComponent({
        id: "UnboundQueue",
        version: "1.0.0",
        description: "Missing an immutable renderer data path.",
        props: defineProps({}),
        renderer: {
          component: "ResponsiveDataTable",
          props: {},
        },
        dataSlots: {
          rows: {
            accepts: [
              {
                dataTypeId: "SupportTicket",
                shapes: ["collection"],
              },
            ],
          },
        },
      }),
    /requires a fixed renderer path binding/,
  );
});

function baseTicketDataModel() {
  return {
    tickets: {
      title: "Priority queue",
      caption: "Executor-validated tickets",
      columns: [],
      rows: [{ ticketId: "stale-row" }],
      state: "loading",
      emptyMessage: "No tickets",
      errorMessage: "",
    },
  };
}

function successfulExecutedTickets() {
  return {
    planId: "support-data-plan",
    results: {
      tickets: {
        ok: true,
        data: [
          {
            ticketId: "SUP-1",
            subject: "SSO blocked",
          },
        ],
        provenance: {
          sources: [{ sourceId: "support-tickets" }],
          freshness: {
            asOf: "2026-07-28T00:00:00.000Z",
          },
        },
      },
    },
  };
}

test("projects validated results into immutable renderer paths and a reserved envelope", () => {
  const projected = projectPlanDataModel(supportSite, {
    plan: dataBindingPlan(),
    plannerManifest: supportPlannerManifest,
    executedData: successfulExecutedTickets(),
    baseDataModel: baseTicketDataModel(),
  });

  assert.deepEqual(projected.tickets.rows, [
    {
      ticketId: "SUP-1",
      subject: "SSO blocked",
    },
  ]);
  assert.equal(projected.tickets.state, "ready");
  assert.equal(projected.tickets.errorMessage, "");
  assert.equal(projected.__renderyes.planId, "support-data-plan");
  assert.equal(projected.__renderyes.requests[0].requestId, "tickets");
  assert.equal(
    projected.__renderyes.requests[0].provenance.sources[0].sourceId,
    "support-tickets",
  );
  // The node-to-request join, copied verbatim from the plan's own bindings.
  // This is what lets a browser gesture in one panel aim `refine` at the
  // request behind another; without it the client holds panels and request
  // ids with nothing connecting them.
  const nodeEnvelope = projected.__renderyes.nodes.find(
    (node) => Object.keys(node.bindings).length > 0,
  );
  assert.ok(nodeEnvelope, "envelope carries node bindings");
  assert.equal(
    Object.values(nodeEnvelope.bindings)[0].requestId,
    "tickets",
  );
  assert.ok(nodeEnvelope.componentId);
});

test("a site reconstructed from its own published manifest compiles identical A2UI messages", () => {
  // The real scenario: a host's original site (built with live Zod props) is
  // serialized, crosses a wire, and is reconstructed server-side with an
  // Ajv-backed props contract instead. If reconstruction were lossy, this
  // would diverge from the direct compile below in whatever it dropped.
  const manifest = toSiteManifest(supportSite);
  const reconstructed = defineSiteFromManifest(manifest);

  assert.notEqual(reconstructed.getComponent("TicketQueue").props, TicketQueue.props);
  assert.deepEqual(reconstructed.getComponent("TicketQueue").renderer.props.rows, {
    path: "/tickets/rows",
  });

  const directMessages = compilePlanDataSurfaceMessages(supportSite, {
    plan: dataBindingPlan(),
    plannerManifest: supportPlannerManifest,
    executedData: successfulExecutedTickets(),
    baseDataModel: baseTicketDataModel(),
    surfaceId: "support-main",
    a2uiCatalogId: "https://renderyes.dev/catalogs/standard/v1",
  });
  const reconstructedMessages = compilePlanDataSurfaceMessages(reconstructed, {
    plan: dataBindingPlan(),
    plannerManifest: supportPlannerManifest,
    executedData: successfulExecutedTickets(),
    baseDataModel: baseTicketDataModel(),
    surfaceId: "support-main",
    a2uiCatalogId: "https://renderyes.dev/catalogs/standard/v1",
  });

  assert.deepEqual(reconstructedMessages, directMessages);

  // The Ajv-backed contract still rejects what the original Zod one would.
  const invalidProps = reconstructed
    .getComponent("TicketQueue")
    .props.safeParse({ density: "huge" });
  assert.equal(invalidProps.success, false);
});

test("createSiteCatalogStore publishes a manifest and rejects an invalid one", () => {
  const store = createSiteCatalogStore();
  const registered = store.publish({ manifest: toSiteManifest(supportSite) });

  assert.equal(registered.siteId, "support-ops");
  assert.equal(
    store.get("support-ops")?.registrationFingerprint,
    registered.registrationFingerprint,
  );
  assert.equal(store.list().length, 1);

  assert.throws(() =>
    store.publish({ manifest: { schemaVersion: "1.0", site: { id: "" } } }),
  );
});

test("compiles projected Plan data into official A2UI messages", () => {
  const messages = compilePlanDataSurfaceMessages(supportSite, {
    plan: dataBindingPlan(),
    plannerManifest: supportPlannerManifest,
    executedData: successfulExecutedTickets(),
    baseDataModel: baseTicketDataModel(),
    surfaceId: "support-main",
    a2uiCatalogId: "https://renderyes.dev/catalogs/standard/v1",
  });

  assert.equal(messages.length, 3);
  // Scoped by node id (`ticket-queue`) so two instances of TicketQueue on one
  // surface can never target the same data-model path. See `scopedDataPath`.
  assert.deepEqual(messages[1].updateComponents.components[1].rows, {
    path: "/ticket-queue/tickets/rows",
  });
  assert.equal(
    messages[2].updateDataModel.value["ticket-queue"].tickets.rows[0].ticketId,
    "SUP-1",
  );
});

test("projects safe component error state without retaining stale rows", () => {
  const projected = projectPlanDataModel(supportSite, {
    plan: dataBindingPlan(),
    plannerManifest: supportPlannerManifest,
    executedData: {
      planId: "support-data-plan",
      results: {
        tickets: {
          ok: false,
          error: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "Ticket service unavailable",
            retryable: true,
          },
        },
      },
    },
    baseDataModel: baseTicketDataModel(),
  });

  assert.deepEqual(projected.tickets.rows, []);
  assert.equal(projected.tickets.state, "error");
  assert.equal(projected.__renderyes.requests[0].state, "error");
  // The runtime's own message must NOT reach the component. This assertion used
  // to expect "Ticket service unavailable" verbatim, which is exactly the leak:
  // the message is written by whichever runtime.execute failed — a host's own,
  // per INTEGRATION.md — and starter-catalog renders this path in a live
  // <p role="alert">.
  assert.equal(projected.tickets.errorMessage, DEFAULT_VISITOR_ERROR_MESSAGE);
  assert.doesNotMatch(JSON.stringify(projected.tickets), /Ticket service unavailable/);
});

test("a host can word the visitor's error itself, and receives the real one to do it", () => {
  const seen = [];
  const projected = projectPlanDataModel(supportSite, {
    plan: dataBindingPlan(),
    plannerManifest: supportPlannerManifest,
    executedData: {
      planId: "support-data-plan",
      results: {
        tickets: {
          ok: false,
          error: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "Ticket service unavailable",
            retryable: true,
          },
        },
      },
    },
    baseDataModel: baseTicketDataModel(),
    formatVisitorError: (error) => {
      seen.push(error);
      return error.retryable ? "Try again in a moment." : "Not available.";
    },
  });

  assert.equal(projected.tickets.errorMessage, "Try again in a moment.");
  // The host gets the code and the unredacted message, so they can log it or
  // branch on it — the redaction is about what the browser is told, not about
  // withholding it from the host.
  assert.deepEqual(seen, [
    { code: "UPSTREAM_UNAVAILABLE", message: "Ticket service unavailable", retryable: true },
  ]);
});

test("rejects reserved state injection and conflicting immutable path writes", () => {
  assert.throws(
    () =>
      projectPlanDataModel(supportSite, {
        plan: dataBindingPlan(),
        plannerManifest: supportPlannerManifest,
        executedData: successfulExecutedTickets(),
        baseDataModel: {
          ...baseTicketDataModel(),
          __renderyes: {
            requests: "model-authored",
          },
        },
      }),
    /reserved __renderyes/,
  );

  const conflictingPlan = dataBindingPlan();
  conflictingPlan.dataRequests.push({
    requestId: "tickets-two",
    capabilityId: "tickets.search",
    params: {},
  });
  conflictingPlan.surfaces[0].nodes.push({
    nodeId: "ticket-queue-two",
    componentId: "TicketQueue",
    props: {},
    dataBindings: {
      rows: { requestId: "tickets-two" },
    },
  });
  const conflictingResults = successfulExecutedTickets();
  conflictingResults.results["tickets-two"] = {
    ...successfulExecutedTickets().results.tickets,
    data: [{ ticketId: "SUP-2", subject: "Different result" }],
  };

  assert.throws(
    () =>
      projectPlanDataModel(supportSite, {
        plan: conflictingPlan,
        plannerManifest: supportPlannerManifest,
        executedData: conflictingResults,
        baseDataModel: baseTicketDataModel(),
      }),
    /Conflicting data projections/,
  );
});

// --- Phase 4: typed data catalog ---

const ticketRows = [
  {
    ticketId: "SUP-1",
    subject: "SSO blocked",
    priority: "Urgent",
    contactEmail: "ops@acme.example",
  },
  {
    ticketId: "SUP-2",
    subject: "Invoice mismatch",
    priority: "High",
    contactEmail: "billing@kite.example",
  },
];

const supportTickets = defineSource({
  id: "supportTickets",
  entity: "SupportTicket",
  description: "The approved support ticket queue for the current session.",
  matchKey: "ticketId",
  requiredPermission: "support.read",
  fields: {
    ticketId: { type: field.string(), sortable: true },
    subject: { type: field.string() },
    priority: { type: field.string(), filterable: true },
    contactEmail: { type: field.string(), sensitive: true },
  },
  contracts: {
    emptyMessage: "No tickets in this queue.",
    errorMessage: "The support queue is unavailable.",
  },
  resolver: ({ session }) => ({
    rows: ticketRows.filter((row) => session.userId === "maya-demo"),
  }),
});

test("defineSource validates matchKey, fields, and resolver", () => {
  assert.throws(
    () =>
      defineSource({
        id: "broken",
        entity: "Thing",
        description: "Bad matchKey.",
        matchKey: "missing",
        fields: { id: { type: field.string() } },
        resolver: () => ({ rows: [] }),
      }),
    /matchKey must name a declared field/,
  );

  assert.throws(
    () =>
      defineSource({
        id: "broken",
        entity: "Thing",
        description: "No resolver.",
        matchKey: "id",
        fields: { id: { type: field.string() } },
        resolver: undefined,
      }),
    /resolver must be a function/,
  );
});

test("resolveSourceSync returns renderer rows and a model-safe summary", () => {
  const resolved = resolveSourceSync(supportTickets, {
    session: { userId: "maya-demo" },
  });

  // Renderer channel keeps every field, including the sensitive one.
  assert.equal(resolved.state, "ready");
  assert.equal(resolved.rows.length, 2);
  assert.equal(resolved.rows[0].contactEmail, "ops@acme.example");

  // Model-safe channel excludes the sensitive field and carries no row values.
  assert.equal(resolved.summary.rowCount, 2);
  assert.ok(!resolved.summary.fields.includes("contactEmail"));
  assert.deepEqual(resolved.summary.fields, ["ticketId", "subject", "priority"]);
  assert.equal("rows" in resolved.summary, false);
});

test("resolveSourceSync derives an empty state and awaits sync resolvers only", async () => {
  const empty = resolveSourceSync(supportTickets, {
    session: { userId: "not-authorized" },
  });
  assert.equal(empty.state, "empty");
  assert.equal(empty.summary.rowCount, 0);

  const asyncSource = defineSource({
    id: "asyncTickets",
    entity: "SupportTicket",
    description: "An async resolver source.",
    matchKey: "ticketId",
    fields: { ticketId: { type: field.string() } },
    resolver: async () => ({ rows: [{ ticketId: "SUP-9" }] }),
  });

  assert.throws(
    () => resolveSourceSync(asyncSource, { session: {} }),
    /use resolveSource instead/,
  );
  const resolved = await resolveSource(asyncSource, { session: {} });
  assert.equal(resolved.rows[0].ticketId, "SUP-9");
});

test("keeps trusted session identity separate from content params", () => {
  let received;
  const source = defineSource({
    id: "sessionBoundary",
    entity: "BoundaryRecord",
    description: "Verifies the resolver input boundary.",
    matchKey: "id",
    fields: {
      id: { type: field.string() },
    },
    resolver: (input) => {
      received = input;
      return {
        rows: [{ id: "record-1" }],
      };
    },
  });
  const session = {
    userId: "trusted-user",
    tenantId: "trusted-tenant",
  };
  const params = {
    status: "open",
  };

  resolveSourceSync(source, { session, params });

  assert.equal(received.session, session);
  assert.equal(received.params, params);
  assert.equal("userId" in received.params, false);
  assert.equal("tenantId" in received.params, false);
});

test("defineSite registers sources, fingerprints them, and exposes getSource", () => {
  const withSource = defineSite({
    id: "support-ops",
    name: "Support operations",
    version: "1.0.0",
    catalogId: "https://support.example.com/renderyes/catalog.json",
    components: [TicketQueue],
    surfaces: supportSite.surfaces,
    theme: supportSite.theme,
    sources: [supportTickets],
  });

  // A registered source changes the deterministic fingerprint.
  assert.notEqual(
    withSource.registrationFingerprint,
    supportSite.registrationFingerprint,
  );
  assert.equal(withSource.getSource("supportTickets")?.entity, "SupportTicket");
  assert.equal(withSource.getSource("unknown"), undefined);

  assert.throws(
    () =>
      defineSite({
        id: "dupe",
        name: "Dupe",
        version: "1.0.0",
        catalogId: "https://example.com/dupe.json",
        components: [TicketQueue],
        surfaces: supportSite.surfaces,
        theme: supportSite.theme,
        sources: [supportTickets, supportTickets],
      }),
    /Duplicate Data source/,
  );
});

test("toSiteManifest emits source metadata without resolvers or rows", () => {
  const manifest = toSiteManifest(
    defineSite({
      id: "support-ops",
      name: "Support operations",
      version: "1.0.0",
      catalogId: "https://support.example.com/renderyes/catalog.json",
      components: [TicketQueue],
      surfaces: supportSite.surfaces,
      theme: supportSite.theme,
      sources: [supportTickets],
    }),
  );

  assert.equal(manifest.sources.length, 1);
  const snapshot = manifest.sources[0];
  assert.equal(snapshot.id, "supportTickets");
  assert.equal(snapshot.matchKey, "ticketId");
  assert.equal(snapshot.requiredPermission, "support.read");
  assert.equal("resolver" in snapshot, false);
  assert.equal("rows" in snapshot, false);

  const sensitive = snapshot.fields.find((f) => f.id === "contactEmail");
  assert.equal(sensitive.sensitive, true);
  const priority = snapshot.fields.find((f) => f.id === "priority");
  assert.equal(priority.filterable, true);
  assert.equal(JSON.stringify(snapshot).includes("acme.example"), false);
});

test("request envelopes carry row counts, not a second copy of the rows", () => {
  // Every row a component renders already arrives through its own data
  // binding. Cloning the full result into `__renderyes.requests[]` as well
  // sent every byte twice, worst on the requests that return the most.
  // `compositionEnvelope`/`joinEnvelope` always reported only `rowCount`;
  // this brings requests in line with them.
  const projected = projectPlanDataModel(supportSite, {
    plan: dataBindingPlan(),
    plannerManifest: supportPlannerManifest,
    executedData: successfulExecutedTickets(),
    baseDataModel: baseTicketDataModel(),
  });

  const envelope = projected.__renderyes.requests[0];
  assert.equal(envelope.data, undefined, "rows must not be duplicated here");
  assert.equal(envelope.rowCount, 1);
  // Metadata a consumer actually uses is still present.
  assert.equal(envelope.requestId, "tickets");
  assert.equal(envelope.provenance.sources[0].sourceId, "support-tickets");
  // And the rows themselves still reach the component that binds them.
  assert.deepEqual(projected.tickets.rows, [
    { ticketId: "SUP-1", subject: "SSO blocked" },
  ]);
});

test("tells a component when a result was truncated, and what it was truncated from", () => {
  const executed = successfulExecutedTickets();
  executed.results.tickets.provenance.truncated = true;
  executed.results.tickets.provenance.totalRowsBeforeTruncation = 4210;

  const projected = projectPlanDataModel(supportSite, {
    plan: dataBindingPlan(),
    plannerManifest: supportPlannerManifest,
    executedData: executed,
    baseDataModel: baseTicketDataModel(),
  });

  // The runtime has always known this — `provenance.truncated` is set by the row
  // budget — and there was no path by which a component could find out, so a
  // truncated collection rendered identically to a complete one and every figure
  // derived from it was wrong with nothing on screen saying so.
  assert.equal(projected.completeness.complete, false);
  assert.equal(projected.completeness.truncated, true);
  assert.equal(projected.completeness.rowCount, 1);
  assert.equal(projected.completeness.totalRows, 4210);
  // `state` is still "ready": the request succeeded. Truncation is a
  // completeness question, not a failure one.
  assert.equal(projected.tickets.state, "ready");
});

test("reports an untruncated result as complete, with no phantom totals", () => {
  const projected = projectPlanDataModel(supportSite, {
    plan: dataBindingPlan(),
    plannerManifest: supportPlannerManifest,
    executedData: successfulExecutedTickets(),
    baseDataModel: baseTicketDataModel(),
  });

  assert.equal(projected.completeness.complete, true);
  assert.equal(projected.completeness.truncated, false);
  assert.equal(projected.completeness.rowCount, 1);
  assert.equal("totalRows" in projected.completeness, false);
});

test("a result narrowed after an incomplete fetch is not reported complete", () => {
  // The fetch met its own ask — not truncated — but a plan-level filter ran
  // over one page of a larger dataset, so the rows on screen may be missing
  // every match that lives beyond the page. `moreAvailable` alone used to be
  // routine here, and `complete: true` next to it was the lie.
  const executed = successfulExecutedTickets();
  executed.results.tickets.provenance.moreAvailable = true;
  executed.results.tickets.provenance.narrowedAfterFetch = true;
  executed.results.tickets.provenance.rowsBeforeNarrowing = 100;

  const projected = projectPlanDataModel(supportSite, {
    plan: dataBindingPlan(),
    plannerManifest: supportPlannerManifest,
    executedData: executed,
    baseDataModel: baseTicketDataModel(),
  });

  assert.equal(projected.completeness.complete, false);
  // Not truncated: nothing was cut relative to the fetch's own ask.
  assert.equal(projected.completeness.truncated, false);
  assert.equal(projected.completeness.narrowedAfterFetch, true);
  assert.equal(projected.completeness.rowsBeforeNarrowing, 100);
  assert.equal(projected.completeness.moreAvailable, true);
  assert.equal(projected.completeness.rowCount, 1);
  // Still a success: incompleteness is a completeness question, not an error.
  assert.equal(projected.tickets.state, "ready");
});

test("moreAvailable alone on an un-narrowed result still reads as complete", () => {
  const executed = successfulExecutedTickets();
  executed.results.tickets.provenance.moreAvailable = true;

  const projected = projectPlanDataModel(supportSite, {
    plan: dataBindingPlan(),
    plannerManifest: supportPlannerManifest,
    executedData: executed,
    baseDataModel: baseTicketDataModel(),
  });

  assert.equal(projected.completeness.complete, true);
  assert.equal(projected.completeness.moreAvailable, true);
  assert.equal("narrowedAfterFetch" in projected.completeness, false);
});

test("surfaces the staleness horizon and record deep links a source declares", () => {
  const executed = successfulExecutedTickets();
  executed.results.tickets.provenance.freshness.staleAt = "2026-07-29T00:00:00.000Z";
  executed.results.tickets.provenance.sources = [
    { sourceId: "support-tickets", recordUrl: "https://support.example.com/t/SUP-1" },
    { sourceId: "audit-log" },
  ];

  const projected = projectPlanDataModel(supportSite, {
    plan: dataBindingPlan(),
    plannerManifest: supportPlannerManifest,
    executedData: executed,
    baseDataModel: baseTicketDataModel(),
  });

  assert.equal(projected.staleAt, "2026-07-29T00:00:00.000Z");
  // Only the source that publishes a link. An entry with no `recordUrl` would be
  // an object with one key a component can do nothing with.
  assert.deepEqual(projected.records, [
    { sourceId: "support-tickets", recordUrl: "https://support.example.com/t/SUP-1" },
  ]);
});

test("distinguishes 'no staleness horizon declared' from a stale prior value", () => {
  const projected = projectPlanDataModel(supportSite, {
    plan: dataBindingPlan(),
    plannerManifest: supportPlannerManifest,
    executedData: successfulExecutedTickets(),
    baseDataModel: baseTicketDataModel(),
  });

  // Empty, not absent and not a leftover: "this never goes stale" and "we don't
  // know" are different claims and only the source can tell them apart.
  assert.equal(projected.staleAt, "");
  assert.deepEqual(projected.records, []);
});

test("a failed request is absent rather than incomplete, and carries no attribution", () => {
  const projected = projectPlanDataModel(supportSite, {
    plan: dataBindingPlan(),
    plannerManifest: supportPlannerManifest,
    executedData: {
      planId: "support-data-plan",
      results: {
        tickets: {
          ok: false,
          error: { code: "TIMEOUT", message: "Upstream timed out", retryable: true },
        },
      },
    },
    baseDataModel: baseTicketDataModel(),
  });

  assert.equal(projected.tickets.state, "error");
  assert.deepEqual(projected.sources, []);
  // `complete: false` because nothing arrived, but `truncated` stays false — the
  // data wasn't cut short, it never came.
  assert.equal(projected.completeness.complete, false);
  assert.equal(projected.completeness.truncated, false);
});

test("the empty value for a failed time-series matches the shape a success would have", () => {
  // A time-series result is an *object* of parallel arrays
  // (`{dates: [...], created: [...]}`), not an array — it was grouped with the
  // list shapes purely because "series" sounds plural, so a chart handed the
  // empty value got `[]` where it expected an object and needed an
  // `Array.isArray` branch that exists for no other reason.
  //
  // Needs its own site because `projectPlanDataModel` checks slot acceptance
  // before it projects anything: a component declaring `collection` cannot be
  // handed a time-series result even to test the failure path, which is the
  // right behaviour and worth having confirmed here.
  const TrendChart = defineComponent({
    id: "TicketQueue",
    version: "1.0.0",
    description: "A trend chart.",
    props: defineProps({}),
    renderer: {
      component: "TrendChart",
      props: { rows: { path: "/tickets/rows" } },
    },
    dataSlots: {
      rows: { accepts: [{ dataTypeId: "SupportTicket", shapes: ["time-series"] }] },
    },
  });
  const trendSite = defineSite({
    id: supportSite.id,
    name: "Support operations",
    version: "1.0.0",
    catalogId: supportSite.catalog.id,
    components: [TrendChart],
    surfaces: [
      defineSurface({
        id: "support-main",
        description: "Support main surface.",
        componentIds: ["TicketQueue"],
        maxComponents: 4,
      }),
    ],
  });

  const timeSeriesManifest = structuredClone(supportPlannerManifest);
  timeSeriesManifest.capabilities[0].output.shape = "time-series";

  const plan = dataBindingPlan();
  plan.catalog = {
    id: trendSite.catalog.id,
    version: trendSite.catalog.version,
    fingerprint: trendSite.catalog.fingerprint,
  };

  const projected = projectPlanDataModel(trendSite, {
    plan,
    plannerManifest: timeSeriesManifest,
    executedData: {
      planId: "support-data-plan",
      results: {
        tickets: {
          ok: false,
          error: { code: "TIMEOUT", message: "Upstream timed out", retryable: true },
        },
      },
    },
    baseDataModel: baseTicketDataModel(),
  });

  assert.deepEqual(projected.tickets.rows, {});
});

/**
 * The server defaults its A2UI catalog id to `${catalogId}:ui` and documents
 * that default in three places, while `defineSite` rejected the colon — so a
 * host taking our own documented default could not build the site it names.
 * The two lines had never been run together.
 */
test("accepts the `${catalogId}:ui` id the server defaults to", () => {
  const site = defineSite({
    id: "support-assist:ui",
    name: "Support Assist UI",
    version: "1.0.0",
    catalogId: "https://example.com/support.json",
    components: [TicketQueue],
    surfaces: [
      defineSurface({
        id: "main",
        description: "Queue.",
        componentIds: ["TicketQueue"],
      }),
    ],
    theme: supportSite.theme,
  });
  assert.equal(site.id, "support-assist:ui");
});

test("allows the colon in a site id and nowhere else", () => {
  assert.throws(
    () =>
      defineSite({
        id: "a:b:c",
        name: "Too many",
        version: "1.0.0",
        catalogId: "https://example.com/support.json",
        components: [TicketQueue],
        surfaces: [
          defineSurface({ id: "main", description: "Queue.", componentIds: ["TicketQueue"] }),
        ],
        theme: supportSite.theme,
      }),
    /Site id must match/,
  );
  assert.throws(
    () =>
      defineSurface({ id: "main:extra", description: "Queue.", componentIds: ["TicketQueue"] }),
    /Surface id must match/,
  );
});

test("a field description reaches the planner-facing JSON schema", () => {
  const props = defineProps({
    heading: field.string({
      default: "Results",
      description: "Short title over the table; restate the visitor's ask.",
    }),
    plain: field.number(),
  });
  assert.equal(
    props.jsonSchema.properties.heading.description,
    "Short title over the table; restate the visitor's ask.",
  );
  // Absent means absent — no empty-string noise in the schema.
  assert.equal("description" in props.jsonSchema.properties.plain, false);
});

/**
 * A to-one join enriches the left row — same identity, same count — so the
 * result is still the left data type. But its rows genuinely carry the right
 * side's fields, and slot acceptance used to check only the left type's
 * declared fields, so a component requiring something the join brings could
 * never bind to the join that brings it. The overlay is computed per plan
 * rather than declared on the type, so a *plain* request of the same type
 * still correctly fails the requirement.
 */
test("a join lets a slot require a field the right side brings", () => {
  const ContactQueue = defineComponent({
    id: "ContactQueue",
    version: "1.0.0",
    description: "Tickets with where their agent is based.",
    props: defineProps({}),
    renderer: {
      component: "ResponsiveDataTable",
      props: {
        rows: { path: "/contacts/rows" },
        state: { path: "/contacts/state" },
      },
    },
    dataSlots: {
      rows: {
        accepts: [{ shape: "collection", requires: [{ semanticType: "location" }] }],
      },
    },
  });
  const site = defineSite({
    id: "contact-ops",
    name: "Contact operations",
    version: "1.0.0",
    catalogId: "https://support.example.com/renderyes/catalog.json",
    components: [ContactQueue],
    surfaces: [
      defineSurface({
        id: "support-main",
        description: "Main workspace.",
        componentIds: ["ContactQueue"],
      }),
    ],
    theme: supportSite.theme,
  });
  const manifest = {
    ...supportPlannerManifest,
    dataTypes: [
      { id: "SupportTicket", fields: { subject: { label: "Subject", semanticType: "text" } } },
      { id: "Agent", fields: { region: { label: "Region", semanticType: "location" } } },
    ],
    capabilities: [
      {
        ...supportPlannerManifest.capabilities[0],
        output: { dataTypeId: "SupportTicket", shape: "collection" },
      },
      {
        ...supportPlannerManifest.capabilities[0],
        id: "agents.list",
        purpose: "List agents.",
        output: { dataTypeId: "Agent", shape: "collection" },
      },
    ],
  };
  const plan = dataBindingPlan();
  plan.siteId = site.id;
  plan.catalog = {
    id: site.catalog.id,
    version: site.catalog.version,
    fingerprint: site.catalog.fingerprint,
  };
  plan.dataRequests = [
    { requestId: "tickets", capabilityId: "tickets.search", params: {} },
    { requestId: "agents", capabilityId: "agents.list", params: {} },
  ];
  plan.dataJoins = [
    {
      joinId: "tickets-with-agent",
      relationshipId: "ticket-owner-agent",
      left: "tickets",
      right: "agents",
      as: "agent",
    },
  ];
  plan.surfaces[0].nodes[0].componentId = "ContactQueue";
  plan.surfaces[0].nodes[0].dataBindings = { rows: { joinId: "tickets-with-agent" } };

  const joined = validatePlanDataBindings(site, plan, manifest);
  assert.equal(joined.ok, true, JSON.stringify(joined.ok ? {} : joined.issues));

  // The same slot, bound to the plain request: the requirement correctly
  // fails, because an unjoined ticket row carries no location.
  const plain = structuredClone(plan);
  plain.surfaces[0].nodes[0].dataBindings = { rows: { requestId: "tickets" } };
  const unjoined = validatePlanDataBindings(site, plain, manifest);
  assert.equal(unjoined.ok, false);
  assert.match(unjoined.issues[0].message, /needs a location field/);
});

test("validatePlanDataBindings refuses a component the site never published", () => {
  // An install report had a plan naming an unpublished component, compose
  // returning ok, and "Unknown component: StarterDataTable" rendering in red
  // where the answer should be. The cause was the offline mock planner, which
  // picked components without consulting the contract and has since been
  // removed; the refusal below is what always guarded the real path.
  //
  // Kept as a lock, because the promise it enforces — nothing renders that the
  // host did not register — is the whole point of publishing a UI catalog, and
  // the mock proved it is reachable to break from outside the planner.
  const plannerManifest = {
    schemaVersion: "1.0",
    catalogId: "nested-data",
    catalogVersion: "0.1.0",
    catalogHash: "h",
    description: "x",
    dataTypes: [],
    capabilities: [],
    relationships: [],
  };
  const plan = {
    schemaVersion: "3.1",
    planId: "p1",
    siteId: nestedSite.id,
    catalog: {
      id: nestedSite.catalog.id,
      version: nestedSite.catalog.version,
      fingerprint: nestedSite.catalog.fingerprint,
    },
    dataCatalog: { id: "nested-data", version: "0.1.0", hash: "h" },
    dataRequests: [],
    surfaces: [
      {
        id: "panel-surface",
        nodes: [{ nodeId: "n1", componentId: "StarterDataTable", props: {} }],
      },
    ],
    generation: {
      providerId: "test",
      modelId: "test",
      createdAt: "2026-08-27T00:00:00.000Z",
      repairCount: 0,
    },
  };

  const result = validatePlanDataBindings(nestedSite, plan, plannerManifest);
  assert.equal(result.ok, false);
  const issue = result.issues.find((candidate) =>
    /Unknown component/.test(candidate.message),
  );
  assert.ok(issue, `expected a refusal, got ${JSON.stringify(result.issues)}`);
  assert.equal(issue.path, "surfaces.0.nodes.0.componentId");
  assert.match(issue.message, /StarterDataTable/);
});
