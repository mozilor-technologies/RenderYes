/**
 * The HTTP surface of a `ViewServer`, as one fetch-standard handler.
 *
 * Every host that mounts this package writes the same routes: match a path,
 * parse a JSON body, call one method, serialize the result. That is not
 * integration work — it is transcription, and each host transcribes it with its
 * own set of mistakes. Ours shipped four of them: `/api/refine` was missing
 * entirely (so refinement was complete on both sides and dead in the middle),
 * all four saved-view methods had no route, `/api/catalog` sat open despite the
 * integration guide saying in bold that it must not, and every failure came
 * back as HTTP 400 including "you are not signed in".
 *
 * So the route table belongs here, next to the methods it exposes, where it can
 * be tested against them. `http.contract.test.mjs` asserts that every method on
 * `ViewServer` is either routed below or named in `LIBRARY_ONLY_METHODS` — which
 * is what makes "we built a feature nobody can reach" a failing test rather
 * than a discovery weeks later.
 *
 * Fetch-standard (`Request` -> `Response`) rather than Express or node:http:
 * that signature is what Bun, Deno, Cloudflare Workers, Hono, and a Next.js
 * route handler all already speak, and `toNodeHandler` adapts it to node:http
 * in twenty lines with no framework dependency. Picking Express for a host would
 * have been picking their framework for them.
 */
import { encodeComposeEvent, type ComposeEvent } from "@renderyes/core";
import { ComposeRateLimitedError, PlanProviderNotConfiguredError } from "./index.js";
import type { ViewServer } from "./index.js";

/**
 * Thrown by a host's `resolveSession` when the request carries no usable
 * credential. The handler maps it to HTTP 401; every other thrown error is a
 * 400.
 *
 * This exists because the distinction is invisible otherwise. `resolveSession`
 * is the host's own function and it throws a plain `Error`, so a missing token
 * and a malformed catalog arrived here identically and both came back as 400 —
 * telling a browser "your request was bad" when the truth was "you are not
 * signed in". A client cannot prompt for a login on a 400.
 *
 * Optional by design: a host that throws a plain `Error` keeps the old
 * behaviour rather than breaking.
 */
export class UnauthenticatedError extends Error {
  constructor(message = "Not authenticated.") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

/**
 * The header the admin token travels in, everywhere this project sends or
 * reads one: the scaffolded `requireAdmin`, the init tool's live checks, and
 * the review app's proxy all use this name, and three surfaces disagreeing on
 * it produced 403s that read as a wrong token rather than a wrong header.
 * `requireAdmin` is still the host's function — a host may read any header it
 * likes — but every default on our side is this one, and tools that let the
 * host differ take the name from an environment variable rather than a fork
 * of this constant.
 */
export const ADMIN_TOKEN_HEADER = "x-renderyes-admin-token";

/**
 * Set on every response this handler produces, so a caller can tell it reached
 * RenderYes rather than something else answering at the same URL.
 *
 * `doctor` reported "Mount is reachable" from any HTTP response at the service
 * URL — satisfied, on a real install, by the host's own front page. It later
 * required JSON, which rules out a framework's 404 page but not a different
 * JSON API, a proxy, or a stale process on the port. A false ✓ sits exactly
 * where a downstream failure needs diagnosing: the check goes on affirming the
 * mount while the mount is the problem.
 *
 * Its value is the protocol generation, not the package version — a probe
 * should not have to know our release cadence to recognize us.
 */
export const HANDLER_HEADER = "x-renderyes-handler";

/**
 * Ceiling on a request body, in bytes. A published GraphQL catalog is the
 * largest thing that legitimately arrives here and can run to a few megabytes
 * on a wide schema, so this is generous rather than tight — but it is finite,
 * because without it a single request can exhaust the process's memory.
 */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** How a route names the `ViewServer` method behind it. */
type RoutedMethod =
  | "composeAgainstPublishedCatalogs"
  | "refineComposedView"
  | "saveComposedView"
  | "listSavedViews"
  | "reopenSavedView"
  | "deleteSavedView"
  | "publishReviewedCatalog"
  | "listPublishedCatalogs"
  | "publishUiCatalog"
  | "listPublishedSites"
  | "listPlanProviders"
  | "getCoverageReport"
  | "describePlanningWiring"
  | "classifyOperations"
  | "suggestSemanticTypes"
  | "proposeFieldSelection"
  | "loadReviewExport"
  | "listCatalogHistory"
  | "rollbackPublishedCatalog"
  | "deletePublishedCatalog"
  | "probePublishedCatalog"
  | "planAgainstPublishedCatalog";

export interface ViewHttpRoute {
  method: "GET" | "POST";
  path: string;
  /** The `ViewServer` method this route exposes. */
  serverMethod: RoutedMethod;
  /**
   * Whether `requireAdmin` must pass before the route runs.
   *
   * The rule is not "does this mutate" but "does this reveal or change what the
   * planner is allowed to do". `/api/catalog` publishes the capability set;
   * `GET /api/coverage` maps every data type to the components that can render
   * it, which is a description of the owner's internal data model; and
   * `/api/plan` and `/api/classify-operations` both spend model calls, so an
   * open route is also someone else's bill.
   */
  admin: boolean;
}

/**
 * Methods deliberately not exposed over HTTP.
 *
 * Named explicitly rather than left out, so that adding a method to
 * `ViewServer` and forgetting to route it fails the contract test instead of
 * silently becoming unreachable. An entry here is a decision; an omission is a
 * bug.
 */
export const LIBRARY_ONLY_METHODS: readonly string[] = Object.freeze([
  // A boot step, not a request. Exposing it would let any caller re-run every
  // stored publish against a running server — which is not a read, and not
  // idempotent from the perspective of anyone mid-compose.
  "restorePublishedCatalogs",
]);

/**
 * The routes, as data.
 *
 * The six visitor-facing paths are a fixed contract with `@renderyes/react`,
 * which builds them from `serviceUrl` — so they are not configurable here. A
 * `basePath` option would let a host move them somewhere the client would never
 * look, which is the same "reachable from one side only" failure this file
 * exists to prevent. If they ever need to move, the client needs the matching
 * option in the same change.
 */
export const VIEW_HTTP_ROUTES: readonly ViewHttpRoute[] = Object.freeze([
  // Visitor-facing. Called by @renderyes/react.
  { method: "POST", path: "/api/compose", serverMethod: "composeAgainstPublishedCatalogs", admin: false },
  { method: "POST", path: "/api/refine", serverMethod: "refineComposedView", admin: false },
  { method: "POST", path: "/api/views", serverMethod: "saveComposedView", admin: false },
  { method: "GET", path: "/api/views", serverMethod: "listSavedViews", admin: false },
  { method: "POST", path: "/api/views/reopen", serverMethod: "reopenSavedView", admin: false },
  { method: "POST", path: "/api/views/delete", serverMethod: "deleteSavedView", admin: false },
  // Owner-facing. Called by the catalog review app and the publish CLI.
  { method: "POST", path: "/api/catalog", serverMethod: "publishReviewedCatalog", admin: true },
  { method: "GET", path: "/api/catalog", serverMethod: "listPublishedCatalogs", admin: true },
  // Lifecycle. Publishing was the only operation a registry had, so a catalog
  // published by mistake could be replaced and never removed, and the retained
  // snapshots the file store had been writing all along could not be read by
  // anything. POST rather than GET for history because the id is a body field
  // like every other admin call here, not a path segment.
  { method: "POST", path: "/api/catalog/history", serverMethod: "listCatalogHistory", admin: true },
  { method: "POST", path: "/api/catalog/rollback", serverMethod: "rollbackPublishedCatalog", admin: true },
  { method: "POST", path: "/api/catalog/delete", serverMethod: "deletePublishedCatalog", admin: true },
  { method: "POST", path: "/api/ui-catalog", serverMethod: "publishUiCatalog", admin: true },
  { method: "GET", path: "/api/ui-catalog", serverMethod: "listPublishedSites", admin: true },
  { method: "GET", path: "/api/providers", serverMethod: "listPlanProviders", admin: true },
  { method: "GET", path: "/api/coverage", serverMethod: "getCoverageReport", admin: true },
  // Admin-gated for the same reason coverage is: it names published capability
  // and component ids. It is the honest answer to "is this install wired up",
  // which the offline mock planner used to answer by fabricating a view.
  {
    method: "GET",
    path: "/api/planning-wiring",
    serverMethod: "describePlanningWiring",
    admin: true,
  },
  { method: "POST", path: "/api/classify-operations", serverMethod: "classifyOperations", admin: true },
  { method: "POST", path: "/api/semantic-suggestions", serverMethod: "suggestSemanticTypes", admin: true },
  { method: "POST", path: "/api/field-proposals", serverMethod: "proposeFieldSelection", admin: true },
  { method: "POST", path: "/api/review-export", serverMethod: "loadReviewExport", admin: true },
  // Diagnostics, not data: it executes against the host's upstream, so it sits
  // behind the same admin gate as publishing. Admin alone is not enough, and the
  // route table saying "admin" has read as though it were: the probe executes
  // capabilities that declare `authentication: "session"`, so the request also
  // needs a visitor credential, which is what the upstream actually sees. Admin
  // authorizes the probe; the session is what it probes with. Send
  // `checkUpstreamCredential: false` to check shape without executing.
  { method: "POST", path: "/api/catalog/probe", serverMethod: "probePublishedCatalog", admin: true },
  { method: "POST", path: "/api/plan", serverMethod: "planAgainstPublishedCatalog", admin: true },
]);

export interface ViewHttpCorsOptions {
  /**
   * Exact origins allowed to make credentialed requests, e.g.
   * `["http://localhost:5173"]`. Compared as whole origins, never by prefix.
   *
   * There is no wildcard. `Access-Control-Allow-Origin: *` is invalid whenever
   * `Allow-Credentials` is `true`, and reflecting the request's own `Origin`
   * back — the obvious workaround, and what our own development host did — is
   * strictly worse than a wildcard: it means *any* website a visitor loads can
   * issue credentialed requests to this server and read the responses. An
   * allowlist is the only shape of this option that is safe, so it is the only
   * shape offered.
   */
  allowedOrigins: readonly string[];
}

export interface ViewHttpHandlerOptions {
  /**
   * Gate on the owner-facing routes: publishing catalogs, listing providers,
   * reading the coverage report, classifying operations, planning.
   *
   * Required, and required to be a function, because the alternative is a
   * default — and every possible default is wrong. Defaulting to open ships a
   * publish endpoint that lets an anonymous caller replace the capability
   * catalog. Defaulting to closed silently breaks the review app with a 403
   * that looks like a bug in us. Making it a parameter means a host cannot
   * reach a running server without having answered the question, which is the
   * only version of this that a busy integrator cannot skip.
   *
   * A host with no admin concept in development can pass
   * `() => true` — but they will have typed it, and it will be greppable.
   */
  requireAdmin: (request: Request) => boolean | Promise<boolean>;
  /** Defaults to `DEFAULT_MAX_BODY_BYTES`. */
  maxBodyBytes?: number;
  /**
   * Off unless supplied. A same-origin deployment — the app and this handler
   * behind one domain — needs no CORS at all, and turning it on by default
   * would loosen those deployments for nothing.
   */
  cors?: ViewHttpCorsOptions;
  /**
   * Called for every request that ends in a 5xx. The handler already returns a
   * generic body in that case; without this the cause would be lost entirely.
   */
  onError?: (error: unknown, request: Request) => void;
}

/** JSON response with the envelope `@renderyes/react` expects. */
function jsonResponse(status: number, value: unknown, headers: Headers): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: (() => {
      const merged = new Headers(headers);
      merged.set("content-type", "application/json; charset=utf-8");
      merged.set(HANDLER_HEADER, "1");
      return merged;
    })(),
  });
}

/**
 * Reads and parses a JSON body, refusing anything too large or not JSON.
 *
 * The content-type check is a CSRF control, not pedantry. A cross-origin
 * `<form>` POST can only send `application/x-www-form-urlencoded`,
 * `multipart/form-data`, or `text/plain`, and the browser sends it *without* a
 * preflight — so CORS never gets a chance to refuse it. Requiring
 * `application/json` forces the request into the preflighted path, where the
 * origin allowlist applies. Since these routes carry the visitor's credentials,
 * that is the difference between "another site can compose and save views as
 * this visitor" and "it cannot".
 */
async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "Expected a JSON request body (content-type: application/json).");
  }

  // Checked first when present, so an oversized body is refused before it is
  // buffered. It can be absent or wrong on a chunked request, which is why the
  // streaming cap below still exists rather than trusting this.
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new HttpError(413, "Request body is too large.");
    }
  }

  let raw: string;
  if (!request.body) {
    raw = "";
  } else {
    const decoder = new TextDecoder();
    const reader = request.body.getReader();
    let bytes = 0;
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "Request body is too large.");
      }
      text += decoder.decode(value, { stream: true });
    }
    raw = text + decoder.decode();
  }

  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

/**
 * One failure envelope, not two.
 *
 * Every transport-level failure in this file says `{ok: false, error}`, but a
 * domain failure (a refused refine, an unsupported compose) crossed the wire
 * as `{ok: false, kind, reason}` — so a caller reading `.error`, which is what
 * every other failure taught them to read, got `undefined` and reported an
 * empty message. `reason`, `kind`, and `issues` stay; `error` is added as the
 * one name that is always present on a failure.
 */
function withErrorAlias(result: unknown): unknown {
  if (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    (result as { ok?: unknown }).ok === false &&
    typeof (result as { reason?: unknown }).reason === "string" &&
    (result as { error?: unknown }).error === undefined
  ) {
    return { ...result, error: (result as { reason: string }).reason };
  }
  return result;
}

/** An error that already knows its status code. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Narrows an unknown JSON body to a property bag without asserting a shape. */
function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Turns a `ViewServer` into a fetch handler.
 *
 * ```ts
 * import { timingSafeEqual } from "node:crypto";
 *
 * // Constant-time, so a caller cannot recover the admin token one byte at a
 * // time from response timing — a `===` compare short-circuits on the first
 * // mismatched byte, and this example is what hosts copy. Length is compared
 * // first because `timingSafeEqual` throws on a length mismatch. Fails
 * // closed: with ADMIN_TOKEN unset or empty, every request is refused rather
 * // than compared against nothing.
 * function isAdminToken(given: string | null): boolean {
 *   const expected = Buffer.from(process.env.ADMIN_TOKEN ?? "", "utf8");
 *   const presented = Buffer.from(given ?? "", "utf8");
 *   if (expected.length === 0 || presented.length === 0) return false;
 *   return expected.length === presented.length && timingSafeEqual(expected, presented);
 * }
 *
 * const handler = createViewHttpHandler(server, {
 *   requireAdmin: (request) => isAdminToken(request.headers.get(ADMIN_TOKEN_HEADER)),
 *   cors: { allowedOrigins: ["http://localhost:5173"] },
 * });
 * ```
 *
 * Note what the `Request` is used for and what it is not. The handler reads the
 * method, the URL, and the body; it never inspects a credential. The whole
 * `Request` is passed through to every `ViewServer` method as `request`, and the
 * host's own `resolveSession` is what reads a header or a cookie off it — so
 * this package still never learns where a host keeps its tokens.
 *
 * That does mean `resolveSession` receives a fetch `Request`
 * (`request.headers.get("authorization")`), not a node:http `IncomingMessage`
 * (`request.headers.authorization`). A host moving an existing hand-written
 * server onto this handler has to update that one function.
 */
export function createViewHttpHandler<Session>(
  server: ViewServer<Session>,
  options: ViewHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  /** Methods this handler serves at a given path, for the 405 `Allow` header. */
  const methodsByPath = new Map<string, Set<string>>();
  for (const route of VIEW_HTTP_ROUTES) {
    const existing = methodsByPath.get(route.path) ?? new Set<string>();
    existing.add(route.method);
    methodsByPath.set(route.path, existing);
  }

  function corsHeaders(request: Request): Headers {
    const headers = new Headers();
    if (!options.cors) return headers;
    const origin = request.headers.get("origin");
    // Absent origin is a same-origin or non-browser request; there is nothing
    // to allow. An origin not on the list gets no headers at all, so the
    // browser refuses the response — which is the correct failure.
    if (origin && options.cors.allowedOrigins.includes(origin)) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Credentials", "true");
      // Tells a shared cache that this response is origin-specific. Without it,
      // a cache can hand one origin's allowed response to another origin.
      headers.set("Vary", "Origin");
    }
    return headers;
  }

  return async function handle(request: Request): Promise<Response> {
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      if (!options.cors) return new Response(null, { status: 405 });
      const headers = new Headers(cors);
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", `content-type, authorization, ${ADMIN_TOKEN_HEADER}`);
      headers.set("Access-Control-Max-Age", "600");
      return new Response(null, { status: 204, headers });
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return jsonResponse(400, { ok: false, error: "Malformed request URL." }, cors);
    }

    // Trailing slashes are normalized so `/api/views/` and `/api/views` are the
    // same route; a client that adds one should not get a 404.
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;

    const allowedMethods = methodsByPath.get(pathname);
    if (!allowedMethods) {
      return jsonResponse(404, { ok: false, error: "Not found." }, cors);
    }
    if (!allowedMethods.has(request.method)) {
      const headers = new Headers(cors);
      headers.set("Allow", [...allowedMethods, "OPTIONS"].join(", "));
      return jsonResponse(405, { ok: false, error: "Method not allowed." }, headers);
    }

    const route = VIEW_HTTP_ROUTES.find(
      (candidate) => candidate.path === pathname && candidate.method === request.method,
    )!;

    try {
      // Before the body is read: an unauthorized caller should not be able to
      // make this process buffer megabytes.
      if (route.admin && !(await options.requireAdmin(request))) {
        return jsonResponse(403, { ok: false, error: "Not permitted." }, cors);
      }

      const body = request.method === "POST" ? asRecord(await readJsonBody(request, maxBodyBytes)) : {};
      if (route.serverMethod === "composeAgainstPublishedCatalogs" && wantsEventStream(request)) {
        return composeEventStreamResponse(server, body, request, cors, options);
      }
      const result = await dispatch(server, route, body, url, request);
      return jsonResponse(200, withErrorAlias(result), cors);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse(error.status, { ok: false, error: error.message }, cors);
      }
      if (error instanceof UnauthenticatedError) {
        return jsonResponse(401, { ok: false, error: error.message }, cors);
      }
      // 429, not 400: a rate limit is the one refusal a client should retry,
      // and the generic status would teach it the request itself was wrong.
      if (error instanceof ComposeRateLimitedError) {
        return jsonResponse(429, { ok: false, error: error.message }, cors);
      }
      // Everything else is treated as a rejected request rather than a server
      // fault, because in practice it is: an unpublished catalog, an unknown
      // plan id, a view that is not yours, a catalog that fails validation.
      // `error.message` is deliberately forwarded — for `unsupported` composes
      // it is the only explanation of *why* the approved data cannot answer —
      // but `error.stack` never is.
      const message = error instanceof Error ? error.message : "Request failed.";
      reportError(options, error, request);
      // Failures a client can act on differently carry a machine-readable
      // kind. Without one, "this host does not do saved views" and "your save
      // failed" reach the browser as the same 400 with different prose, so the
      // chrome has to be told by configuration what it could have detected.
      const kind = (error as { kind?: unknown })?.kind;
      return jsonResponse(
        400,
        {
          ok: false,
          error: message,
          ...(typeof kind === "string" ? { kind } : {}),
          ...(error instanceof PlanProviderNotConfiguredError
            ? { kind: "plan-provider-not-configured", wiring: error.wiring }
            : {}),
        },
        cors,
      );
    }
  };
}

/**
 * Invokes the host's error hook without ever letting it break the response.
 *
 * The hook is an observer: a throw inside it must be logged loudly and go no
 * further. Unwrapped, it escaped this handler's own catch — the visitor's 400
 * became a 500 and, in the streamed form, an aborted stream — and the failure
 * read as the request's rather than the hook's.
 */
function reportError(
  options: Pick<ViewHttpHandlerOptions, "onError">,
  error: unknown,
  request: Request,
): void {
  try {
    options.onError?.(error, request);
  } catch (cause) {
    console.error(`[renderyes:http] onError hook threw: ${String(cause)}`);
  }
}

/**
 * True when the caller asked for the streamed form of a compose.
 *
 * Negotiated on `Accept` rather than on a separate route or a body flag: it is
 * the same compose either way, and one route means a client changes a header to
 * change how it receives the answer, not which endpoint it talks to.
 */
function wantsEventStream(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/event-stream");
}

/**
 * Serves a compose as Server-Sent Events.
 *
 * The pipeline is unchanged — this passes `onEvent` and encodes what comes
 * back. Nothing here decides anything about the compose, which is why the
 * streamed and batch forms cannot diverge.
 *
 * Errors thrown before the first event still reach the client as a RUN_ERROR
 * inside the stream, because by the time anything throws the response headers
 * are already sent and a status code is no longer available to say it with.
 */
function composeEventStreamResponse<Session>(
  server: ViewServer<Session>,
  body: Record<string, unknown>,
  request: Request,
  cors: Headers,
  options: ViewHttpHandlerOptions,
): Response {
  const runId = `run-${globalThis.crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: ComposeEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeComposeEvent(event)));
        } catch {
          // The client went away mid-compose. The compose itself continues to
          // completion rather than being torn down: it may be writing to the
          // plan cache and the saved-view store, and a half-run compose is a
          // worse outcome than a few wasted frames.
          closed = true;
        }
      };
      try {
        await server.composeAgainstPublishedCatalogs({
          catalogId: requireString(body.catalogId, "catalogId"),
          prompt: requireString(body.prompt, "prompt"),
          ...(asString(body.surfaceId) ? { surfaceId: asString(body.surfaceId)! } : {}),
          ...(asString(body.uiCatalogId) ? { uiCatalogId: asString(body.uiCatalogId)! } : {}),
          ...(body.answersClarification === true
            ? { answersClarification: true }
            : {}),
          ...(asString(body.previousPlanId)
            ? { previousPlanId: asString(body.previousPlanId)! }
            : {}),
          ...(asString(body.providerId) ? { providerId: asString(body.providerId)! } : {}),
          request,
          runId,
          onEvent: send,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Request failed.";
        reportError(options, error, request);
        send({
          type: "RUN_ERROR",
          runId,
          timestamp: Date.now(),
          kind:
            error instanceof UnauthenticatedError
              ? "unauthenticated"
              : error instanceof HttpError || error instanceof ComposeRateLimitedError
                ? "rejected"
                : "failed",
          reason: message,
        });
      } finally {
        try {
          controller.close();
        } catch {
          // Already errored or cancelled by the client going away; a throw
          // here would surface as an unhandled rejection with nothing to fix.
        }
      }
    },
  });

  const headers = new Headers(cors);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  // A compose can idle for tens of seconds between frames. Both of these stop
  // an intermediary from buffering the stream into a single response, which
  // would reproduce exactly the wait streaming exists to remove.
  headers.set("cache-control", "no-cache, no-transform");
  headers.set("x-accel-buffering", "no");
  headers.set(HANDLER_HEADER, "1");
  return new Response(stream, { status: 200, headers });
}

/**
 * Maps one route to its `ViewServer` call, and normalizes the response envelope.
 *
 * The envelope is the handler's job because the methods are honest about their
 * own return types: `listSavedViews` returns an array, not `{ok, views}`, and
 * `getCoverageReport` returns `{ok: true, ...}` already. The client checks
 * `payload.ok === true` on every call, so something has to reconcile those —
 * and doing it here means each host does not invent its own key names for the
 * list routes, which is precisely what the client cannot tolerate.
 */
async function dispatch<Session>(
  server: ViewServer<Session>,
  route: ViewHttpRoute,
  body: Record<string, unknown>,
  url: URL,
  request: Request,
): Promise<unknown> {
  switch (route.serverMethod) {
    case "composeAgainstPublishedCatalogs":
      return server.composeAgainstPublishedCatalogs({
        catalogId: requireString(body.catalogId, "catalogId"),
        prompt: requireString(body.prompt, "prompt"),
        ...(asString(body.surfaceId) ? { surfaceId: asString(body.surfaceId)! } : {}),
        ...(asString(body.uiCatalogId) ? { uiCatalogId: asString(body.uiCatalogId)! } : {}),
        ...(body.answersClarification === true ? { answersClarification: true } : {}),
        ...(asString(body.previousPlanId) ? { previousPlanId: asString(body.previousPlanId)! } : {}),
        ...(asString(body.providerId) ? { providerId: asString(body.providerId)! } : {}),
        request,
      });

    case "refineComposedView":
      return server.refineComposedView({
        catalogId: requireString(body.catalogId, "catalogId"),
        planId: requireString(body.planId, "planId"),
        operations: Array.isArray(body.operations) ? (body.operations as never) : [],
        request,
      });

    case "saveComposedView":
      return server.saveComposedView({
        catalogId: requireString(body.catalogId, "catalogId"),
        planId: requireString(body.planId, "planId"),
        ...(asString(body.label) ? { label: asString(body.label)! } : {}),
        // Present, this saves a pin: the server slices the plan down to these
        // top-level nodes. Never defaulted or coerced — a malformed value is a
        // 400, because silently dropping it would save the *whole* view under
        // a click that promised one panel.
        ...(body.nodeIds !== undefined
          ? { nodeIds: requireStringArray(body.nodeIds, "nodeIds") }
          : {}),
        request,
      });

    case "listSavedViews":
      return { ok: true, views: await server.listSavedViews({ request }) };

    case "reopenSavedView":
      return server.reopenSavedView({
        viewId: requireString(body.viewId, "viewId"),
        request,
      });

    case "deleteSavedView": {
      const result = await server.deleteSavedView({
        viewId: requireString(body.viewId, "viewId"),
        request,
      });
      // A false `ok` means the view is not there, or not this visitor's — the
      // store makes those indistinguishable on purpose. Returning HTTP 200 with
      // `{ok: false}` would leave the client reporting "failed (200)", which
      // says nothing; 404 with a reason is what a caller can act on.
      if (!result.ok) {
        throw new HttpError(404, "That view no longer exists.");
      }
      return result;
    }

    case "publishReviewedCatalog":
      return server.publishReviewedCatalog(body);

    case "listPublishedCatalogs":
      return { ok: true, catalogs: server.listPublishedCatalogs() };

    case "publishUiCatalog":
      return server.publishUiCatalog(body);

    case "listPublishedSites":
      return { ok: true, sites: server.listPublishedSites() };

    case "listPlanProviders":
      return { ok: true, providers: server.listPlanProviders() };

    case "getCoverageReport":
      return server.getCoverageReport(
        requireString(url.searchParams.get("catalogId") ?? undefined, "catalogId"),
      );

    case "describePlanningWiring":
      return {
        ok: true,
        ...server.describePlanningWiring(
          requireString(url.searchParams.get("catalogId") ?? undefined, "catalogId"),
        ),
      };

    case "classifyOperations":
      return { ok: true, ...(await server.classifyOperations(body)) };

    // Both of these were routed and never dispatched: the switch fell through,
    // dispatch returned undefined, and the caller got 200 with an empty body —
    // a success the client fails to parse, far from the cause. The review UI's
    // "Publish to host" button posts to the first of them.
    case "loadReviewExport":
      return server.loadReviewExport(body);
    case "listCatalogHistory":
      return server.listCatalogHistory(body);
    case "rollbackPublishedCatalog":
      return server.rollbackPublishedCatalog(body);
    case "deletePublishedCatalog":
      return server.deletePublishedCatalog(body);

    case "suggestSemanticTypes":
      return { ok: true, ...(await server.suggestSemanticTypes(body)) };
    case "proposeFieldSelection":
      return { ok: true, ...(await server.proposeFieldSelection(body)) };

    case "probePublishedCatalog":
      // `request` rides along the same way compose's does: the probe executes
      // real capabilities, so it needs a real session to resolve.
      return server.probePublishedCatalog({
        catalogId: requireString(body.catalogId, "catalogId"),
        // Forwarded rather than defaulted here: the second pass is on unless a
        // caller says otherwise, and that decision lives with the probe.
        ...(body.checkUpstreamCredential === false
          ? { checkUpstreamCredential: false }
          : {}),
        request,
      });

    case "planAgainstPublishedCatalog":
      return server.planAgainstPublishedCatalog({
        catalogId: requireString(body.catalogId, "catalogId"),
        prompt: requireString(body.prompt, "prompt"),
        ...(asString(body.providerId) ? { providerId: asString(body.providerId)! } : {}),
        request,
      });
  }
}

/**
 * Rejects a missing required field as a 400 naming the field.
 *
 * Without this, a body missing `catalogId` reaches the server as `undefined`
 * and fails deep inside with "no published catalog \"undefined\"" — which reads
 * like a publishing problem rather than a malformed request.
 */
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `Missing required field "${field}".`);
  }
  return value;
}

/**
 * Rejects a present-but-malformed optional array field as a 400 naming it.
 *
 * Used for `nodeIds`, where the two silent alternatives are both wrong:
 * treating garbage as absent saves the whole view when the caller asked for a
 * pin, and treating it as empty fails deep inside with a message about
 * slicing. The caller only reaches this when the field was supplied at all.
 */
function requireStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry): entry is string => typeof entry === "string" && entry.length > 0)
  ) {
    throw new HttpError(400, `Field "${field}" must be a non-empty array of strings.`);
  }
  return value;
}
