import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createViewServer } from "../dist/index.js";
import { createFileCatalogStore } from "../dist/node.js";
import { compileCuratedGraphQlCatalog } from "@renderyes/capability-catalog/graphql";

/**
 * Unpublishing, and going back.
 *
 * Publishing was the only operation either registry had. A catalog published by
 * mistake — a trial run against a real host, a mistyped id — could be replaced
 * and never removed, and the only way to clear one was restarting the process.
 * That happened during a real walk and there was nothing to tell the host but
 * "restart your dev server".
 *
 * Meanwhile the file store had been retaining every publish under
 * `<id>.history/` since retention landed, and nothing could read it. Captured
 * and unreachable is worse than absent: it looks like the feature is there.
 */

const schema = /* GraphQL */ `
  type Ticket { id: ID!  title: String! }
  type Query { tickets(limit: Int): [Ticket!]! }
`;

function catalogBody(id, description) {
  const compiled = compileCuratedGraphQlCatalog({
    schema,
    catalog: { id, version: "1.0.0", description },
    source: { id: "src", label: "Test API", description: "Test source." },
    policy: { authentication: "session", maximumRows: 50, timeoutMs: 2_000 },
  });
  return {
    bindingKind: "graphql",
    catalog: compiled.catalog,
    bindings: Object.fromEntries(compiled.bindings),
    schema,
    endpoint: "http://127.0.0.1:4000/graphql",
  };
}

function makeServer(dir) {
  return createViewServer({
    host: { isAuthenticated: () => true, hasPermission: () => true, getSessionValue: () => undefined },
    resolveSession: () => ({}),
    allowedUpstreamOrigins: ["http://127.0.0.1:4000"],
    catalogStore: createFileCatalogStore(dir),
    graphql: {
      resolveHeaders: () => ({}),
      resolveProvenance: ({ sourceId }) => ({
        sources: [{ sourceId }],
        freshness: { asOf: "2026-08-27T00:00:00.000Z" },
      }),
    },
  });
}

test("a published catalog can be listed, rolled back, and removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-lifecycle-"));
  const server = makeServer(dir);

  await server.publishReviewedCatalog(catalogBody("shop", "First."));
  await server.publishReviewedCatalog(catalogBody("shop", "Second."));

  // ── history ──────────────────────────────────────────────────────────
  const history = await server.listCatalogHistory({ catalogId: "shop" });
  assert.equal(history.ok, true);
  assert.equal(history.snapshots.length, 2);
  // Newest first, so `snapshots[1]` is the one to go back to.
  assert.ok(history.snapshots[0].stamp > history.snapshots[1].stamp);

  assert.equal(server.listPublishedCatalogs()[0].catalogId, "shop");
  const describing = () =>
    server.listPublishedCatalogs().find((entry) => entry.catalogId === "shop");
  const secondHash = describing().catalogHash;

  // ── rollback ─────────────────────────────────────────────────────────
  const rolled = await server.rollbackPublishedCatalog({
    catalogId: "shop",
    stamp: history.snapshots[1].stamp,
  });
  assert.equal(rolled.restoredFrom, history.snapshots[1].stamp);
  // It really replaced the live one, rather than reporting success over it.
  assert.notEqual(describing().catalogHash, secondHash);

  // A rollback is a publish, so it is retained too — which is what makes it
  // reversible by rolling forward rather than a one-way door.
  const afterRollback = await server.listCatalogHistory({ catalogId: "shop" });
  assert.equal(afterRollback.snapshots.length, 3);

  // ── delete ───────────────────────────────────────────────────────────
  const deleted = await server.deletePublishedCatalog({ catalogId: "shop" });
  assert.deepEqual(
    { unregistered: deleted.unregistered, forgotten: deleted.forgotten },
    { unregistered: true, forgotten: true },
  );
  assert.equal(server.listPublishedCatalogs().length, 0);

  // Gone from the store too, or it returns at the next boot — which is the
  // whole complaint: a restart was the only way to clear one, and a restart
  // brought it straight back.
  const rebooted = makeServer(dir);
  const restored = await rebooted.restorePublishedCatalogs();
  assert.equal(restored.capabilityCatalogs, 0);
  assert.equal(rebooted.listPublishedCatalogs().length, 0);

  // But the snapshots survive, so a mistaken delete is recoverable.
  const survived = await rebooted.listCatalogHistory({ catalogId: "shop" });
  assert.equal(survived.snapshots.length, 3);
  await rebooted.rollbackPublishedCatalog({
    catalogId: "shop",
    stamp: survived.snapshots[0].stamp,
  });
  assert.equal(rebooted.listPublishedCatalogs().length, 1);
});

test("deleting something that was never published says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-lifecycle-absent-"));
  const server = makeServer(dir);
  const result = await server.deletePublishedCatalog({ catalogId: "never-existed" });
  // `ok: true` over two falses would read as a successful delete.
  assert.equal(result.unregistered, false);
  assert.equal(result.forgotten, false);
  assert.match(result.note, /Nothing was published under "never-existed"/);
});

test("rolling back to a stamp that does not exist names how to find one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-lifecycle-stamp-"));
  const server = makeServer(dir);
  await server.publishReviewedCatalog(catalogBody("shop", "Only."));
  await assert.rejects(
    () => server.rollbackPublishedCatalog({ catalogId: "shop", stamp: "20200101T000000" }),
    /No retained publish .* List them first: POST \/api\/catalog\/history/s,
  );
});

test("a stamp cannot read outside the store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-lifecycle-traversal-"));
  const server = makeServer(dir);
  await server.publishReviewedCatalog(catalogBody("shop", "Only."));
  // `stamp` arrives from a caller like any other field.
  await assert.rejects(
    () =>
      server.rollbackPublishedCatalog({
        catalogId: "shop",
        stamp: "../../../../etc/passwd",
      }),
    /No retained publish/,
  );
});

test("the routes are reachable, and admin-gated", async () => {
  const { VIEW_HTTP_ROUTES } = await import("../dist/index.js");
  for (const path of ["/api/catalog/history", "/api/catalog/rollback", "/api/catalog/delete"]) {
    const route = VIEW_HTTP_ROUTES.find((entry) => entry.path === path);
    // The gap this catches has happened here before: finished methods with no
    // route, invisible because every unit test called the method directly.
    assert.ok(route, `${path} has no route`);
    assert.equal(route.admin, true, `${path} is not admin-gated`);
  }
});
