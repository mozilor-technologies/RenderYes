/**
 * The live half: what only a running server can answer.
 *
 * Every call goes through the host's own HTTP mount rather than importing their
 * server, deliberately. Reaching into the process would bypass the
 * `requireAdmin` they wrote and verify a configuration nobody will ever run.
 * The admin token is read from an environment variable the host names — this
 * tool never prompts for a secret, never stores one, and never writes one.
 */
import { interpretCatalogState, interpretCompose, interpretProbe, LEVELS } from "./checks.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;

async function call(baseUrl, path, { method = "GET", body, adminToken, timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // URL resolution replaces the base's last path segment unless it ends in a
  // slash, so `http://host/api/renderyes` + `api/catalog` silently became
  // `http://host/api/catalog` — off the mount, and reported as "answered, but
  // not with RenderYes's routes" against a perfectly healthy prefix mount.
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  try {
    const response = await fetch(new URL(path, base), {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        // ADMIN_TOKEN_HEADER in @renderyes/server, inlined because this tool
        // deliberately depends on nothing — the scaffolded requireAdmin reads
        // the same name.
        ...(adminToken ? { "x-renderyes-admin-token": adminToken } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      // HTML where JSON was expected is the signature of a request that reached
      // a static server or a framework's 404 page rather than the mount.
      const hostFailure = nextFailureIn(text);
      return {
        ok: false,
        status: response.status,
        error: `Expected JSON from ${path}, got ${text.slice(0, 60)}…`,
        ...(hostFailure ? { hostFailure } : {}),
      };
    }
    return {
      ok: response.ok,
      status: response.status,
      body: parsed,
      handler: response.headers.get("x-renderyes-handler") !== null,
    };
  } catch (cause) {
    return {
      ok: false,
      status: 0,
      error: controller.signal.aborted ? "timed out" : String(cause),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What a Next response says about itself when it is dead.
 *
 * A page with no root layout is served as HTTP 200 — the status line is a
 * fiction, and every check that reads only the status reports a page nobody
 * can use as healthy. A build error like two parallel routes resolving to one
 * path is served as 500 on *every* route, including the mount, which is how a
 * routing mistake gets diagnosed as a mounting mistake.
 *
 * Only markers Next actually emits, no heuristics. A false "your app is
 * broken" would be worse than the false "healthy" this replaces, so an
 * unrecognised body is not a finding.
 */
export function nextFailureIn(text) {
  if (typeof text !== "string") return undefined;
  if (text.includes("NEXT_MISSING_ROOT_TAGS")) {
    return (
      "The page rendered with no <html>/<body> (NEXT_MISSING_ROOT_TAGS): it has no root " +
      "layout. In an app that keeps its layouts inside route groups, a page outside them " +
      "inherits none."
    );
  }
  if (text.includes("two parallel pages that resolve to the same path")) {
    return (
      "Two pages resolve to the same route, so Next is failing every route in the " +
      "application. Route groups contribute no path segment, so a page inside one and a " +
      "page outside it are the same URL — delete whichever is not yours."
    );
  }
  const digest = /data-next-error-digest="([^"]+)"/.exec(text);
  if (digest) return `Next reported a server error on this route (digest ${digest[1]}).`;
  return undefined;
}

/**
 * Whether the mount is there at all, before anything else is attempted.
 *
 * These sit at the *mounted* level: answering on the wire is what a mount
 * proves, and nothing more. Filed under `published` they rendered a tick
 * beneath a heading they had not earned — able to contradict a failing
 * source-scan of the same mount in the same report.
 *
 * Separated because "nothing is listening" and "the routes are not mounted
 * where you said" produce the same downstream noise otherwise, and the fix is
 * different for each.
 *
 * Returns an array, because one probe answers two questions: the route it hits
 * is admin-gated, so the *status* of the answer is a free reading on whether
 * `requireAdmin` refuses a token this tool just invented.
 */
export async function checkReachable(serviceUrl) {
  const probe = await call(serviceUrl, "api/catalog", { adminToken: "probe-unauthenticated" });
  if (probe.status === 0) {
    return [{
      id: "reachable",
      status: "fail",
      level: LEVELS.L2,
      summary: `Nothing answered at ${serviceUrl}`,
      remedy: `Start the app, and check --service-url points at the mount (${probe.error}).`,
    }];
  }
  if (probe.hostFailure) {
    // Not a mounting problem, and saying it was sent a host to re-check a mount
    // this same tool had verified minutes earlier. An application failing to
    // render fails its own routes and the mount alike; nothing about the mount
    // can be judged until it serves.
    return [{
      id: "reachable",
      status: "fail",
      level: LEVELS.L2,
      summary: `${serviceUrl} answered, but the application itself is not rendering`,
      remedy: `${probe.hostFailure} Fix that first — the mount cannot be judged through it.`,
    }];
  }
  if (probe.error) {
    return [{
      id: "reachable",
      status: "fail",
      level: LEVELS.L2,
      summary: `${serviceUrl} answered, but not with RenderYes's routes`,
      remedy:
        "The handler owns its route paths. Mount createViewHttpHandler rather than " +
        "hand-writing routes, and point --service-url at the prefix it is mounted under.",
    }];
  }
  // JSON narrows it to "an API answered"; only the handler's own header says
  // *this* API. Without it a different JSON service, a proxy, or a stale
  // process on the port all read as a healthy mount — and this check sits
  // exactly where a downstream failure gets diagnosed, so a false pass here
  // sends whoever is debugging to the wrong place.
  if (!probe.handler) {
    return [{
      id: "reachable",
      status: "fail",
      level: LEVELS.L2,
      summary: `${serviceUrl} answered with JSON, but not from a RenderYes handler`,
      remedy:
        "Something else is serving this URL — a different API, a proxy, or an older " +
        "process still holding the port. Check --service-url points at the mount, and " +
        "that createViewHttpHandler is what answers there.",
    }];
  }
  if (probe.status === 401 || probe.status === 403) {
    return [{
      id: "reachable",
      status: "pass",
      level: LEVELS.L2,
      // The admin gate refusing a bad token is the healthiest possible answer
      // here: the routes exist and requireAdmin is doing its job.
      summary: "Mount is reachable and the admin gate is closed to a bad token",
    }];
  }
  const checks = [{
    id: "reachable",
    status: "pass",
    level: LEVELS.L2,
    summary: "Mount is reachable",
  }];
  // A 2xx means an admin-gated route answered a token with no reason to be
  // accepted. A warn rather than a fail: a requireAdmin built on something
  // other than a token — internal network, mTLS — legitimately says yes here,
  // and failing would punish a valid setup for not being the common one.
  if (probe.ok) {
    checks.push({
      id: "admin-gate",
      status: "warn",
      level: LEVELS.L2,
      summary: "The admin gate accepted a token this tool invented",
      remedy:
        "GET /api/catalog is admin-gated, and it answered a garbage token. If your " +
        "requireAdmin checks something other than the token itself (network, mTLS), " +
        "this is expected. Otherwise the publish routes are open, and anyone who can " +
        "reach this mount can replace your catalog.",
    });
  }
  return checks;
}

/**
 * Whether the scaffolded page is a page, not merely a response.
 *
 * Nothing checked this before, which is how an install reported MOUNTED on
 * every line while the surface a visitor opens was serving an empty shell.
 * The mount and the page are separate things on separate routes: a healthy
 * mount says nothing about whether the page renders.
 *
 * Judged on the body, because the status line does not carry the answer — a
 * page with no root layout is a 200. Only markers Next emits count; an
 * unrecognised body is a pass, since this must never invent an outage.
 */
export async function checkPage(pageUrl) {
  let response;
  let text = "";
  try {
    response = await fetch(pageUrl, { signal: AbortSignal.timeout(10_000) });
    text = await response.text();
  } catch (cause) {
    return {
      id: "page",
      status: "fail",
      level: LEVELS.L2,
      summary: `Nothing answered at ${pageUrl}`,
      remedy: `Start the app, or pass --page-url if the page is served elsewhere (${String(cause)}).`,
    };
  }
  const failure = nextFailureIn(text);
  if (failure) {
    return {
      id: "page",
      status: "fail",
      level: LEVELS.L2,
      summary: `${pageUrl} answered ${response.status}, but the page is not rendering`,
      remedy: failure,
    };
  }
  if (!response.ok) {
    return {
      id: "page",
      status: "fail",
      level: LEVELS.L2,
      summary: `${pageUrl} answered ${response.status}`,
      remedy: "The page route is not serving. Check the app's own logs for this route.",
    };
  }
  return {
    id: "page",
    status: "pass",
    level: LEVELS.L2,
    summary: `Page renders at ${pageUrl}`,
  };
}

/**
 * Everything the server can tell us, in one pass.
 *
 * `adminToken` is a value the caller read from an environment variable. Absent,
 * the admin-gated reads are skipped rather than failed — a host running this
 * without the token is asking a narrower question, not doing it wrong.
 */
export async function runLiveChecks(serviceUrl, options = {}) {
  const checks = await gatherLiveChecks(serviceUrl, options);
  // Every path out of the gather leaves at the first thing it cannot get past,
  // and each of those used to drop `verified` from the report entirely rather
  // than reporting it as unreached. A level that is missing cannot block, so
  // doctor printed "nothing blocking" and exited 0 on an install it had never
  // verified. Reported once, here, so no early return can lose it again.
  if (!checks.some((check) => check.id === "compose")) {
    checks.push(interpretCompose(undefined));
  }
  return checks;
}

async function gatherLiveChecks(serviceUrl, { adminToken, catalogId, prompt, pageUrl } = {}) {
  const checks = [...(await checkReachable(serviceUrl))];
  // Before the early return below: a page that does not render is worth saying
  // even when the mount is what failed, and the two are independent surfaces.
  if (pageUrl) checks.push(await checkPage(pageUrl));
  if (checks.some((check) => check.id === "reachable" && check.status === "fail")) return checks;

  if (!adminToken) {
    checks.push({
      id: "admin-token",
      status: "skip",
      level: LEVELS.L3,
      summary: "No admin token supplied, so catalog state was not read",
      remedy:
        "Pass --admin-token-env NAME to name the variable holding it. The value is " +
        "read from the environment and never stored.",
    });
    return checks;
  }

  const [capability, ui] = await Promise.all([
    call(serviceUrl, "api/catalog", { adminToken }),
    call(serviceUrl, "api/ui-catalog", { adminToken }),
  ]);

  if (capability.status === 401 || capability.status === 403) {
    checks.push({
      id: "admin-token",
      status: "fail",
      level: LEVELS.L3,
      summary: "The admin token was rejected",
      remedy: "requireAdmin refused it. Check the variable holds what your own gate compares against.",
    });
    return checks;
  }

  const capabilityCatalogs = capability.body?.catalogs ?? capability.body ?? [];
  const uiCatalogs = ui.body?.sites ?? ui.body ?? [];
  const resolvedCatalogId =
    catalogId ??
    (Array.isArray(capabilityCatalogs) && capabilityCatalogs.length === 1
      ? capabilityCatalogs[0].catalogId
      : undefined);

  const coverage = resolvedCatalogId
    ? (await call(serviceUrl, `api/coverage?catalogId=${encodeURIComponent(resolvedCatalogId)}`, {
        adminToken,
      })).body
    : undefined;

  checks.push(
    ...interpretCatalogState({
      capabilityCatalogs: Array.isArray(capabilityCatalogs) ? capabilityCatalogs : [],
      uiCatalogs: Array.isArray(uiCatalogs) ? uiCatalogs : [],
      coverage,
    }),
  );

  if (!resolvedCatalogId) return checks;

  const probe = await call(serviceUrl, "api/catalog/probe", {
    method: "POST",
    adminToken,
    // Shape only: a probe that executes needs a visitor credential this tool
    // does not have and should not ask for. What it still catches is a catalog
    // the upstream cannot serve at all.
    body: { catalogId: resolvedCatalogId, checkUpstreamCredential: false },
    timeoutMs: 30_000,
  });
  checks.push(...interpretProbe(probe.body));

  if (!prompt) return checks;
  {
    const compose = await call(serviceUrl, "api/compose", {
      method: "POST",
      // No `providerId`: the host's own default provider answers. This used to
      // pass `"mock"`, a reserved id resolving to a built-in planner that
      // returned the first approved capability with empty params and never read
      // the prompt — so this check "passed" against an install with no model
      // configured, which is the state it was most likely to be run in. The id
      // is gone; a host with no provider now gets a refusal naming what is
      // missing, and `interpretCompose` reports that as the finding it is.
      body: { catalogId: resolvedCatalogId, prompt },
      timeoutMs: 30_000,
    });
    checks.push(
      interpretCompose(
        compose.body ?? { ok: false, error: compose.error ?? `HTTP ${compose.status}` },
      ),
    );
  }

  return checks;
}
