import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createMemoryCatalogStore,
  createViewServer,
  LIBRARY_ONLY_METHODS,
} from "../dist/index.js";
import { createFileCatalogStore } from "../dist/node.js";
import { defineComponent, defineProps, defineSite, defineSurface, field, toSiteManifest } from "@renderyes/site-sdk";

/**
 * The property under test is "a restart does not empty the registries", which
 * has no unit-testable surface of its own — the only honest way to check it is to
 * publish into one server, then build a *second* server over the same store and
 * confirm what it can see. That second construction is the restart.
 */

const catalog = {
  schemaVersion: "1.0",
  id: "support-assist",
  version: "1.0.0",
  description: "Approved reads.",
  dataTypes: [
    {
      id: "AgentReport",
      version: "1.0.0",
      description: "A report.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { type: "string" } },
      },
      fields: { status: { label: "Status", semanticType: "status" } },
    },
  ],
  sources: [{ id: "support-api", label: "Support API" }],
  capabilities: [
    {
      id: "agentReport.list",
      version: "1.0.0",
      purpose: "List reports.",
      kind: "query",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { type: "string" } },
      },
      output: { dataTypeId: "AgentReport", shape: "entity" },
      requiredSessionKeys: [],
      sourceIds: ["support-api"],
      policy: { authentication: "public" },
    },
  ],
  relationships: [],
};

const bindings = {
  "agentReport.list": {
    capabilityId: "agentReport.list",
    method: "GET",
    path: "/api/v1/agent-report",
    contentParameters: [],
    exposeFields: ["status"],
  },
};

const ReportCard = defineComponent({
  id: "ReportCard",
  version: "1.0.0",
  description: "Shows one report.",
  props: defineProps({ title: field.string({ default: "Report" }) }),
  renderer: { component: "ReportCard", props: { report: { path: "/report" } } },
  dataSlots: { report: { accepts: [{ dataTypeId: "AgentReport", shapes: ["entity"] }] } },
});

const site = defineSite({
  id: "support-assist",
  name: "Support Assist",
  version: "1.0.0",
  catalogId: "https://support.example.com/catalog.json",
  components: [ReportCard],
  surfaces: [
    defineSurface({ id: "main", description: "Main.", componentIds: ["ReportCard"], maxComponents: 1 }),
  ],
});

function serverOver(store) {
  return createViewServer({
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
    },
    resolveSession: () => ({}),
    allowedUpstreamOrigins: ["https://api.internal.example"],
    catalogStore: store,
  });
}

test("a published catalog survives a restart when a store is configured", async () => {
  const store = createMemoryCatalogStore();

  const first = serverOver(store);
  await first.publishReviewedCatalog({
    catalog,
    bindings,
    baseUrl: "https://api.internal.example",
  });
  await first.publishUiCatalog({ manifest: toSiteManifest(site) });

  // The restart. A fresh server shares nothing with the first but the store.
  const second = serverOver(store);
  assert.deepEqual(
    second.listPublishedCatalogs(),
    [],
    "a fresh server starts empty — the registries hold closures, not data",
  );

  const summary = await second.restorePublishedCatalogs();
  assert.equal(summary.capabilityCatalogs, 1);
  assert.equal(summary.uiCatalogs, 1);
  assert.deepEqual(summary.failures, []);

  assert.equal(second.listPublishedCatalogs().length, 1);
  assert.equal(second.listPublishedCatalogs()[0].catalogId, "support-assist");
  assert.equal(second.listPublishedSites().length, 1);
});

test("nothing is stored when a publish is rejected", async () => {
  const store = createMemoryCatalogStore();
  const server = serverOver(store);

  // Outside allowedUpstreamOrigins, so the in-memory publish throws.
  await assert.rejects(
    () =>
      server.publishReviewedCatalog({
        catalog,
        bindings,
        baseUrl: "http://169.254.169.254",
      }),
    /not in allowedUpstreamOrigins/,
  );

  assert.deepEqual(
    await store.list(),
    [],
    "storing before validating would persist a body that fails on every future boot",
  );
});

test("a stored record that no longer validates is reported, not thrown", async () => {
  const store = createMemoryCatalogStore();
  await store.put({
    kind: "capability",
    id: "broken",
    body: { catalog: { schemaVersion: "1.0", id: "broken" }, bindings: {} },
    publishedAt: new Date(0).toISOString(),
  });
  await store.put({
    kind: "capability",
    id: "support-assist",
    body: { catalog, bindings, baseUrl: "https://api.internal.example" },
    publishedAt: new Date(0).toISOString(),
  });

  const summary = await serverOver(store).restorePublishedCatalogs();

  // One bad record must not cost the others. A process that refuses to start
  // because of one stale catalog is worse than one that starts and says so.
  assert.equal(summary.capabilityCatalogs, 1);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].id, "broken");
  assert.ok(summary.failures[0].reason.length > 0);
});

test("republishing the same id replaces its record rather than accumulating", async () => {
  const store = createMemoryCatalogStore();
  const server = serverOver(store);

  await server.publishReviewedCatalog({ catalog, bindings, baseUrl: "https://api.internal.example" });
  await server.publishReviewedCatalog({
    catalog: { ...catalog, version: "1.1.0" },
    bindings,
    baseUrl: "https://api.internal.example",
  });

  const records = await store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].body.catalog.version, "1.1.0");
});

test("a configured store with no restore call says so in the failure", async () => {
  const server = serverOver(createMemoryCatalogStore());

  // The symptom of forgetting the boot step: registries are empty, and the
  // message used to blame publishing. The hint lives on the admin-gated plan
  // route — compose serves visitors before any credential is resolved, so it
  // gets only the neutral sentence below.
  await assert.rejects(
    () => server.planAgainstPublishedCatalog({ catalogId: "support-assist", prompt: "show reports", request: {} }),
    /restorePublishedCatalogs\(\) has not been called/,
  );
  await assert.rejects(
    () => server.composeAgainstPublishedCatalogs({ catalogId: "support-assist", prompt: "show reports", request: {} }),
    (error) => {
      assert.equal(error.message, "This catalog is not available.");
      return true;
    },
  );
});

test("the hint disappears once restore has run, so it never misleads", async () => {
  const server = serverOver(createMemoryCatalogStore());
  await server.restorePublishedCatalogs();

  await assert.rejects(
    () => server.planAgainstPublishedCatalog({ catalogId: "support-assist", prompt: "show reports", request: {} }),
    (error) => {
      assert.match(error.message, /No capability catalog "support-assist" has been published/);
      assert.doesNotMatch(
        error.message,
        /restorePublishedCatalogs/,
        "after a restore the catalog is genuinely unpublished; still suggesting the boot step would send someone the wrong way",
      );
      return true;
    },
  );
});

test("restorePublishedCatalogs is a no-op without a store, so a host can call it unconditionally", async () => {
  const server = createViewServer({
    host: { isAuthenticated: () => true, hasPermission: () => true, getSessionValue: () => undefined },
    resolveSession: () => ({}),
    allowedUpstreamOrigins: ["https://api.internal.example"],
  });
  assert.deepEqual(await server.restorePublishedCatalogs(), {
    capabilityCatalogs: 0,
    uiCatalogs: 0,
    failures: [],
  });
});

test("restorePublishedCatalogs is declared library-only, not accidentally unrouted", () => {
  assert.ok(
    LIBRARY_ONLY_METHODS.includes("restorePublishedCatalogs"),
    "re-running every stored publish is a boot step; over HTTP it would be a way to disturb a running server",
  );
});

test("the file store round-trips through a real directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-catalogs-"));
  try {
    const first = serverOver(createFileCatalogStore(dir));
    await first.publishReviewedCatalog({ catalog, bindings, baseUrl: "https://api.internal.example" });
    await first.publishUiCatalog({ manifest: toSiteManifest(site) });

    // A genuinely separate store instance, as a new process would build.
    const second = serverOver(createFileCatalogStore(dir));
    const summary = await second.restorePublishedCatalogs();
    assert.equal(summary.capabilityCatalogs, 1);
    assert.equal(summary.uiCatalogs, 1);
    assert.deepEqual(summary.failures, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the file store cannot be made to write outside its directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-catalogs-"));
  try {
    const store = createFileCatalogStore(dir);
    // A catalog id comes from a publish payload, so it is caller-controlled.
    await store.put({
      kind: "capability",
      id: "../../escaped",
      body: { marker: true },
      publishedAt: new Date(0).toISOString(),
    });

    const records = await store.list();
    assert.equal(records.length, 1);
    // Read back from inside the directory, and still carrying its real id: the
    // filename is sanitised, the record is not rewritten.
    assert.equal(records[0].id, "../../escaped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a truncated record is skipped rather than crashing the boot it exists to enable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-catalogs-"));
  try {
    const store = createFileCatalogStore(dir);
    // What a process killed mid-write leaves behind. Written after the store is
    // constructed, since that is what creates the directory.
    writeFileSync(join(dir, "catalogs", "half.json"), '{"kind":"capability","id":"half","bod');
    const records = await store.list();
    assert.deepEqual(records, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare publish body from the pre-store layout is still restored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-catalogs-"));
  try {
    const store = createFileCatalogStore(dir);
    // Exactly what a host hand-rolling this layout wrote before the store
    // existed: the publish body, with no envelope. Upgrading must not quietly
    // discard these — the symptom would be every compose failing after a deploy,
    // caused by the very thing meant to prevent that.
    writeFileSync(
      join(dir, "catalogs", "support-assist.json"),
      JSON.stringify({ catalog, bindings, baseUrl: "https://api.internal.example" }),
    );
    writeFileSync(
      join(dir, "ui-catalogs", "support-assist.json"),
      JSON.stringify({ manifest: toSiteManifest(site) }),
    );

    const summary = await serverOver(store).restorePublishedCatalogs();
    assert.equal(summary.capabilityCatalogs, 1);
    assert.equal(summary.uiCatalogs, 1);
    assert.deepEqual(summary.failures, []);

    // And the id comes from the filename, since a bare body has no envelope.
    const records = await store.list();
    assert.ok(records.every((record) => record.id === "support-assist"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
