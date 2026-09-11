import assert from "node:assert/strict";
import test from "node:test";
import { createViewServer } from "../dist/index.js";
import { buildGraphQlReviewExport } from "@renderyes/capability-catalog";
import { compileCuratedGraphQlCatalog } from "@renderyes/capability-catalog/graphql";
import {
  defineSite,
  defineSurface,
  toSiteManifest,
} from "@renderyes/site-sdk";
import { createDataTable } from "@renderyes/starter-catalog";

const schema = /* GraphQL */ `
  type Ticket {
    id: ID!
    title: String!
    count: Int!
  }
  type Query {
    tickets(limit: Int): [Ticket!]!
  }
`;

function makeExport(endpoint) {
  const compiled = compileCuratedGraphQlCatalog({
    schema,
    catalog: { id: "export-test", version: "1.0.0", description: "Export test." },
    source: { id: "src", label: "Test API", description: "Test source." },
    policy: { authentication: "session", maximumRows: 50, timeoutMs: 2_000 },
  });
  const definitions = [createDataTable().definition];
  const uiManifest = toSiteManifest(
    defineSite({
      id: "export-test",
      name: "Export test",
      version: "1.0.0",
      catalogId: "https://localhost/renderyes/export-test.json",
      components: definitions,
      surfaces: [
        defineSurface({
          id: "main",
          description: "Test surface.",
          componentIds: definitions.map((definition) => definition.id),
        }),
      ],
    }),
  );
  return buildGraphQlReviewExport({
    catalogId: "export-test",
    compiled,
    schema,
    endpoint,
    uiManifest,
  });
}

function makeServer(allowedUpstreamOrigins) {
  return createViewServer({
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
    },
    resolveSession: () => ({}),
    allowedUpstreamOrigins,
    graphql: {
      resolveHeaders: () => ({}),
      resolveProvenance: ({ sourceId }) => ({
        sources: [{ sourceId }],
        freshness: { asOf: "2026-08-03T00:00:00.000Z" },
      }),
    },
  });
}

test("loadReviewExport publishes both catalogs in one call", async () => {
  const server = makeServer(["http://127.0.0.1:9999"]);
  const summary = await server.loadReviewExport(
    makeExport("http://127.0.0.1:9999/graphql"),
  );
  assert.equal(summary.ok, true);
  assert.equal(summary.catalogId, "export-test");
  assert.ok(summary.executableCapabilityCount >= 1);
  assert.deepEqual(summary.componentIds, ["StarterDataTable"]);
  assert.equal(server.listPublishedCatalogs().length, 1);
  assert.equal(server.listPublishedSites().length, 1);
});

/**
 * The loader published the UI catalog without forwarding the bundle's
 * catalogId, so it landed under whatever `site.id` the manifest carried — the
 * exact misfiling the parameter exists to prevent. The review UI happens to set
 * both to the same string, so this was latent for bundles it produced and live
 * for hand-built ones, which is the case a host writing its own publisher hits.
 */
test("a bundle whose site is named differently still lands where compose looks", async () => {
  const server = makeServer(["http://127.0.0.1:9999"]);
  const bundle = makeExport("http://127.0.0.1:9999/graphql");
  bundle.ui.manifest = {
    ...bundle.ui.manifest,
    site: { ...bundle.ui.manifest.site, id: "export-test-ui" },
  };

  await server.loadReviewExport(bundle);

  // Filed under the capability catalog id, not the site id.
  assert.equal(server.listPublishedSites()[0].catalogId, "export-test");
  assert.equal(server.listPublishedSites()[0].siteId, "export-test-ui");
  // And therefore findable: this threw before.
  assert.equal(server.getCoverageReport("export-test").ok, true);
});

test("loadReviewExport fails closed with a checklist when origins are missing", async () => {
  const server = makeServer(["http://127.0.0.1:1"]);
  await assert.rejects(
    () => server.loadReviewExport(makeExport("http://127.0.0.1:9999/graphql")),
    /needs upstream origins .*http:\/\/127\.0\.0\.1:9999.*allowedUpstreamOrigins/,
  );
  // Nothing was half-published.
  assert.equal(server.listPublishedCatalogs().length, 0);
  assert.equal(server.listPublishedSites().length, 0);
});

test("loadReviewExport refuses a bundle from the future", async () => {
  const server = makeServer(["http://127.0.0.1:9999"]);
  const bundle = makeExport("http://127.0.0.1:9999/graphql");
  bundle.formatVersion = 99;
  await assert.rejects(
    () => server.loadReviewExport(bundle),
    /newer than this server/,
  );
});
