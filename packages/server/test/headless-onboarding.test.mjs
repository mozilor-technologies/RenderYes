import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createViewHttpHandler, createViewServer } from "../dist/index.js";
import { defineSite, defineSurface, toSiteManifest } from "@renderyes/site-sdk";
import { createCardGrid, createDataTable, createMetricCard } from "@renderyes/starter-catalog";

/**
 * A schema file to rows on the wire, through the real binaries, with no
 * browser and no hand-written JSON anywhere.
 *
 * Every piece of this route has been tested alone: the CLI emits a compiling
 * decisions file, the server accepts a review export, the runtime executes a
 * binding. The route itself was tested nowhere, and it is the route a host
 * actually walks — which is how it stayed broken in three separate places at
 * once (no `compile` verb, no `publish` verb, a scaffolded script whose import
 * path did not resolve) while every unit test passed.
 *
 * Deliberately *not* a Relay connection. Relay is what discovery handles best
 * and what every other GraphQL test here uses, so it is the shape least likely
 * to regress. This fixture wraps its list in a plain object — `{docs,
 * totalDocs}`, the Payload CMS shape — which is the case that needs two host
 * corrections the schema cannot supply: a result shape (`entity` is inferred
 * for the wrapper; it is a collection) and a semantic type for each bare
 * `Int!`. Both corrections travel through flags, and this asserts they arrive.
 *
 * Assertions are on rows and their content, never on exit codes alone. A CLI
 * that exits 0 having published an empty catalog satisfies an exit-code test
 * completely.
 */

const require = createRequire(import.meta.url);
const CATALOG_CLI = join(
  require.resolve("@renderyes/capability-catalog/package.json"),
  "..",
  "bin",
  "catalog.mjs",
);

const SDL = /* GraphQL */ `
  type Article {
    id: ID!
    title: String!
    views: Int!
  }
  type Articles {
    docs: [Article!]!
    totalDocs: Int!
  }
  type Query {
    "Published articles, newest first."
    Articles(limit: Int, page: Int): Articles
  }
`;

const ARTICLES = [
  { id: "a1", title: "Monsoon arrives early", views: 4120 },
  { id: "a2", title: "Metro line three opens", views: 2870 },
  { id: "a3", title: "City budget, line by line", views: 1544 },
];

/** The upstream, recording what was actually asked of it. */
async function startUpstream() {
  const documents = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      documents.push(JSON.parse(body).query ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ data: { Articles: { docs: ARTICLES, totalDocs: ARTICLES.length } } }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, documents, url: `http://127.0.0.1:${server.address().port}/graphql` };
}

/**
 * The host's mount, over a real socket.
 *
 * The CLI publishes with `fetch`, so an in-process handler would not exercise
 * what it does: URL resolution against a mount prefix, the admin header, the
 * JSON-or-HTML ambiguity when a prefix is wrong.
 */
async function startHost(upstreamUrl) {
  const server = createViewServer({
    host: {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
    },
    resolveSession: () => ({}),
    // The plan this test composes, supplied by this test. It used to come from
    // a mock inside the server that picked the first approved capability and
    // the first component that accepted data — which meant the assertions
    // below were checking our guess as much as this install. Writing it down
    // here makes the compose step verify the wiring it claims to.
    planProviders: [
      {
        id: "scripted",
        plans: [
          {
            status: "ready",
            dataRequests: [
              { requestId: "r1", capabilityId: "graphql.Articles", params: {} },
            ],
            nodes: [
              {
                nodeId: "n1",
                componentId: "StarterDataTable",
                props: {},
                dataBindings: { rows: { requestId: "r1" } },
              },
            ],
          },
        ],
      },
    ],
    allowedUpstreamOrigins: [new URL(upstreamUrl).origin],
    graphql: {
      resolveHeaders: () => ({}),
      resolveProvenance: ({ sourceId }) => ({
        sources: [{ sourceId }],
        freshness: { asOf: "2026-08-27T00:00:00.000Z" },
      }),
    },
  });
  const handler = createViewHttpHandler(server, {
    requireAdmin: (request) => request.headers.get("x-renderyes-admin-token") === "test-token",
  });
  const listener = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const url = new URL(request.url, "http://127.0.0.1");
      // The mount lives under a prefix, because a prefix is what every real
      // host has and what URL resolution gets wrong when a trailing slash is
      // missing.
      const path = url.pathname.replace(/^\/mount/, "");
      handler(
        new Request(`http://127.0.0.1${path}${url.search}`, {
          method: request.method,
          headers: Object.entries(request.headers),
          ...(body ? { body } : {}),
        }),
      ).then(
        async (result) => {
          const text = await result.text();
          response.writeHead(result.status, {
            "content-type": result.headers.get("content-type") ?? "application/json",
          });
          response.end(text);
        },
        (cause) => {
          // Answered rather than dropped: a handler that throws and never
          // replies leaves the caller waiting on a socket, which surfaces as a
          // test timeout with nothing in it to read.
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: String(cause) }));
        },
      );
    });
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  return {
    listener,
    server,
    url: `http://127.0.0.1:${listener.address().port}/mount`,
  };
}

/**
 * Async, and it has to be: `publish` talks to the host mount, which is served
 * from *this* process. `execFileSync` blocks this event loop, so the listener
 * never accepts the child's connection and both sides wait for each other
 * until the test times out with no output at all.
 */
const execFileAsync = promisify(execFile);

async function runCli(args, env = {}) {
  const { stdout } = await execFileAsync(process.execPath, [CATALOG_CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return stdout;
}

test("a schema file reaches published rows through the CLI alone", async (t) => {
  const upstream = await startUpstream();
  const host = await startHost(upstream.url);
  t.after(() => {
    upstream.server.close();
    host.listener.close();
  });

  const dir = mkdtempSync(join(tmpdir(), "renderyes-headless-"));
  const path = (name) => join(dir, name);
  writeFileSync(path("schema.graphql"), SDL);
  // The two corrections a schema cannot make for itself. `Articles` returns a
  // wrapper object, so discovery infers `entity`; and a bare `Int!` has no
  // meaning the schema states, so `views` and `totalDocs` are refused rather
  // than guessed.
  writeFileSync(path("shapes.json"), JSON.stringify({ Articles: "collection" }));
  // Where the rows live. Never detected — an entity that is scalars plus one
  // nested list looks identical — so the host declares it, and declaring it
  // makes the approved paths row-relative.
  writeFileSync(
    path("envelopes.json"),
    JSON.stringify({
      Articles: { rowsField: "docs", totalCountField: "totalDocs", pageSizeArgument: "limit" },
    }),
  );
  writeFileSync(
    path("semantic-types.json"),
    JSON.stringify({ "Query.Articles.views": "quantity" }),
  );

  await runCli([
    "inventory",
    "--schema", path("schema.graphql"),
    "--catalog-id", "news",
    "--source-label", "The Bharat Times",
    "--shapes", path("shapes.json"),
    "--list-envelopes", path("envelopes.json"),
    "--out", path("inventory.json"),
  ]);
  await runCli([
    "candidate",
    "--inventory", path("inventory.json"),
    "--approve-all-discovered",
    "--schema", path("schema.graphql"),
    "--semantic-types", path("semantic-types.json"),
    "--out", path("decisions.json"),
  ]);

  // The UI half comes from real components, the way a host's own would: the
  // scaffolded publish script emits exactly this file with `--emit`.
  const definitions = [
    createDataTable().definition,
    createMetricCard().definition,
    createCardGrid().definition,
  ];
  writeFileSync(
    path("ui.json"),
    JSON.stringify(
      toSiteManifest(
        defineSite({
          id: "news",
          name: "The Bharat Times",
          version: "1.0.0",
          catalogId: "news",
          components: definitions,
          surfaces: [
            defineSurface({
              id: "main",
              description: "Main surface.",
              componentIds: definitions.map((definition) => definition.id),
            }),
          ],
        }),
      ),
    ),
  );

  await runCli([
    "compile",
    "--schema", path("schema.graphql"),
    "--inventory", path("inventory.json"),
    "--decisions", path("decisions.json"),
    "--endpoint", upstream.url,
    "--ui-manifest", path("ui.json"),
    "--out", path("bundle.json"),
  ]);

  const bundle = JSON.parse(readFileSync(path("bundle.json"), "utf8"));
  assert.equal(bundle.catalogId, "news");
  // The correction survived inventory -> decisions -> compile. Asserted on the
  // compiled catalog rather than on either file, because those are where it was
  // typed and the catalog is where it has to arrive.
  assert.equal(bundle.capability.catalog.capabilities[0].output.shape, "collection");
  assert.deepEqual(bundle.requirements.upstreamOrigins, [new URL(upstream.url).origin]);

  const published = await runCli(
    ["publish", "--service-url", host.url, "--file", path("bundle.json")],
    { RENDERYES_ADMIN_TOKEN: "test-token" },
  );
  assert.match(published, /Published "news": 1 executable capability/);
  assert.match(published, /UI catalog: 3 component\(s\) registered/);

  // ─── The half that matters: does data come back? ──────────────────────
  const probe = await fetch(new URL("api/catalog/probe", `${host.url}/`), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-renderyes-admin-token": "test-token",
    },
    body: JSON.stringify({ catalogId: "news", checkUpstreamCredential: false }),
  });
  const probeBody = await probe.json();
  assert.equal(probe.status, 200, JSON.stringify(probeBody));
  const entry = probeBody.results.find((result) => result.capabilityId === "graphql.Articles");
  assert.equal(entry.status, "ok", entry.reason);
  assert.equal(entry.rowCount, ARTICLES.length);

  // Content, not just a count: the approved leaves are what the upstream was
  // asked for. A binding that selected `id` alone would satisfy a row count
  // and blank every column a view renders.
  const document = upstream.documents.at(-1);
  for (const field of ["docs", "id", "title", "views", "totalDocs"]) {
    assert.ok(document.includes(field), `upstream document is missing ${field}:\n${document}`);
  }

  // And end to end through the planner, deterministically: the plan is
  // scripted in this file's own server config, so this needs no model key and
  // cannot flake on one.
  const compose = await fetch(new URL("api/compose", `${host.url}/`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      catalogId: "news",
      prompt: "show me the articles",
      providerId: "scripted",
    }),
  });
  const composed = await compose.json();
  assert.equal(composed.ok, true, JSON.stringify(composed).slice(0, 400));
  assert.ok(composed.messages.length > 0, "compose produced nothing to render");
  // `ok: true` describes the request, not the answer — a slot whose capability
  // refused sits at state "error" under an ok envelope, so the per-request
  // outcome is what says the data arrived.
  assert.deepEqual(
    composed.requests.map((request) => [request.capabilityId, request.ok]),
    [["graphql.Articles", true]],
  );

  const dataModel = composed.messages.find((message) => message.updateDataModel)
    ?.updateDataModel.value;
  assert.ok(dataModel, "compose emitted no data model");
  const slot = Object.entries(dataModel).find(([key]) => key !== "__renderyes")?.[1];

  // Content, not a count: every fixture row, with its values, in the model the
  // surface renders from. A binding that selected `id` alone would satisfy any
  // row-count assertion and blank every column a view draws.
  const serialized = JSON.stringify(slot);
  for (const article of ARTICLES) {
    assert.ok(serialized.includes(article.title), `missing row: ${article.title}`);
    assert.ok(serialized.includes(String(article.views)), `missing views: ${article.views}`);
  }
  // Attribution travels with them, or the one thing this system exists to
  // prevent — ungrounded figures presented as grounded — has already happened.
  assert.deepEqual(dataModel.__renderyes.requests[0].provenance.sources, [
    { sourceId: "news-source" },
  ]);

  // The rows arrive as rows. This assertion used to be its inverse, pinned as a
  // known gap: a declared envelope bound `{docs: [...]}` into a slot whose prop
  // takes an array, so a table rendered "Nothing to show" over rows that had
  // arrived intact. `listEnvelope` closed it, and the tripwire fired on merge.
  assert.ok(Array.isArray(slot.rows), `rows is not an array: ${JSON.stringify(slot.rows)}`);
  assert.equal(slot.rows.length, ARTICLES.length);
});
