import { z } from "zod";
import type {
  CapabilityExecutionContext,
  CapabilityRuntime,
} from "@renderyes/capability-catalog/server";
import type { CapabilityExecutionResult } from "@renderyes/capability-catalog";
import type { OpenApiOperationBinding } from "@renderyes/capability-catalog/openapi";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 200;

export interface OpenApiRuntimeOptions {
  /** The compiled binding for one approved operation, from an CompiledOpenApiCatalog. */
  binding: OpenApiOperationBinding;
  /** Must match a sourceId declared on the compiled capability catalog. */
  sourceId: string;
  /** Used when the binding itself carries no serverUrl. */
  baseUrl?: string;
  /**
   * Resolves server-only auth headers at request time. Never sourced from planner
   * params — this is where a host injects its own API key/token.
   *
   * Receives the trusted session values the capability declared in
   * `requiredSessionKeys`, already resolved and verified present by the
   * executor. That is what makes an identity-scoped OpenAPI capability
   * honest: without it the keys were resolved, failed closed when absent, and
   * then discarded, so `requiredSessionKeys: ["userId"]` amounted to "the
   * session must have a userId" and never to "these rows belong to that user".
   *
   * A capability declaring `requiredSessionKeys` with no hook here is refused
   * at execution — see `forwardsIdentity` on `CapabilityRuntime`.
   */
  headers?: (context: {
    identity: Readonly<Record<string, unknown>>;
  }) => MaybePromise<Record<string, string>>;
  /**
   * Re-checks the resolved URL against the host's upstream allowlist, on every
   * request, immediately before the credential is attached.
   *
   * The allowlist is already enforced when a catalog is published, which covers
   * a binding that named a destination nobody approved. It does not cover the
   * host *narrowing* the allowlist afterwards: without this hook an already
   * published catalog kept calling a revoked origin until someone republished
   * it. The GraphQL transport has always re-checked here for that reason; this
   * is the same check, and the OpenAPI path went without it.
   *
   * Throws to refuse. Omitted, only the publish-time check applies.
   */
  assertAllowedUpstream?: (url: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Builds a fetch-based CapabilityRuntime for one approved, read-only OpenAPI
 * operation. Returns raw parsed JSON on success — this relies on the catalog's
 * compiled outputSchema (additionalProperties:false) and the trusted executor's
 * validateCapabilityResult to fail closed on any field the owner didn't approve;
 * this adapter must never filter or reshape the response itself.
 */
export function createOpenApiRuntime(options: OpenApiRuntimeOptions): CapabilityRuntime {
  // A host-approved POST may be semantically read-only, but retrying it after
  // a network failure could still repeat an upstream operation whose outcome
  // is uncertain. Keep automatic retries exclusively for idempotent GETs.
  const maxAttempts =
    options.binding.method === "POST"
      ? 1
      : positiveIntegerOr(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const retryBaseDelayMs = positiveIntegerOr(
    options.retryBaseDelayMs,
    DEFAULT_RETRY_BASE_DELAY_MS,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  return {
    capabilityId: options.binding.capabilityId,
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.unknown(),
    // With no `headers` hook there is no path by which a resolved session value
    // could reach the upstream, so a capability declaring `requiredSessionKeys`
    // against this runtime cannot be scoped to that identity however it is
    // configured. Declared here so the executor can refuse rather than return
    // unscoped rows under a scoped capability's name.
    forwardsIdentity: options.headers !== undefined,
    execute: (input, context) =>
      executeOpenApiOperation(options, input, context, {
        maxAttempts,
        retryBaseDelayMs,
        fetchImpl,
        now,
      }),
  };
}

interface ResolvedRuntimeConfig {
  maxAttempts: number;
  retryBaseDelayMs: number;
  fetchImpl: typeof fetch;
  now: () => number;
}

async function executeOpenApiOperation(
  options: OpenApiRuntimeOptions,
  input: unknown,
  context: CapabilityExecutionContext,
  config: ResolvedRuntimeConfig,
): Promise<CapabilityExecutionResult<unknown>> {
  const request = buildRequest(options.binding, options.baseUrl, input);
  const url = request.url;
  if (!url) {
    return {
      ok: false,
      error: {
        code: "CONFIGURATION_ERROR",
        message: "This capability has no resolvable upstream URL",
        retryable: false,
      },
    };
  }

  // Before any attempt and before any credential is resolved: a revoked origin
  // must not be contacted at all, not contacted once and then refused.
  if (options.assertAllowedUpstream) {
    options.assertAllowedUpstream(url);
  }

  let lastTransientError: { code: string; message: string } | undefined;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    if (context.signal?.aborted) {
      throw context.signal.reason ?? new Error("Aborted");
    }

    // Resolved per attempt, not once up front: a resolver may mint or
    // refresh a short-lived token, so a stale header must not survive into a
    // retry. This also keeps a slow/hanging resolver subject to the same
    // abort check above rather than running unguarded before it.
    const headers = options.headers
      ? await options.headers({ identity: context.identity })
      : {};
    if (request.body !== undefined && !hasHeader(headers, "content-type")) {
      headers["content-type"] = "application/json";
    }

    let response: Response;
    try {
      response = await config.fetchImpl(url, {
        method: options.binding.method,
        headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        signal: context.signal,
        // The origin allowlist is enforced when a catalog is published, and a
        // followed redirect would step straight around it: an approved host
        // answering 302 to somewhere else would have this process re-send the
        // credentialed request to a destination nobody approved. `fetch` also
        // forwards the Authorization header across a same-scheme redirect, so
        // following one is a credential-disclosure primitive, not just a
        // routing surprise. A 3xx becomes an error below.
        redirect: "manual",
      });
    } catch (error) {
      if (context.signal?.aborted) {
        throw context.signal.reason ?? error;
      }
      lastTransientError = {
        code: "UPSTREAM_UNAVAILABLE",
        message: "The upstream API could not be reached",
      };
      if (attempt < config.maxAttempts) {
        await delay(backoffDelay(config.retryBaseDelayMs, attempt), context.signal);
        continue;
      }
      return { ok: false, error: { ...lastTransientError, retryable: true } };
    }

    // Not retryable and not followed. With `redirect: "manual"` a 3xx arrives
    // here as an ordinary response; treating it as success would parse a
    // redirect body as data, and following it would leave the approved origin.
    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        error: {
          code: "UPSTREAM_REDIRECTED",
          message:
            "The approved endpoint redirected. Publish the final destination instead — a redirect leaves the origin the catalog approved.",
          retryable: false,
        },
      };
    }

    if (response.status === 429 || response.status >= 500) {
      lastTransientError = {
        code: response.status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
        message:
          response.status === 429
            ? "The upstream API rate-limited this request"
            : "The upstream API is currently unavailable",
      };
      if (attempt < config.maxAttempts) {
        await delay(backoffDelay(config.retryBaseDelayMs, attempt), context.signal);
        continue;
      }
      return { ok: false, error: { ...lastTransientError, retryable: true } };
    }

    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: "UPSTREAM_ERROR",
          message: "The upstream API rejected this request",
          retryable: false,
        },
      };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return {
        ok: false,
        error: {
          code: "UPSTREAM_INVALID_RESPONSE",
          message: "The upstream API returned a response that could not be parsed",
          retryable: false,
        },
      };
    }

    const fetchedAt = config.now();
    const reported = reportedDataAge(response.headers, fetchedAt);
    const limit = options.binding.freshnessMaximumAgeSeconds;
    if (limit !== undefined && reported !== undefined) {
      const ageSeconds = Math.max(0, (fetchedAt - reported.asOf) / 1000);
      if (ageSeconds > limit) {
        return {
          ok: false,
          error: {
            code: "STALE_UPSTREAM_RESULT",
            message: `The upstream reported data ${Math.round(ageSeconds)}s old, above the approved limit of ${limit}s`,
            retryable: false,
          },
        };
      }
    }

    return {
      ok: true,
      data,
      provenance: {
        sources: [{ sourceId: options.sourceId }],
        freshness: {
          // The upstream's own reported age when it gave one, otherwise the
          // moment of the fetch. The distinction matters: stamping fetch time
          // and calling it freshness makes every result look current, and a
          // freshness limit compared against it can never fire.
          asOf: new Date(reported?.asOf ?? fetchedAt).toISOString(),
        },
      },
    };
  }

  return {
    ok: false,
    error: {
      ...(lastTransientError ?? {
        code: "UPSTREAM_UNAVAILABLE",
        message: "The upstream API is currently unavailable",
      }),
      retryable: true,
    },
  };
}

function backoffDelay(baseMs: number, attempt: number): number {
  const exponential = baseMs * 2 ** (attempt - 1);
  const jitter = Math.random() * baseMs;
  return exponential + jitter;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Forwards only the owner-approved URL/body allow-lists, regardless of what
 * extra keys `input` happens to carry. URL values become path/query values;
 * POST body values become top-level JSON object properties.
 */
function buildRequest(
  binding: OpenApiOperationBinding,
  baseUrl: string | undefined,
  input: unknown,
): { url?: string; body?: string } {
  const base = binding.serverUrl ?? baseUrl;
  if (!base) return {};

  const params = isPlainRecord(input) ? input : {};
  let path = binding.path;
  const query = new URLSearchParams();

  for (const key of binding.contentParameters) {
    if (!(key in params)) continue;
    const value = params[key];
    if (value === undefined) continue;
    const placeholder = `{${key}}`;
    if (path.includes(placeholder)) {
      path = path.split(placeholder).join(encodeURIComponent(String(value)));
    } else {
      query.set(key, String(value));
    }
  }

  const url = new URL(path, base);
  const queryString = query.toString();
  if (queryString) url.search = queryString;

  if (binding.method !== "POST") return { url: url.toString() };
  const body: Record<string, unknown> = {};
  for (const key of binding.bodyParameters ?? []) {
    if (!(key in params) || params[key] === undefined) continue;
    body[key] = params[key];
  }
  return { url: url.toString(), body: JSON.stringify(body) };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const expected = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === expected);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

/**
 * When the upstream says its data was current, from the response headers.
 *
 * This is the REST-shaped answer to a question GraphQL settles differently. A
 * GraphQL host supplies `resolveProvenance` and can report a cache timestamp
 * from wherever it knows one; a REST response carries the answer in the
 * protocol, so read it rather than asking the host to.
 *
 * `Last-Modified` is preferred — it is a statement about the data. `Date` less
 * `Age` is the fallback, which is what a caching proxy in front of the API
 * reports: `Date` is when the origin generated the response and `Age` is how
 * long the cache has held it, so the difference is when the data was actually
 * current. `Age` alone is relative to a `Date` we would then be guessing.
 *
 * Returns undefined when the upstream reports nothing, which is honest: no age
 * is not the same as age zero, and treating it as zero would let a freshness
 * limit pass on an API that never said anything.
 */
function reportedDataAge(
  headers: Headers,
  fetchedAt: number,
): { asOf: number } | undefined {
  const lastModified = headers.get("last-modified");
  if (lastModified) {
    const parsed = Date.parse(lastModified);
    if (Number.isFinite(parsed)) return { asOf: parsed };
  }

  const date = headers.get("date");
  const age = headers.get("age");
  if (date && age !== null) {
    const parsedDate = Date.parse(date);
    const parsedAge = Number(age);
    if (Number.isFinite(parsedDate) && Number.isInteger(parsedAge) && parsedAge >= 0) {
      // Clamped: a proxy reporting an Age larger than the document is old would
      // otherwise produce an asOf in the future relative to Date.
      return { asOf: Math.min(parsedDate - parsedAge * 1000, fetchedAt) };
    }
  }

  return undefined;
}
