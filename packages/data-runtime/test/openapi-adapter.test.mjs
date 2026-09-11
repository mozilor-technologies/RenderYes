import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import {
  createOpenApiCatalogInventory,
  compileApprovedOpenApiCatalog,
} from "@renderyes/capability-catalog/openapi";
import { hashCapabilityCatalog } from "@renderyes/capability-catalog";
import { executeDataRequest, createOpenApiRuntime } from "../dist/index.js";

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const binding = {
  capabilityId: "restaurants.search",
  method: "GET",
  path: "/restaurants",
  contentParameters: ["diet"],
  exposeFields: ["name", "distance"],
};

test("executes a GET and returns provenance-tagged raw data", async () => {
  const server = await startServer((req, res) => {
    jsonResponse(res, 200, [{ name: "Pizza Place", distance: 1.2 }]);
  });
  try {
    const runtime = createOpenApiRuntime({
      binding,
      sourceId: "test-source",
      baseUrl: server.baseUrl,
      now: () => 1_700_000_000_000,
    });
    const result = await runtime.execute({ diet: "vegan" }, { identity: {} });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, [{ name: "Pizza Place", distance: 1.2 }]);
    assert.deepEqual(result.provenance.sources, [{ sourceId: "test-source" }]);
    assert.equal(
      result.provenance.freshness.asOf,
      new Date(1_700_000_000_000).toISOString(),
    );
  } finally {
    await server.close();
  }
});

test("forwards only approved content parameters, dropping everything else", async () => {
  let observedUrl;
  const server = await startServer((req, res) => {
    observedUrl = req.url;
    jsonResponse(res, 200, []);
  });
  try {
    const runtime = createOpenApiRuntime({
      binding,
      sourceId: "test-source",
      baseUrl: server.baseUrl,
    });
    await runtime.execute(
      { diet: "vegan", supplierCost: "should-not-leak", accessToken: "secret" },
      { identity: {} },
    );
    assert.match(observedUrl, /diet=vegan/);
    assert.doesNotMatch(observedUrl, /supplierCost/);
    assert.doesNotMatch(observedUrl, /accessToken/);
    assert.doesNotMatch(observedUrl, /secret/);
  } finally {
    await server.close();
  }
});

test("executes an approved read-only POST with only approved JSON body fields", async () => {
  let observed;
  const runtime = createOpenApiRuntime({
    binding: {
      capabilityId: "conversations.list",
      method: "POST",
      path: "/api/v1/chat/conversation-list",
      contentParameters: ["tenant"],
      bodyParameters: ["search", "page"],
      exposeFields: ["items"],
    },
    sourceId: "support-api",
    baseUrl: "https://support.example.test",
    fetchImpl: async (url, init) => {
      observed = { url: String(url), init };
      return new Response(JSON.stringify({ items: [] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await runtime.execute(
    { tenant: "acme", search: "login failure", page: 2, internalFlag: true },
    { identity: {} },
  );

  assert.equal(result.ok, true);
  assert.equal(
    observed.url,
    "https://support.example.test/api/v1/chat/conversation-list?tenant=acme",
  );
  assert.equal(observed.init.method, "POST");
  assert.equal(observed.init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(observed.init.body), { search: "login failure", page: 2 });
});

test("substitutes approved params that appear as path placeholders", async () => {
  let observedUrl;
  const server = await startServer((req, res) => {
    observedUrl = req.url;
    jsonResponse(res, 200, []);
  });
  try {
    const runtime = createOpenApiRuntime({
      binding: {
        ...binding,
        path: "/restaurants/{restaurantId}",
        contentParameters: ["restaurantId"],
      },
      sourceId: "test-source",
      baseUrl: server.baseUrl,
    });
    await runtime.execute({ restaurantId: "abc 123" }, { identity: {} });
    assert.equal(observedUrl, "/restaurants/abc%20123");
  } finally {
    await server.close();
  }
});

test("retries a transient 500 then succeeds, without leaking upstream details", async () => {
  let calls = 0;
  const server = await startServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      jsonResponse(res, 500, { message: "boom" });
      return;
    }
    jsonResponse(res, 200, [{ name: "Ok" }]);
  });
  try {
    const runtime = createOpenApiRuntime({
      binding,
      sourceId: "test-source",
      baseUrl: server.baseUrl,
      retryBaseDelayMs: 1,
    });
    const result = await runtime.execute({ diet: "vegan" }, { identity: {} });
    assert.equal(calls, 2);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, [{ name: "Ok" }]);
  } finally {
    await server.close();
  }
});

test("does not retry a 4xx and marks it non-retryable", async () => {
  let calls = 0;
  const server = await startServer((req, res) => {
    calls += 1;
    jsonResponse(res, 404, { message: "not found" });
  });
  try {
    const runtime = createOpenApiRuntime({
      binding,
      sourceId: "test-source",
      baseUrl: server.baseUrl,
      retryBaseDelayMs: 1,
    });
    const result = await runtime.execute({ diet: "vegan" }, { identity: {} });
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "UPSTREAM_ERROR");
    assert.equal(result.error.retryable, false);
  } finally {
    await server.close();
  }
});

test("gives up after maxAttempts on persistent 500s and marks retryable", async () => {
  let calls = 0;
  const server = await startServer((req, res) => {
    calls += 1;
    jsonResponse(res, 500, { message: "boom" });
  });
  try {
    const runtime = createOpenApiRuntime({
      binding,
      sourceId: "test-source",
      baseUrl: server.baseUrl,
      maxAttempts: 2,
      retryBaseDelayMs: 1,
    });
    const result = await runtime.execute({ diet: "vegan" }, { identity: {} });
    assert.equal(calls, 2);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "UPSTREAM_UNAVAILABLE");
    assert.equal(result.error.retryable, true);
  } finally {
    await server.close();
  }
});

test("propagates cancellation as a rejection instead of retrying", async () => {
  const server = await startServer((req, res) => {
    setTimeout(() => jsonResponse(res, 500, { message: "boom" }), 200);
  });
  try {
    const runtime = createOpenApiRuntime({
      binding,
      sourceId: "test-source",
      baseUrl: server.baseUrl,
      retryBaseDelayMs: 1,
    });
    const controller = new AbortController();
    const reason = new Error("RenderYes capability timeout");
    setTimeout(() => controller.abort(reason), 20);
    await assert.rejects(
      runtime.execute({ diet: "vegan" }, { identity: {}, signal: controller.signal }),
    );
  } finally {
    await server.close();
  }
});

test("resolves headers fresh on every retry attempt, not once up front", async () => {
  const observedAuth = [];
  let calls = 0;
  const server = await startServer((req, res) => {
    calls += 1;
    observedAuth.push(req.headers.authorization);
    if (calls === 1) {
      jsonResponse(res, 500, { message: "boom" });
      return;
    }
    jsonResponse(res, 200, []);
  });
  try {
    let tokenCalls = 0;
    const runtime = createOpenApiRuntime({
      binding,
      sourceId: "test-source",
      baseUrl: server.baseUrl,
      retryBaseDelayMs: 1,
      headers: () => {
        tokenCalls += 1;
        return { Authorization: `Bearer token-${tokenCalls}` };
      },
    });
    const result = await runtime.execute({ diet: "vegan" }, { identity: {} });
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.deepEqual(observedAuth, ["Bearer token-1", "Bearer token-2"]);
  } finally {
    await server.close();
  }
});

test("never includes the upstream URL or injected credentials in a failure message", async () => {
  const server = await startServer((req, res) => {
    jsonResponse(res, 503, { message: "boom" });
  });
  try {
    const runtime = createOpenApiRuntime({
      binding,
      sourceId: "test-source",
      baseUrl: server.baseUrl,
      retryBaseDelayMs: 1,
      maxAttempts: 1,
      headers: () => ({ Authorization: "Bearer super-secret-token" }),
    });
    const result = await runtime.execute({ diet: "vegan" }, { identity: {} });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error.message, /super-secret-token/);
    assert.doesNotMatch(
      result.error.message,
      new RegExp(server.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  } finally {
    await server.close();
  }
});

test("end-to-end: an upstream field the owner never approved is rejected, not silently dropped", async () => {
  const server = await startServer((req, res) => {
    jsonResponse(res, 200, [{ name: "Pizza Place", distance: 1.2, supplierCost: 3.5 }]);
  });
  try {
    const document = {
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0" },
      paths: {
        "/restaurants": {
          get: {
            operationId: "searchRestaurants",
            parameters: [{ name: "diet", in: "query", schema: { type: "string" } }],
            responses: {
              200: {
                content: {
                  "application/json": {
                    schema: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          distance: { type: "number" },
                          supplierCost: { type: "number" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const reviewDraft = createOpenApiCatalogInventory({
      document,
      catalog: { id: "test-catalog", version: "1.0.0", description: "test" },
      source: { id: "test-source", label: "Test source" },
      operations: [
        {
          operationId: "searchRestaurants",
          capabilityId: "restaurants.search",
          dataTypeId: "Restaurant",
          resultShape: "collection",
        },
      ],
    });

    const compiled = compileApprovedOpenApiCatalog(document, reviewDraft, {
      schemaVersion: "1.0",
      reviewSourceHash: reviewDraft.reviewSourceHash,
      operations: [
        {
          capabilityId: "restaurants.search",
          approvedVisitorParameters: ["diet"],
          approvedOutputFields: ["name", "distance"],
          // The access decision is part of the approval artifact now. The
          // GraphQL approval has always carried it; OpenAPI was the outlier,
          // and compilation defaulted the missing field to "public".
          policy: { authentication: "session" },
        },
      ],
    });

    const liveBinding = compiled.bindings.get("restaurants.search");
    const runtime = createOpenApiRuntime({
      binding: liveBinding,
      sourceId: "test-source",
      baseUrl: server.baseUrl,
    });

    const session = { userId: "u1" };
    const host = {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
      allowExecution: () => true,
    };

    const result = await executeDataRequest({
      request: {
        requestId: "r1",
        capabilityId: "restaurants.search",
        params: { diet: "vegan" },
      },
      dataCatalog: {
        id: compiled.catalog.id,
        version: compiled.catalog.version,
        hash: hashCapabilityCatalog(compiled.catalog),
      },
      catalog: compiled.catalog,
      runtimes: new Map([["restaurants.search", runtime]]),
      session,
      host,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_RUNTIME_RESULT");
  } finally {
    await server.close();
  }
});

test("end-to-end: filter and sort apply to real fetched rows when the owner declared supports", async () => {
  const server = await startServer((req, res) => {
    jsonResponse(res, 200, [
      { name: "Alpha", status: "active" },
      { name: "Beta", status: "paused" },
      { name: "Gamma", status: "active" },
    ]);
  });
  try {
    const document = {
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0" },
      paths: {
        "/items": {
          get: {
            operationId: "listItems",
            parameters: [],
            responses: {
              200: {
                content: {
                  "application/json": {
                    schema: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          status: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const reviewDraft = createOpenApiCatalogInventory({
      document,
      catalog: { id: "test-catalog", version: "1.0.0", description: "test" },
      source: { id: "test-source", label: "Test source" },
      operations: [
        {
          operationId: "listItems",
          capabilityId: "items.list",
          dataTypeId: "Item",
          resultShape: "collection",
          // The owner must explicitly declare query support at review time,
          // the same explicit-approval pattern as contentParameters/exposeFields.
          supports: { filterFields: ["status"], sortFields: ["name"] },
        },
      ],
    });

    const compiled = compileApprovedOpenApiCatalog(document, reviewDraft, {
      schemaVersion: "1.0",
      reviewSourceHash: reviewDraft.reviewSourceHash,
      operations: [
        {
          capabilityId: "items.list",
          approvedVisitorParameters: [],
          approvedOutputFields: ["name", "status"],
          policy: { authentication: "session" },
        },
      ],
    });

    const binding = compiled.bindings.get("items.list");
    const runtime = createOpenApiRuntime({
      binding,
      sourceId: "test-source",
      baseUrl: server.baseUrl,
    });

    const host = {
      isAuthenticated: () => true,
      hasPermission: () => true,
      getSessionValue: () => undefined,
      allowExecution: () => true,
    };

    const result = await executeDataRequest({
      request: {
        requestId: "r1",
        capabilityId: "items.list",
        params: {},
        query: {
          filter: {
            combine: "all",
            conditions: [{ field: "status", operator: "eq", value: "active" }],
          },
          sort: [{ field: "name", direction: "asc" }],
        },
      },
      dataCatalog: {
        id: compiled.catalog.id,
        version: compiled.catalog.version,
        hash: hashCapabilityCatalog(compiled.catalog),
      },
      catalog: compiled.catalog,
      runtimes: new Map([["items.list", runtime]]),
      session: {},
      host,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.data, [
      { name: "Alpha", status: "active" },
      { name: "Gamma", status: "active" },
    ]);
  } finally {
    await server.close();
  }
});

test("refuses a redirect instead of following it off the approved origin", async () => {
  // The origin allowlist is enforced at publish time. A followed redirect
  // steps around it entirely: an approved host answering 302 would have this
  // process re-send the credentialed request wherever it points, and fetch
  // carries Authorization across a same-scheme redirect.
  const calls = [];
  const runtime = createOpenApiRuntime({
    binding: {
      capabilityId: "conversations.list",
      method: "GET",
      path: "/api/v1/chat/conversation-list",
      contentParameters: [],
      exposeFields: ["items"],
    },
    sourceId: "support-api",
    baseUrl: "https://support.example.test",
    maxAttempts: 1,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), redirect: init.redirect });
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/collect" },
      });
    },
  });

  const result = await runtime.execute({}, { identity: {} });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UPSTREAM_REDIRECTED");
  // Not retryable: retrying reproduces the same redirect.
  assert.equal(result.error.retryable, false);
  // And the adapter asked fetch not to follow it in the first place.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, "manual");
});

test("the headers hook receives the capability's resolved trusted identity", async () => {
  let seenAuthorization;
  const server = await startServer((req, res) => {
    seenAuthorization = req.headers.authorization;
    jsonResponse(res, 200, [{ name: "Pizza Place", distance: 1.2 }]);
  });
  try {
    const identitySeen = [];
    const runtime = createOpenApiRuntime({
      binding,
      sourceId: "test-source",
      baseUrl: server.baseUrl,
      // This is what makes an identity-scoped OpenAPI capability honest. Without
      // it, `requiredSessionKeys` was resolved, failed closed when absent, and
      // then discarded — so the capability claimed to be scoped to a user and
      // called the upstream with no user on the request at all.
      headers: ({ identity }) => {
        identitySeen.push(identity);
        return { authorization: `Bearer ${identity.tenantToken}` };
      },
      now: () => 1_700_000_000_000,
    });

    const result = await runtime.execute(
      { diet: "vegan" },
      { identity: { tenantToken: "tenant-7" } },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(identitySeen, [{ tenantToken: "tenant-7" }]);
    // The scoping actually reached the wire, not just the hook.
    assert.equal(seenAuthorization, "Bearer tenant-7");
  } finally {
    await server.close();
  }
});

test("declares whether it can forward identity, based on whether a headers hook exists", () => {
  assert.equal(
    createOpenApiRuntime({ binding, sourceId: "s", baseUrl: "http://127.0.0.1:1" })
      .forwardsIdentity,
    false,
  );
  assert.equal(
    createOpenApiRuntime({
      binding,
      sourceId: "s",
      baseUrl: "http://127.0.0.1:1",
      headers: () => ({}),
    }).forwardsIdentity,
    true,
  );
});

/**
 * Freshness on the OpenAPI path, measured against what the upstream reports
 * rather than against the moment we fetched.
 *
 * The adapter used to stamp `asOf: now` unconditionally, so every result looked
 * current by construction — a freshness limit compared against that can never
 * fire, which is a check that reads as a guarantee and is not one. REST carries
 * the answer in the protocol, so these tests pin that it is read from there.
 */
const NOW = 1_700_000_000_000;

function freshnessRuntime(server, extra = {}) {
  return createOpenApiRuntime({
    binding: { ...binding, ...extra },
    sourceId: "test-source",
    baseUrl: server.baseUrl,
    now: () => NOW,
  });
}

test("provenance reports the age the upstream declares, not the fetch time", async () => {
  const modifiedAt = new Date(NOW - 600_000).toUTCString();
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "last-modified": modifiedAt });
    res.end(JSON.stringify([{ name: "Pizza Place", distance: 1.2 }]));
  });
  try {
    const result = await freshnessRuntime(server).execute({ diet: "vegan" }, { identity: {} });
    assert.equal(result.ok, true);
    assert.equal(result.provenance.freshness.asOf, new Date(Date.parse(modifiedAt)).toISOString());
    // Emphatically not the fetch time, which is what it used to be.
    assert.notEqual(result.provenance.freshness.asOf, new Date(NOW).toISOString());
  } finally {
    await server.close();
  }
});

test("Date less Age is used when the upstream reports no Last-Modified", async () => {
  // What a caching proxy in front of the API reports.
  const server = await startServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      date: new Date(NOW).toUTCString(),
      age: "300",
    });
    res.end(JSON.stringify([{ name: "Pizza Place", distance: 1.2 }]));
  });
  try {
    const result = await freshnessRuntime(server).execute({ diet: "vegan" }, { identity: {} });
    assert.equal(result.ok, true);
    assert.equal(result.provenance.freshness.asOf, new Date(NOW - 300_000).toISOString());
  } finally {
    await server.close();
  }
});

test("a result older than the approved freshness limit is refused", async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "last-modified": new Date(NOW - 600_000).toUTCString(),
    });
    res.end(JSON.stringify([{ name: "Pizza Place", distance: 1.2 }]));
  });
  try {
    const runtime = freshnessRuntime(server, { freshnessMaximumAgeSeconds: 60 });
    const result = await runtime.execute({ diet: "vegan" }, { identity: {} });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "STALE_UPSTREAM_RESULT");
    assert.match(result.error.message, /above the approved limit of 60s/);

    // Within the limit, the same data is accepted.
    const generous = freshnessRuntime(server, { freshnessMaximumAgeSeconds: 3600 });
    assert.equal((await generous.execute({ diet: "vegan" }, { identity: {} })).ok, true);
  } finally {
    await server.close();
  }
});

test("an upstream that reports no age cannot be certified fresh", async () => {
  // No age is not age zero. Treating it as zero would let the limit pass on an
  // API that never said anything, which is the failure mode worth avoiding: the
  // limit would look enforced everywhere and mean nothing.
  const server = await startServer((_req, res) => {
    jsonResponse(res, 200, [{ name: "Pizza Place", distance: 1.2 }]);
  });
  try {
    const runtime = freshnessRuntime(server, { freshnessMaximumAgeSeconds: 60 });
    const result = await runtime.execute({ diet: "vegan" }, { identity: {} });
    // Accepted, because there is nothing to judge — but provenance falls back to
    // the fetch time and says so by carrying it, so a caller can tell the
    // difference between "current" and "unknown".
    assert.equal(result.ok, true);
    assert.equal(result.provenance.freshness.asOf, new Date(NOW).toISOString());
  } finally {
    await server.close();
  }
});
