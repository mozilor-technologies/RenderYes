import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import {
  createViewServer,
  createViewHttpHandler,
  createModelPlanProvider,
  createMemoryViewStore,
  MAX_PROMPT_LENGTH,
  applyRefineOperations,
  createMemoryPlanCache,
} from "../dist/index.js";
import {
  compileApprovedGraphQlCatalog,
  compileCuratedGraphQlCatalog,
  createGraphQlCatalogInventory,
} from "@renderyes/capability-catalog/graphql";
import {
  DEFAULT_CONTRACT_TOKEN_BUDGET,
  hashCapabilityCatalog,
} from "@renderyes/capability-catalog";
import {
  createGraphQlRuntimesFromBindings,
  executeDataRequest,
} from "@renderyes/data-runtime";
import {
  defineComponent,
  defineProps,
  defineSite,
  defineSurface,
  field,
  toSiteManifest,
} from "@renderyes/site-sdk";

async function startUpstream(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Shaped exactly like the review UI's `capability-catalog.json` export. */
const approvedCatalog = {
  schemaVersion: "1.0",
  id: "support-assist",
  version: "1.0.0",
  description: "Approved Support Assist reads.",
  dataTypes: [
    {
      id: "AgentReport",
      version: "1.0.0",
      description: "An approved agent report summary.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["status", "total_reports"],
        properties: {
          status: { type: "string" },
          total_reports: { type: "integer" },
        },
      },
      fields: {
        status: { label: "Status", semanticType: "status" },
        total_reports: { label: "Total Reports", semanticType: "quantity" },
      },
    },
  ],
  sources: [{ id: "support-api", label: "Support Assist API" }],
  capabilities: [
    {
      id: "agentReport.list",
      version: "1.0.0",
      purpose: "List generated agent reports.",
      kind: "query",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["status", "total_reports"],
        properties: {
          status: { type: "string" },
          total_reports: { type: "integer" },
        },
      },
      output: { dataTypeId: "AgentReport", shape: "entity" },
      requiredSessionKeys: [],
      sourceIds: ["support-api"],
      policy: { authentication: "public" },
    },
  ],
  relationships: [],
};

/** Shaped exactly like the review UI's `server-bindings.json` export. */
const approvedBindings = {
  "agentReport.list": {
    capabilityId: "agentReport.list",
    method: "GET",
    path: "/api/v1/agent-report",
    contentParameters: [],
    exposeFields: ["status", "total_reports"],
  },
};

test("classifies onboarding operations server-side and reuses schema-hash cache entries", async () => {
  let classifierCalls = 0;
  const renderYesServer = createViewServer({
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
    },
    resolveSession: () => ({}),
    operationClassifier: {
      cacheKey: "test-model:operation-effect-v1",
      async classify(operations) {
        classifierCalls += 1;
        return operations.map((operation) => ({
          operationKey: operation.operationKey,
          effect: "read-only-query",
          confidence: 0.97,
          reason: "The operation retrieves support records.",
          riskSignals: operation.coordinate.startsWith("POST ") ? ["HTTP POST"] : [],
        }));
      },
    },
  });
  const request = {
    operations: [
      {
        operationKey: "openapi:getConversationList",
        protocol: "openapi",
        coordinate: "POST /api/v1/chat/conversation-list",
        operationName: "getConversationList",
        summary: "Get Conversation List",
        tags: ["Chat"],
        inputShape: { type: "object", properties: { page: { type: "integer" } } },
        outputShape: { type: "array", items: { type: "object" } },
        security: [{ bearerAuth: [] }],
      },
    ],
  };

  const first = await renderYesServer.classifyOperations(request);
  const second = await renderYesServer.classifyOperations(request);

  assert.equal(first.classifications[0].source, "model");
  assert.equal(first.classifications[0].suggestedSelection, true);
  assert.equal(first.classifications[0].requiresHumanReview, true);
  assert.equal(second.classifications[0].source, "cache");
  assert.equal(classifierCalls, 1);
});

const ReportCard = defineComponent({
  id: "ReportCard",
  version: "1.0.0",
  description: "Shows one agent report.",
  props: defineProps({
    title: field.string({ default: "Agent report" }),
  }),
  renderer: {
    component: "ReportCard",
    props: {
      report: { path: "/report" },
    },
  },
  dataSlots: {
    report: { accepts: [{ dataTypeId: "AgentReport", shapes: ["entity"] }] },
  },
});

const supportSite = defineSite({
  id: "support-assist",
  name: "Support Assist",
  version: "1.0.0",
  catalogId: "https://support.example.com/renderyes/catalog.json",
  components: [ReportCard],
  surfaces: [
    defineSurface({
      id: "main",
      description: "Main surface.",
      componentIds: ["ReportCard"],
      maxComponents: 1,
    }),
  ],
});

async function createTestServer(baseUrl, extraConfig = {}) {
  const session = { agentId: "AG-1", permissions: new Set() };
  const renderYesServer = createViewServer({
    host: {
      isAuthenticated: (s) => Boolean(s.agentId),
      hasPermission: (s, permission) => s.permissions.has(permission),
      getSessionValue: (s, key) => s[key],
    },
    resolveSession: () => session,
    // Every planId lookup is an authorization decision, so any path that
    // revises, refines or saves needs an owner to check against. A fixture
    // without one is a fixture that cannot reach those paths at all.
    resolveViewOwner: (s) => s.agentId,
    ...extraConfig,
    // The gate fails closed, so even a fixture has to name where it may call.
    // Deriving this from `baseUrl` rather than hardcoding keeps the fixture
    // honest: it declares the origin it actually uses, exactly as a host does.
    allowedUpstreamOrigins: [new URL(baseUrl).origin],
  });
  await renderYesServer.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    baseUrl,
  });
  await renderYesServer.publishUiCatalog({ manifest: toSiteManifest(supportSite) });
  return renderYesServer;
}

/**
 * A scripted provider that reads the contract it is handed and asks for the
 * first approved capability, bound to the first component that accepts data.
 *
 * This logic used to live in the server, as an offline mock reachable by
 * omitting `planProviders` — so a host with no API key got a working-looking
 * view built by something that never read their prompt. It is exactly right
 * for a test double and exactly wrong for a product, so it moved here.
 *
 * Reads the compiled contract rather than hardcoding ids because these tests
 * run against two different fixtures (REST and GraphQL), and a double that
 * needs updating whenever a fixture gains a capability is a double nobody
 * maintains.
 */
function scriptedFromContract(jsonSchema) {
  const consts = [];
  const walk = (node, key) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((item) => walk(item, key));
    if (typeof node.const === "string") consts.push([key, node.const]);
    for (const [name, value] of Object.entries(node)) walk(value, name);
  };
  walk(jsonSchema, "");
  const first = (name) => consts.find(([key]) => key === name)?.[1];
  const capabilityId = first("capabilityId");
  const componentId = first("componentId");
  // The slot name is a property of `dataBindings` on the same node variant.
  let slot;
  const findSlot = (node) => {
    if (!node || typeof node !== "object" || slot) return;
    if (Array.isArray(node)) return node.forEach(findSlot);
    const bindings = node.properties?.dataBindings?.properties;
    if (bindings && Object.keys(bindings).length > 0) slot = Object.keys(bindings)[0];
    for (const value of Object.values(node)) findSlot(value);
  };
  findSlot(jsonSchema);
  return {
    status: "ready",
    dataRequests: capabilityId ? [{ requestId: "r1", capabilityId, params: {} }] : [],
    nodes:
      componentId && slot
        ? [{ nodeId: "n1", componentId, props: {}, dataBindings: { [slot]: { requestId: "r1" } } }]
        : [],
  };
}

const createProvider = () => ({
  id: "scripted",
  async generatePlan({ jsonSchema }) {
    return { modelId: "scripted-1", value: scriptedFromContract(jsonSchema) };
  },
});

function reviewedGraphQlCatalog() {
  const schema = `
    type AgentReport {
      status: String!
      total_reports: Int!
    }

    type Query {
      agentReport(agentId: ID!): AgentReport!
    }
  `;
  const draft = createGraphQlCatalogInventory({
    schema,
    catalog: {
      id: "support-graph",
      version: "1.0.0",
      description: "Approved report graph reads.",
    },
    source: { id: "report-graph", label: "Report GraphQL API" },
    queries: [
      {
        fieldName: "agentReport",
        capabilityId: "agentReport.get",
        purpose: "Read the current agent's approved report summary.",
        dataTypeId: "AgentReport",
        resultShape: "entity",
        fields: {
          status: { label: "Status", semanticType: "status" },
          total_reports: { label: "Total reports", semanticType: "quantity" },
        },
      },
    ],
  });
  const compiled = compileApprovedGraphQlCatalog(schema, draft, {
    schemaVersion: "1.0",
    reviewSourceHash: draft.reviewSourceHash,
    queries: [
      {
        capabilityId: "agentReport.get",
        approvedVisitorArguments: [],
        identityArguments: { agentId: "agentId" },
        approvedOutputFields: ["status", "total_reports"],
        requiredOutputFields: ["status", "total_reports"],
        policy: {
          authentication: "session",
          requiredPermissions: ["reports:read"],
          maximumRows: 1,
          timeoutMs: 2_000,
        },
        limits: {
          maximumSelectionDepth: 2,
          maximumSelectedFields: 5,
        },
      },
    ],
  });
  return {
    schema,
    catalog: compiled.catalog,
    bindings: Object.fromEntries(compiled.bindings),
  };
}

test("createViewServer publishes a capability catalog with no bindings leaked to the browser", async () => {
  const renderYesServer = await createTestServer("http://127.0.0.1:9");
  const published = await renderYesServer.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    baseUrl: "http://127.0.0.1:9",
  });
  assert.equal(published.ok, true);
  assert.equal(published.catalogId, "support-assist");
  assert.deepEqual(published.unboundCapabilities, []);
  assert.equal(JSON.stringify(published).includes("/api/v1/agent-report"), false);
});

test("composeAgainstPublishedCatalogs runs prompt -> plan -> live execution -> A2UI messages end to end", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 7 }));
  });
  try {
    const renderYesServer = await createTestServer(upstream.baseUrl);

    const result = await renderYesServer.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "how many reports are open",
      request: {},
      createProvider,
    });

    assert.equal(result.ok, true);
    assert.equal(result.catalogId, "support-assist");
    const messageKinds = result.messages.map((message) => Object.keys(message)[1]);
    assert.deepEqual(messageKinds, [
      "createSurface",
      "updateComponents",
      "updateDataModel",
    ]);
    const dataModelMessage = result.messages.find((message) => message.updateDataModel);
    // Scoped by node id (`n1`, from the mock provider's fallback plan) so two
    // instances of one component never target the same path — see
    // `scopedDataPath` in `@renderyes/site-sdk`.
    assert.equal(dataModelMessage.updateDataModel.value.n1.report.status, "ok");
    assert.equal(dataModelMessage.updateDataModel.value.n1.report.total_reports, 7);
  } finally {
    await upstream.close();
  }
});

test("planAgainstPublishedCatalog rejects a request against an unpublished catalog", async () => {
  const renderYesServer = await createTestServer("http://127.0.0.1:9");
  await assert.rejects(
    () =>
      renderYesServer.planAgainstPublishedCatalog({
        catalogId: "does-not-exist",
        prompt: "anything",
        request: {},
        createProvider,
      }),
    /No capability catalog "does-not-exist" has been published/,
  );
});

test("getCoverageReport surfaces which published data types have no matching component", async () => {
  const renderYesServer = await createTestServer("http://127.0.0.1:9");
  const report = renderYesServer.getCoverageReport("support-assist");
  assert.equal(report.ok, true);
  // approvedCatalog's only capability (agentReport.list -> AgentReport as
  // "entity") is matched by ReportCard, the only component supportSite
  // registers for that exact (dataTypeId, shape) pair.
  const entityCoverage = report.coverage.find(
    (row) => row.dataTypeId === "AgentReport" && row.shape === "entity",
  );
  assert.ok(entityCoverage);
  assert.deepEqual(entityCoverage.matchingComponentIds, ["ReportCard"]);
  assert.equal(entityCoverage.unrenderable, false);
});

test("getCoverageReport rejects a catalogId with no published UI catalog", async () => {
  const session = { agentId: "AG-1", permissions: new Set() };
  const renderYesServer = createViewServer({
    host: {
      isAuthenticated: (s) => Boolean(s.agentId),
      hasPermission: (s, permission) => s.permissions.has(permission),
      getSessionValue: (s, key) => s[key],
    },
    resolveSession: () => session,
    allowedUpstreamOrigins: ["http://127.0.0.1:9"],
  });
  await renderYesServer.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    baseUrl: "http://127.0.0.1:9",
  });
  assert.throws(
    () => renderYesServer.getCoverageReport("support-assist"),
    /No UI catalog "support-assist" has been published/,
  );
});

/**
 * Every consumer looks a UI catalog up by the capability catalog id, while the
 * store filed it under the site id — so the two had to be the same string and
 * nothing said so. A host naming the site `<catalog>-ui`, the obvious name,
 * published with ok: true and failed at compose from a message naming a catalog
 * that existed.
 */
test("a UI catalog can declare which capability catalog it renders", async () => {
  const session = { agentId: "AG-1", permissions: new Set() };
  const renderYesServer = createViewServer({
    host: {
      isAuthenticated: (s) => Boolean(s.agentId),
      hasPermission: (s, permission) => s.permissions.has(permission),
      getSessionValue: (s, key) => s[key],
    },
    resolveSession: () => session,
    allowedUpstreamOrigins: ["http://127.0.0.1:9"],
  });
  await renderYesServer.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    baseUrl: "http://127.0.0.1:9",
  });
  const manifest = toSiteManifest(supportSite);

  const published = await renderYesServer.publishUiCatalog({
    manifest: { ...manifest, site: { ...manifest.site, id: "support-assist-ui" } },
    catalogId: "support-assist",
  });
  // The site keeps its own name; the key is what it declared.
  assert.equal(published.siteId, "support-assist-ui");
  assert.equal(published.catalogId, "support-assist");

  // And it is findable, which is the whole point.
  const report = renderYesServer.getCoverageReport("support-assist");
  assert.equal(report.ok, true);
  assert.equal(renderYesServer.listPublishedSites()[0].catalogId, "support-assist");
});

/**
 * Without the declaration the site id is the default, and a wrong default files
 * the catalog under a name nothing looks up. The message then reads as "you
 * forgot to publish" about something plainly published, so it shows what is
 * registered and under which key.
 */
test("a UI catalog under an undeclared name says what is registered", async () => {
  const session = { agentId: "AG-1", permissions: new Set() };
  const renderYesServer = createViewServer({
    host: {
      isAuthenticated: (s) => Boolean(s.agentId),
      hasPermission: (s, permission) => s.permissions.has(permission),
      getSessionValue: (s, key) => s[key],
    },
    resolveSession: () => session,
    allowedUpstreamOrigins: ["http://127.0.0.1:9"],
  });
  await renderYesServer.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    baseUrl: "http://127.0.0.1:9",
  });
  const manifest = toSiteManifest(supportSite);
  await renderYesServer.publishUiCatalog({
    manifest: { ...manifest, site: { ...manifest.site, id: "support-assist-ui" } },
  });

  assert.throws(
    () => renderYesServer.getCoverageReport("support-assist"),
    /Published: "support-assist-ui"[\s\S]*Pass catalogId: "support-assist"/,
  );
});

/**
 * The same misfiling, caught at the moment it happens rather than at the next
 * compose.
 *
 * The throw above only fires once something asks for the catalog by its real
 * id. A host publishing from a script sees `ok: true`, moves on, and finds out
 * when a visitor gets an empty view — a symptom that reads as bad planning and
 * points nowhere near a string that never matched. Publishing a capability
 * catalog has always reported the mirror of this; the UI side reported nothing.
 *
 * Reported, not rejected: a UI catalog published before its capability catalog
 * is legitimate ordering, which is the choice the capability path already made.
 */
test("publishing a UI catalog reports whether its capability catalog exists", async () => {
  const session = { agentId: "AG-1", permissions: new Set() };
  const renderYesServer = createViewServer({
    host: {
      isAuthenticated: (s) => Boolean(s.agentId),
      hasPermission: (s, permission) => s.permissions.has(permission),
      getSessionValue: (s, key) => s[key],
    },
    resolveSession: () => session,
    allowedUpstreamOrigins: ["http://127.0.0.1:9"],
  });
  await renderYesServer.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    baseUrl: "http://127.0.0.1:9",
  });
  const manifest = toSiteManifest(supportSite);

  // The mistake: site named `<catalog>-ui`, no catalogId declared, so the key
  // defaults to the site id and matches nothing.
  const misfiled = await renderYesServer.publishUiCatalog({
    manifest: { ...manifest, site: { ...manifest.site, id: "support-assist-ui" } },
  });
  assert.equal(misfiled.ok, true, "still publishes — this is a report, not a gate");
  assert.equal(misfiled.catalogId, "support-assist-ui");
  assert.equal(misfiled.capabilityCatalogRegistered, false);

  // The same manifest, filed correctly.
  const correct = await renderYesServer.publishUiCatalog({
    manifest,
    catalogId: "support-assist",
  });
  assert.equal(correct.capabilityCatalogRegistered, true);
  assert.deepEqual(
    correct.unrenderableDataTypes,
    [],
    "a matching pair renders everything the catalog produces",
  );
});

/**
 * A component pinning a data type the catalog does not produce — the other half
 * of the same silence, and the one a four-day evaluation lost time to: the
 * catalog carried `support.ticket`, the component accepted `support.tickets`.
 * Neither publish objected and the component simply stopped being offered.
 */
test("publishing a UI catalog reports data types nothing can render", async () => {
  const session = { agentId: "AG-1", permissions: new Set() };
  const renderYesServer = createViewServer({
    host: {
      isAuthenticated: (s) => Boolean(s.agentId),
      hasPermission: (s, permission) => s.permissions.has(permission),
      getSessionValue: (s, key) => s[key],
    },
    resolveSession: () => session,
    allowedUpstreamOrigins: ["http://127.0.0.1:9"],
  });
  await renderYesServer.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    baseUrl: "http://127.0.0.1:9",
  });

  const manifest = toSiteManifest(supportSite);
  // Repoint every slot at a data type the catalog does not produce. `components`
  // is top-level on a manifest, not under `site`.
  const drifted = {
    ...manifest,
    components: manifest.components.map((component) => ({
      ...component,
      dataSlots: Object.fromEntries(
        Object.entries(component.dataSlots ?? {}).map(([slot, spec]) => [
          slot,
          {
            ...spec,
            // Keep each acceptance's shape and change only the id, which is the
            // mistake as it actually happens: the shape is right, the name is
            // one character off. A structural acceptance carries `shape`, a
            // nominal one `shapes` — pinning turns the former into the latter.
            accepts: spec.accepts.map((acceptance) => ({
              dataTypeId: "support.nonexistent",
              shapes: acceptance.shapes ?? [acceptance.shape],
            })),
          },
        ]),
      ),
    })),
  };

  const published = await renderYesServer.publishUiCatalog({
    manifest: drifted,
    catalogId: "support-assist",
  });
  assert.equal(published.capabilityCatalogRegistered, true);
  assert.ok(
    published.unrenderableDataTypes.length > 0,
    "a pin that matches nothing has to be visible at publish, not at compose",
  );
});

test("a host can scope the visitor's credential to one destination", async () => {
  // The mechanism a reference host actually depends on: `resolveHeaders`
  // receives `destinationOrigin`, so a host can forward the visitor's own
  // token to its own backend and nothing else. A catalog names where a
  // capability lives, so forwarding to every destination it *could* name hands
  // whoever publishes the catalog a say in where a visitor's token goes.
  //
  // Untested until now, and credential decisions hang on the value: if it
  // arrived undefined, a host's `allowed.includes(destinationOrigin)` check
  // would silently send no auth header and every upstream call would fail
  // authentication with nothing pointing at the cause.
  const seen = [];
  const upstream = await startUpstream(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ authorization: req.headers.authorization ?? null });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ data: { agentReport: { status: "ok", total_reports: 3 } } }),
    );
  });
  try {
    const reviewed = reviewedGraphQlCatalog();
    const contexts = [];
    const renderYesServer = createViewServer({
      host: {
        isAuthenticated: (session) => Boolean(session.agentId),
        hasPermission: (session, permission) => session.permissions.has(permission),
        getSessionValue: (session, key) => session[key],
      },
      resolveSession: () => ({
        agentId: "AG-1",
        accessToken: "visitor-token",
        permissions: new Set(["reports:read"]),
      }),
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
      graphql: {
        resolveHeaders: (context) => {
          contexts.push({
            endpoint: context.endpoint,
            destinationOrigin: context.destinationOrigin,
          });
          // The policy a host writes: this origin gets the visitor's token,
          // anywhere else gets nothing.
          const forwardTo = [new URL(upstream.baseUrl).origin];
          if (!forwardTo.includes(context.destinationOrigin)) return {};
          return { authorization: `Bearer ${context.session.accessToken}` };
        },
        resolveProvenance: ({ sourceId }) => ({
          sources: [{ sourceId }],
          freshness: { asOf: "2026-08-10T00:00:00.000Z" },
        }),
      },
    });
    await renderYesServer.publishReviewedCatalog({
      bindingKind: "graphql",
      catalog: reviewed.catalog,
      bindings: reviewed.bindings,
      schema: reviewed.schema,
      endpoint: `${upstream.baseUrl}/graphql`,
    });

    // `planAgainstPublishedCatalog` rather than compose: it drives the same
    // GraphQL execution path, and this catalog id has no UI catalog of its own
    // — rendering is not what is under test here.
    const result = await renderYesServer.planAgainstPublishedCatalog({
      catalogId: "support-graph",
      prompt: "show my report summary",
      request: { agentId: "AG-1", accessToken: "visitor-token" },
      createProvider,
    });
    assert.equal(result.ok, true);

    assert.ok(contexts.length > 0, "resolveHeaders must be called");
    // Both fields arrive, and the origin is the origin — not the full URL.
    assert.equal(contexts[0].endpoint, `${upstream.baseUrl}/graphql`);
    assert.equal(contexts[0].destinationOrigin, new URL(upstream.baseUrl).origin);
    assert.ok(!contexts[0].destinationOrigin.includes("/graphql"));
    // And the host's scoping decision took effect on the wire.
    assert.equal(seen[0].authorization, "Bearer visitor-token");
  } finally {
    await upstream.close();
  }
});

/** Publishes the reviewed GraphQL catalog against `endpoint` and plans once. */
async function planAgainstGraphQlEndpoint({ endpoint, allowedUpstreamOrigins }) {
  const reviewed = reviewedGraphQlCatalog();
  const renderYesServer = createViewServer({
    host: {
      isAuthenticated: (session) => Boolean(session.agentId),
      hasPermission: (session, permission) => session.permissions.has(permission),
      getSessionValue: (session, key) => session[key],
    },
    resolveSession: () => ({
      agentId: "AG-1",
      accessToken: "visitor-token",
      permissions: new Set(["reports:read"]),
    }),
    allowedUpstreamOrigins,
    graphql: {
      resolveHeaders: () => ({ authorization: "Bearer visitor-token" }),
      resolveProvenance: ({ sourceId }) => ({
        sources: [{ sourceId }],
        freshness: { asOf: "2026-08-10T00:00:00.000Z" },
      }),
    },
  });
  await renderYesServer.publishReviewedCatalog({
    bindingKind: "graphql",
    catalog: reviewed.catalog,
    bindings: reviewed.bindings,
    schema: reviewed.schema,
    endpoint,
  });
  return {
    server: renderYesServer,
    plan: () =>
      renderYesServer.planAgainstPublishedCatalog({
        catalogId: "support-graph",
        prompt: "show my report summary",
        request: { agentId: "AG-1", accessToken: "visitor-token" },
        createProvider,
      }),
  };
}

test("a credentialed GraphQL request refuses a redirect instead of following it", async () => {
  // `fetch` carries the Authorization header across a same-scheme redirect, so
  // following one hands the visitor's token to wherever the approved endpoint
  // points. The equivalent OpenAPI guard was tested; this one was not — turning
  // `redirect: "manual"` into `"follow"` left the whole suite green.
  const reached = [];
  const redirectTarget = await startUpstream(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    reached.push({ authorization: req.headers.authorization ?? null });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { agentReport: { status: "ok", total_reports: 3 } } }));
  });
  const upstream = await startUpstream(async (_req, res) => {
    res.writeHead(302, { location: `${redirectTarget.baseUrl}/graphql` });
    res.end();
  });

  try {
    const { plan } = await planAgainstGraphQlEndpoint({
      endpoint: `${upstream.baseUrl}/graphql`,
      // Both origins allowed, so the allowlist is not what stops this — the
      // redirect refusal is. Otherwise this test would pass for the wrong reason.
      allowedUpstreamOrigins: [
        new URL(upstream.baseUrl).origin,
        new URL(redirectTarget.baseUrl).origin,
      ],
    });

    const result = await plan();
    // The plan itself is fine; the data request is what fails, and it fails
    // per-request rather than sinking the whole compose.
    const failure = result.results.r1;
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, "GRAPHQL_TRANSPORT_ERROR");
    assert.match(failure.error.message, /redirected/);
    assert.equal(
      reached.length,
      0,
      "the redirect target must never receive the credentialed request",
    );
  } finally {
    await upstream.close();
    await redirectTarget.close();
  }
});

test("narrowing allowedUpstreamOrigins revokes an already published GraphQL catalog", async () => {
  // The endpoint is checked at publish *and* again per request, so that removing
  // an origin takes effect without republishing. Deleting the per-request check
  // left the suite green: nothing covered revocation, only publication.
  const served = [];
  const upstream = await startUpstream(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    served.push(1);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { agentReport: { status: "ok", total_reports: 3 } } }));
  });

  try {
    // The allowlist is re-read from config on every check, so this array is the
    // seam a host's revocation would come through.
    const origins = [new URL(upstream.baseUrl).origin];
    const { plan } = await planAgainstGraphQlEndpoint({
      endpoint: `${upstream.baseUrl}/graphql`,
      allowedUpstreamOrigins: origins,
    });

    const before = await plan();
    assert.equal(
      before.results.r1.ok,
      true,
      "the published catalog works while its origin is allowed",
    );
    assert.equal(served.length, 1);

    // Revoke it. No republish.
    origins.length = 0;
    origins.push("http://127.0.0.1:9");

    const after = await plan();
    assert.equal(after.results.r1.ok, false, "a revoked origin must stop being reachable");
    assert.match(after.results.r1.error.message, /allowedUpstreamOrigins|not in allowed/);
    assert.equal(served.length, 1, "no further request may reach the upstream");
  } finally {
    await upstream.close();
  }
});

test("narrowing allowedUpstreamOrigins revokes an already published OpenAPI catalog", async () => {
  // The GraphQL transport has always re-checked the endpoint per request so that
  // narrowing the allowlist revokes a live catalog. The OpenAPI path enforced the
  // allowlist at publish alone, so a revoked origin kept being called until
  // someone republished.
  const served = [];
  const upstream = await startUpstream((req, res) => {
    served.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 3 }));
  });

  try {
    // Read fresh on every check, so this array is the seam a revocation uses.
    // Built here rather than through createTestServer, which sets
    // allowedUpstreamOrigins after spreading extraConfig and would replace it.
    const origins = [new URL(upstream.baseUrl).origin];
    const session = { agentId: "AG-1", permissions: new Set() };
    const server = createViewServer({
      host: {
        isAuthenticated: (s) => Boolean(s.agentId),
        hasPermission: (s, permission) => s.permissions.has(permission),
        getSessionValue: (s, key) => s[key],
      },
      resolveSession: () => session,
      resolveViewOwner: (s) => s.agentId,
      allowedUpstreamOrigins: origins,
    });
    await server.publishReviewedCatalog({
      catalog: approvedCatalog,
      bindings: approvedBindings,
      baseUrl: upstream.baseUrl,
    });
    await server.publishUiCatalog({ manifest: toSiteManifest(supportSite) });

    const before = await composeOnce(server, {});
    assert.equal(before.ok, true);
    assert.equal(before.requests[0].ok, true);
    assert.equal(served.length, 1, "the published catalog works while allowed");

    origins.length = 0;
    origins.push("http://127.0.0.1:9");

    const after = await composeOnce(server, {});
    assert.equal(
      served.length,
      1,
      "a revoked origin must not be contacted again, with or without a credential",
    );
    // The compose still returns a view; the data request inside it is what fails.
    const failed = (after.requests ?? []).filter((entry) => !entry.ok);
    assert.equal(failed.length, 1, "the request against the revoked origin must fail");
  } finally {
    await upstream.close();
  }
});

test("a published URL carrying credentials in its userinfo is refused", async () => {
  // assertHttpUrl gates every published baseUrl, binding serverUrl and GraphQL
  // endpoint. Deleting the userinfo check left the suite green, and with it gone
  // `https://user:pass@host/` publishes and the userinfo then travels into logs
  // and error text via `endpoint`.
  const renderYesServer = createViewServer({
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
    },
    resolveSession: () => ({}),
    allowedUpstreamOrigins: ["https://api.internal.example"],
  });

  for (const baseUrl of [
    "https://someone:secret@api.internal.example",
    "https://someone@api.internal.example",
  ]) {
    await assert.rejects(
      () =>
        renderYesServer.publishReviewedCatalog({
          catalog: approvedCatalog,
          bindings: approvedBindings,
          baseUrl,
        }),
      /must not contain credentials/,
      `${baseUrl} must be refused`,
    );
  }
});

test("publishes and executes GraphQL with request-scoped host authentication", async () => {
  const observedRequests = [];
  const upstream = await startUpstream(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    observedRequests.push({
      authorization: req.headers.authorization,
      variables: body.variables,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: {
          agentReport: {
            status: "ready",
            total_reports: body.variables.agentId === "AG-7" ? 12 : 4,
          },
        },
      }),
    );
  });

  try {
    const reviewed = reviewedGraphQlCatalog();
    const renderYesServer = createViewServer({
      host: {
        isAuthenticated: (session) => Boolean(session.agentId),
        hasPermission: (session, permission) => session.permissions.has(permission),
        getSessionValue: (session, key) => session[key],
      },
      resolveSession: (request) => ({
        agentId: request.agentId,
        accessToken: request.accessToken,
        permissions: new Set(["reports:read"]),
      }),
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
      graphql: {
        resolveHeaders: ({ session }) => ({
          authorization: `Bearer ${session.accessToken}`,
        }),
        resolveProvenance: ({ sourceId }) => ({
          sources: [{ sourceId }],
          freshness: { asOf: "2026-08-03T00:00:00.000Z" },
        }),
      },
    });
    const published = await renderYesServer.publishReviewedCatalog({
      bindingKind: "graphql",
      catalog: reviewed.catalog,
      bindings: reviewed.bindings,
      schema: reviewed.schema,
      endpoint: `${upstream.baseUrl}/graphql`,
    });

    const [result, concurrentResult] = await Promise.all([
      renderYesServer.planAgainstPublishedCatalog({
        catalogId: "support-graph",
        prompt: "show my report summary",
        request: { agentId: "AG-7", accessToken: "session-token-7" },
        createProvider,
      }),
      renderYesServer.planAgainstPublishedCatalog({
        catalogId: "support-graph",
        prompt: "show my other report summary",
        request: { agentId: "AG-8", accessToken: "session-token-8" },
        createProvider,
      }),
    ]);

    assert.equal(published.bindingKind, "graphql");
    assert.equal(JSON.stringify(published).includes("/graphql"), false);
    assert.equal(JSON.stringify(published).includes("session-token-7"), false);
    assert.equal(result.ok, true);
    assert.equal(result.results.r1.ok, true);
    assert.deepEqual(result.results.r1.data, {
      status: "ready",
      total_reports: 12,
    });
    assert.equal(concurrentResult.results.r1.data.total_reports, 4);
    assert.deepEqual(
      observedRequests.sort((left, right) =>
        left.variables.agentId.localeCompare(right.variables.agentId),
      ),
      [
        {
          authorization: "Bearer session-token-7",
          variables: { agentId: "AG-7" },
        },
        {
          authorization: "Bearer session-token-8",
          variables: { agentId: "AG-8" },
        },
      ],
    );
  } finally {
    await upstream.close();
  }
});

test("compose rejects a prompt over the length cap before reaching a provider", async () => {
  let providerCalled = false;
  const renderYesServer = await createTestServer("http://127.0.0.1:9");
  await assert.rejects(
    () =>
      renderYesServer.composeAgainstPublishedCatalogs({
        catalogId: "support-assist",
        prompt: "x".repeat(MAX_PROMPT_LENGTH + 1),
        request: {},
        createProvider: () => {
          providerCalled = true;
          return {
            id: "mock",
            async generatePlan() {
              return { modelId: "m", value: {} };
            },
          };
        },
      }),
    /at most 2000 characters/,
  );
  // The point of the cap is cost: it has to reject before anything bills.
  assert.equal(providerCalled, false);
});

test("compose still accepts a prompt exactly at the length cap", async () => {
  const renderYesServer = await createTestServer("http://127.0.0.1:9");
  const result = await renderYesServer.composeAgainstPublishedCatalogs({
    catalogId: "support-assist",
    prompt: "x".repeat(MAX_PROMPT_LENGTH),
    request: {},
    createProvider,
  });
  // Boundary is inclusive — only past it should fail.
  assert.ok(result.ok === true || result.ok === false);
});

test("a stalled model call is aborted at its timeout instead of hanging", async () => {
  const provider = createModelPlanProvider({
    id: "openai",
    apiKeyEnv: "RENDERYES_TEST_KEY",
    model: "test-model",
    timeoutMs: 50,
    // Never settles on its own: only the abort signal can end this.
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
  });
  process.env.RENDERYES_TEST_KEY = "test-key";
  await assert.rejects(
    () => provider.generatePlan({ systemPrompt: "s", userPrompt: "u", jsonSchema: {} }),
    /exceeded its 50ms timeout/,
  );
  delete process.env.RENDERYES_TEST_KEY;
});

test("compose reports metrics with timings, token usage, and capability count", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 3 }));
  });
  try {
    const seen = [];
    const session = { agentId: "AG-1", permissions: new Set() };
    const renderYesServer = createViewServer({
      host: {
        isAuthenticated: (s) => Boolean(s.agentId),
        hasPermission: (s, permission) => s.permissions.has(permission),
        getSessionValue: (s, key) => s[key],
      },
      resolveSession: () => session,
      onComposeMetrics: (metrics) => seen.push(metrics),
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
    });
    await renderYesServer.publishReviewedCatalog({
      catalog: approvedCatalog,
      bindings: approvedBindings,
      baseUrl: upstream.baseUrl,
    });
    await renderYesServer.publishUiCatalog({ manifest: toSiteManifest(supportSite) });

    const result = await renderYesServer.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me open agent reports",
      request: {},
      createProvider: () => ({
        id: "metered",
        async generatePlan() {
          return {
            modelId: "test-model",
            value: {
              status: "ready",
              dataRequests: [
                { requestId: "r1", capabilityId: "agentReport.list", params: {} },
              ],
              nodes: [
                {
                  nodeId: "n1",
                  componentId: "ReportCard",
                  props: {},
                  dataBindings: { report: { requestId: "r1" } },
                },
              ],
            },
            usage: { inputTokens: 120, outputTokens: 45, calls: 1 },
          };
        },
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(seen.length, 1, "exactly one metrics event per compose");
    const m = seen[0];
    assert.equal(m.catalogId, "support-assist");
    assert.equal(m.outcome, "ready");
    assert.equal(m.cached, false);
    assert.equal(m.modelId, "test-model");
    assert.equal(m.inputTokens, 120);
    assert.equal(m.outputTokens, 45);
    assert.equal(m.modelCalls, 1);
    assert.equal(m.capabilityCount, 1);
    assert.equal(m.promptLength, "show me open agent reports".length);
    // The whole point is separating model time from upstream data time.
    assert.ok(typeof m.planMs === "number" && m.planMs >= 0);
    assert.ok(typeof m.dataMs === "number" && m.dataMs >= 0);
    assert.ok(m.totalMs >= m.dataMs);
    // One request over one data type, and this catalog declares no
    // relationships — which is every catalog today, since neither the review UI
    // nor `draft`/`candidate` emits one. Reported as two facts rather than a
    // verdict: `dataTypesSpanned > 1 && joinableRelationshipCount === 0` is the
    // condition worth knowing, and it is a query the host runs over its own
    // telemetry rather than a judgement this library makes.
    assert.equal(m.dataTypesSpanned, 1);
    assert.equal(m.joinableRelationshipCount, 0);
    // Prompt text and fetched rows must never ride along into telemetry.
    assert.equal(JSON.stringify(m).includes("show me open"), false);
  } finally {
    await upstream.close();
  }
});

test("a throwing metrics sink cannot fail a compose, and stays armed for the next one", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 3 }));
  });
  try {
    const session = { agentId: "AG-1", permissions: new Set() };
    let sinkCalls = 0;
    const renderYesServer = createViewServer({
      host: {
        isAuthenticated: (s) => Boolean(s.agentId),
        hasPermission: (s, permission) => s.permissions.has(permission),
        getSessionValue: (s, key) => s[key],
      },
      resolveSession: () => session,
      onComposeMetrics: () => {
        sinkCalls += 1;
        if (sinkCalls === 1) throw new Error("telemetry backend is down");
      },
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
    });
    await renderYesServer.publishReviewedCatalog({
      catalog: approvedCatalog,
      bindings: approvedBindings,
      baseUrl: upstream.baseUrl,
    });
    await renderYesServer.publishUiCatalog({ manifest: toSiteManifest(supportSite) });

    const result = await renderYesServer.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me open agent reports",
      request: {},
      createProvider,
    });
    assert.equal(result.ok, true);
    assert.equal(sinkCalls, 1);

    // One throw must not disarm the observer for the process lifetime — the
    // failure mode measured live as 56 composes against 49 metric rows.
    const second = await renderYesServer.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me open agent reports again",
      request: {},
      createProvider,
    });
    assert.equal(second.ok, true);
    assert.equal(sinkCalls, 2, "the sink is still invoked after throwing once");
  } finally {
    await upstream.close();
  }
});

function credentialServer(extra = {}) {
  return createViewServer({
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
    },
    resolveSession: () => ({}),
    allowedUpstreamOrigins: ["https://api.internal.example"],
    ...extra,
  });
}

test("publish refuses a credentialId the host never declared", async () => {
  process.env.RENDERYES_SECRET_UNRELATED = "super-secret";
  const renderYesServer = credentialServer({
    upstreamCredentials: { "support-api": "RENDERYES_SUPPORT_TOKEN" },
  });
  // The old design let the caller name the env var outright; this is the
  // exfiltration attempt that used to succeed.
  //
  // `baseUrl` is a *permitted* origin here on purpose. The realistic attack
  // points at an attacker-controlled host, but the origin gate now rejects
  // that before the credential is ever looked at — which would leave this
  // test passing for the wrong reason and stop proving anything about
  // `credentialId`. Sending to an allowed origin isolates the second lock.
  await assert.rejects(
    () =>
      renderYesServer.publishReviewedCatalog({
        catalog: approvedCatalog,
        bindings: approvedBindings,
        baseUrl: "https://api.internal.example",
        credentialId: "RENDERYES_SECRET_UNRELATED",
      }),
    /Unknown credentialId/,
  );
  delete process.env.RENDERYES_SECRET_UNRELATED;
});

test("publish accepts a declared credentialId", async () => {
  const renderYesServer = credentialServer({
    upstreamCredentials: { "support-api": "RENDERYES_SUPPORT_TOKEN" },
  });
  const summary = await renderYesServer.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    baseUrl: "https://api.internal.example",
    credentialId: "support-api",
  });
  assert.equal(summary.ok, true);
});

test("publish rejects a baseUrl outside the allowed origins", async () => {
  const renderYesServer = credentialServer({
    allowedUpstreamOrigins: ["https://api.internal.example"],
  });
  await assert.rejects(
    () =>
      renderYesServer.publishReviewedCatalog({
        catalog: approvedCatalog,
        bindings: approvedBindings,
        baseUrl: "http://169.254.169.254",
      }),
    /not in allowedUpstreamOrigins/,
  );
});

test("origin allowlist is not defeated by a lookalike prefix host", async () => {
  const renderYesServer = credentialServer({
    allowedUpstreamOrigins: ["https://api.internal.example"],
  });
  // Would pass a naive startsWith() check.
  await assert.rejects(
    () =>
      renderYesServer.publishReviewedCatalog({
        catalog: approvedCatalog,
        bindings: approvedBindings,
        baseUrl: "https://api.internal.example.attacker.com",
      }),
    /not in allowedUpstreamOrigins/,
  );
});

test("an allowed origin still publishes normally", async () => {
  const renderYesServer = credentialServer({
    allowedUpstreamOrigins: ["https://api.internal.example"],
  });
  const summary = await renderYesServer.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    baseUrl: "https://api.internal.example/v1",
  });
  assert.equal(summary.ok, true);
});

test("an unconfigured allowlist rejects every destination rather than allowing all", async () => {
  // The gate used to treat "no list" as "no restriction", so a host that
  // never learned the option existed ran with no gate at all. Silence is a
  // bad way to opt into unrestricted outbound requests.
  const renderYesServer = credentialServer({ allowedUpstreamOrigins: undefined });
  await assert.rejects(
    () =>
      renderYesServer.publishReviewedCatalog({
        catalog: approvedCatalog,
        bindings: approvedBindings,
        baseUrl: "https://api.internal.example",
      }),
    /no allowedUpstreamOrigins are configured/,
  );
});

test("a binding's own serverUrl cannot route around the baseUrl allowlist", async () => {
  // `openapi-adapter.ts` resolves `binding.serverUrl ?? baseUrl`, so serverUrl
  // wins outright. Gating baseUrl alone left the credential deliverable to any
  // host a publish call named here.
  const renderYesServer = credentialServer({
    allowedUpstreamOrigins: ["https://api.internal.example"],
  });
  await assert.rejects(
    () =>
      renderYesServer.publishReviewedCatalog({
        catalog: approvedCatalog,
        bindings: {
          "agentReport.list": {
            ...approvedBindings["agentReport.list"],
            serverUrl: "https://attacker.example",
          },
        },
        baseUrl: "https://api.internal.example",
        credentialId: "support-api",
      }),
    /serverUrl.*not in allowedUpstreamOrigins/s,
  );
});

test("a binding path that is an absolute URL cannot discard the approved base", async () => {
  // `new URL(path, base)` ignores `base` entirely when `path` is absolute.
  const renderYesServer = credentialServer({
    allowedUpstreamOrigins: ["https://api.internal.example"],
  });
  for (const path of ["https://attacker.example/steal", "//attacker.example/steal"]) {
    await assert.rejects(
      () =>
        renderYesServer.publishReviewedCatalog({
          catalog: approvedCatalog,
          bindings: {
            "agentReport.list": { ...approvedBindings["agentReport.list"], path },
          },
          baseUrl: "https://api.internal.example",
          credentialId: "support-api",
        }),
      /must be relative to the approved server/,
      `expected ${path} to be rejected`,
    );
  }
});

test("a binding that stays on the approved server still publishes", async () => {
  const renderYesServer = credentialServer({
    allowedUpstreamOrigins: [
      "https://api.internal.example",
      "https://reports.internal.example",
    ],
    upstreamCredentials: { "support-api": "RENDERYES_SUPPORT_TOKEN" },
  });
  const summary = await renderYesServer.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: {
      "agentReport.list": {
        ...approvedBindings["agentReport.list"],
        // A second allowlisted origin is legitimate: one catalog may span
        // several approved services.
        serverUrl: "https://reports.internal.example",
      },
    },
    baseUrl: "https://api.internal.example",
    credentialId: "support-api",
  });
  assert.equal(summary.ok, true);
});

async function savedViewServer(upstreamBaseUrl, sessionsByRequest) {
  const renderYesServer = createViewServer({
    host: {
      isAuthenticated: (s) => Boolean(s.agentId),
      hasPermission: (s, permission) => s.permissions.has(permission),
      getSessionValue: (s, key) => s[key],
    },
    resolveSession: (request) => sessionsByRequest(request),
    viewStore: createMemoryViewStore(),
    resolveViewOwner: (session) => session.agentId,
    allowedUpstreamOrigins: [new URL(upstreamBaseUrl).origin],
  });
  await renderYesServer.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    baseUrl: upstreamBaseUrl,
  });
  await renderYesServer.publishUiCatalog({ manifest: toSiteManifest(supportSite) });
  return renderYesServer;
}

async function composeOnce(server, request) {
  return server.composeAgainstPublishedCatalogs({
    catalogId: "support-assist",
    prompt: "show me open agent reports",
    request,
    createProvider: () => ({
      id: "fixed",
      async generatePlan() {
        return {
          modelId: "test-model",
          value: {
            status: "ready",
            dataRequests: [
              { requestId: "r1", capabilityId: "agentReport.list", params: {} },
            ],
            nodes: [
              {
                nodeId: "n1",
                componentId: "ReportCard",
                props: {},
                dataBindings: { report: { requestId: "r1" } },
              },
            ],
          },
        };
      },
    }),
  });
}

test("saves a composed view and reopens it with freshly fetched data", async () => {
  let upstreamCalls = 0;
  const upstream = await startUpstream((req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: upstreamCalls }));
  });
  try {
    const alice = { agentId: "alice", permissions: new Set() };
    const server = await savedViewServer(upstream.baseUrl, () => alice);

    const composed = await composeOnce(server, {});
    assert.equal(composed.ok, true);
    const planId = composed.messages
      .flatMap((m) => (m.updateDataModel ? [m.updateDataModel] : []))
      .map((d) => d.value?.__renderyes?.planId)
      .find(Boolean);
    assert.ok(planId, "compose should expose a planId in the data model");

    const saved = await server.saveComposedView({
      catalogId: "support-assist",
      planId,
      label: "My reports",
      request: {},
    });
    assert.equal(saved.ok, true);

    const list = await server.listSavedViews({ request: {} });
    assert.equal(list.length, 1);
    assert.equal(list[0].label, "My reports");
    // Catalog is unchanged since saving, so nothing is stale.
    assert.equal(list[0].stale, false);
    // A summary must not carry the plan body.
    assert.equal(list[0].plan, undefined);

    const callsBeforeReopen = upstreamCalls;
    const reopened = await server.reopenSavedView({ viewId: saved.viewId, request: {} });
    assert.equal(reopened.ok, true);
    // Reopening replays the plan rather than restoring a snapshot.
    assert.ok(upstreamCalls > callsBeforeReopen, "reopen should refetch upstream data");
  } finally {
    await upstream.close();
  }
});

test("one visitor cannot read, reopen, or delete another's saved view", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 1 }));
  });
  try {
    const alice = { agentId: "alice", permissions: new Set() };
    const mallory = { agentId: "mallory", permissions: new Set() };
    const server = await savedViewServer(upstream.baseUrl, (request) =>
      request?.who === "mallory" ? mallory : alice,
    );

    const composed = await composeOnce(server, {});
    const planId = composed.messages
      .flatMap((m) => (m.updateDataModel ? [m.updateDataModel] : []))
      .map((d) => d.value?.__renderyes?.planId)
      .find(Boolean);
    const saved = await server.saveComposedView({
      catalogId: "support-assist",
      planId,
      request: {},
    });

    // Mallory holds a valid view id, which must not be an authorisation.
    assert.deepEqual(await server.listSavedViews({ request: { who: "mallory" } }), []);
    await assert.rejects(
      () => server.reopenSavedView({ viewId: saved.viewId, request: { who: "mallory" } }),
      /No saved view/,
    );
    assert.deepEqual(
      await server.deleteSavedView({ viewId: saved.viewId, request: { who: "mallory" } }),
      { ok: false },
    );
    // Alice still has it.
    assert.equal((await server.listSavedViews({ request: {} })).length, 1);
  } finally {
    await upstream.close();
  }
});

test("one visitor cannot save, refine, or revise another's composed plan", async () => {
  // `planId` is a v4 UUID, so this is not reachable by guessing — but an
  // authorization check that depends on an identifier staying secret is not an
  // authorization check. One leaked log line, proxy trace, or echoed response
  // and holding the id would be enough. A remembered plan also carries the
  // visitor's own `prompt`, so the leak is what they asked, not just a handle.
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 1 }));
  });
  try {
    const alice = { agentId: "alice", permissions: new Set() };
    const mallory = { agentId: "mallory", permissions: new Set() };
    const server = await savedViewServer(upstream.baseUrl, (request) =>
      request?.who === "mallory" ? mallory : alice,
    );

    const composed = await composeOnce(server, {});
    const planId = composed.messages
      .flatMap((m) => (m.updateDataModel ? [m.updateDataModel] : []))
      .map((d) => d.value?.__renderyes?.planId)
      .find(Boolean);
    assert.ok(planId, "expected a planId from the compose");

    const asMallory = { who: "mallory" };
    await assert.rejects(
      () =>
        server.saveComposedView({
          catalogId: "support-assist",
          planId,
          request: asMallory,
        }),
      /No recently composed plan/,
      "mallory must not save alice's plan",
    );
    await assert.rejects(
      () =>
        server.refineComposedView({
          catalogId: "support-assist",
          planId,
          operations: [{ kind: "setLimit", requestId: "r1", limit: 5 }],
          request: asMallory,
        }),
      /No recently composed plan/,
      "mallory must not refine alice's plan",
    );
    await assert.rejects(
      () =>
        server.composeAgainstPublishedCatalogs({
          catalogId: "support-assist",
          prompt: "now show me closed ones",
          previousPlanId: planId,
          createProvider,
          request: asMallory,
        }),
      /No recently composed plan/,
      "mallory must not revise alice's plan",
    );

    // Alice can still do all three — the check gates on identity, not on the
    // plan having been touched.
    const saved = await server.saveComposedView({
      catalogId: "support-assist",
      planId,
      request: {},
    });
    assert.equal(saved.ok, true);
  } finally {
    await upstream.close();
  }
});

test("saving refuses a planId this server never composed", async () => {
  const server = await savedViewServer("http://127.0.0.1:9", () => ({
    agentId: "alice",
    permissions: new Set(),
  }));
  // Otherwise a caller could store an arbitrary plan and have it executed.
  await assert.rejects(
    () =>
      server.saveComposedView({
        catalogId: "support-assist",
        planId: "plan-not-from-here",
        request: {},
      }),
    /No recently composed plan/,
  );
});

test("saved-view methods reject when no store is configured", async () => {
  const server = await createTestServer("http://127.0.0.1:9");
  await assert.rejects(
    () => server.listSavedViews({ request: {} }),
    /Saved views are not enabled/,
  );
});

test("refines a composed view without calling the model", async () => {
  let providerCalls = 0;
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 7 }));
  });
  try {
    const server = await savedViewServer(upstream.baseUrl, () => ({
      agentId: "alice",
      permissions: new Set(),
    }));
    const composed = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me open agent reports",
      request: {},
      createProvider: () => ({
        id: "counting",
        async generatePlan() {
          providerCalls += 1;
          return {
            modelId: "test-model",
            value: {
              status: "ready",
              dataRequests: [
                { requestId: "r1", capabilityId: "agentReport.list", params: {} },
              ],
              nodes: [
                {
                  nodeId: "n1",
                  componentId: "ReportCard",
                  props: {},
                  dataBindings: { report: { requestId: "r1" } },
                },
              ],
            },
          };
        },
      }),
    });
    assert.equal(composed.ok, true);
    assert.equal(providerCalls, 1);

    const planId = composed.messages
      .flatMap((m) => (m.updateDataModel ? [m.updateDataModel] : []))
      .map((d) => d.value?.__renderyes?.planId)
      .find(Boolean);

    const refined = await server.refineComposedView({
      catalogId: "support-assist",
      planId,
      operations: [{ kind: "setLimit", requestId: "r1", limit: 5 }],
      request: {},
    });
    assert.equal(refined.ok, true);
    // The whole point: a sort/filter/limit click must not cost a composition.
    assert.equal(providerCalls, 1);
  } finally {
    await upstream.close();
  }
});

test("a failed revision returns the previous view instead of nothing", async () => {
  // The planner has always built `fallbackPlan` for exactly this case, and the
  // server used to drop it — so a visitor who typed a follow-up the model
  // could not satisfy lost the view they already had as the price of asking.
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 7 }));
  });
  try {
    const server = await savedViewServer(upstream.baseUrl, () => ({
      agentId: "alice",
      permissions: new Set(),
    }));
    let call = 0;
    const provider = () => ({
      id: "flaky",
      async generatePlan() {
        call += 1;
        // First compose succeeds; every later attempt returns a draft that
        // cannot validate, exhausting the repair loop.
        if (call === 1) {
          return {
            modelId: "test-model",
            value: {
              status: "ready",
              dataRequests: [
                { requestId: "r1", capabilityId: "agentReport.list", params: {} },
              ],
              nodes: [
                {
                  nodeId: "n1",
                  componentId: "ReportCard",
                  props: {},
                  dataBindings: { report: { requestId: "r1" } },
                },
              ],
            },
          };
        }
        return {
          modelId: "test-model",
          value: { status: "ready", dataRequests: [], nodes: [] },
        };
      },
    });

    const composed = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me open agent reports",
      request: {},
      createProvider: provider,
    });
    assert.equal(composed.ok, true);

    const revised = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "now group them by something impossible",
      previousPlanId: composed.planId,
      request: {},
      createProvider: provider,
    });

    // Still reported as a failure — the revision genuinely did not work.
    assert.equal(revised.ok, false);
    assert.equal(revised.fellBack, true);
    assert.ok(revised.reason);
    // But the visitor keeps a renderable view: the one they already had.
    assert.ok(Array.isArray(revised.messages) && revised.messages.length > 0);
    assert.ok(revised.planId, "the fallback view is addressable for further refinement");
  } finally {
    await upstream.close();
  }
});

test("a failed first compose has no fallback and returns no messages", async () => {
  // Nothing to fall back to, so the failure stays a plain failure — the
  // fallback path must not invent an empty view.
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 7 }));
  });
  try {
    const server = await savedViewServer(upstream.baseUrl, () => ({
      agentId: "alice",
      permissions: new Set(),
    }));
    const result = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "something impossible",
      request: {},
      createProvider: () => ({
        id: "broken",
        async generatePlan() {
          return {
            modelId: "test-model",
            value: { status: "ready", dataRequests: [], nodes: [] },
          };
        },
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.fellBack, undefined);
    assert.equal(result.messages, undefined);
  } finally {
    await upstream.close();
  }
});

test("compose returns the planId that refine, save, and revise accept", async () => {
  // The id used to exist only inside the `__renderyes` data-model envelope,
  // so no client could name a view to act on it — every post-compose feature
  // was implemented, tested, and unreachable. This asserts the round trip a
  // real client makes: compose, then act on what compose returned.
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 7 }));
  });
  try {
    const server = await savedViewServer(upstream.baseUrl, () => ({
      agentId: "alice",
      permissions: new Set(),
    }));
    const composed = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me open agent reports",
      request: {},
      createProvider: () => ({
        id: "fixed",
        async generatePlan() {
          return {
            modelId: "test-model",
            value: {
              status: "ready",
              dataRequests: [
                { requestId: "r1", capabilityId: "agentReport.list", params: {} },
              ],
              nodes: [
                {
                  nodeId: "n1",
                  componentId: "ReportCard",
                  props: {},
                  dataBindings: { report: { requestId: "r1" } },
                },
              ],
            },
          };
        },
      }),
    });

    assert.equal(composed.ok, true);
    assert.ok(composed.planId, "compose must return a planId");
    // It must be the same id the envelope carries, not a second identity.
    const envelopeId = composed.messages
      .flatMap((m) => (m.updateDataModel ? [m.updateDataModel] : []))
      .map((d) => d.value?.__renderyes?.planId)
      .find(Boolean);
    assert.equal(composed.planId, envelopeId);

    // Same gap one level down: `refineComposedView` takes a requestId, and that
    // id lived only in the envelope, so a caller could hold a refinable view and
    // still not name which request to refine.
    assert.deepEqual(composed.requests, [
      // `delivered` alongside `ok`: the first says execution did not fail, the
      // second says rows reached the slot. Counting them as one thing is how a
      // view with every slot empty reported success.
      {
        requestId: "r1",
        capabilityId: "agentReport.list",
        ok: true,
        // `state` is what `use-compose` reads to aim a refine; `delivered` is
        // whether rows arrived. Both, because `ok` alone conflated "did not
        // throw" with "has something in it".
        state: "ready",
        delivered: true,
      },
    ]);

    // Every follow-up accepts it — including the requestId, taken from the
    // result rather than known in advance.
    const refined = await server.refineComposedView({
      catalogId: "support-assist",
      planId: composed.planId,
      operations: [
        { kind: "setLimit", requestId: composed.requests[0].requestId, limit: 5 },
      ],
      request: {},
    });
    assert.equal(refined.ok, true);
    assert.ok(refined.planId, "refine must return a planId too");
    // A refinement is a new plan, so chaining refines from the returned id
    // builds on the latest view rather than re-refining the original.
    assert.notEqual(refined.planId, composed.planId);

    // And the refined id is itself actionable.
    const saved = await server.saveComposedView({
      catalogId: "support-assist",
      planId: refined.planId,
      request: {},
    });
    assert.equal(saved.ok, true);

    const reopened = await server.reopenSavedView({
      viewId: saved.viewId,
      request: {},
    });
    assert.equal(reopened.ok, true);
    assert.equal(reopened.planId, refined.planId, "reopen names the plan it replayed");
  } finally {
    await upstream.close();
  }
});

test("refine re-validates queries against the approved catalog", async () => {
  // The control the docs advertise, previously untested. A refinement is
  // visitor input, so a hand-built filter must pass the same catalog check a
  // model-produced plan does — otherwise "direct manipulation without a model
  // call" would also mean "without the approval boundary". This capability
  // advertises no filterable fields at all, so any filter must be refused.
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 7 }));
  });
  try {
    const server = await savedViewServer(upstream.baseUrl, () => ({
      agentId: "alice",
      permissions: new Set(),
    }));
    const composed = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me open agent reports",
      request: {},
      createProvider: () => ({
        id: "fixed",
        async generatePlan() {
          return {
            modelId: "test-model",
            value: {
              status: "ready",
              dataRequests: [
                { requestId: "r1", capabilityId: "agentReport.list", params: {} },
              ],
              nodes: [
                {
                  nodeId: "n1",
                  componentId: "ReportCard",
                  props: {},
                  dataBindings: { report: { requestId: "r1" } },
                },
              ],
            },
          };
        },
      }),
    });
    assert.equal(composed.ok, true);
    const planId = composed.messages
      .flatMap((m) => (m.updateDataModel ? [m.updateDataModel] : []))
      .map((d) => d.value?.__renderyes?.planId)
      .find(Boolean);

    const refined = await server.refineComposedView({
      catalogId: "support-assist",
      planId,
      operations: [
        {
          kind: "setFilter",
          requestId: "r1",
          filter: {
            operator: "and",
            conditions: [{ field: "total_reports", operator: "greater-than", value: 3 }],
          },
        },
      ],
      request: {},
    });

    assert.equal(refined.ok, false);
    assert.equal(refined.kind, "invalid");
    assert.match(refined.reason, /not valid against the approved catalog/);
  } finally {
    await upstream.close();
  }
});

test("refine rejects an unknown requestId and an empty surface", async () => {
  const plan = {
    schemaVersion: "3.1",
    planId: "plan-1",
    siteId: "support-assist",
    catalog: { id: "c", version: "1.0.0" },
    dataCatalog: { id: "d", version: "1.0.0", catalogHash: "h" },
    dataRequests: [{ requestId: "r1", capabilityId: "agentReport.list", params: {} }],
    surfaces: [
      { id: "main", nodes: [{ nodeId: "n1", componentId: "ReportCard", props: {} }] },
    ],
    generation: { createdAt: new Date().toISOString() },
  };
  assert.equal(
    applyRefineOperations(
      plan,
      [{ kind: "setLimit", requestId: "nope", limit: 2 }],
      "main",
    ).ok,
    false,
  );
  // Removing the only component leaves nothing to render — that is a reset,
  // not a refinement.
  const emptied = applyRefineOperations(
    plan,
    [{ kind: "removeNode", nodeId: "n1" }],
    "main",
  );
  assert.equal(emptied.ok, false);
  assert.match(emptied.reason, /at least one component/);
});

test("refine reorders nodes and assigns the result a new planId", async () => {
  const plan = {
    schemaVersion: "3.1",
    planId: "plan-1",
    siteId: "support-assist",
    catalog: { id: "c", version: "1.0.0" },
    dataCatalog: { id: "d", version: "1.0.0", catalogHash: "h" },
    dataRequests: [],
    surfaces: [
      {
        id: "main",
        nodes: [
          { nodeId: "a", componentId: "ReportCard", props: {} },
          { nodeId: "b", componentId: "ReportCard", props: {} },
        ],
      },
    ],
    generation: { createdAt: new Date().toISOString() },
  };
  const result = applyRefineOperations(
    plan,
    [{ kind: "reorderNodes", nodeIds: ["b", "a"] }],
    "main",
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.plan.surfaces[0].nodes.map((n) => n.nodeId),
    ["b", "a"],
  );
  assert.notEqual(result.plan.planId, "plan-1");
  // Input must not be mutated.
  assert.deepEqual(
    plan.surfaces[0].nodes.map((n) => n.nodeId),
    ["a", "b"],
  );
  // A partial reorder is rejected rather than silently dropping a node.
  assert.equal(
    applyRefineOperations(plan, [{ kind: "reorderNodes", nodeIds: ["a"] }], "main").ok,
    false,
  );
});

test("a revision sees the current view and is never served from the plan cache", async () => {
  const prompts = [];
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 1 }));
  });
  try {
    const server = createViewServer({
      host: {
        isAuthenticated: (s) => Boolean(s.agentId),
        hasPermission: (s, permission) => s.permissions.has(permission),
        getSessionValue: (s, key) => s[key],
      },
      resolveSession: () => ({ agentId: "alice", permissions: new Set() }),
      // Required to revise: a planId lookup is an authorization decision, so
      // without an owner to check against the server refuses rather than
      // serving anyone who holds the id.
      resolveViewOwner: (s) => s.agentId,
      // Enabled precisely so the revision path can prove it bypasses it.
      planCache: createMemoryPlanCache(),
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
    });
    await server.publishReviewedCatalog({
      catalog: approvedCatalog,
      bindings: approvedBindings,
      baseUrl: upstream.baseUrl,
    });
    await server.publishUiCatalog({ manifest: toSiteManifest(supportSite) });

    const provider = () => ({
      id: "recording",
      async generatePlan(request) {
        prompts.push(request.userPrompt);
        return {
          modelId: "test-model",
          value: {
            status: "ready",
            dataRequests: [
              { requestId: "r1", capabilityId: "agentReport.list", params: {} },
            ],
            nodes: [
              {
                nodeId: "n1",
                componentId: "ReportCard",
                props: {},
                dataBindings: { report: { requestId: "r1" } },
              },
            ],
          },
        };
      },
    });

    const first = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me open agent reports",
      request: {},
      createProvider: provider,
    });
    assert.equal(first.ok, true);
    const planId = first.messages
      .flatMap((m) => (m.updateDataModel ? [m.updateDataModel] : []))
      .map((d) => d.value?.__renderyes?.planId)
      .find(Boolean);

    const revised = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "only the open ones",
      previousPlanId: planId,
      request: {},
      createProvider: provider,
    });
    assert.equal(revised.ok, true);
    // A revision must actually reach the model, not a cache keyed on prompt.
    assert.equal(prompts.length, 2);
    assert.equal(revised.cached, false);
    // The model must be told what is currently on screen, or "only the open
    // ones" is meaningless.
    assert.match(prompts[1], /Current components:/);
    assert.match(prompts[1], /n1: ReportCard/);
    assert.match(prompts[1], /r1: agentReport\.list/);
    assert.match(prompts[1], /Requested change: only the open ones/);
  } finally {
    await upstream.close();
  }
});

test("revising an unknown planId is rejected rather than silently starting over", async () => {
  const server = await createTestServer("http://127.0.0.1:9");
  await assert.rejects(
    () =>
      server.composeAgainstPublishedCatalogs({
        catalogId: "support-assist",
        prompt: "only the open ones",
        previousPlanId: "plan-does-not-exist",
        request: {},
        createProvider,
      }),
    /No recently composed plan/,
  );
});

/** The A2UI catalog id the surface message actually names. */
function surfaceCatalogId(result) {
  return result.messages.find((message) => message.createSurface)?.createSurface.catalogId;
}

function planIdOf(result) {
  return result.messages
    .flatMap((m) => (m.updateDataModel ? [m.updateDataModel] : []))
    .map((d) => d.value?.__renderyes?.planId)
    .find(Boolean);
}

test("a host's uiCatalogId survives refinement instead of reverting to the default", async () => {
  // The client sends `uiCatalogId` on refine and the server used to recompute
  // `${catalogId}:ui` regardless. A host that overrode it therefore got a
  // working first compose and an empty surface on every refinement — component
  // registrations were filed under one id and the refinement named another,
  // with no error and nothing logged. The docs then pointed at this exact
  // mismatch, so a host following them found nothing wrong.
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 3 }));
  });
  try {
    const server = await createTestServer(upstream.baseUrl);
    const composed = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me open agent reports",
      uiCatalogId: "host-chosen-ui",
      request: {},
      createProvider,
    });
    assert.equal(composed.ok, true);
    assert.equal(surfaceCatalogId(composed), "host-chosen-ui");

    const refined = await server.refineComposedView({
      catalogId: "support-assist",
      planId: planIdOf(composed),
      operations: [{ kind: "setLimit", requestId: "r1", limit: 5 }],
      request: {},
    });
    assert.equal(refined.ok, true);
    assert.equal(
      surfaceCatalogId(refined),
      "host-chosen-ui",
      "a refinement must render against the catalog the plan was composed against",
    );

    // And a refinement of the refinement, since each one is remembered afresh.
    const again = await server.refineComposedView({
      catalogId: "support-assist",
      planId: planIdOf(refined),
      operations: [{ kind: "setLimit", requestId: "r1", limit: 4 }],
      request: {},
    });
    assert.equal(surfaceCatalogId(again), "host-chosen-ui");
  } finally {
    await upstream.close();
  }
});

test("a host's uiCatalogId survives save and reopen", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 3 }));
  });
  try {
    const alice = { agentId: "alice", permissions: new Set() };
    const server = await savedViewServer(upstream.baseUrl, () => alice);

    const composed = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me open agent reports",
      uiCatalogId: "host-chosen-ui",
      request: {},
      createProvider,
    });
    const saved = await server.saveComposedView({
      catalogId: "support-assist",
      planId: planIdOf(composed),
      request: {},
    });

    const reopened = await server.reopenSavedView({ viewId: saved.viewId, request: {} });
    assert.equal(reopened.ok, true);
    assert.equal(
      surfaceCatalogId(reopened),
      "host-chosen-ui",
      "coming back to a saved view must render against the same catalog it was composed against",
    );
  } finally {
    await upstream.close();
  }
});

test("a server with no resolveViewOwner refuses to revise, refine or save", async () => {
  // Every planId lookup is an authorization decision. The check used to compare
  // only when both sides carried a key, so a host that declared no resolver got
  // a check that matched everyone: holding any planId was enough to act on
  // another visitor's view. Absence is now a refusal.
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 3 }));
  });
  try {
    // `resolveViewOwner: undefined` overrides the fixture's own resolver.
    const server = await createTestServer(upstream.baseUrl, {
      resolveViewOwner: undefined,
    });

    // Composing is still fine — a stateless host needs no owner.
    const composed = await composeOnce(server, {});
    assert.equal(composed.ok, true);
    const planId = planIdOf(composed);

    await assert.rejects(
      () =>
        server.refineComposedView({
          catalogId: "support-assist",
          planId,
          operations: [{ kind: "setLimit", requestId: "r1", limit: 5 }],
          request: {},
        }),
      /resolveViewOwner is required to refine/,
    );

    await assert.rejects(
      () =>
        server.composeAgainstPublishedCatalogs({
          catalogId: "support-assist",
          prompt: "only the open ones",
          previousPlanId: planId,
          request: {},
          createProvider,
        }),
      /resolveViewOwner is required to revise/,
    );
  } finally {
    await upstream.close();
  }
});

test("a plan remembered before an owner resolver existed is refused, not left open", async () => {
  // The migration direction that matters: an entry with no ownerKey must not
  // become a plan everybody owns. `undefined !== ownerKey` denies it.
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 3 }));
  });
  try {
    let owner;
    const server = await createTestServer(upstream.baseUrl, {
      // Absent for the compose, present by the time the refine arrives.
      resolveViewOwner: () => owner,
    });
    const composed = await composeOnce(server, {});
    const planId = planIdOf(composed);

    owner = "AG-1";
    await assert.rejects(
      () =>
        server.refineComposedView({
          catalogId: "support-assist",
          planId,
          operations: [{ kind: "setLimit", requestId: "r1", limit: 5 }],
          request: {},
        }),
      /No recently composed plan/,
    );
  } finally {
    await upstream.close();
  }
});

test("a view saved against a since-changed component set lists as stale and says why", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 3 }));
  });
  try {
    const alice = { agentId: "alice", permissions: new Set() };
    const server = await savedViewServer(upstream.baseUrl, () => alice);

    const composed = await composeOnce(server, {});
    const planId = composed.messages
      .flatMap((m) => (m.updateDataModel ? [m.updateDataModel] : []))
      .map((d) => d.value?.__renderyes?.planId)
      .find(Boolean);
    const saved = await server.saveComposedView({
      catalogId: "support-assist",
      planId,
      request: {},
    });
    assert.equal((await server.listSavedViews({ request: {} }))[0].stale, false);

    // Republish with a second component added. The capability catalog is
    // untouched — only the *site* moved. Staleness used to be judged on the
    // catalog hash alone, so this listed as perfectly fresh and the drift was
    // discovered on reopen or not at all.
    //
    // Adding rather than changing, so the saved plan is still replayable: the
    // point is that "stale" and "broken" are different, and a host needs to be
    // able to say "this rendered, but it was built against an older set".
    await server.publishUiCatalog({
      manifest: toSiteManifest(
        defineSite({
          id: supportSite.id,
          name: "Support Assist",
          // Version deliberately unchanged: a host adding a component and not
          // bumping the site version is the ordinary case, and the one where
          // "stale but still renders" is a meaningful state.
          version: "1.0.0",
          catalogId: supportSite.catalog.id,
          components: [
            ReportCard,
            defineComponent({
              id: "ReportTable",
              version: "1.0.0",
              description: "Shows many agent reports as a table.",
              props: defineProps({}),
              renderer: { component: "ReportTable", props: { rows: { path: "/rows" } } },
              dataSlots: {
                rows: { accepts: [{ dataTypeId: "AgentReport", shapes: ["collection"] }] },
              },
            }),
          ],
          surfaces: [
            defineSurface({
              id: "main",
              description: "Main surface.",
              componentIds: ["ReportCard", "ReportTable"],
              maxComponents: 4,
            }),
          ],
        }),
      ),
    });

    const list = await server.listSavedViews({ request: {} });
    assert.equal(list[0].stale, true);

    // Still replayable: the plan names components that are all still there, so
    // refusing outright would discard a view that renders correctly.
    const reopened = await server.reopenSavedView({ viewId: saved.viewId, request: {} });
    assert.equal(reopened.ok, true);
    assert.equal(reopened.stale, true);
    assert.match(reopened.staleReason, /component registrations have changed/);
  } finally {
    await upstream.close();
  }
});

test("reopening a view whose component is gone fails as a result rather than throwing", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 3 }));
  });
  try {
    const alice = { agentId: "alice", permissions: new Set() };
    const server = await savedViewServer(upstream.baseUrl, () => alice);

    const composed = await composeOnce(server, {});
    const planId = composed.messages
      .flatMap((m) => (m.updateDataModel ? [m.updateDataModel] : []))
      .map((d) => d.value?.__renderyes?.planId)
      .find(Boolean);
    const saved = await server.saveComposedView({
      catalogId: "support-assist",
      planId,
      request: {},
    });

    // Publish a site that no longer has the component the saved plan names.
    await server.publishUiCatalog({
      manifest: toSiteManifest(
        defineSite({
          id: supportSite.id,
          name: "Support operations",
          version: "2.0.0",
          catalogId: supportSite.catalog.id,
          components: [
            defineComponent({
              id: "SomethingElse",
              version: "1.0.0",
              description: "A different component entirely.",
              props: defineProps({}),
              renderer: { component: "SomethingElse", props: { report: { path: "/report" } } },
              dataSlots: {
                report: { accepts: [{ dataTypeId: "AgentReport", shapes: ["entity"] }] },
              },
            }),
          ],
          surfaces: [
            defineSurface({
              id: "main",
              description: "Main surface.",
              componentIds: ["SomethingElse"],
              maxComponents: 4,
            }),
          ],
        }),
      ),
    });

    // Uncaught, this took the whole request down with a message about an unknown
    // component id and no hint that the view was simply old.
    const reopened = await server.reopenSavedView({ viewId: saved.viewId, request: {} });
    assert.equal(reopened.ok, false);
    assert.equal(reopened.kind, "invalid");
    assert.match(reopened.reason, /can no longer be replayed/);
    assert.match(reopened.reason, /component registrations have changed/);
  } finally {
    await upstream.close();
  }
});

test("reopening a view whose catalog was withdrawn is unsupported, not an exception", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 3 }));
  });
  try {
    const alice = { agentId: "alice", permissions: new Set() };
    const server = await savedViewServer(upstream.baseUrl, () => alice);
    const composed = await composeOnce(server, {});
    const planId = composed.messages
      .flatMap((m) => (m.updateDataModel ? [m.updateDataModel] : []))
      .map((d) => d.value?.__renderyes?.planId)
      .find(Boolean);
    const saved = await server.saveComposedView({
      catalogId: "support-assist",
      planId,
      request: {},
    });

    // A fresh server with the view store shared but nothing published is the
    // same situation a host hits after a redeploy that hasn't republished yet.
    const bare = createViewServer({
      host: {
        isAuthenticated: () => true,
        hasPermission: () => true,
        getSessionValue: () => undefined,
      },
      resolveSession: () => alice,
      viewStore: {
        save: async () => {},
        get: async () => ({
          id: saved.viewId,
          catalogId: "support-assist",
          surfaceId: "main",
          ownerKey: "alice",
          prompt: "show me open agent reports",
          plan: { schemaVersion: "3.1", planId: "p", siteId: "x", surfaces: [] },
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
          catalogHash: "sha256:whatever",
        }),
        list: async () => [],
        delete: async () => {},
      },
      resolveViewOwner: (session) => session.agentId,
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
    });

    const reopened = await bare.reopenSavedView({ viewId: saved.viewId, request: {} });
    assert.equal(reopened.ok, false);
    assert.equal(reopened.kind, "unsupported");
    assert.match(reopened.reason, /no longer published/);
  } finally {
    await upstream.close();
  }
});

/**
 * The upstream's HTTP status decides two things a caller acts on: whether to
 * retry, and which side of the boundary to investigate. Both were previously
 * discarded — every non-2xx became one message with `retryable: true`.
 */
async function graphQlFailureAgainst(status, body) {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body ?? JSON.stringify({ errors: [{ message: "nope" }] }));
  });
  try {
    const reviewed = reviewedGraphQlCatalog();
    const server = createViewServer({
      host: {
        isAuthenticated: () => true,
        hasPermission: () => true,
        getSessionValue: (session, key) => session[key],
      },
      resolveSession: () => ({ agentId: "AG-1", permissions: new Set(["reports:read"]) }),
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
      graphql: {
        resolveHeaders: () => ({}),
        resolveProvenance: ({ sourceId }) => ({
          sources: [{ sourceId }],
          freshness: { asOf: "2026-08-10T00:00:00.000Z" },
        }),
      },
    });
    await server.publishReviewedCatalog({
      bindingKind: "graphql",
      catalog: reviewed.catalog,
      bindings: reviewed.bindings,
      schema: reviewed.schema,
      endpoint: `${upstream.baseUrl}/graphql`,
    });
    const result = await server.planAgainstPublishedCatalog({
      catalogId: "support-graph",
      prompt: "show my report summary",
      request: { agentId: "AG-1" },
      createProvider,
    });
    return result.results.r1;
  } finally {
    await upstream.close();
  }
}

test("a 5xx upstream is reported as the upstream failing, and is retryable", async () => {
  const failed = await graphQlFailureAgainst(500);

  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "GRAPHQL_TRANSPORT_ERROR");
  // "Rejected" reads as a decision the upstream made about the request, which
  // sends whoever is debugging to inspect the request. A 500 means the upstream
  // itself failed — exactly what a gateway missing an environment variable
  // returns, and it was previously indistinguishable from a 400.
  assert.match(failed.error.message, /failed to handle the request/);
  assert.match(failed.error.message, /HTTP 500/);
  assert.equal(failed.error.retryable, true);
});

/**
 * 401 and 403 are split out for the same reason 5xx is: they name a different
 * thing to go and look at. Folded into "rejected the request" they read as a bad
 * query, when the query was fine and the forwarded credential was not — and this
 * is the failure that otherwise reappears downstream as an empty permission set
 * and then as "missing permission", three hops from the cause.
 */
test("a rejected credential is not reported as a rejected query", async () => {
  for (const status of [401, 403]) {
    const failed = await graphQlFailureAgainst(status);
    assert.match(failed.error.message, /rejected the forwarded credential, not the query/);
    assert.match(failed.error.message, /resolveHeaders/);
    assert.match(failed.error.message, new RegExp(`HTTP ${status}`));
    // A credential that is wrong now is wrong on a retry.
    assert.equal(failed.error.retryable, false);
  }
});

test("a 4xx upstream is reported as a rejection, and is not retryable", async () => {
  const failed = await graphQlFailureAgainst(400);

  assert.match(failed.error.message, /rejected the request/);
  assert.match(failed.error.message, /HTTP 400/);
  // A malformed request will be just as malformed next time. Marking it
  // retryable buys nothing but latency.
  assert.equal(failed.error.retryable, false);
});

test("401 is a rejection and not retryable; 429 is the 4xx a retry can fix", async () => {
  const unauthorized = await graphQlFailureAgainst(401);
  assert.match(unauthorized.error.message, /HTTP 401/);
  assert.equal(unauthorized.error.retryable, false);

  const throttled = await graphQlFailureAgainst(429);
  assert.match(throttled.error.message, /HTTP 429/);
  assert.equal(throttled.error.retryable, true);
});

test("a 2xx that is not JSON is not treated as transient", async () => {
  // Something other than the GraphQL endpoint is answering — a proxy, a login
  // page, an error page. Retrying returns the same page.
  const failed = await graphQlFailureAgainst(200, "<html>login</html>");

  assert.match(failed.error.message, /invalid JSON/);
  assert.equal(failed.error.retryable, false);
});

/**
 * A GraphQL adapter supplying `fetchImpl` and `resolveHeaders` but not
 * `resolveProvenance` is a truthy object, so publication used to succeed and
 * the gap surfaced later as PROVENANCE_UNAVAILABLE — a failure that needs a
 * request to get far enough to have rows to attribute. Anything failing in
 * front of it (a permission, an upstream page cap) hides it entirely; in one
 * real integration it stayed hidden for a day behind two unrelated failures.
 */
test("publishing a GraphQL catalog requires resolveProvenance up front", async () => {
  const reviewed = reviewedGraphQlCatalog();
  const renderYesServer = createViewServer({
    host: {
      isAuthenticated: (session) => Boolean(session.agentId),
      hasPermission: (session, permission) => session.permissions.has(permission),
      getSessionValue: (session, key) => session[key],
    },
    resolveSession: () => ({ agentId: "AG-1", permissions: new Set(["reports:read"]) }),
    allowedUpstreamOrigins: ["http://127.0.0.1:9"],
    // A plausible half-configuration: headers wired, attribution forgotten.
    graphql: { resolveHeaders: () => ({}) },
  });

  await assert.rejects(
    () =>
      renderYesServer.publishReviewedCatalog({
        bindingKind: "graphql",
        catalog: reviewed.catalog,
        bindings: reviewed.bindings,
        schema: reviewed.schema,
        endpoint: "http://127.0.0.1:9/graphql",
      }),
    /resolveProvenance is required to publish a GraphQL catalog/,
  );
});

/**
 * The whole truncation chain, end to end, because each layer was already
 * covered alone and the gap between them was not: `graphql.ts` sets
 * `provenance.truncated` from `pageInfo.hasNextPage`, the registry builds the
 * runtime, `executeDataRequest` must carry the flag through validation and the
 * row budget, and `projectPlanDataModel` must turn it into `complete: false`.
 *
 * A connection that reports another page is the case where a host sees a clean
 * 100 rows out of thousands. If any link drops the flag the system asserts
 * something false rather than merely incomplete, which is worse than a vague
 * answer, so it is asserted across the links rather than within them.
 */
test("a connection with further pages reaches the data model as incomplete", async () => {
  const SDL = `
    type Query { orders(first: Int, after: String): OrderCountableConnection }
    type OrderCountableConnection { edges: [OrderCountableEdge!]!  pageInfo: PageInfo! }
    type OrderCountableEdge { cursor: String!  node: Order! }
    type PageInfo { hasNextPage: Boolean!  hasPreviousPage: Boolean!  startCursor: String  endCursor: String }
    type Order { id: ID!  number: String! }
  `;
  const compiled = compileCuratedGraphQlCatalog({
    schema: SDL,
    catalog: { id: "shop", version: "1.0.0", description: "Curated reads." },
    source: { id: "shop-api", label: "Shop", description: "The store's graph." },
    policy: {
      authentication: "public",
      maximumRows: 1_000,
      timeoutMs: 5_000,
      cacheTtlSeconds: 0,
      maximumSelectedFields: 40,
      maximumSelectionDepth: 4,
    },
  });
  const capabilityId = compiled.catalog.capabilities.find(
    (capability) => capability.output.shape === "collection",
  ).id;

  let sentVariables;
  const { runtimes } = createGraphQlRuntimesFromBindings(
    compiled.catalog,
    Object.fromEntries(compiled.bindings),
    {
      schema: SDL,
      transport: async (request) => {
        sentVariables = request.variables;
        return {
          data: {
            orders: {
              pageInfo: {
                hasNextPage: true,
                hasPreviousPage: false,
                startCursor: "a",
                endCursor: "z",
              },
              edges: [{ cursor: "c1", node: { id: "1", number: "2500" } }],
            },
          },
        };
      },
      resolveProvenance: () => ({
        sources: [{ sourceId: "shop-api" }],
        freshness: { asOf: "2026-08-14T00:00:00.000Z" },
      }),
    },
  );

  const result = await executeDataRequest({
    request: { requestId: "r1", capabilityId, params: {} },
    dataCatalog: {
      id: compiled.catalog.id,
      version: compiled.catalog.version,
      hash: hashCapabilityCatalog(compiled.catalog),
    },
    catalog: compiled.catalog,
    runtimes,
    session: {},
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
  // The page cap was applied, so this is exactly the "clean 100 of 2500" case.
  assert.equal(sentVariables.first, 100);
  assert.equal(
    result.provenance.truncated,
    true,
    "a connection reporting hasNextPage was cut short by the page size",
  );
  // Deliberately absent: the upstream returned every row it was asked for, and
  // pageInfo cannot say how many exist beyond them.
  assert.equal(result.provenance.totalRowsBeforeTruncation, undefined);
});

/**
 * Publish returned what it stored, never what it knew. Renderability and
 * contract size were both computable here and only discoverable later — the
 * first by knowing to call /api/coverage, the second by running composes and
 * reading metrics:report afterwards. That pattern, not any single defect, cost
 * the most hours in the integrations so far.
 */
test("publishing reports what it already knows about the catalog", async () => {
  const session = { agentId: "AG-1", permissions: new Set() };
  const renderYesServer = createViewServer({
    host: {
      isAuthenticated: (s) => Boolean(s.agentId),
      hasPermission: (s, permission) => s.permissions.has(permission),
      getSessionValue: (s, key) => s[key],
    },
    resolveSession: () => session,
    allowedUpstreamOrigins: ["http://127.0.0.1:9"],
  });

  // Capability catalog first, which is legitimate ordering and not a mistake:
  // reported as "no UI catalog yet" rather than by listing every data type as
  // unrenderable. A list that is noise on day one is ignored by day two.
  const first = await renderYesServer.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    baseUrl: "http://127.0.0.1:9",
  });
  assert.equal(first.uiCatalogRegistered, false);
  assert.deepEqual(first.unrenderableDataTypes, []);

  // Contract size is the dominant token cost — resent on every plan attempt —
  // and a host could previously only learn it by composing and reading metrics.
  assert.ok(first.contractBytes > 0, "a catalog with capabilities has a contract");
  assert.equal(first.approximateTokens, Math.round(first.contractBytes / 4));
  // And attributed, not just totalled. A number with nothing to compare it
  // against was the whole of this for a while: a host read "415568 bytes",
  // learned their catalog was large, and had no way to know what made it large.
  assert.equal(first.contractCost.bytes, first.contractBytes);
  assert.ok(
    first.contractCost.capabilities.length > 0,
    "every capability's own contribution is reported so a host knows where to cut",
  );
  // `<=`, not `<`: this fixture's capabilities advertise no query facets, so
  // dropping them is a no-op and the floor *is* the contract. The interesting
  // case — where the filter vocabulary is most of the size — is measured
  // against a fixture that has one, in capability-catalog's own suite.
  assert.ok(
    first.contractCost.baselineBytes <= first.contractCost.bytes,
    "the facet-free floor is a floor",
  );
  assert.equal(first.contractBudget.overBudget, false);
  assert.equal(first.contractBudget.budgetTokens, DEFAULT_CONTRACT_TOKEN_BUDGET);

  await renderYesServer.publishUiCatalog({ manifest: toSiteManifest(supportSite) });
  const second = await renderYesServer.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    baseUrl: "http://127.0.0.1:9",
  });
  assert.equal(second.uiCatalogRegistered, true);
  // Derived from the same matcher /api/coverage uses, so the two must agree —
  // otherwise the publish-time answer becomes a second, drifting truth.
  const coverage = renderYesServer.getCoverageReport("support-assist");
  assert.deepEqual(
    second.unrenderableDataTypes,
    coverage.coverage
      .filter((row) => row.unrenderable)
      .map((row) => `${row.dataTypeId} (${row.shape})`),
  );
});

/**
 * A schema can lie: Saleor declares `ProductVariant.revenue`'s `period`
 * argument optional and its resolver requires it, so the field passes
 * discovery, passes approval, publishes cleanly — and then every product row
 * errors in front of a visitor. No static analysis catches a resolver
 * contradicting its own SDL. One cheap execution per capability does, at the
 * moment the host can still act on it.
 */
test("probing a published catalog reports what the upstream actually answers", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        errors: [
          {
            message:
              "resolve_revenue() missing 1 required keyword-only argument: 'period'",
            path: ["agentReport", "revenue"],
          },
        ],
      }),
    );
  });
  try {
    const reviewed = reviewedGraphQlCatalog();
    const session = {
      agentId: "AG-1",
      accessToken: "visitor-token",
      permissions: new Set(["reports:read"]),
    };
    const renderYesServer = createViewServer({
      host: {
        isAuthenticated: (s) => Boolean(s.agentId),
        hasPermission: (s, permission) => s.permissions.has(permission),
        getSessionValue: (s, key) => s[key],
      },
      resolveSession: () => session,
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
      graphql: {
        resolveHeaders: () => ({}),
        resolveProvenance: ({ sourceId }) => ({
          sources: [{ sourceId }],
          freshness: { asOf: "2026-08-10T00:00:00.000Z" },
        }),
      },
    });
    await renderYesServer.publishReviewedCatalog({
      bindingKind: "graphql",
      catalog: reviewed.catalog,
      bindings: reviewed.bindings,
      schema: reviewed.schema,
      endpoint: `${upstream.baseUrl}/graphql`,
    });

    const probe = await renderYesServer.probePublishedCatalog({
      catalogId: "support-graph",
      request: { agentId: "AG-1" },
    });
    assert.equal(probe.ok, true);
    assert.equal(probe.results.length, 1);
    const [entry] = probe.results;
    assert.equal(entry.capabilityId, "agentReport.get");
    assert.equal(entry.status, "failed");
    // Names the field, not just the capability — "(at agentReport.revenue)" is
    // the difference between knowing what to un-approve and guessing.
    assert.match(entry.reason, /revenue/);
    assert.match(entry.reason, /at agentReport\.revenue/);
  } finally {
    await upstream.close();
  }
});

test("a healthy capability probes ok", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ data: { agentReport: { status: "ok", total_reports: 3 } } }),
    );
  });
  try {
    const reviewed = reviewedGraphQlCatalog();
    const session = {
      agentId: "AG-1",
      accessToken: "visitor-token",
      permissions: new Set(["reports:read"]),
    };
    const renderYesServer = createViewServer({
      host: {
        isAuthenticated: (s) => Boolean(s.agentId),
        hasPermission: (s, permission) => s.permissions.has(permission),
        getSessionValue: (s, key) => s[key],
      },
      resolveSession: () => session,
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
      graphql: {
        resolveHeaders: () => ({}),
        resolveProvenance: ({ sourceId }) => ({
          sources: [{ sourceId }],
          freshness: { asOf: "2026-08-10T00:00:00.000Z" },
        }),
      },
    });
    await renderYesServer.publishReviewedCatalog({
      bindingKind: "graphql",
      catalog: reviewed.catalog,
      bindings: reviewed.bindings,
      schema: reviewed.schema,
      endpoint: `${upstream.baseUrl}/graphql`,
    });

    const probe = await renderYesServer.probePublishedCatalog({
      catalogId: "support-graph",
      request: { agentId: "AG-1" },
    });
    assert.equal(probe.results[0].status, "ok");
  } finally {
    await upstream.close();
  }
});

/**
 * A catalog says `authentication: "session"` because a reviewer picked it from
 * a dropdown, and no step between that dropdown and a visitor's screen has ever
 * compared it with what the upstream does. These two tests are that comparison:
 * ask the same question with the host's credential withheld and report what
 * came back.
 */
test("the probe reports an upstream that answers without the host's credential", async () => {
  const seenAuthorization = [];
  const upstream = await startUpstream((req, res) => {
    seenAuthorization.push(req.headers.authorization ?? null);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ data: { agentReport: { status: "ok", total_reports: 3 } } }),
    );
  });
  try {
    const reviewed = reviewedGraphQlCatalog();
    const session = {
      agentId: "AG-1",
      accessToken: "visitor-token",
      permissions: new Set(["reports:read"]),
    };
    const renderYesServer = createViewServer({
      host: {
        isAuthenticated: (s) => Boolean(s.agentId),
        hasPermission: (s, permission) => s.permissions.has(permission),
        getSessionValue: (s, key) => s[key],
      },
      resolveSession: () => session,
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
      graphql: {
        resolveHeaders: () => ({ authorization: "Bearer service-key" }),
        resolveProvenance: ({ sourceId }) => ({
          sources: [{ sourceId }],
          freshness: { asOf: "2026-08-10T00:00:00.000Z" },
        }),
      },
    });
    await renderYesServer.publishReviewedCatalog({
      bindingKind: "graphql",
      catalog: reviewed.catalog,
      bindings: reviewed.bindings,
      schema: reviewed.schema,
      endpoint: `${upstream.baseUrl}/graphql`,
    });

    const probe = await renderYesServer.probePublishedCatalog({
      catalogId: "support-graph",
      request: { agentId: "AG-1" },
    });

    assert.equal(probe.results[0].status, "ok");
    assert.equal(probe.results[0].upstreamCredential, "not-required");
    // Withheld by this server, not by asking the host's `resolveHeaders` to
    // withhold it — the measurement exists because a host's beliefs about their
    // own credentials may be wrong, so it cannot be delegated back to them.
    assert.deepEqual(seenAuthorization, ["Bearer service-key", null]);
  } finally {
    await upstream.close();
  }
});

test("an upstream that rejects the anonymous call is reported as enforcing", async () => {
  const upstream = await startUpstream((req, res) => {
    if (!req.headers.authorization) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "Unauthenticated." }] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ data: { agentReport: { status: "ok", total_reports: 3 } } }),
    );
  });
  try {
    const reviewed = reviewedGraphQlCatalog();
    const session = {
      agentId: "AG-1",
      accessToken: "visitor-token",
      permissions: new Set(["reports:read"]),
    };
    const renderYesServer = createViewServer({
      host: {
        isAuthenticated: (s) => Boolean(s.agentId),
        hasPermission: (s, permission) => s.permissions.has(permission),
        getSessionValue: (s, key) => s[key],
      },
      resolveSession: () => session,
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
      graphql: {
        resolveHeaders: () => ({ authorization: "Bearer service-key" }),
        resolveProvenance: ({ sourceId }) => ({
          sources: [{ sourceId }],
          freshness: { asOf: "2026-08-10T00:00:00.000Z" },
        }),
      },
    });
    await renderYesServer.publishReviewedCatalog({
      bindingKind: "graphql",
      catalog: reviewed.catalog,
      bindings: reviewed.bindings,
      schema: reviewed.schema,
      endpoint: `${upstream.baseUrl}/graphql`,
    });

    const probe = await renderYesServer.probePublishedCatalog({
      catalogId: "support-graph",
      request: { agentId: "AG-1" },
    });
    assert.equal(probe.results[0].upstreamCredential, "enforced");

    // Opt out, for an operator who does not want a second call per capability
    // against someone else's API.
    const quiet = await renderYesServer.probePublishedCatalog({
      catalogId: "support-graph",
      request: { agentId: "AG-1" },
      checkUpstreamCredential: false,
    });
    assert.equal(quiet.results[0].upstreamCredential, undefined);
  } finally {
    await upstream.close();
  }
});

/**
 * The same measurement on the OpenAPI path, which had none. It was excluded
 * because the runtime captured its credential at publish, so withholding it
 * meant republishing — the publish path now wraps the credential instead, and
 * the server drops it for one request rather than asking the host to.
 */
async function probeOpenApiCatalog(upstreamBaseUrl) {
  process.env.RENDERYES_SUPPORT_TOKEN = "service-key";
  const renderYesServer = createViewServer({
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
    },
    resolveSession: () => ({}),
    allowedUpstreamOrigins: [new URL(upstreamBaseUrl).origin],
    upstreamCredentials: { "support-api": "RENDERYES_SUPPORT_TOKEN" },
  });
  await renderYesServer.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    baseUrl: upstreamBaseUrl,
    credentialId: "support-api",
  });
  return renderYesServer.probePublishedCatalog({
    catalogId: "support-assist",
    request: {},
  });
}

test("an OpenAPI probe reports enforced when the upstream rejects the anonymous retry", async () => {
  const seen = [];
  const upstream = await startUpstream((req, res) => {
    seen.push(req.headers.authorization ?? null);
    if (!req.headers.authorization) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 3 }));
  });

  try {
    const probe = await probeOpenApiCatalog(upstream.baseUrl);
    assert.equal(probe.results[0].upstreamCredential, "enforced");
    // Two calls: the credentialed one, then the same request with the credential
    // withheld. The second is what makes this a measurement rather than a claim.
    assert.deepEqual(seen, ["Bearer service-key", null]);
  } finally {
    await upstream.close();
    delete process.env.RENDERYES_SUPPORT_TOKEN;
  }
});

test("an OpenAPI probe reports not-required when the upstream answers anyone", async () => {
  // The finding this exists to surface: a catalog can say `authentication:
  // "session"` while the upstream guards nothing, and nobody would know.
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 3 }));
  });

  try {
    const probe = await probeOpenApiCatalog(upstream.baseUrl);
    assert.equal(probe.results[0].upstreamCredential, "not-required");
  } finally {
    await upstream.close();
    delete process.env.RENDERYES_SUPPORT_TOKEN;
  }
});

/**
 * The clarification branch, end to end through the server.
 *
 * Two properties, and the second is the one that makes the feature safe: a
 * question reaches the caller as a question, and a compose that is *answering*
 * one cannot produce another. Without the second, a model that keeps finding
 * the prompt ambiguous asks indefinitely and the visitor's only exit is
 * reloading the page.
 */
test("a planner question reaches the caller with its options, and is not an error", async () => {
  const renderYesServer = await createTestServer("http://127.0.0.1:9");
  const result = await renderYesServer.composeAgainstPublishedCatalogs({
    catalogId: "support-assist",
    prompt: "show me reports",
    request: {},
    createProvider: () => ({
      id: "asking",
      generatePlan: async () => ({
        value: {
          status: "needs-clarification",
          question: "Open reports, or reports you opened?",
          options: ["Open reports", "Reports I opened"],
        },
        modelId: "mock",
      }),
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "needs-clarification");
  assert.equal(result.question, "Open reports, or reports you opened?");
  assert.deepEqual(result.options, ["Open reports", "Reports I opened"]);
  // The question is also the reason, so a caller that only reads the older
  // failure shape shows something true rather than generic failure copy.
  assert.equal(result.reason, result.question);
});

test("answering a question removes the branch from the contract the server builds", async () => {
  const renderYesServer = await createTestServer("http://127.0.0.1:9");
  const schemas = [];
  const capture = () => ({
    id: "asking",
    generatePlan: async (request) => {
      schemas.push(request.jsonSchema);
      return {
        value: { status: "unsupported", reason: "not today" },
        modelId: "mock",
      };
    },
  });

  await renderYesServer.composeAgainstPublishedCatalogs({
    catalogId: "support-assist",
    prompt: "show me reports",
    request: {},
    createProvider: capture,
  });
  await renderYesServer.composeAgainstPublishedCatalogs({
    catalogId: "support-assist",
    prompt: "show me reports\n\nYou asked: which?\nThe answer is: open ones",
    request: {},
    answersClarification: true,
    createProvider: capture,
  });

  const statusesOf = (schema) =>
    schema.oneOf.map((variant) => variant.properties.status.const);
  assert.deepEqual(statusesOf(schemas[0]), [
    "ready",
    "unsupported",
    "needs-clarification",
  ]);
  // The whole guard: the second call cannot emit a question, because the schema
  // it is decoding against has no branch for one.
  assert.deepEqual(statusesOf(schemas[1]), ["ready", "unsupported"]);
});

test("a question is reported to metrics as neither a success nor a failure", async () => {
  // A system that asks a question every time would otherwise look like one that
  // never fails, and the outcome report exists to stop exactly that.
  const recorded = [];
  const renderYesServer = await createTestServer("http://127.0.0.1:9", {
    onComposeMetrics: (metrics) => recorded.push(metrics),
  });
  await renderYesServer.composeAgainstPublishedCatalogs({
    catalogId: "support-assist",
    prompt: "show me reports",
    request: {},
    createProvider: () => ({
      id: "asking",
      generatePlan: async () => ({
        value: { status: "needs-clarification", question: "Which ones?" },
        modelId: "mock",
      }),
    }),
  });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].outcome, "needs-clarification");
});

/**
 * Pinning: saving one panel of a composed view as its own live view.
 *
 * The contract under test is the server-side slice (`saveComposedView` with
 * `nodeIds`): the caller still sends only ids, the stored plan keeps exactly
 * the named top-level nodes (slot children included) plus the data those nodes
 * transitively reference — a join pulls both side requests, everything else is
 * dropped — and the result revalidates and replays through the ordinary
 * saved-view machinery.
 */
const pinCatalog = {
  schemaVersion: "1.0",
  id: "pin-demo",
  version: "1.0.0",
  description: "Approved reads for the pin tests.",
  dataTypes: [
    {
      id: "Ticket",
      version: "1.0.0",
      description: "An approved support ticket row.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ticket", "owner"],
        properties: { ticket: { type: "string" }, owner: { type: "string" } },
      },
      fields: {
        ticket: { label: "Ticket", semanticType: "identifier" },
        owner: { label: "Owner", semanticType: "text" },
      },
    },
    {
      id: "Agent",
      version: "1.0.0",
      description: "An approved support agent.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["name", "team"],
        properties: { name: { type: "string" }, team: { type: "string" } },
      },
      fields: {
        name: { label: "Agent", semanticType: "identifier" },
        team: { label: "Team", semanticType: "text" },
      },
    },
    {
      id: "Stat",
      version: "1.0.0",
      description: "An approved summary statistic.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["label", "total"],
        properties: { label: { type: "string" }, total: { type: "integer" } },
      },
      fields: {
        label: { label: "Label", semanticType: "text" },
        total: { label: "Total", semanticType: "quantity" },
      },
    },
  ],
  sources: [{ id: "pin-api", label: "Pin API" }],
  capabilities: [
    {
      id: "tickets.search",
      version: "1.0.0",
      purpose: "List approved support tickets.",
      kind: "query",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ticket", "owner"],
          properties: { ticket: { type: "string" }, owner: { type: "string" } },
        },
      },
      output: { dataTypeId: "Ticket", shape: "collection" },
      requiredSessionKeys: [],
      sourceIds: ["pin-api"],
      policy: { authentication: "public" },
    },
    {
      id: "agents.list",
      version: "1.0.0",
      purpose: "List approved support agents.",
      kind: "query",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "team"],
          properties: { name: { type: "string" }, team: { type: "string" } },
        },
      },
      output: { dataTypeId: "Agent", shape: "collection" },
      requiredSessionKeys: [],
      sourceIds: ["pin-api"],
      policy: { authentication: "public" },
    },
    {
      id: "stats.summary",
      version: "1.0.0",
      purpose: "Read the approved ticket summary statistic.",
      kind: "query",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["label", "total"],
        properties: { label: { type: "string" }, total: { type: "integer" } },
      },
      output: { dataTypeId: "Stat", shape: "entity" },
      requiredSessionKeys: [],
      sourceIds: ["pin-api"],
      policy: { authentication: "public" },
    },
  ],
  relationships: [
    {
      id: "ticket-owner-agent",
      description: "A ticket's owner is an agent.",
      from: { dataTypeId: "Ticket", field: "owner" },
      to: { dataTypeId: "Agent", field: "name" },
      cardinality: "many-to-one",
    },
  ],
};

const pinBindings = {
  "tickets.search": {
    capabilityId: "tickets.search",
    method: "GET",
    path: "/api/v1/tickets",
    contentParameters: [],
    exposeFields: ["ticket", "owner"],
  },
  "agents.list": {
    capabilityId: "agents.list",
    method: "GET",
    path: "/api/v1/agents",
    contentParameters: [],
    exposeFields: ["name", "team"],
  },
  "stats.summary": {
    capabilityId: "stats.summary",
    method: "GET",
    path: "/api/v1/stats",
    contentParameters: [],
    exposeFields: ["label", "total"],
  },
};

const TicketTable = defineComponent({
  id: "TicketTable",
  version: "1.0.0",
  description: "Shows tickets with their owning agent joined in.",
  props: defineProps({ title: field.string({ default: "Tickets" }) }),
  renderer: { component: "DataTable", props: { rows: { path: "/rows" } } },
  dataSlots: {
    rows: { accepts: [{ dataTypeId: "Ticket", shapes: ["collection"] }] },
  },
});

const StatCard = defineComponent({
  id: "StatCard",
  version: "1.0.0",
  description: "Shows one summary statistic.",
  props: defineProps({ title: field.string({ default: "Stat" }) }),
  renderer: { component: "Text", props: { stat: { path: "/stat" } } },
  dataSlots: {
    stat: { accepts: [{ dataTypeId: "Stat", shapes: ["entity"] }] },
  },
});

const SummaryPanel = defineComponent({
  id: "SummaryPanel",
  version: "1.0.0",
  description: "A container panel with one headline stat.",
  props: defineProps({}),
  renderer: { component: "Column", props: {} },
  slots: {
    headline: {
      description: "The stat shown at the top of the panel.",
      cardinality: "one",
      accepts: ["StatCard"],
    },
  },
});

const pinSite = defineSite({
  id: "pin-demo",
  name: "Pin demo",
  version: "1.0.0",
  catalogId: "https://pin.example.com/renderyes/catalog.json",
  components: [TicketTable, StatCard, SummaryPanel],
  surfaces: [
    defineSurface({
      id: "main",
      description: "Main surface.",
      componentIds: ["TicketTable", "StatCard", "SummaryPanel"],
    }),
  ],
});

/**
 * A deterministic three-panel plan: panel-a is a container whose *slot child*
 * binds r-stats, table-b binds a join of r-tickets and r-agents, card-c binds
 * r-extra. Each slicing property the tests assert has a node that isolates it.
 */
const pinPlanProvider = () => ({
  id: "fixed-pin",
  async generatePlan() {
    return {
      modelId: "test-model",
      value: {
        status: "ready",
        dataRequests: [
          { requestId: "r-tickets", capabilityId: "tickets.search", params: {} },
          { requestId: "r-agents", capabilityId: "agents.list", params: {} },
          { requestId: "r-stats", capabilityId: "stats.summary", params: {} },
          { requestId: "r-extra", capabilityId: "stats.summary", params: {} },
        ],
        dataJoins: [
          {
            joinId: "j1",
            relationshipId: "ticket-owner-agent",
            left: "r-tickets",
            right: "r-agents",
            as: "agent",
          },
        ],
        nodes: [
          {
            nodeId: "panel-a",
            componentId: "SummaryPanel",
            props: {},
            slots: {
              headline: [
                {
                  nodeId: "stat-child",
                  componentId: "StatCard",
                  props: {},
                  dataBindings: { stat: { requestId: "r-stats" } },
                },
              ],
            },
          },
          {
            nodeId: "table-b",
            componentId: "TicketTable",
            props: {},
            dataBindings: { rows: { joinId: "j1" } },
          },
          {
            nodeId: "card-c",
            componentId: "StatCard",
            props: {},
            dataBindings: { stat: { requestId: "r-extra" } },
          },
        ],
      },
    };
  },
});

/**
 * Upstream, server, one composed three-panel view, and a window into what the
 * view store was actually given — the slice's output is the stored plan, and
 * reading it back through the store is the honest way to see it.
 */
async function pinFixture() {
  const pathCalls = {};
  const upstream = await startUpstream((req, res) => {
    const path = req.url.split("?")[0];
    pathCalls[path] = (pathCalls[path] ?? 0) + 1;
    res.writeHead(200, { "content-type": "application/json" });
    if (path === "/api/v1/tickets") {
      res.end(
        JSON.stringify([
          { ticket: "T1", owner: "Maya" },
          { ticket: "T2", owner: "Priya" },
        ]),
      );
    } else if (path === "/api/v1/agents") {
      res.end(JSON.stringify([{ name: "Maya", team: "Billing" }]));
    } else {
      res.end(JSON.stringify({ label: "Total", total: 12 }));
    }
  });

  const inner = createMemoryViewStore();
  const savedViews = [];
  const viewStore = {
    save: async (view) => {
      savedViews.push(view);
      return inner.save(view);
    },
    get: (id, ownerKey) => inner.get(id, ownerKey),
    list: (ownerKey) => inner.list(ownerKey),
    delete: (id, ownerKey) => inner.delete(id, ownerKey),
  };

  const server = createViewServer({
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: (session, key) => session[key],
    },
    resolveSession: () => ({ agentId: "alice", permissions: new Set() }),
    resolveViewOwner: (session) => session.agentId,
    viewStore,
    allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
  });
  await server.publishReviewedCatalog({
    catalog: pinCatalog,
    bindings: pinBindings,
    baseUrl: upstream.baseUrl,
  });
  await server.publishUiCatalog({ manifest: toSiteManifest(pinSite) });

  const composed = await server.composeAgainstPublishedCatalogs({
    catalogId: "pin-demo",
    prompt: "tickets with their agents, plus the summary stats",
    request: {},
    createProvider: pinPlanProvider,
  });
  assert.equal(composed.ok, true, `fixture compose failed: ${composed.reason ?? ""}`);
  return { server, upstream, composed, savedViews, pathCalls };
}

test("pinning the join panel keeps both join sides and drops every unrelated request", async () => {
  const { server, upstream, composed, savedViews } = await pinFixture();
  try {
    const saved = await server.saveComposedView({
      catalogId: "pin-demo",
      planId: composed.planId,
      nodeIds: ["table-b"],
      label: "Just the table",
      request: {},
    });
    assert.equal(saved.ok, true);

    const view = savedViews.at(-1);
    const plan = view.plan;
    // Exactly the pinned node, its binding's join, and the join's two side
    // requests. r-stats and r-extra fed other panels and must not ride along.
    assert.deepEqual(
      plan.surfaces[0].nodes.map((node) => node.nodeId),
      ["table-b"],
    );
    assert.deepEqual(
      plan.dataRequests.map((request) => request.requestId).sort(),
      ["r-agents", "r-tickets"],
    );
    assert.deepEqual(
      (plan.dataJoins ?? []).map((join) => join.joinId),
      ["j1"],
    );
    assert.equal(plan.dataCompositions, undefined);
    // The pin is a new plan with recorded provenance, not the old plan mutated.
    assert.notEqual(plan.planId, composed.planId);
    assert.equal(view.pinnedFromPlanId, composed.planId);
    // The list summary still works and carries no plan body.
    const listed = await server.listSavedViews({ request: {} });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].label, "Just the table");
    assert.equal(listed[0].plan, undefined);
  } finally {
    await upstream.close();
  }
});

test("pinning a container panel keeps its nested slot children's bindings", async () => {
  const { server, upstream, composed, savedViews } = await pinFixture();
  try {
    const saved = await server.saveComposedView({
      catalogId: "pin-demo",
      planId: composed.planId,
      nodeIds: ["panel-a"],
      request: {},
    });
    assert.equal(saved.ok, true);

    const plan = savedViews.at(-1).plan;
    // The container survives with its slot child intact…
    assert.deepEqual(
      plan.surfaces[0].nodes.map((node) => node.nodeId),
      ["panel-a"],
    );
    assert.deepEqual(
      plan.surfaces[0].nodes[0].slots.headline.map((child) => child.nodeId),
      ["stat-child"],
    );
    // …and the request only that child binds is what is kept. The join and
    // its sides belong to another panel and are gone.
    assert.deepEqual(
      plan.dataRequests.map((request) => request.requestId),
      ["r-stats"],
    );
    assert.equal(plan.dataJoins, undefined);
  } finally {
    await upstream.close();
  }
});

test("pinning rejects an unknown nodeId, and a nested child is not a top-level node", async () => {
  const { server, upstream, composed, savedViews } = await pinFixture();
  try {
    await assert.rejects(
      () =>
        server.saveComposedView({
          catalogId: "pin-demo",
          planId: composed.planId,
          nodeIds: ["not-a-node"],
          request: {},
        }),
      /no top-level node "not-a-node"/,
    );
    // A slot child is part of its parent's approved layout, not a panel of its
    // own — naming it is the same refusal, not a smaller pin.
    await assert.rejects(
      () =>
        server.saveComposedView({
          catalogId: "pin-demo",
          planId: composed.planId,
          nodeIds: ["stat-child"],
          request: {},
        }),
      /no top-level node "stat-child"/,
    );
    // And an empty list is a malformed request, not a save of nothing.
    await assert.rejects(
      () =>
        server.saveComposedView({
          catalogId: "pin-demo",
          planId: composed.planId,
          nodeIds: [],
          request: {},
        }),
      /at least one nodeId/,
    );
    // None of the refusals stored anything.
    assert.equal(savedViews.length, 0);
  } finally {
    await upstream.close();
  }
});

test("a saved pin reopens through reopenSavedView and executes only its own requests", async () => {
  const { server, upstream, composed, pathCalls } = await pinFixture();
  try {
    const saved = await server.saveComposedView({
      catalogId: "pin-demo",
      planId: composed.planId,
      nodeIds: ["table-b"],
      request: {},
    });

    const before = { ...pathCalls };
    const reopened = await server.reopenSavedView({ viewId: saved.viewId, request: {} });
    assert.equal(reopened.ok, true);
    // Fresh data for the join's two sides…
    assert.equal(pathCalls["/api/v1/tickets"], (before["/api/v1/tickets"] ?? 0) + 1);
    assert.equal(pathCalls["/api/v1/agents"], (before["/api/v1/agents"] ?? 0) + 1);
    // …and nothing for the panels the pin left behind.
    assert.equal(pathCalls["/api/v1/stats"] ?? 0, before["/api/v1/stats"] ?? 0);
    assert.deepEqual(
      reopened.requests.map((request) => request.requestId).sort(),
      ["r-agents", "r-tickets"],
    );
    assert.ok(reopened.requests.every((request) => request.ok));
    // It compiled into renderable messages — a sliced plan is just a small
    // plan, and the ordinary replay path accepts a single-node surface.
    assert.ok(Array.isArray(reopened.messages) && reopened.messages.length > 0);
    // Not stale: the pin was saved against the currently published catalog.
    assert.equal(reopened.stale, undefined);
  } finally {
    await upstream.close();
  }
});

test("a save without nodeIds is unchanged: whole plan, same planId, no pin provenance", async () => {
  const { server, upstream, composed, savedViews } = await pinFixture();
  try {
    const saved = await server.saveComposedView({
      catalogId: "pin-demo",
      planId: composed.planId,
      request: {},
    });
    assert.equal(saved.ok, true);
    const view = savedViews.at(-1);
    assert.equal(view.plan.planId, composed.planId);
    assert.deepEqual(
      view.plan.surfaces[0].nodes.map((node) => node.nodeId),
      ["panel-a", "table-b", "card-c"],
    );
    assert.equal(view.plan.dataRequests.length, 4);
    assert.equal(view.pinnedFromPlanId, undefined);
  } finally {
    await upstream.close();
  }
});

/**
 * The signal item 8 exists to produce.
 *
 * A plan spanning two data types with no relationship available does not fail
 * and is not refused: the planner only ever sees approved relationships, so it
 * never asks for one that is absent. It emits two independent requests, the
 * visitor gets two unlinked panels, and nothing distinguishes that from two
 * panels being exactly what was wanted.
 *
 * So the metrics carry two facts and no verdict. `dataTypesSpanned > 1 &&
 * joinableRelationshipCount === 0` is the condition worth knowing, and it is a
 * query a host runs over its own telemetry rather than a judgement this library
 * makes on one request.
 */
test("compose reports how many data types a plan spanned and whether joins exist", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 3 }));
  });
  try {
    const objectSchema = {
      type: "object",
      additionalProperties: false,
      required: ["status", "total_reports"],
      properties: { status: { type: "string" }, total_reports: { type: "integer" } },
    };
    const dataType = (id) => ({
      id,
      version: "1.0.0",
      description: `${id} fixture.`,
      schema: objectSchema,
      fields: {
        status: { label: "Status", semanticType: "status" },
        total_reports: { label: "Total", semanticType: "quantity" },
      },
    });
    const capability = (id, dataTypeId) => ({
      id,
      version: "1.0.0",
      purpose: `Read ${dataTypeId}.`,
      kind: "query",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: objectSchema,
      output: { dataTypeId, shape: "entity" },
      requiredSessionKeys: [],
      sourceIds: ["support-api"],
      policy: { authentication: "public" },
    });
    const binding = (id) => ({
      capabilityId: id,
      method: "GET",
      path: "/api/v1/agent-report",
      contentParameters: [],
      exposeFields: ["status", "total_reports"],
    });

    const spanningCatalog = {
      schemaVersion: "1.0",
      id: "spanning",
      version: "1.0.0",
      description: "Two data types, one to-one relationship.",
      dataTypes: [dataType("AgentReport"), dataType("AgentSummary")],
      sources: [{ id: "support-api", label: "Support Assist API" }],
      capabilities: [
        capability("report.get", "AgentReport"),
        capability("summary.get", "AgentSummary"),
      ],
      relationships: [
        {
          id: "report.summary",
          description: "A report's summary.",
          from: { dataTypeId: "AgentReport", field: "status" },
          to: { dataTypeId: "AgentSummary", field: "status" },
          cardinality: "many-to-one",
        },
        {
          // Counted by nothing: the runtime's `joinOne` and the planner both
          // refuse anything that is not to-one, so reporting it as available
          // would promise a join both layers reject.
          id: "report.many",
          description: "Not joinable.",
          from: { dataTypeId: "AgentReport", field: "status" },
          to: { dataTypeId: "AgentSummary", field: "status" },
          cardinality: "one-to-many",
        },
      ],
    };

    // Accepts by shape, not by data type id, so one component serves both.
    const AnyEntity = defineComponent({
      id: "AnyEntity",
      version: "1.0.0",
      description: "Shows one record.",
      props: defineProps({ title: field.string({ default: "Record" }) }),
      renderer: { component: "AnyEntity", props: { record: { path: "/record" } } },
      dataSlots: { record: { accepts: [{ shape: "entity" }] } },
    });
    const spanningSite = defineSite({
      id: "spanning",
      name: "Spanning",
      version: "1.0.0",
      catalogId: "https://support.example.com/renderyes/catalog.json",
      components: [AnyEntity],
      surfaces: [
        defineSurface({
          id: "main",
          description: "Main surface.",
          componentIds: ["AnyEntity"],
          maxComponents: 2,
        }),
      ],
    });

    const seen = [];
    const session = { agentId: "AG-1", permissions: new Set() };
    const renderYesServer = createViewServer({
      host: {
        isAuthenticated: (s) => Boolean(s.agentId),
        hasPermission: (s, permission) => s.permissions.has(permission),
        getSessionValue: (s, key) => s[key],
      },
      resolveSession: () => session,
      onComposeMetrics: (metrics) => seen.push(metrics),
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
    });
    await renderYesServer.publishReviewedCatalog({
      catalog: spanningCatalog,
      bindings: { "report.get": binding("report.get"), "summary.get": binding("summary.get") },
      baseUrl: upstream.baseUrl,
    });
    await renderYesServer.publishUiCatalog({
      manifest: toSiteManifest(spanningSite),
      catalogId: "spanning",
    });

    const result = await renderYesServer.composeAgainstPublishedCatalogs({
      catalogId: "spanning",
      prompt: "show reports and summaries",
      request: {},
      createProvider: () => ({
        id: "spanning",
        async generatePlan() {
          return {
            modelId: "test-model",
            value: {
              status: "ready",
              dataRequests: [
                { requestId: "r1", capabilityId: "report.get", params: {} },
                { requestId: "r2", capabilityId: "summary.get", params: {} },
              ],
              nodes: [
                {
                  nodeId: "n1",
                  componentId: "AnyEntity",
                  props: {},
                  dataBindings: { record: { requestId: "r1" } },
                },
                {
                  nodeId: "n2",
                  componentId: "AnyEntity",
                  props: {},
                  dataBindings: { record: { requestId: "r2" } },
                },
              ],
            },
            usage: { inputTokens: 10, outputTokens: 5, calls: 1 },
          };
        },
      }),
    });

    assert.equal(result.ok, true);
    const m = seen.at(-1);
    // The fact that matters: this answer drew on two entities.
    assert.equal(m.dataTypesSpanned, 2);
    // And exactly one of the two declared relationships is one the runtime
    // would actually execute.
    assert.equal(m.joinableRelationshipCount, 1);
  } finally {
    await upstream.close();
  }
});

/**
 * A published GraphQL connection over a 10-order dataset, with a UI catalog
 * whose one component renders the collection. The upstream honours `first`
 * and reports `hasNextPage`, so fetch completeness is real, not simulated —
 * this is the shape the live evaluation ran against.
 */
async function ordersConnectionServer() {
  const SDL = `
    type Query { orders(first: Int, after: String): OrderCountableConnection }
    type OrderCountableConnection { edges: [OrderCountableEdge!]!  pageInfo: PageInfo! }
    type OrderCountableEdge { cursor: String!  node: Order! }
    type PageInfo { hasNextPage: Boolean!  hasPreviousPage: Boolean!  startCursor: String  endCursor: String }
    type Order { id: ID!  number: String! }
  `;
  const orders = Array.from({ length: 10 }, (_, index) => ({
    id: `id-${index}`,
    number: `ORD-${index}`,
  }));
  const upstream = await startUpstream(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const first = body.variables?.first ?? orders.length;
    const page = orders.slice(0, first);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: {
          orders: {
            pageInfo: {
              hasNextPage: page.length < orders.length,
              hasPreviousPage: false,
              startCursor: "a",
              endCursor: "z",
            },
            edges: page.map((node, index) => ({ cursor: `c${index}`, node })),
          },
        },
      }),
    );
  });

  const compiled = compileCuratedGraphQlCatalog({
    schema: SDL,
    catalog: { id: "shop", version: "1.0.0", description: "Curated reads." },
    source: { id: "shop-api", label: "Shop", description: "The store's graph." },
    policy: {
      authentication: "public",
      maximumRows: 1_000,
      timeoutMs: 5_000,
      cacheTtlSeconds: 0,
      maximumSelectedFields: 40,
      maximumSelectionDepth: 4,
      // Smaller than the dataset, so an unbounded fetch is provably one page
      // of it — the completeness question these tests exist to ask.
      maximumPageSize: 5,
    },
  });
  const capabilityId = compiled.catalog.capabilities.find(
    (capability) => capability.output.shape === "collection",
  ).id;

  const OrdersTable = defineComponent({
    id: "OrdersTable",
    version: "1.0.0",
    description: "Lists orders.",
    props: defineProps({}),
    renderer: { component: "OrdersTable", props: { rows: { path: "/rows" } } },
    dataSlots: {
      rows: { accepts: [{ dataTypeId: "orders", shapes: ["collection"] }] },
    },
  });
  const shopSite = defineSite({
    id: "shop",
    name: "Shop",
    version: "1.0.0",
    catalogId: "https://shop.example.com/renderyes/catalog.json",
    components: [OrdersTable],
    surfaces: [
      defineSurface({
        id: "main",
        description: "Main surface.",
        componentIds: ["OrdersTable"],
        maxComponents: 1,
      }),
    ],
  });

  const server = createViewServer({
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
    },
    resolveSession: () => ({ agentId: "AG-1", permissions: new Set() }),
    resolveViewOwner: (session) => session.agentId,
    viewStore: createMemoryViewStore(),
    allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
    graphql: {
      resolveProvenance: ({ sourceId }) => ({
        sources: [{ sourceId }],
        freshness: { asOf: "2026-08-20T00:00:00.000Z" },
      }),
    },
  });
  await server.publishReviewedCatalog({
    bindingKind: "graphql",
    catalog: compiled.catalog,
    bindings: Object.fromEntries(compiled.bindings),
    schema: SDL,
    endpoint: `${upstream.baseUrl}/graphql`,
  });
  await server.publishUiCatalog({ manifest: toSiteManifest(shopSite) });

  const composeWithQuery = (query) =>
    server.composeAgainstPublishedCatalogs({
      catalogId: "shop",
      prompt: "orders question",
      request: {},
      createProvider: () => ({
        id: "fixed",
        async generatePlan() {
          return {
            modelId: "test-model",
            value: {
              status: "ready",
              dataRequests: [
                {
                  requestId: "r1",
                  capabilityId,
                  params: {},
                  ...(query ? { query } : {}),
                },
              ],
              nodes: [
                {
                  nodeId: "n1",
                  componentId: "OrdersTable",
                  props: {},
                  dataBindings: { rows: { requestId: "r1" } },
                },
              ],
            },
          };
        },
      }),
    });

  return { server, upstream, capabilityId, composeWithQuery };
}

/** Deep-searches the compose messages for the one completeness tag written. */
function completenessOf(messages) {
  const found = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      if ("complete" in value && "truncated" in value) {
        found.push(value);
        return;
      }
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(messages);
  assert.equal(found.length, 1, "expected exactly one completeness tag");
  return found[0];
}

test("a plan-level filter over one page of a larger dataset is not reported complete", async () => {
  // The live failure: "which warehouse holds Apple Juice" filtered a fetched
  // page, matched nothing, and told the visitor `complete: true` over 0 rows —
  // the answer lived in the pages never fetched.
  const { upstream, composeWithQuery } = await ordersConnectionServer();
  try {
    const composed = await composeWithQuery({
      filter: {
        combine: "all",
        conditions: [{ field: "number", operator: "eq", value: "ORD-999" }],
      },
    });
    // `ok: false` now, where this test previously asserted `true`. The
    // completeness metadata below already said the result was page-bounded and
    // held no rows; the envelope went on claiming success over it, and `ok` is
    // the only signal most hosts monitor — the same gap that produced "83%
    // success against a reader-visible 50%" on one production install. The view still
    // travels, so nothing the visitor could be shown is lost.
    assert.equal(composed.ok, false);
    assert.equal(composed.kind, "data-unavailable");
    assert.match(composed.reason, /over one page/);
    const completeness = completenessOf(composed.messages);
    assert.equal(completeness.complete, false);
    assert.equal(completeness.narrowedAfterFetch, true);
    assert.equal(completeness.moreAvailable, true);
    assert.equal(completeness.rowCount, 0);
  } finally {
    await upstream.close();
  }
});

test("reopening a saved view of a page-narrowed result stays incomplete", async () => {
  // Saved views replay the stored plan through the same executor, so the
  // completeness fix must hold on reopen — the eval found the lie had a longer
  // shelf life there.
  const { server, upstream, composeWithQuery } = await ordersConnectionServer();
  try {
    const composed = await composeWithQuery({
      filter: {
        combine: "all",
        conditions: [{ field: "number", operator: "eq", value: "ORD-999" }],
      },
    });
    // Page-narrowed and empty, so the envelope reports the absence — the plan
    // is still saveable, which is what this test is about.
    assert.equal(composed.ok, false);
    const saved = await server.saveComposedView({
      catalogId: "shop",
      planId: composed.planId,
      request: {},
    });
    assert.equal(saved.ok, true);

    const reopened = await server.reopenSavedView({
      viewId: saved.viewId,
      request: {},
    });
    assert.equal(reopened.ok, true);
    const completeness = completenessOf(reopened.messages);
    assert.equal(completeness.complete, false);
    assert.equal(completeness.narrowedAfterFetch, true);
  } finally {
    await upstream.close();
  }
});

test("refine reports a met limit as complete, not truncated", async () => {
  // The compose path stopped calling a met limit "truncated"; refine runs the
  // same executor and must agree: the visitor asked for 3 and got 3 — nothing
  // was cut short, the dataset merely goes on.
  const { server, upstream, composeWithQuery } = await ordersConnectionServer();
  try {
    const composed = await composeWithQuery(undefined);
    assert.equal(composed.ok, true);

    const refined = await server.refineComposedView({
      catalogId: "shop",
      planId: composed.planId,
      operations: [{ kind: "setLimit", requestId: "r1", limit: 3 }],
      request: {},
    });
    assert.equal(refined.ok, true);
    const completeness = completenessOf(refined.messages);
    assert.equal(completeness.truncated, false);
    assert.equal(completeness.complete, true);
    assert.equal(completeness.moreAvailable, true);
    assert.equal(completeness.rowCount, 3);
  } finally {
    await upstream.close();
  }
});

test("a refine limit above the page cap is refused, and the error names the ceiling", async () => {
  // Two ceilings used to disagree: policy.maximumRows (1000 here) passed a
  // limit the connection's `first <= 5` can never satisfy. And the one
  // actionable sentence sat in host-only `issues` while the visitor got a
  // generic refusal — it carries a plan constraint, not data, so it belongs in
  // the visitor-facing error.
  const { server, upstream, composeWithQuery } = await ordersConnectionServer();
  try {
    const composed = await composeWithQuery(undefined);
    assert.equal(composed.ok, true);

    const refined = await server.refineComposedView({
      catalogId: "shop",
      planId: composed.planId,
      operations: [{ kind: "setLimit", requestId: "r1", limit: 500 }],
      request: {},
    });
    assert.equal(refined.ok, false);
    assert.equal(refined.kind, "invalid");
    assert.match(refined.reason, /Limit 500 exceeds capability maximum 5/);

    // Within the effective ceiling still refines normally.
    const within = await server.refineComposedView({
      catalogId: "shop",
      planId: composed.planId,
      operations: [{ kind: "setLimit", requestId: "r1", limit: 5 }],
      request: {},
    });
    assert.equal(within.ok, true);
  } finally {
    await upstream.close();
  }
});

test("a refusal makes no repair, and the metrics say so", async () => {
  // repairCount used to be derived from billed HTTP calls minus one, so a
  // provider whose adapter retries internally (schema fallback: 2 calls in one
  // attempt) reported every refusal as one repair the planner never ran.
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 3 }));
  });
  try {
    const seen = [];
    const session = { agentId: "AG-1", permissions: new Set() };
    const renderYesServer = createViewServer({
      host: {
        isAuthenticated: (s) => Boolean(s.agentId),
        hasPermission: (s, permission) => s.permissions.has(permission),
        getSessionValue: (s, key) => s[key],
      },
      resolveSession: () => session,
      onComposeMetrics: (metrics) => seen.push(metrics),
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
    });
    await renderYesServer.publishReviewedCatalog({
      catalog: approvedCatalog,
      bindings: approvedBindings,
      baseUrl: upstream.baseUrl,
    });
    await renderYesServer.publishUiCatalog({ manifest: toSiteManifest(supportSite) });

    const result = await renderYesServer.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "please do something this site cannot",
      request: {},
      createProvider: () => ({
        id: "refusing",
        async generatePlan() {
          return {
            modelId: "test-model",
            value: {
              status: "unsupported",
              reason: "The approved catalog has no capability for that.",
            },
            // Two billed HTTP calls in the one attempt, as a schema-fallback
            // retry produces. Still zero repairs.
            usage: { inputTokens: 10, outputTokens: 5, calls: 2 },
          };
        },
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.kind, "unsupported");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].outcome, "unsupported");
    assert.equal(seen[0].modelCalls, 2);
    assert.equal(seen[0].repairCount, 0, "a refusal is not a repair");
  } finally {
    await upstream.close();
  }
});

test("a real repair loop still counts its repairs", async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 3 }));
  });
  try {
    const seen = [];
    const session = { agentId: "AG-1", permissions: new Set() };
    const renderYesServer = createViewServer({
      host: {
        isAuthenticated: (s) => Boolean(s.agentId),
        hasPermission: (s, permission) => s.permissions.has(permission),
        getSessionValue: (s, key) => s[key],
      },
      resolveSession: () => session,
      onComposeMetrics: (metrics) => seen.push(metrics),
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
    });
    await renderYesServer.publishReviewedCatalog({
      catalog: approvedCatalog,
      bindings: approvedBindings,
      baseUrl: upstream.baseUrl,
    });
    await renderYesServer.publishUiCatalog({ manifest: toSiteManifest(supportSite) });

    let attempts = 0;
    const result = await renderYesServer.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me open agent reports",
      request: {},
      createProvider: () => ({
        id: "flaky",
        async generatePlan() {
          attempts += 1;
          if (attempts === 1) {
            // An invalid draft, so the planner runs one corrective re-prompt.
            return {
              modelId: "test-model",
              value: { status: "ready", dataRequests: [], nodes: [] },
            };
          }
          return {
            modelId: "test-model",
            value: {
              status: "ready",
              dataRequests: [
                { requestId: "r1", capabilityId: "agentReport.list", params: {} },
              ],
              nodes: [
                {
                  nodeId: "n1",
                  componentId: "ReportCard",
                  props: {},
                  dataBindings: { report: { requestId: "r1" } },
                },
              ],
            },
          };
        },
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].repairCount, 1);
  } finally {
    await upstream.close();
  }
});

test("publishing a catalog with zero capabilities is refused", async () => {
  const renderYesServer = createViewServer({
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
    },
    resolveSession: () => ({}),
    allowedUpstreamOrigins: ["http://127.0.0.1:9"],
  });
  // The live incident: a caller-side slice produced a structurally valid,
  // completely empty catalog; the publish returned ok:true and replaced the
  // working one, and every later compose read as planner trouble.
  await assert.rejects(
    () =>
      renderYesServer.publishReviewedCatalog({
        catalog: { ...approvedCatalog, capabilities: [], relationships: [] },
        bindings: {},
        baseUrl: "http://127.0.0.1:9",
      }),
    /declares no capabilities/,
  );
});

test("a setLimit that cannot grow the rows says so instead of silently staying small", async () => {
  // Interim honesty for refine-vs-limit: the operation applies (ok stays
  // true), but 2 matching rows under a limit of 4 with a known-continuing set
  // must not read as "that is all there is". The plan filters, so the fetch is
  // page-bounded and the filter's matches are what the limit applies to.
  const { server, upstream, composeWithQuery } = await ordersConnectionServer();
  try {
    const composed = await composeWithQuery({
      filter: {
        combine: "all",
        conditions: [
          { field: "number", operator: "in", value: ["ORD-1", "ORD-3"] },
        ],
      },
    });
    assert.equal(composed.ok, true);

    const raised = await server.refineComposedView({
      catalogId: "shop",
      planId: composed.planId,
      operations: [{ kind: "setLimit", requestId: "r1", limit: 4 }],
      request: {},
    });
    assert.equal(raised.ok, true);
    assert.ok(Array.isArray(raised.notices), "expected a notice");
    assert.equal(raised.notices.length, 1);
    assert.match(raised.notices[0], /Limit 4 could only be filled to 2 row/);
    assert.match(raised.notices[0], /more rows exist/);

    // A legitimate shrink stays clean: the limit was met, nothing to caveat.
    const shrunk = await server.refineComposedView({
      catalogId: "shop",
      planId: raised.planId,
      operations: [{ kind: "setLimit", requestId: "r1", limit: 1 }],
      request: {},
    });
    assert.equal(shrunk.ok, true);
    assert.equal(shrunk.notices, undefined);
  } finally {
    await upstream.close();
  }
});

test("the probe warns on approved fields that answered null on every sampled row", async () => {
  // A raising resolver is `degraded`; a null-answering one probed clean while
  // every view selecting the field rendered blanks — measured as three such
  // fields in one schema, each needing an argument the SDL declares optional.
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 7, note: null }));
  });
  try {
    const nullableCatalog = structuredClone(approvedCatalog);
    nullableCatalog.dataTypes[0].schema.properties.note = {
      anyOf: [{ type: "string" }, { type: "null" }],
    };
    nullableCatalog.dataTypes[0].fields.note = { label: "Note", semanticType: "text" };
    nullableCatalog.capabilities[0].outputSchema.properties.note = {
      anyOf: [{ type: "string" }, { type: "null" }],
    };
    const nullableBindings = structuredClone(approvedBindings);
    nullableBindings["agentReport.list"].exposeFields.push("note");

    const server = createViewServer({
      host: {
        isAuthenticated: () => true,
        hasPermission: () => true,
        getSessionValue: () => undefined,
      },
      resolveSession: () => ({}),
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
    });
    await server.publishReviewedCatalog({
      catalog: nullableCatalog,
      bindings: nullableBindings,
      baseUrl: upstream.baseUrl,
    });

    const probe = await server.probePublishedCatalog({
      catalogId: "support-assist",
      checkUpstreamCredential: false,
      request: {},
    });
    const entry = probe.results.find((row) => row.capabilityId === "agentReport.list");
    // Advisory, never a block: the capability still probes ok.
    assert.equal(entry.status, "ok");
    assert.deepEqual(entry.alwaysNullFields, ["note"]);
    assert.equal(entry.warnings.length, 1);
    assert.match(entry.warnings[0], /"note" was null on every sampled row/);
    assert.match(entry.warnings[0], /optional/);
    // Populated fields are not flagged.
    assert.equal(entry.alwaysNullFields.includes("status"), false);
  } finally {
    await upstream.close();
  }
});

test("coverage reports each capability's narrowing reach alongside renderability", async () => {
  const { server, upstream } = await ordersConnectionServer();
  try {
    const report = await server.getCoverageReport("shop");
    assert.equal(report.ok, true);
    // Additive: the original shape is intact.
    assert.ok(Array.isArray(report.coverage));
    const entry = report.filtering.find((row) => row.capabilityId === "graphql.orders");
    assert.ok(entry, "expected a filtering entry per capability");
    // The curated fixture approves only paging arguments, so every advertised
    // filter field is page-scoped and nothing narrows at the source — the
    // caveat that used to exist nowhere an integrator could read.
    assert.equal(entry.noSourceNarrowing, true);
    assert.deepEqual(entry.sourceNarrowingArguments, []);
    assert.ok(entry.pageScopedFilterFieldCount >= 1);
    assert.equal(entry.dataTypeId, "orders");
  } finally {
    await upstream.close();
  }
});

test("a coverage-blocked refusal names the missing component, and crosses the wire", async () => {
  // End to end for R7: a published capability the surface cannot render used
  // to be simply absent from the contract, so the model truthfully reported
  // having no capability and named the *catalog* — the one blocker whose fix
  // ("approve more fields") cannot help. The fact must reach the prompt and
  // the refusal text must reach the client.
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", total_reports: 1 }));
  });
  try {
    // A second capability producing a hierarchy — the measured shape. Nothing
    // in `supportSite` accepts it.
    const withTree = structuredClone(approvedCatalog);
    withTree.dataTypes.push({
      id: "CategoryTree",
      version: "1.0.0",
      description: "A category tree.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { type: "string" } },
      },
      fields: { status: { label: "Status", semanticType: "status" } },
    });
    withTree.capabilities.push({
      ...structuredClone(approvedCatalog.capabilities[0]),
      id: "categories.tree",
      purpose: "Browse the product category tree.",
      output: { dataTypeId: "CategoryTree", shape: "hierarchy" },
    });
    const treeBindings = structuredClone(approvedBindings);
    treeBindings["categories.tree"] = {
      ...structuredClone(approvedBindings["agentReport.list"]),
      capabilityId: "categories.tree",
    };

    const server = createViewServer({
      host: {
        isAuthenticated: () => true,
        hasPermission: () => true,
        getSessionValue: () => undefined,
      },
      resolveSession: () => ({ agentId: "alice", permissions: new Set() }),
      resolveViewOwner: (session) => session.agentId,
      allowedUpstreamOrigins: [new URL(upstream.baseUrl).origin],
    });
    await server.publishReviewedCatalog({
      catalog: withTree,
      bindings: treeBindings,
      baseUrl: upstream.baseUrl,
    });
    await server.publishUiCatalog({ manifest: toSiteManifest(supportSite) });

    let systemPrompt = "";
    const refusal =
      "The category tree data is approved and available, but this surface has no " +
      "component that can present a CategoryTree hierarchy.";
    const result = await server.composeAgainstPublishedCatalogs({
      catalogId: "support-assist",
      prompt: "show me the product category tree",
      request: {},
      createProvider: () => ({
        id: "refusing",
        async generatePlan(request) {
          systemPrompt = request.systemPrompt;
          return {
            modelId: "test-model",
            value: { status: "unsupported", reason: refusal },
          };
        },
      }),
    });

    // The fact reached the prompt, compactly, marked unusable.
    assert.match(systemPrompt, /Approved data this surface cannot display/);
    assert.match(systemPrompt, /CategoryTree \(hierarchy\)/);
    assert.match(systemPrompt, /These are NOT bindable/);
    assert.match(systemPrompt, /this surface has no component that can present it/);
    // And the capability stayed out of every bindable part of the contract.
    assert.equal(systemPrompt.includes("categories.tree"), false);

    // The refusal itself is returned verbatim, not replaced by a generic
    // message — the visitor-facing distinction is the whole point.
    assert.equal(result.ok, false);
    assert.equal(result.kind, "unsupported");
    assert.equal(result.reason, refusal);

    // And over HTTP, where a client reads `error`. The handler cannot be
    // handed a provider through a request body — that is the point of the
    // boundary — so the refusing provider is injected at the seam a host
    // would wrap, leaving the envelope itself under test.
    const handler = createViewHttpHandler(
      {
        ...server,
        composeAgainstPublishedCatalogs: (input) =>
          server.composeAgainstPublishedCatalogs({
            ...input,
            createProvider: () => ({
              id: "refusing",
              async generatePlan() {
                return {
                  modelId: "test-model",
                  value: { status: "unsupported", reason: refusal },
                };
              },
            }),
          }),
      },
      { requireAdmin: () => true },
    );
    const response = await handler(
      new Request("http://localhost:4200/api/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          catalogId: "support-assist",
          prompt: "show me the product category tree",
        }),
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.reason, refusal);
    assert.equal(body.error, refusal);
  } finally {
    await upstream.close();
  }
});

/**
 * A contract too large to send is refused at publish, when the host asked for
 * that.
 *
 * The failure this closes is not a crash. A provider handed an oversized
 * structured schema rejects it, and the planner does not fail the compose — it
 * retries in unconstrained JSON mode, at an extra call per attempt and worse
 * decoding. So the symptom of publishing a catalog past what a model will take
 * is a quality regression with a console warning, and publish returning
 * `ok: true` was the last place that could have said so.
 */
test("a contract past the declared ceiling is refused before anything is published", async () => {
  const session = { agentId: "AG-1", permissions: new Set() };
  const config = {
    host: {
      isAuthenticated: (s) => Boolean(s.agentId),
      hasPermission: (s, permission) => s.permissions.has(permission),
      getSessionValue: (s, key) => s[key],
    },
    resolveSession: () => session,
    allowedUpstreamOrigins: ["http://127.0.0.1:9"],
  };

  // A ceiling of one token refuses anything, which is the point: the number is
  // the host's, and the library ships no default for it.
  const strict = createViewServer({ ...config, contractTokenCeiling: 1 });
  await assert.rejects(
    () =>
      strict.publishReviewedCatalog({
        catalog: approvedCatalog,
        bindings: approvedBindings,
        baseUrl: "http://127.0.0.1:9",
      }),
    (error) => {
      assert.match(error.message, /Refusing to publish/);
      // Refused with the levers, not just the verdict.
      assert.match(error.message, /Fewer capabilities is the linear lever/);
      assert.match(error.message, /contractTokenCeiling/);
      return true;
    },
  );
  // Refused before the store was touched: a catalog that is live and unusable
  // is worse than one that never published.
  assert.deepEqual(strict.listPublishedCatalogs(), []);

  // No ceiling declared is the default, and it publishes.
  const permissive = createViewServer(config);
  const summary = await permissive.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    baseUrl: "http://127.0.0.1:9",
  });
  assert.equal(summary.ok, true);

  // A budget below the cost warns on the summary without refusing, which is the
  // difference between the two knobs.
  const budgeted = createViewServer({ ...config, contractTokenBudget: 1 });
  const warned = await budgeted.publishReviewedCatalog({
    catalog: approvedCatalog,
    bindings: approvedBindings,
    baseUrl: "http://127.0.0.1:9",
  });
  assert.equal(warned.ok, true);
  assert.equal(warned.contractBudget.overBudget, true);
  assert.match(warned.contractBudget.advice, /Fewer capabilities is the linear lever/);
});
