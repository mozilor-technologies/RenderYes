import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ADMIN_TOKEN_HEADER,
  createMemoryViewStore,
  createViewHttpHandler,
  createViewServer,
  DEFAULT_MAX_BODY_BYTES,
  LIBRARY_ONLY_METHODS,
  UnauthenticatedError,
  VIEW_HTTP_ROUTES,
} from "../dist/index.js";

/**
 * What these tests are for.
 *
 * The first one is the reason this file exists. Six finished features on this
 * server — refinement and all four saved-view methods — had no HTTP route for
 * weeks. Nothing failed: the methods were implemented, unit-tested, and
 * documented, and the client called paths that returned 404. The gap was
 * invisible because no test looked across the boundary between "the method
 * exists" and "someone can reach it".
 *
 * The rest pin the status codes, because every one of them was wrong in the
 * hand-written host server this replaces: not-signed-in was a 400, an
 * unauthenticated caller could publish a capability catalog, and a wrong method
 * on a real path was a 404.
 */

/** Minimal server. No catalog is published, so calls fail — routing still works. */
function testServer(overrides = {}) {
  return createViewServer({
    host: {
      isAuthenticated: (session) => Boolean(session?.token),
      hasPermission: () => true,
      getSessionValue: (session, key) => session?.[key],
    },
    resolveSession: (request) => {
      const authorization = request.headers.get("authorization");
      if (!authorization) throw new UnauthenticatedError("No session token present.");
      return { token: authorization.slice(7) };
    },
    allowedUpstreamOrigins: ["http://127.0.0.1:4000"],
    // Present so the saved-view routes reach `resolveSession` at all. Without a
    // store they refuse up front ("saving is disabled"), which would make the
    // 401 test below pass or fail for the wrong reason.
    viewStore: createMemoryViewStore(),
    resolveViewOwner: (session) => session.token,
    ...overrides,
  });
}

function post(path, body, headers = {}) {
  return new Request(`http://localhost:4200${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
}

function get(path, headers = {}) {
  return new Request(`http://localhost:4200${path}`, { method: "GET", headers });
}

test("every ViewServer method is routed or explicitly declared library-only", () => {
  // Enumerated from a real instance rather than from a hand-maintained list, so
  // adding a method to `createViewServer`'s returned object is enough to make
  // this notice.
  const methods = Object.keys(testServer()).filter(
    (key) => typeof testServer()[key] === "function",
  );
  const routed = new Set(VIEW_HTTP_ROUTES.map((route) => route.serverMethod));
  const exempt = new Set(LIBRARY_ONLY_METHODS);

  const unreachable = methods.filter((name) => !routed.has(name) && !exempt.has(name));
  assert.deepEqual(
    unreachable,
    [],
    `These ViewServer methods have no HTTP route and are not declared library-only, so a ` +
      `client cannot reach them: ${unreachable.join(", ")}. Add a route in VIEW_HTTP_ROUTES, ` +
      `or add the name to LIBRARY_ONLY_METHODS to say the omission is deliberate.`,
  );

  // A route can also be declared and never dispatched. That is worse than an
  // absent route, because the request succeeds: `dispatch` falls off the end of
  // the switch, returns undefined, and the caller receives HTTP 200 with an
  // empty body — which a client parses as JSON and fails on, far from the
  // cause. Two admin routes shipped in exactly that state, past a contract test
  // that checked only whether the method was *named* in the table.
  const dispatched = new Set(
    [...readFileSync(new URL("../src/http.ts", import.meta.url), "utf8").matchAll(
      /case "([A-Za-z]+)":/g,
    )].map((match) => match[1]),
  );
  const undispatched = [...routed].filter((name) => !dispatched.has(name));
  assert.deepEqual(
    undispatched,
    [],
    `These routes are declared in VIEW_HTTP_ROUTES but have no case in dispatch(), so they ` +
      `answer 200 with an empty body: ${undispatched.join(", ")}.`,
  );

  // The other direction: a route naming a method that no longer exists would
  // throw at dispatch time, in production, on that one path.
  const missing = [...routed].filter((name) => !methods.includes(name));
  assert.deepEqual(missing, [], `Routes name methods that do not exist: ${missing.join(", ")}`);
});

test("the six visitor paths the react client calls are all routed", () => {
  // Hardcoded here on purpose. These strings are built from `serviceUrl` inside
  // `@renderyes/react`, so they are a wire contract, and a rename on this side
  // must fail here rather than in a browser.
  const clientPaths = [
    ["POST", "/api/compose"],
    ["POST", "/api/refine"],
    ["POST", "/api/views"],
    ["GET", "/api/views"],
    ["POST", "/api/views/reopen"],
    ["POST", "/api/views/delete"],
  ];
  for (const [method, path] of clientPaths) {
    assert.ok(
      VIEW_HTTP_ROUTES.some((route) => route.method === method && route.path === path),
      `@renderyes/react calls ${method} ${path} and no route serves it`,
    );
  }
});

test("owner-facing routes require admin; visitor routes do not", () => {
  const adminPaths = new Set(
    VIEW_HTTP_ROUTES.filter((route) => route.admin).map((route) => route.path),
  );
  // Publishing replaces the capability catalog, coverage describes the owner's
  // whole data model, and plan/classify spend model calls. None may be open.
  for (const path of ["/api/catalog", "/api/ui-catalog", "/api/coverage", "/api/providers", "/api/plan", "/api/classify-operations"]) {
    assert.ok(adminPaths.has(path), `${path} must be behind requireAdmin`);
  }
  for (const route of VIEW_HTTP_ROUTES) {
    if (route.path.startsWith("/api/views") || route.path === "/api/compose" || route.path === "/api/refine") {
      assert.equal(route.admin, false, `${route.path} is visitor-facing and must not need admin`);
    }
  }
});

test("admin routes reject a caller requireAdmin refuses, without reading the body", async () => {
  const handler = createViewHttpHandler(testServer(), {
    requireAdmin: () => false,
    // Small enough that the body below exceeds it.
    maxBodyBytes: 32,
  });

  // The ordering is asserted through its consequence rather than by watching the
  // stream: undici drains a `ReadableStream` request body on its own schedule,
  // so instrumenting the stream reports a read that this handler never made.
  //
  // Instead: this body is over the cap *and* the caller is not an admin. A 413
  // would mean the body was buffered before the gate ran — which is how a
  // refused caller can still make the process allocate. A 403 means the gate
  // won.
  const response = await handler(post("/api/catalog", { catalog: { id: "x".repeat(200) } }));

  assert.equal(
    response.status,
    403,
    "the admin gate must run before the body is buffered, or a refused caller can still make this process allocate megabytes",
  );
  assert.equal((await response.json()).ok, false);
});

test("the body cap still applies when the host omits maxBodyBytes", async () => {
  // Both other body tests pass an explicit cap (32 and 64 bytes), so the default
  // was never exercised: replacing DEFAULT_MAX_BODY_BYTES with
  // Number.MAX_SAFE_INTEGER left the whole suite green. The omitted-option path
  // is the default deployment, and an unbounded body is unbounded process memory.
  const handler = createViewHttpHandler(testServer(), {
    requireAdmin: () => true,
  });

  const oversized = "x".repeat(DEFAULT_MAX_BODY_BYTES + 1);
  const response = await handler(post("/api/catalog", { catalog: { id: oversized } }));

  assert.equal(response.status, 413);
  assert.equal((await response.json()).ok, false);
});

test("admin routes run when requireAdmin passes", async () => {
  const handler = createViewHttpHandler(testServer(), {
    requireAdmin: (request) => request.headers.get("x-admin") === "yes",
  });
  const response = await handler(get("/api/providers", { "x-admin": "yes" }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.providers));
});

test("a missing session is 401, not 400", async () => {
  const handler = createViewHttpHandler(testServer(), { requireAdmin: () => true });
  // No authorization header, so the test server's resolveSession throws
  // UnauthenticatedError.
  const response = await handler(get("/api/views"));
  assert.equal(
    response.status,
    401,
    "a client cannot prompt for a login on a 400; this was 400 for every failure in the hand-written host",
  );
});

test("an unknown path is 404 and a wrong method is 405 with Allow", async () => {
  const handler = createViewHttpHandler(testServer(), { requireAdmin: () => true });

  assert.equal((await handler(get("/api/nope"))).status, 404);

  // /api/views exists for GET and POST but not DELETE.
  const wrongMethod = await handler(
    new Request("http://localhost:4200/api/views", { method: "DELETE" }),
  );
  assert.equal(wrongMethod.status, 405);
  const allow = wrongMethod.headers.get("allow") ?? "";
  assert.ok(allow.includes("GET") && allow.includes("POST"), `Allow header was ${allow}`);
});

test("a trailing slash resolves to the same route", async () => {
  const handler = createViewHttpHandler(testServer(), { requireAdmin: () => true });
  const response = await handler(get("/api/views/", { authorization: "Bearer t" }));
  assert.notEqual(response.status, 404);
});

test("a non-JSON content type on a POST is refused", async () => {
  const handler = createViewHttpHandler(testServer(), { requireAdmin: () => true });
  const response = await handler(
    new Request("http://localhost:4200/api/compose", {
      method: "POST",
      // What a cross-origin <form> can send with no preflight. Refusing it is
      // what forces these credentialed routes through CORS.
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "catalogId=x&prompt=y",
    }),
  );
  assert.equal(response.status, 415);
});

test("an oversized body is refused with 413 rather than buffered", async () => {
  const handler = createViewHttpHandler(testServer(), {
    requireAdmin: () => true,
    maxBodyBytes: 64,
  });
  const response = await handler(post("/api/compose", { prompt: "x".repeat(500) }));
  assert.equal(response.status, 413);
});

test("a missing required field names the field", async () => {
  const handler = createViewHttpHandler(testServer(), { requireAdmin: () => true });
  const response = await handler(post("/api/compose", { prompt: "show me tickets" }, { authorization: "Bearer t" }));
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.match(
    payload.error,
    /catalogId/,
    "without this the request fails deep inside as 'no published catalog \"undefined\"', which reads like a publishing problem",
  );
});

test("list routes are wrapped in the envelope the client checks", async () => {
  const handler = createViewHttpHandler(testServer(), { requireAdmin: () => true });
  // `@renderyes/react` treats any payload without `ok === true` as a failure,
  // and these three ViewServer methods return bare arrays.
  const catalogs = await (await handler(get("/api/catalog"))).json();
  assert.equal(catalogs.ok, true);
  assert.ok(Array.isArray(catalogs.catalogs));

  const sites = await (await handler(get("/api/ui-catalog"))).json();
  assert.equal(sites.ok, true);
  assert.ok(Array.isArray(sites.sites));
});

test("CORS is off unless configured, and never reflects an unlisted origin", async () => {
  const closed = createViewHttpHandler(testServer(), { requireAdmin: () => true });
  const noCors = await closed(get("/api/views", { origin: "https://evil.example" }));
  assert.equal(noCors.headers.get("access-control-allow-origin"), null);

  const open = createViewHttpHandler(testServer(), {
    requireAdmin: () => true,
    cors: { allowedOrigins: ["http://localhost:5173"] },
  });

  const allowed = await open(get("/api/views", { origin: "http://localhost:5173" }));
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");
  assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
  assert.equal(
    allowed.headers.get("vary"),
    "Origin",
    "without Vary a shared cache can hand one origin's allowed response to another",
  );

  // The failure mode of the host server this replaces: it reflected whatever
  // Origin arrived, with Allow-Credentials true, so any site a visitor loaded
  // could read this server's responses as that visitor.
  const rejected = await open(get("/api/views", { origin: "https://evil.example" }));
  assert.equal(rejected.headers.get("access-control-allow-origin"), null);
});

test("a preflight is answered only when CORS is configured", async () => {
  const preflight = (handler) =>
    handler(
      new Request("http://localhost:4200/api/compose", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:5173" },
      }),
    );

  const closed = createViewHttpHandler(testServer(), { requireAdmin: () => true });
  assert.equal((await preflight(closed)).status, 405);

  const open = createViewHttpHandler(testServer(), {
    requireAdmin: () => true,
    cors: { allowedOrigins: ["http://localhost:5173"] },
  });
  const response = await preflight(open);
  assert.equal(response.status, 204);
  assert.ok((response.headers.get("access-control-allow-headers") ?? "").includes("authorization"));
  // The admin header must survive preflight, or a cross-origin review tool
  // loses its credential before requireAdmin ever sees the request.
  assert.ok(
    (response.headers.get("access-control-allow-headers") ?? "").includes(ADMIN_TOKEN_HEADER),
  );
});

test("the admin header name is one exported constant, and it is the neutral one", () => {
  // Three surfaces used to disagree — scaffolded mounts read x-admin-token,
  // the review app sent x-catalog-publish-token — and the 403 that produced
  // read as a wrong token rather than a wrong header. Tools that cannot
  // import this package (the init scaffolder, the review proxy) inline the
  // string, so this pin is what keeps every copy honest.
  assert.equal(ADMIN_TOKEN_HEADER, "x-renderyes-admin-token");
});

test("an error body carries the message but never a stack", async () => {
  const handler = createViewHttpHandler(testServer(), { requireAdmin: () => true });
  const response = await handler(
    post(
      "/api/compose",
      { catalogId: "not-published", prompt: "show me open tickets" },
      { authorization: "Bearer t" },
    ),
  );
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(typeof payload.error, "string");
  assert.equal(payload.stack, undefined);
  // A stack frame is a line beginning with "at " and naming a file, which is
  // what distinguishes it from prose that happens to contain the word.
  assert.doesNotMatch(
    payload.error,
    /\n\s*at .*[:(]/,
    `error message carries a stack frame: ${payload.error}`,
  );
});

test("POST /api/views forwards nodeIds when present, and omits them when absent", async () => {
  // A stub rather than a full server: this boundary test is about what crosses
  // from the body into the method call, not about what the method then does —
  // slicing itself is covered in server.test.mjs.
  const inputs = [];
  const stub = {
    saveComposedView: async (input) => {
      inputs.push(input);
      return { ok: true, viewId: "view-1", createdAt: "2026-08-20T00:00:00.000Z" };
    },
  };
  const handler = createViewHttpHandler(stub, { requireAdmin: () => true });

  const pinned = await handler(
    post("/api/views", { catalogId: "c1", planId: "p1", nodeIds: ["n2"] }),
  );
  assert.equal(pinned.status, 200);
  assert.deepEqual(inputs[0].nodeIds, ["n2"]);
  assert.equal(inputs[0].planId, "p1");

  // The pre-pin body shape is a wire contract with every deployed client:
  // absent must stay absent, not become [] or null.
  const plain = await handler(post("/api/views", { catalogId: "c1", planId: "p1" }));
  assert.equal(plain.status, 200);
  assert.equal("nodeIds" in inputs[1], false);
});

test("a malformed nodeIds is a 400 naming the field, never a silent full save", async () => {
  // The dangerous failure shape: a caller asked for one panel, the field is
  // dropped, and the whole view is saved under a click that promised a pin.
  let calls = 0;
  const stub = {
    saveComposedView: async () => {
      calls += 1;
      return { ok: true, viewId: "view-1", createdAt: "2026-08-20T00:00:00.000Z" };
    },
  };
  const handler = createViewHttpHandler(stub, { requireAdmin: () => true });

  for (const nodeIds of ["n2", [], [42], [""], { n: 1 }]) {
    const response = await handler(
      post("/api/views", { catalogId: "c1", planId: "p1", nodeIds }),
    );
    assert.equal(response.status, 400, `nodeIds=${JSON.stringify(nodeIds)}`);
    assert.match((await response.json()).error, /nodeIds/);
  }
  assert.equal(calls, 0);
});

test("a throwing onError hook cannot turn a rejected request into a worse failure", async () => {
  // `onError` is an observer. Unwrapped, its throw escaped the handler's own
  // catch: the caller's clean 400 became an unhandled rejection in whatever
  // adapter mounted the handler.
  let hookCalls = 0;
  const handler = createViewHttpHandler(testServer(), {
    requireAdmin: () => true,
    onError: () => {
      hookCalls += 1;
      throw new Error("the host's error pipeline is itself broken");
    },
  });

  // No catalog is published, so a compose is a rejected request — the path
  // that invokes onError.
  const response = await handler(
    post("/api/compose", { catalogId: "nope", prompt: "hello" }, { authorization: "Bearer t" }),
  );
  assert.equal(response.status, 400);
  assert.equal(hookCalls, 1);

  // And the hook is still invoked for the next failure.
  const second = await handler(
    post("/api/compose", { catalogId: "nope", prompt: "hello" }, { authorization: "Bearer t" }),
  );
  assert.equal(second.status, 400);
  assert.equal(hookCalls, 2);
});
