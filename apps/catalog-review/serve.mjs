#!/usr/bin/env node
/**
 * Serves the built review UI on localhost and proxies its API calls to an
 * RenderYes host.
 *
 * The review UI was a Vite app inside this repo, so producing a first catalog
 * required cloning the monorepo and knowing which workspace command to run.
 * Every host who wanted one either did that or wrote their own publisher — the
 * Saleor integration did the latter, against a format that will drift the
 * moment we change it, silently, because nothing validates a catalog built
 * outside our tooling.
 *
 * A static server rather than an entry in `@renderyes/server`: a production
 * server has no business shipping browser assets for a build-time GUI, and a
 * host running the review app is doing onboarding work, not serving traffic.
 *
 * The UI fetches same-origin /api/* routes that only exist on a host, so the
 * static-only version of this file left registry consumers with a UI that
 * could browse but never publish — the SPA fallback answered those fetches
 * with index.html and a 200, and the UI died parsing HTML as JSON. This file
 * used to refuse all configurability as a security stance; the proxy
 * deliberately relaxes that, within limits: still bound to 127.0.0.1, only a
 * fixed allowlist of routes is forwarded, and the admin credential lives in
 * this process so the browser never sees it. The token comes from the
 * environment only — a CLI flag would leave it in argv, ps output, and shell
 * history.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("./dist/", import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Flag wins over the environment so a shell profile export can be overridden
// per run without unsetting it.
let hostUrlArg;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--host-url") {
    if (args[i + 1] === undefined) {
      fail("--host-url requires a value, e.g. --host-url http://localhost:3000");
    }
    hostUrlArg = args[i + 1];
    i += 1;
  } else if (args[i].startsWith("--host-url=")) {
    hostUrlArg = args[i].slice("--host-url=".length);
  }
}

const rawHostUrl = hostUrlArg ?? process.env.RENDERYES_HOST_URL;
let hostUrl;
if (rawHostUrl) {
  try {
    hostUrl = new URL(rawHostUrl);
  } catch {
    fail(`Not a URL: "${rawHostUrl}". Expected something like http://localhost:3000.`);
  }
  if (hostUrl.protocol !== "http:" && hostUrl.protocol !== "https:") {
    fail(`Unsupported host URL protocol "${hostUrl.protocol}". Use http:// or https://.`);
  }
}

const ADMIN_TOKEN = process.env.RENDERYES_ADMIN_TOKEN;
// The header name is host-defined (requireAdmin is implemented by each host),
// so it has to be overridable; the default is ADMIN_TOKEN_HEADER from
// @renderyes/server, inlined because this tool does not depend on that
// package — every scaffolded mount reads the same name.
const ADMIN_HEADER = process.env.RENDERYES_ADMIN_HEADER ?? "x-renderyes-admin-token";

// Not a general forward proxy: only the routes the review UI actually calls,
// pinned by method, so nothing can use this process as a credential-injecting
// tunnel to the rest of the host.
const PROXY_ROUTES = new Set([
  "GET /api/catalog",
  "POST /api/catalog",
  "POST /api/semantic-suggestions",
  "POST /api/classify-operations",
  "POST /api/review-export",
]);

const PROXY_TIMEOUT_MS = 30_000;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

// The token must never reach a log line or a response body, including error
// messages that quote something the token was interpolated into.
function redact(text) {
  const message = String(text);
  return ADMIN_TOKEN ? message.split(ADMIN_TOKEN).join("[redacted]") : message;
}

async function proxy(request, response, requested) {
  if (!hostUrl) {
    // 501 rather than the SPA fallback: the old behavior answered these
    // fetches with index.html and a 200, and the UI died parsing HTML as JSON.
    sendJson(response, 501, {
      error:
        "No RenderYes host configured. Pass --host-url <url> or set RENDERYES_HOST_URL.",
    });
    return;
  }

  const route = `${request.method} ${requested.pathname}`;
  if (!PROXY_ROUTES.has(route)) {
    sendJson(response, 404, { error: `Unknown API route: ${route}` });
    return;
  }

  // Joined onto the full host URL rather than its origin, so a host mounted
  // under a path prefix keeps working.
  const target = `${hostUrl.href.replace(/\/+$/, "")}${requested.pathname}${requested.search}`;

  // Headers are rebuilt from scratch: whatever credentials the browser sends
  // (cookies, tokens pasted into devtools) stop here, and the only credential
  // upstream sees is the one this process injects.
  const headers = {};
  if (request.headers["content-type"]) headers["content-type"] = request.headers["content-type"];
  if (ADMIN_TOKEN) headers[ADMIN_HEADER] = ADMIN_TOKEN;

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      sendJson(response, 504, {
        error: `The RenderYes host at ${hostUrl.href} did not respond within ${PROXY_TIMEOUT_MS / 1000}s.`,
      });
    } else {
      sendJson(response, 502, {
        error: redact(
          `Could not reach the RenderYes host at ${hostUrl.href}: ${error?.cause?.message ?? error?.message ?? error}`,
        ),
      });
    }
    return;
  }

  // Status and body pass through verbatim — the UI already knows how to read
  // the host's errors, and rewriting them here would only hide information.
  const payload = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
  });
  response.end(payload);
}

const server = createServer(async (request, response) => {
  const requested = new URL(request.url ?? "/", "http://127.0.0.1");

  if (requested.pathname === "/api" || requested.pathname.startsWith("/api/")) {
    try {
      await proxy(request, response, requested);
    } catch (error) {
      sendJson(response, 500, { error: redact(error?.message ?? error) });
    }
    return;
  }

  // Resolved and then checked against the root, because `..` in a request path
  // otherwise reads any file the process can. A local-only tool is still a
  // server.
  const candidate = normalize(
    join(DIST, requested.pathname === "/" ? "index.html" : requested.pathname),
  );
  const withinRoot = candidate === DIST.slice(0, -1) || candidate.startsWith(DIST);

  try {
    if (!withinRoot) throw new Error("outside root");
    const body = await readFile(candidate);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(candidate)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch {
    // A single-page app owns its routing, so an unknown path is a client route
    // rather than a missing file — except for assets, where index.html would be
    // served as JavaScript and fail confusingly in the browser.
    if (extname(candidate) !== "" && extname(candidate) !== ".html") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
      return;
    }
    try {
      const index = await readFile(join(DIST, "index.html"));
      response.writeHead(200, { "content-type": CONTENT_TYPES[".html"] });
      response.end(index);
    } catch {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(`The review UI is not built. Expected ${DIST}index.html.`);
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`RenderYes catalog review: http://127.0.0.1:${PORT}`);
  console.log(
    `RenderYes host: ${hostUrl ? hostUrl.href : "none — API calls disabled"}`,
  );
  console.log(`Admin token: ${ADMIN_TOKEN ? `configured (sent as ${ADMIN_HEADER})` : "not set"}`);
  if (hostUrl && !ADMIN_TOKEN) {
    console.warn(
      "Warning: RENDERYES_ADMIN_TOKEN is not set — publish and AI-assist calls will likely return 401.",
    );
  }
  console.log("Connect a GraphQL or OpenAPI schema, approve, and export the catalog.");
});
