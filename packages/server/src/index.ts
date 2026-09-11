import { AsyncLocalStorage } from "node:async_hooks";
import {
  createCapabilityCatalogStore,
  createDataPlanningContract,
  executeDataRequest,
  executePlanData,
  executePlanDataRequests,
  validateDataRequestQuery,
  type ExecutionResult,
  type GraphQlRuntimeConfig,
  type OpenApiRuntimeConfig,
  type TrustedExecutionHost,
} from "@renderyes/data-runtime";
import {
  MemoryOperationClassificationCache,
  ReviewExportEnvelopeSchema,
  REVIEW_EXPORT_VERSION,
  assertCapabilityCatalog,
  classifyOperationEffects,
  createPlannerManifest,
  describeContractCost,
  isListResultShape,
  judgeContractCost,
  proposeApprovedFields,
  suggestFieldSemanticTypes,
  type ContractBudgetVerdict,
  type ContractCost,
  type DataProvenance,
  type OperationClassificationCache,
  type OperationEffectClassifier,
  type ResolvedOperationClassification,
} from "@renderyes/capability-catalog";
import { GraphQlTransportError } from "@renderyes/capability-catalog/graphql";
import type {
  GraphQlOperationBinding,
  GraphQlTransportResponse,
} from "@renderyes/capability-catalog/graphql";
import {
  compilePlanDataSurfaceMessages,
  createSiteCatalogStore,
  matchCatalogToComponents,
  type CompiledSiteSurface,
  type DataTypeCoverage,
  type SiteCatalogStore,
  type SiteManifest,
} from "@renderyes/site-sdk";
import {
  composeDataPlan,
  validateComposedPlan,
  type DataPlanIssue,
} from "@renderyes/planner";
import {
  diffDataModel,
  type ComposeEvent,
  type DataRequestState,
} from "@renderyes/core";
import type { PlanV3_1 } from "@renderyes/core";
import {
  createModelPlanProvider,
  createScriptedPlanProvider,
  isScriptedProvider,
  providerDiagnostic,
  type ModelProviderConfig,
  type ScriptedProviderConfig,
} from "./providers.js";

export {
  createModelPlanProvider,
  createScriptedPlanProvider,
  jsonModeSystemPrompt,
  oversizedParamsSchemas,
  providerDiagnostic,
  shouldRetryWithoutStructuredSchema,
  structuredOutputSchema,
  structuredRejectionDetail,
  type ModelProviderConfig,
  type OversizedParamsSchema,
  type ScriptedProviderConfig,
} from "./providers.js";

import { createMemoryViewStore, type SavedView, type ViewStore } from "./views.js";
import { slicePlanToNodes } from "./slice.js";
import type { CatalogSnapshot, CatalogStore, RestoreSummary } from "./catalogs.js";
import { applyRefineOperations, type RefineOperation } from "./refine.js";
import {
  newTraceId,
  type ModelCallEvent,
  type ModelCallObserver,
} from "./observability.js";

export { createMemoryViewStore, type SavedView, type ViewStore } from "./views.js";

/**
 * Durable published catalogs. `createFileCatalogStore` lives in
 * `@renderyes/server/node`, because it imports `node:fs`.
 */
export {
  createMemoryCatalogStore,
  type CatalogStore,
  type PublishedCatalogRecord,
  type RestoreSummary,
} from "./catalogs.js";

export {
  applyRefineOperations,
  type RefineOperation,
  type RefineResult,
} from "./refine.js";

export {
  createOtlpModelObserver,
  type ModelCallEvent,
  type ModelCallObserver,
  type OtlpModelObserver,
  type OtlpObserverConfig,
} from "./observability.js";

/**
 * The routes, so a host mounts one handler instead of transcribing fourteen.
 * `@renderyes/server/node` adapts it to `node:http`.
 */
export {
  createViewHttpHandler,
  UnauthenticatedError,
  ADMIN_TOKEN_HEADER,
  HANDLER_HEADER,
  DEFAULT_MAX_BODY_BYTES,
  LIBRARY_ONLY_METHODS,
  VIEW_HTTP_ROUTES,
  type ViewHttpCorsOptions,
  type ViewHttpHandlerOptions,
  type ViewHttpRoute,
} from "./http.js";

/**
 * The backend a host actually runs alongside `@renderyes/react`.
 *
 * This used to live inline in a demo app (`apps/demo-finance-site`), which
 * hardcoded a fake session/host adapter and mixed demo-only routes into the
 * same file as the reusable registry/compose logic. This package is that
 * reusable part on its own: no demo routes, no fixed session, no baked-in
 * HTTP framework. A host supplies its own session type and adapter, and mounts
 * `createViewHttpHandler` on whatever server it already runs (plain node:http,
 * Express, Fastify, a serverless handler — anything).
 *
 * Note the boundary that moved since that split. "No baked-in HTTP framework"
 * was right; "no routes" was not. The paths are a contract with
 * `@renderyes/react`, so leaving each host to transcribe them produced hosts
 * that were missing some — six finished features here had no route at all for
 * weeks, and nothing failed, because nothing was looking across that boundary.
 * The routes now live in `http.ts` with a contract test; the framework choice is
 * still the host's.
 */

export interface PlanProviderResult {
  modelId: string;
  value: unknown;
  /**
   * What the call cost, when the provider reports it. Optional because not
   * every provider returns usage, and one that doesn't must not be forced to
   * invent numbers — an absent field means "unknown", never zero.
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    /**
     * HTTP calls this result actually took. Usually 1, but a structured-schema
     * rejection retries in plain JSON mode, so one `generatePlan` can bill twice.
     */
    calls?: number;
  };
  /**
   * Whether the winning call ran under a provider-enforced response schema
   * (true) or degraded to prompt-embedded JSON mode (false). Lands in the
   * plan's `generation.constrainedDecoding`, so the fallback is no longer
   * silent. Optional: a custom provider that doesn't know must not guess.
   */
  constrainedDecoding?: boolean;
}

export interface PlanProvider {
  id: string;
  generatePlan(request: {
    systemPrompt: string;
    userPrompt: string;
    jsonSchema: unknown;
  }): Promise<PlanProviderResult>;
}

export interface GraphQlHostRequestContext<Session> {
  /** The opaque request originally passed to plan/compose. */
  request: unknown;
  /** The host-verified session returned by resolveSession. */
  session: Session;
  catalogId: string;
  capabilityId: string;
  sourceId: string;
  /**
   * Where this request is about to be sent, already checked against
   * `allowedUpstreamOrigins`.
   *
   * Supplied so a host can vary credentials by destination — most usefully,
   * forwarding a caller's own token to one preconfigured origin while
   * presenting a service credential, or nothing, everywhere else. Without it
   * a host decides blind, which in practice means sending the same credential
   * to every destination a catalog is able to name.
   */
  endpoint: string;
  /** The origin of `endpoint`, for comparison against a host's own allowlist. */
  destinationOrigin: string;
}

export interface GraphQlHostAdapter<Session> {
  /**
   * Resolve upstream credentials from trusted request/session state. This is
   * invoked during execution and is never exposed to the planner or browser.
   */
  resolveHeaders?: (
    context: GraphQlHostRequestContext<Session>,
  ) => Record<string, string> | Promise<Record<string, string>>;
  /** GraphQL cannot establish factual freshness by itself, so the host must. */
  resolveProvenance: (
    context: GraphQlHostRequestContext<Session> & { data: unknown },
  ) => DataProvenance | Promise<DataProvenance>;
  fetchImpl?: typeof fetch;
}

export interface ViewServerConfig<Session> {
  /** The trusted adapter identity injection is scoped through. Never optional in a real deployment. */
  host: TrustedExecutionHost<Session>;
  /**
   * Resolves the session for one request. Most hosts derive this from their
   * own auth (a verified cookie, a bearer token) — this package never reads
   * request headers itself, so it stays transport-agnostic.
   */
  resolveSession: (request: unknown) => Session | Promise<Session>;
  /** Required only when the host publishes GraphQL catalogs. */
  graphql?: GraphQlHostAdapter<Session>;
  /**
   * Optional server-side semantic classifier used during onboarding review.
   * The classifier proposes business effects; it never approves an operation.
   */
  operationClassifier?: OperationEffectClassifier;
  /** Defaults to process-local memory. Hosts may supply a durable cache. */
  operationClassificationCache?: OperationClassificationCache;
  /**
   * Reuses a previously composed plan for an identical prompt on the same
   * surface, skipping the model call entirely. Off unless supplied — see
   * `createMemoryPlanCache` for the reasoning and the safety argument.
   */
  planCache?: PlanCache;
  /**
   * Providers `composeAgainstPublishedCatalogs` and `planAgainstPublishedCatalog`
   * may select among by id. The first entry is the default when a caller does not
   * name one.
   *
   * Required for planning. With none configured, planning refuses rather than
   * degrading: it names what is missing and reports everything that *is* wired
   * up (`describePlanningWiring`). There is deliberately no built-in fallback
   * planner, because a plan produced without reading the prompt renders through
   * real components and cannot be told apart from a working install.
   *
   * A `ScriptedProviderConfig` — `{id, plans}` — is the supported way to run
   * the pipeline without a model. The plans are the host's own, so a pass says
   * something about the install rather than about our guess.
   */
  planProviders?: readonly (ModelProviderConfig | ScriptedProviderConfig)[];
  /**
   * Called once per `composeAgainstPublishedCatalogs`, on success and on
   * failure alike. The host decides where this goes — a JSONL file, stdout, a
   * metrics backend — because this package should not own that choice.
   *
   * Never throws into the request: an exception here is caught and logged, so
   * a broken telemetry sink cannot fail a compose that otherwise worked.
   */
  onComposeMetrics?: (metrics: ComposeMetrics) => void;
  /**
   * Per-compose admission gate, mirroring `host.allowExecution`'s shape: the
   * package owns the enforcement point, the host owns the policy (a token
   * bucket keyed by session, a per-tenant quota, a global breaker).
   *
   * Off unless supplied. Worth supplying before the endpoint is public: one
   * compose costs two or more model calls and 13-27 seconds of paid work, and
   * `/api/compose` is visitor-facing — an unthrottled loop spends real money
   * at model-call rates, not HTTP rates.
   *
   * Checked after the session resolves and before any model call, so a denied
   * request costs a session lookup and nothing else. Returning false rejects
   * the compose with `ComposeRateLimitedError`, which the HTTP handler maps
   * to 429. A gate that throws fails the request the same way any host hook
   * failure would — denial must come from a decision, not an accident.
   */
  allowCompose?: (context: {
    session: Session;
    catalogId: string;
  }) => boolean | Promise<boolean>;
  /**
   * Called once per model call — including every planner repair attempt and
   * every provider a host supplies through `createProvider`.
   *
   * Deliberately a plain callback rather than an SDK: this package is
   * installed into someone else's backend, and picking their observability
   * vendor for them is not ours to do. `createOtlpModelObserver` in this
   * package turns it into OpenTelemetry GenAI spans over OTLP/HTTP, which
   * Langfuse ingests natively and any OTLP collector forwards anywhere else.
   *
   * Never throws into a request: an exception here is caught and logged, so a
   * broken tracing backend cannot fail a compose that otherwise worked.
   */
  onModelCall?: ModelCallObserver;
  /**
   * Includes prompt and completion text in `ModelCallEvent`. Off by default.
   *
   * Enabling tracing must not quietly start shipping content to a third
   * party. The user prompt is the visitor's own words, and the system prompt
   * carries the host's entire catalog — capability descriptions, field names,
   * component inventory. A host may have promised not to send either
   * anywhere, so this is a separate, explicit decision from turning on
   * observability at all.
   */
  captureModelPrompts?: boolean;
  /**
   * Wall-clock ceiling on the planning phase of one compose, shared across
   * every repair attempt. Defaults to `DEFAULT_PLAN_DEADLINE_MS`.
   *
   * This exists because the per-call timeout multiplied out. Each model call
   * gets `DEFAULT_MODEL_TIMEOUT_MS`, a structured-schema rejection retries
   * once within a single call, and the planner repairs up to twice — six
   * billed calls and around six minutes of work, against a browser default of
   * 45 seconds. Server spend outliving the client that asked for it is pure
   * waste: there is nobody left to receive the result.
   *
   * Set it at or under whatever the frontend's own timeout is.
   */
  planDeadlineMs?: number;
  /**
   * Wall-clock ceiling on a whole compose — planning *and* execution.
   * Defaults to `DEFAULT_COMPOSE_DEADLINE_MS`.
   *
   * `planDeadlineMs` bounds only the repair loop, which left the request
   * itself unbounded: a measured compose reported "Planning exceeded its
   * 40000ms budget" and took 48,970ms, both statements true. The host's real
   * tail was the plan budget plus execution plus whatever the last attempt was
   * doing when the budget expired, and the browser had given up long before —
   * so the server finished, billed, and returned into a closed connection.
   *
   * Planning takes its budget from inside this one, so the two cannot sum past
   * it: the effective plan deadline is whichever of the two is smaller, and
   * execution gets whatever planning left.
   */
  composeDeadlineMs?: number;
  /**
   * Approximate token size past which a publish reports its planning contract
   * as over budget. Defaults to `DEFAULT_CONTRACT_TOKEN_BUDGET`.
   *
   * The contract is resent on every plan attempt and a compose makes up to
   * three, so this is the dominant cost of the system and the one a catalog
   * decision moves most. Publishing measured it already and returned it as an
   * integer with nothing to compare it to; this is the comparison.
   */
  contractTokenBudget?: number;
  /**
   * Approximate token size past which a publish is *refused*. No default.
   *
   * Separate from the budget because the two answer different questions. Over
   * budget is a cost a host may knowingly accept. Over the ceiling is a
   * contract they have decided must never be sent — worth having because a
   * provider that rejects an oversized schema does not fail the compose, it
   * silently retries unconstrained, so the symptom of going too far is a
   * quality regression rather than an error.
   */
  contractTokenCeiling?: number;
  /**
   * Maps an opaque credential id a publish call may reference to the
   * environment variable its token is read from. Only ids declared here can be
   * used; anything else is rejected.
   *
   * This indirection is the security boundary. The publish payload previously
   * carried the environment variable *name* directly, validated only for
   * shape — so a caller who could reach the route could name any variable in
   * this process (`OPENAI_API_KEY`, cloud credentials, a database URL) and
   * have its value sent as a bearer token to a `baseUrl` they also chose.
   * Validating the format of a secret's name constrains what the attack looks
   * like, not whether it works. An allowlist the host declares out-of-band
   * removes the caller's ability to choose at all.
   */
  upstreamCredentials?: Readonly<Record<string, string>>;
  /**
   * Origins an approved catalog may point a capability at, e.g.
   * `["https://api.internal.example"]`. Compared by parsed origin, never by
   * string prefix — prefix matching accepts
   * `https://api.internal.example.attacker.com`.
   *
   * A catalog names *where* a capability lives, so without this list whoever
   * can publish also chooses where this process makes authenticated outbound
   * requests. That is a deployment decision, never a catalog one, which is
   * why it lives in config rather than in the published payload.
   *
   * Fails closed: an absent or empty list rejects every destination. This
   * deliberately does not treat "unconfigured" as "unrestricted" — the
   * earlier behaviour meant a host that never learned the option existed ran
   * with no gate at all, and silence is a bad way to opt into that. A host
   * that legitimately serves capabilities from its own process names its own
   * origin here; loopback is allowed, but only when stated.
   */
  allowedUpstreamOrigins?: readonly string[];
  /**
   * Where saved views live. Omit to disable saving entirely — the save/reopen
   * methods then reject rather than silently pretending to persist.
   *
   * `createMemoryViewStore()` is process-local and lost on restart; a host
   * that wants visitors to actually come back to a view needs a durable
   * implementation.
   */
  viewStore?: ViewStore;
  /**
   * Derives the opaque owner key a saved view is filed under, from the same
   * session `resolveSession` returns.
   *
   * Required whenever `viewStore` is set. There is no default: guessing an
   * identity here would be guessing who is allowed to read a saved view, and
   * the wrong guess (say, falling back to a shared constant for anonymous
   * visitors) would make every saved view world-readable. The host knows what
   * identity means in its system; this package does not.
   *
   * Optional only for a host that composes statelessly. Any path that looks a
   * plan up by id — refine, revise, save — refuses to run without it, because
   * every such lookup is an authorization decision and absence would mean any
   * caller holding a planId could act on another visitor's view.
   */
  resolveViewOwner?: (session: Session) => string;
  /**
   * Turns a failed data request into the string a **visitor** sees.
   *
   * Omitted, every failure renders one fixed sentence
   * (`DEFAULT_VISITOR_ERROR_MESSAGE`). That is the safe default rather than the
   * informative one: a failure's `message` is written by whichever
   * `runtime.execute` produced it, host runtimes included, and it used to reach
   * the browser verbatim.
   *
   * Supply this to localise or to distinguish "sign in" from "not available"
   * using `error.code`. The unredacted error stays available to the host's own
   * logging — this only controls what the browser is told.
   */
  formatVisitorError?: (error: {
    code: string;
    message: string;
    retryable?: boolean;
  }) => string;
  /**
   * Where published catalogs are recorded so a restart can replay them. Omit and
   * the registries are purely in-memory, as they always were.
   *
   * `createFileCatalogStore` in `@renderyes/server/node` is the usual choice
   * for a single-process host. Whatever the implementation, the host must call
   * `restorePublishedCatalogs()` once at boot — see the note there on why that
   * cannot happen inside `createViewServer`.
   */
  catalogStore?: CatalogStore;
}

export interface PlanCache {
  get(key: string): PlanV3_1 | undefined;
  set(key: string, plan: PlanV3_1): void;
}

/**
 * A bounded, TTL'd in-memory plan cache.
 *
 * Two properties make caching a *plan* safe in a way that caching a *response*
 * would not be:
 *
 * 1. **A plan contains no data.** It names a capability, its params, and a
 *    component — every row is fetched fresh by `executePlanData` on every
 *    request. A cache hit can never serve stale business data.
 * 2. **A plan is visitor-independent.** The planner never sees identity;
 *    identity is injected by the executor from session context. So one cached
 *    plan is correct for every visitor, and two visitors asking the same
 *    question legitimately share it — which is what makes the hit rate worth
 *    having at all.
 *
 * It is still opt-in rather than on by default: sharing composed views across
 * visitors is a decision an owner should make deliberately, and the owner has to
 * be able to bound and disable it (see the engineering rubric in AGENTS.md).
 *
 * Prompt matching is exact after case/whitespace normalization. Nothing fuzzier:
 * two prompts that merely look similar can want genuinely different views, and
 * an embedding-similarity cache would trade correctness for hit rate silently.
 */
export function createMemoryPlanCache(
  options: { maxEntries?: number; ttlMs?: number } = {},
): PlanCache {
  const maxEntries = options.maxEntries ?? 500;
  const ttlMs = options.ttlMs ?? 15 * 60 * 1000;
  const entries = new Map<string, { plan: PlanV3_1; expiresAt: number }>();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.plan;
    },
    set(key, plan) {
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(key, { plan, expiresAt: Date.now() + ttlMs });
    },
  };
}

/**
 * Normalizes a prompt for exact cache matching. Case and surrounding/internal
 * whitespace only — nothing that could change meaning.
 */
/**
 * `providerKey` is part of the key because a cached plan is a *model's*
 * answer. Swapping provider or model, or upgrading the planner contract, can
 * change what a prompt should produce — without this, a model change would
 * keep serving plans the previous model wrote until each entry aged out.
 */
function planCacheKey(input: {
  catalogId: string;
  catalogHash: string;
  siteVersion: string;
  catalogFingerprint: string;
  surfaceId: string;
  prompt: string;
  providerKey: string;
}): string {
  return [
    input.catalogId,
    input.catalogHash,
    input.siteVersion,
    input.catalogFingerprint,
    input.providerKey,
    input.surfaceId,
    input.prompt.trim().toLowerCase().replace(/\s+/g, " "),
  ].join("\0");
}

/**
 * Renders a provider's parsed value as text for a trace, bounded.
 *
 * A plan is already a JSON object by the time it reaches here, and a trace
 * backend wants a string. Capped because a plan against a large catalog is
 * big and this is telemetry, not storage.
 */
function safeCompletionText(value: unknown): string | undefined {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text === undefined ? undefined : text.slice(0, 20_000);
  } catch {
    return undefined;
  }
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertHttpUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a URL`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error(`${label} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  return parsed.toString();
}

/**
 * Ceiling on a visitor-supplied prompt, in characters.
 *
 * A prompt is forwarded to a model that bills by token, so an unbounded one is
 * an unbounded bill — and on a visitor-facing route, one anybody can run up.
 * 2000 characters is far beyond any real "show me X" intent while still
 * rejecting a pasted document outright, before it reaches a provider.
 */
export const MAX_PROMPT_LENGTH = 2000;

/**
 * Default ceiling on the planning phase of a compose, across all attempts.
 *
 * 40s, chosen to sit just under `@renderyes/react`'s 45s client default so
 * the server gives up before the browser does rather than after. Measured
 * behaviour fits: a single-capability plan lands in 11-13s and a
 * multi-capability one in 23-57s, so this allows a clean first pass and one
 * repair, and cuts the pathological three-attempt case that no caller is
 * still waiting for.
 */
export const DEFAULT_PLAN_DEADLINE_MS = 40_000;

/**
 * Default ceiling on a whole compose.
 *
 * Matched to the client's own default (`DEFAULT_COMPOSE_TIMEOUT_MS` in
 * `@renderyes/react`) rather than chosen independently. Two constants either
 * side of the wire, each picked on its own, is what produced a server that
 * worked past the point its caller was listening; the response now carries the
 * effective value so a client can stop holding a copy at all.
 */
export const DEFAULT_COMPOSE_DEADLINE_MS = 45_000;

/**
 * Describes an existing plan compactly enough to prepend to a revision prompt.
 *
 * A summary rather than the plan JSON on purpose: the full document is large
 * (every prop, binding, and query), and the model only needs to know what is
 * currently on screen and what the pieces are called in order to adjust it.
 * Sending the whole thing would cost tokens on every revision and invite the
 * model to echo structure back verbatim instead of reasoning about the change.
 */
function summarizePlanForRevision(plan: PlanV3_1, surfaceId: string): string {
  const requests = (plan.dataRequests ?? [])
    .map((request) => `- ${request.requestId}: ${request.capabilityId}`)
    .join("\n");
  const surface = plan.surfaces.find((candidate) => candidate.id === surfaceId);
  const nodes = (surface?.nodes ?? [])
    .map((node) => `- ${node.nodeId}: ${node.componentId}`)
    .join("\n");
  return [
    "The visitor is looking at this view and wants it changed.",
    "Current data requests:",
    requests || "- (none)",
    "Current components:",
    nodes || "- (none)",
  ].join("\n");
}

/**
 * One compose call's cost and timing, handed to `ViewServerConfig.onComposeMetrics`.
 *
 * Exists because compose latency was measured at 11-13s for single-capability
 * prompts and 23-57s for three-capability ones on otherwise identical
 * requests, and nothing in the system could say which part of that was model
 * generation and which was upstream data fetching. Every field here is one
 * that had to be guessed at during that investigation.
 *
 * Deliberately carries no prompt text and no fetched data — only shapes and
 * durations — so a host can log it wholesale without routing visitor content
 * or customer data into its telemetry.
 */
export interface ComposeMetrics {
  catalogId: string;
  surfaceId: string;
  /** Length of the submitted prompt. The prompt itself is never included. */
  promptLength: number;
  /** True when the plan came from `planCache` and no model call was made. */
  cached: boolean;
  /**
   * `needs-clarification` counts as neither a success nor a failure: the
   * catalog can answer and the planner asked first. Reported separately so it
   * cannot quietly inflate either rate — a system that asks a question every
   * time would otherwise look like one that never fails.
   */
  outcome: "ready" | "unsupported" | "invalid" | "provider-error" | "needs-clarification";
  /** Absent on a cache hit, since no model was called. */
  modelId?: string;
  /**
   * Wall time inside the planner, including any structured-schema retry.
   * Absent on a cache hit.
   */
  planMs?: number;
  /**
   * Summed across every model call this compose made, not just the last one.
   *
   * A plan that fails validation is retried with a repair prompt, and the
   * whole system prompt is resent each time — so a repaired compose can cost
   * three times what a clean one does. Reporting only the final attempt
   * under-reported spend by up to 3×, and did so precisely on the requests
   * that cost the most.
   */
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Whether the winning model call ran under a provider-enforced response
   * schema, or degraded to a schema embedded in the prompt. Absent on a cache
   * hit and for providers that do not report it.
   *
   * Worth watching rather than assuming: structured mode was refused on every
   * compose of a measured evaluation, so every plan came from the fallback —
   * visible only as a log line, while this field would have shown it.
   */
  constrainedDecoding?: boolean;
  /**
   * Every model HTTP call this compose made: plan attempts multiplied by the
   * structured-schema retry within each. Up to 6 at current defaults.
   */
  modelCalls?: number;
  /**
   * Plan repair attempts. 0 means the first plan validated.
   *
   * This is the dominant driver of both latency and cost — a compose is one
   * to three full-contract model calls depending on it — so it is reported
   * even though it duplicates a field on the plan itself. Absent on a cache
   * hit, where no planning happened.
   */
  repairCount?: number;
  /** Data requests the plan asked for. 0 on a failed plan. */
  capabilityCount: number;
  /**
   * How many of those requests came back as failures. Absent when no plan ran.
   *
   * `outcome: "ready"` means the planner produced a valid plan, not that the
   * visitor got an answer — a plan whose every data request failed still
   * reports ready, and renders a view of empty error slots. Without this the
   * only success rate derivable from these records counted those as wins,
   * which is the metric quietly saying yes to the question it exists to ask.
   */
  failedRequestCount?: number;
  /**
   * Distinct data types this plan drew on, and how many to-one relationships the
   * catalog declares.
   *
   * Two facts rather than a verdict, because the interesting condition is a
   * query over them: `dataTypesSpanned > 1 && joinableRelationshipCount === 0`
   * means visitors are asking across entities that this catalog cannot connect.
   *
   * That state is invisible any other way. A plan spanning two data types with
   * no relationship available does not fail and is not refused — the planner
   * only ever sees approved relationships, so it never asks for one that is
   * absent. It emits two independent requests and the visitor gets two unlinked
   * panels. The answer is thinner, nothing says so, and nothing distinguishes it
   * from two panels being exactly what was wanted.
   *
   * No relationship reaches a catalog today: neither the review UI nor the
   * headless `draft`/`candidate` path emits one, so `joinableRelationshipCount`
   * is 0 for every catalog now in existence. Which is the point — this is here
   * to find out whether real prompts ever want a join, before building
   * discovery for them on the strength of an assumption.
   */
  dataTypesSpanned: number;
  joinableRelationshipCount: number;
  /** Wall time executing every data request, including upstream round trips. */
  dataMs: number;
  /** Total wall time for the whole compose, planning and data together. */
  totalMs: number;
}

/**
 * Validates a visitor-supplied prompt at both ends. The lower bound catches
 * an empty or accidental submit; the upper bound is a cost control — see
 * `MAX_PROMPT_LENGTH`. Throws rather than returning a result because every
 * caller treats a bad prompt as a request-level failure.
 */
function assertPrompt(prompt: unknown): asserts prompt is string {
  if (typeof prompt !== "string" || prompt.trim().length < 3) {
    throw new Error("Prompt must contain at least 3 characters");
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Prompt must be at most ${MAX_PROMPT_LENGTH} characters`);
  }
}

/**
 * Result of `classifyOperations`: the resolved effect classification for
 * every operation in the request, in the same order they were submitted.
 */
export interface ClassifyOperationsResult {
  classifications: ResolvedOperationClassification[];
}

/**
 * Result of `publishReviewedCatalog`. No binding, endpoint, schema,
 * credential, or planner-unsafe detail is included because this response may
 * go to the onboarding browser.
 */
export interface CatalogPublicationSummary {
  ok: true;
  catalogId: string;
  version: string;
  catalogHash: string;
  bindingKind: "openapi" | "graphql";
  publishedAt: string;
  capabilityCount: number;
  executableCapabilityCount: number;
  unboundCapabilities: string[];
  dataTypes: string[];
  /**
   * Whether a UI catalog is registered for this catalog id yet, and which of
   * the data types it produces no registered component can render.
   *
   * Everything here was already computable at publish and only reported at
   * failure: `matchCatalogToComponents` has always known it, and a host had to
   * know to ask `/api/coverage`. The failure mode without it is the one that
   * function's own comment describes — an approved capability the planner
   * silently never selects, and a host who blames their prompt.
   *
   * A publish with no UI catalog yet is legitimate ordering, not a mistake, so
   * `uiCatalogRegistered: false` is reported instead of listing every data type
   * as unrenderable. A list that is noise on day one is ignored by day two.
   */
  uiCatalogRegistered: boolean;
  unrenderableDataTypes: string[];
  /**
   * Size of the planner contract this catalog produces. Resent on every plan
   * attempt, so it is the dominant token cost and, on the measurements so far,
   * plausibly the dominant latency too.
   *
   * `approximateTokens` is bytes/4 and is labelled approximate because it is: an
   * exact count needs the model's tokenizer, which does not belong in this
   * package. The decision it informs — whether approving forty more fields will
   * cost real money — does not need the last 15%.
   */
  contractBytes: number;
  approximateTokens: number;
  /**
   * The same size, attributed: which capabilities cost the most, and what each
   * `supports` facet is worth if dropped.
   *
   * The bare total above was the whole story for a while, and it is the half a
   * host can do nothing with. "415568 bytes" says the catalog is large; it does
   * not say that the filter vocabulary is three quarters of it.
   */
  contractCost: ContractCost;
  /**
   * That cost against the budget, with the levers in measured order when it is
   * over. Always present — a publish that stays quiet about a contract no model
   * will accept is the defect this closes.
   */
  contractBudget: ContractBudgetVerdict;
}

/** One entry of `listPublishedCatalogs`. */
export interface PublishedCatalogSummary {
  catalogId: string;
  version: string;
  catalogHash: string;
  publishedAt: string;
  capabilityCount: number;
  executableCapabilityCount: number;
  bindingKind: "openapi" | "graphql";
}

/** Result of `publishUiCatalog`. */
export interface UiCatalogPublicationSummary {
  ok: true;
  siteId: string;
  /**
   * The capability catalog this UI catalog renders, and the key compose will
   * look it up by. Equals `siteId` unless the publish payload named one.
   */
  catalogId: string;
  version: string;
  registrationFingerprint: string;
  publishedAt: string;
  componentIds: string[];
  surfaceIds: string[];
  /**
   * The mirror of `CatalogPublicationSummary`'s two insight fields, on the path
   * that lacked them.
   *
   * Publishing a capability catalog has always reported whether a UI catalog was
   * registered for it and which of its data types nothing could render.
   * Publishing a UI catalog reported neither, so the most common onboarding
   * mistake was invisible from the side that makes it: a site named
   * `<catalog>-ui` publishes 200 OK, `catalogId` defaults to the site id, and
   * compose then finds nothing. That symptom reads as bad planning, and the
   * cause is a string that never matched.
   *
   * Reported rather than rejected, deliberately, because the capability path
   * already settled that question — a publish whose counterpart does not exist
   * yet is legitimate ordering, not a mistake. The two paths agreeing matters
   * more than either being strict.
   */
  capabilityCatalogRegistered: boolean;
  unrenderableDataTypes: string[];
}

/** One entry of `listPublishedSites`. */
export interface PublishedSiteSummary {
  siteId: string;
  /** The capability catalog id this UI catalog is filed under and found by. */
  catalogId: string;
  version: string;
  registrationFingerprint: string;
  publishedAt: string;
  componentIds: string[];
}

/**
 * Result of `planAgainstPublishedCatalog`. `dataRequests` is the provider's
 * raw draft output (already shape-checked against the catalog by the time a
 * success result is returned, but never re-typed into a narrower structure),
 * so it is honestly `unknown[]` rather than a stronger type this code does
 * not actually enforce.
 */
export type PlanResult =
  | {
      ok: false;
      kind: "invalid";
      issues: Array<{ path: string; message: string }>;
    }
  | {
      ok: true;
      catalogId: string;
      dataRequests: unknown[];
      results: Record<string, ExecutionResult>;
    };

/**
 * Result of `composeAgainstPublishedCatalogs`. `cached` reports only whether
 * the *plan* was reused from `planCache` — the data inside `messages` is
 * fetched fresh on every request either way.
 */
export type ComposeResult =
  | {
      ok: false;
      /**
       * `data-unavailable` is the compose that planned correctly and then
       * delivered nothing, so the visitor is looking at an absence where the
       * answer should be. It travels with `messages`, because that view — the
       * one carrying the per-slot errors or the empty state — is still what
       * should be rendered.
       *
       * Two ways to deliver nothing, and both are here. Every bound slot
       * resolved to `error` is the plain one. The other is every slot returning
       * no rows *from narrowing this server did itself*, over one page of a
       * larger collection: the matching rows may sit entirely in the pages
       * never fetched, so zero is not a finding about anything. An empty result
       * the source produced is the opposite — nothing matched, the whole
       * collection was considered, and that is an answer the visitor is given
       * with `ok: true`.
       *
       * It exists because the envelope used to report `ok: true` over exactly
       * this state. Measured on one production install: six identical prompts, five
       * `ok: true`, three views. A host monitoring the only top-level signal
       * the package publishes recorded 83% success against a reader-visible
       * 50%, and no signal anywhere distinguished the two.
       */
      kind:
        | "unsupported"
        | "invalid"
        | "provider-error"
        | "needs-clarification"
        | "data-unavailable";
      reason: string;
      /**
       * Present when `kind` is `"needs-clarification"`. The planner can answer
       * this prompt in two or more materially different ways and is asking
       * which, rather than guessing and showing something else.
       *
       * Not a failure, though it travels on the failure shape: no plan was
       * produced. A caller that renders `reason` alone still shows the visitor
       * the question, because `reason` is the question.
       */
      question?: string;
      /** Two to four suggested answers, when the question has a closed set. */
      options?: readonly string[];
      issues: DataPlanIssue[];
      /**
       * Set when a failed *revision* fell back to the view the visitor already
       * had. `messages` then render that prior view, and `planId` names it.
       *
       * The planner has always built this fallback — a revision that fails
       * should leave someone on what they were looking at, not on nothing —
       * but the server used to discard it and return only the error, so the
       * documented behaviour never actually happened. A caller should render
       * `messages` and show `reason` alongside, not instead.
       */
      fellBack?: true;
      planId?: string;
      requests?: ComposedRequestSummary[];
      messages?: CompiledSiteSurface[];
    }
  | {
      ok: true;
      catalogId: string;
      cached: boolean;
      /**
       * Set only by `reopenSavedView`, when the saved view replayed against a
       * catalog or component set that has changed since it was saved. The view
       * rendered, but it is not necessarily the view that was saved.
       */
      stale?: true;
      /** Which half drifted. Present whenever `stale` is. */
      staleReason?: string;
      /**
       * Identifies the plan behind this view, and is required by every
       * follow-up: `refineComposedView`, `saveComposedView`, and a
       * `previousPlanId` revision all take it.
       *
       * Returned here because it previously was not. The id existed only
       * inside the `__renderyes` data-model envelope, which is an internal
       * wire detail no host reads — so the entire post-compose lifecycle,
       * though implemented and tested on this server, was unreachable from
       * any client. A caller could not refine a view because it could not
       * name one.
       */
      planId: string;
      /**
       * The plan's data requests, in plan order, with whether each one
       * succeeded.
       *
       * Same gap `planId` had, one level down: `refineComposedView` takes a
       * `requestId`, and that id existed only inside the `__renderyes`
       * data-model envelope — an internal wire detail. A non-React caller could
       * see that a view had refinable data and still not name which request to
       * refine. `capabilityId` and `ok` come along because choosing between
       * several requests needs more than a list of opaque ids, and both are
       * already in hand here.
       */
      requests: ComposedRequestSummary[];
      /**
       * Set when the view rendered but some of it is missing: at least one
       * bound slot delivered and at least one resolved to `error`.
       *
       * Deliberately not collapsed into `ok: false`. A partial view is a real
       * answer — three of four panels carrying data is worth rendering, and
       * telling a host it failed outright would lose the distinction between
       * that and a blank screen. `requests` says which ones, and each carries
       * its own `error`.
       */
      partial?: true;
      /**
       * The whole-request budget this compose ran under, in milliseconds.
       *
       * Reported so a client can derive its own timeout instead of holding a
       * constant. Two independently chosen numbers either side of the wire is
       * what produced a server that kept working — and billing — past the
       * point the browser had stopped listening: a 43s response the server
       * produced successfully was discarded by a client that gave up at 40.
       */
      deadlineMs?: number;
      messages: CompiledSiteSurface[];
      /**
       * Visitor-safe caveats about an operation that applied but could not do
       * everything it looks like it did. Set today by `refineComposedView`
       * when a `setLimit` asks for more rows than one fetch can return here
       * and the set is known to continue: the refine succeeded, the rows on
       * screen did not grow to the limit, and silence would read as "that is
       * all there is". Same rule as the `reason` on failures: constraint
       * sentences, never data.
       */
      notices?: string[];
    };

/** One entry of `ComposeResult.requests`. */
export interface ComposedRequestSummary {
  requestId: string;
  capabilityId: string;
  /** False when the request failed; its slot carries `state: "error"`. */
  ok: boolean;
  /**
   * Why, when `ok` is false. One fixed sentence derived from `errorCode`,
   * never the executor's own message: that one is written for an operator —
   * joined upstream GraphQL errors, validator field names, interpolated
   * params — and this envelope goes to a browser. The exceptions are
   * `TIMEOUT` and `GRAPHQL_TRANSPORT_ERROR`, whose executor messages carry
   * nothing upstream-authored and are forwarded byte-for-byte because hosts
   * match on them. The unredacted message still reaches the host's own
   * logging and the admin-gated probe.
   */
  error?: string;
  /** The executor's failure code, for callers that branch on cause. */
  errorCode?: string;
  /**
   * Whether this request actually put rows in its slot.
   *
   * Separate from `ok`, which says only that execution did not fail. A request
   * that ran cleanly and matched nothing is `ok` and delivers nothing, and
   * counting the two as the same thing is how a view with every slot empty
   * reported success.
   */
  delivered?: boolean;
  /**
   * What this request's slot holds, in the vocabulary the streamed
   * `TOOL_CALL_END` frames already use: `error`, `empty`, or `ready`.
   *
   * The batch envelope never carried it, while `use-compose` reads exactly
   * this field to decide which panel a click can aim `refine` at — so against
   * a real server every panel read `unknown`, and only a fixture that wrote
   * the field by hand made it look otherwise. Derived the same way the
   * streaming path derives it, so a view assembled from frames and the same
   * view assembled from the batch envelope describe their slots identically.
   *
   * `pending` never appears here: a batch envelope is built after every
   * request has settled.
   */
  state?: Exclude<DataRequestState, "pending">;
  /**
   * Set when this request returned no rows *and* the narrowing that produced
   * that ran here, over one fetched page, rather than at the source.
   *
   * The distinction the envelope turns on. An empty result from a filter the
   * database applied is an answer — nothing matched, and the visitor should be
   * told so. An empty result from a filter applied to whatever fifty rows came
   * back is not an answer about anything; the matching rows may sit entirely in
   * the pages never fetched. The two are indistinguishable in the data and are
   * told apart only here.
   */
  emptyUnconfirmed?: boolean;
}

/** One capability's outcome from `probePublishedCatalog`. */
export interface CapabilityProbeEntry {
  capabilityId: string;
  /**
   * `skipped` is for a capability whose input schema requires parameters —
   * there is no honest value to invent for one, and a probe that guesses is
   * measuring its own guess.
   *
   * `degraded` is the case this probe was built for: the capability answers,
   * and some approved field on it does not. The runtime now serves those rows
   * rather than discarding them, which is right for a visitor and would have
   * made the probe report a dead column as `ok`.
   */
  status: "ok" | "degraded" | "failed" | "skipped";
  /** Present when `status` is not `"ok"`. */
  reason?: string;
  /** Rows the probe received, present on a row-shaped success. */
  rowCount?: number;
  /** Approved fields the upstream errored on, present when `degraded`. */
  degradedFields?: string[];
  /**
   * What the upstream did when the same request was repeated with the host's
   * credential withheld. Measured, not declared.
   *
   * `not-required` is the finding worth having: the endpoint answered without
   * the credential, so whatever a reviewer chose in the authentication dropdown,
   * nothing upstream is enforcing it. A catalog records `authentication:
   * "session"` because somebody typed it, and no step between that dropdown and
   * a visitor's screen has ever compared it with reality.
   *
   * `unknown` when the credentialed call already failed — a failure without the
   * credential would then say nothing about access control — or when the
   * binding is OpenAPI, whose headers are fixed at publish.
   */
  upstreamCredential?: "enforced" | "not-required" | "unknown";
  /**
   * Approved fields whose value was null on every sampled row. A resolver
   * that *raises* is already `degraded`; one that quietly answers null looks
   * healthy while every view built on the field renders blanks — measured as
   * three such fields in one schema, each needing an argument the SDL
   * declares optional. Present only when the probe had rows to sample.
   */
  alwaysNullFields?: string[];
  /** Advisory findings, one sentence each. Never a block. */
  warnings?: string[];
}

/**
 * What a server can verify about an install without calling a model.
 *
 * Returned by `describePlanningWiring`, and carried on the refusal a compose
 * gets when no plan provider is configured.
 */
export interface PlanningWiringReport {
  catalogId: string;
  capabilityCatalogPublished: boolean;
  capabilityCount: number;
  uiCatalogPublished: boolean;
  componentIds: string[];
  /** Capabilities whose output no registered component accepts — unreachable by any plan. */
  unrenderableCapabilityIds: string[];
  configuredProviderIds: string[];
  /** Of those, the ones whose API key environment variable is actually set. */
  providersWithCredentials: string[];
}

/**
 * Thrown when a plan-lifecycle call needs a visitor identity the host has not
 * declared.
 *
 * Typed, because a client cannot detect this from a message. Refining, saving,
 * pinning and reopening all require `resolveViewOwner` — a host composing
 * statelessly legitimately has none — and the only signal was a 400 carrying
 * prose. So the browser could not tell "this host does not do saved views"
 * from "that failed", and the chrome exposes `savedViews` as a boolean a host
 * has to remember to set correctly. With a kind on the wire, the chrome can
 * simply stop offering what this host cannot do.
 */
export class VisitorIdentityRequiredError extends Error {
  readonly kind = "visitor-identity-required";
  constructor(readonly action: string) {
    super(
      `ViewServerConfig.resolveViewOwner is required to ${action} a composed plan. ` +
        "Without it there is no identity to check a planId against, so any caller " +
        "holding one could act on another visitor's view. A host that only composes " +
        "statelessly can leave it unset and not offer saved views.",
    );
    this.name = "VisitorIdentityRequiredError";
  }
}

/**
 * Thrown when planning is attempted with no plan provider configured.
 *
 * A refusal at compose time rather than a throw at construction: a host
 * mid-setup — packages installed, catalog published, key not yet exported —
 * should get a server that starts and tells them what is missing, not one that
 * refuses to boot.
 */
export class PlanProviderNotConfiguredError extends Error {
  constructor(readonly wiring: PlanningWiringReport) {
    super(
      "No plan provider is configured, so no plan can be produced. Add one to " +
        "`planProviders` (with its API key in the named environment variable), or pass " +
        "`createProvider` to supply plans yourself. " +
        `Everything else about this install: ${JSON.stringify(wiring)}`,
    );
    this.name = "PlanProviderNotConfiguredError";
  }
}

/** Result of `listCatalogHistory`. */
export interface CatalogHistoryResult {
  ok: true;
  catalogId: string;
  kind: "capability" | "ui";
  /** Newest first. `stamp` is the handle `rollbackPublishedCatalog` takes. */
  snapshots: CatalogSnapshot[];
}

/** Result of `rollbackPublishedCatalog`. */
export interface CatalogRollbackSummary {
  ok: true;
  kind: "capability" | "ui";
  catalogId: string;
  /** The stamp that was republished. */
  restoredFrom: string;
}

/** Result of `deletePublishedCatalog`. */
export interface CatalogDeleteSummary {
  ok: true;
  kind: "capability" | "ui";
  catalogId: string;
  /** Whether the live registry held it. */
  unregistered: boolean;
  /** Whether a stored record was removed, so it will not replay at boot. */
  forgotten: boolean;
  /** Present when neither was true, because `ok: true` alone would mislead. */
  note?: string;
}

/** Result of `probePublishedCatalog`. */
export interface CatalogProbeResult {
  ok: true;
  catalogId: string;
  results: CapabilityProbeEntry[];
}

/** Result of `getCoverageReport`. */
export interface SaveViewResult {
  ok: true;
  viewId: string;
  createdAt: string;
}

/**
 * A saved view as listed back to a visitor. Carries no `plan`: a list is for
 * choosing what to reopen, and shipping every stored plan body to render a
 * menu would leak the full shape of each one for no benefit.
 */
export interface SavedViewSummary {
  id: string;
  catalogId: string;
  surfaceId: string;
  prompt: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * True when the catalog *or* the host's component registrations have changed
   * since this view was saved, so replaying it may behave differently or fail.
   * Surfaced rather than hidden so a host can warn instead of letting a reopen
   * break unexplained.
   *
   * Both halves are checked. Only the catalog hash was, which meant a view
   * whose component had been removed or renamed listed as fresh and then threw
   * on reopen — the least useful place to find out.
   */
  stale: boolean;
}

export interface CoverageReport {
  ok: true;
  catalogId: string;
  coverage: DataTypeCoverage[];
  /**
   * Per-capability narrowing facts, additive to `coverage`. The old report
   * answered only "does some slot accept this type" and called a catalog fully
   * renderable while every filter on it was page-scoped — the caveat existed
   * nowhere an integrator could read before going live.
   */
  filtering: CapabilityFilteringCoverage[];
}

/** One capability's narrowing reach, for `CoverageReport.filtering`. */
export interface CapabilityFilteringCoverage {
  capabilityId: string;
  dataTypeId: string;
  /**
   * Advertised `supports.filterFields`. Every one of them runs post-fetch, on
   * the server, over only the rows one fetch returned — page-scoped by
   * construction; the count is here so "all N advertised filter fields are
   * page-scoped" is computable per capability.
   */
  pageScopedFilterFieldCount: number;
  /** Approved params the source applies over the whole dataset. */
  sourceNarrowingArguments: string[];
  /**
   * True when nothing narrows at the source: every visitor constraint on this
   * capability filters a fetched page and is reported incomplete.
   */
  noSourceNarrowing: boolean;
}

export interface ReviewExportLoadSummary {
  ok: true;
  catalogId: string;
  executableCapabilityCount: number;
  componentIds: string[];
}

export interface SuggestSemanticTypesResult {
  suggestions: import("@renderyes/capability-catalog").SemanticTypeSuggestion[];
  usedLiveModel: boolean;
}

/**
 * Result of `proposeFieldSelection`.
 *
 * Carries proposals and nothing else — deliberately not a field list. A
 * response shaped like "here are the fields to review" would be a model
 * deciding what a host sees during a security review; this one can only mark
 * rows the caller already has.
 */
export interface FieldSelectionProposalResult {
  proposals: import("@renderyes/capability-catalog").FieldSelectionProposal[];
  /** False when no plan provider is configured; the proposals are then empty. */
  usedLiveModel: boolean;
}

export interface ViewServer<Session> {
  classifyOperations(body: unknown): Promise<ClassifyOperationsResult>;
  /**
   * AI-suggested semantic types for curated-review queue rows. Suggestions
   * are advisory: they prefill a reviewer's dropdowns and never touch a
   * catalog. With no live plan provider configured this returns an empty
   * list rather than guessing, so the queue degrades to fully manual.
   */
  suggestSemanticTypes(body: unknown): Promise<SuggestSemanticTypesResult>;
  /**
   * AI-proposed field selection for a capability under review — which of the
   * discovered fields a visitor-facing view would actually use.
   *
   * Advisory in exactly the same way, and for a sharper reason: this proposes
   * what a host approves for visitor access, so a proposal that quietly removed
   * a row would make the review theatre. It marks; the reviewer still sees
   * every field. With no live provider it proposes nothing rather than falling
   * back to name patterns.
   */
  proposeFieldSelection(body: unknown): Promise<FieldSelectionProposalResult>;
  /**
   * Loads a versioned review export — the capability catalog, its server
   * bindings, and the matching UI catalog — in one call. Pre-checks the
   * format version and the endpoint against allowedUpstreamOrigins before
   * publishing anything, so a misconfigured host gets an actionable
   * checklist instead of a mysterious failure at compose time.
   *
   * Async for the same reason as `publishReviewedCatalog`: it publishes
   * through both registries, and a configured `catalogStore` is written
   * before either resolves.
   */
  loadReviewExport(body: unknown): Promise<ReviewExportLoadSummary>;
  /** Prior publishes of one catalog, newest first. Needs a store that retains them. */
  listCatalogHistory(body: unknown): Promise<CatalogHistoryResult>;
  /**
   * Republishes a retained snapshot through the ordinary publish path, so a
   * rollback is itself retained and reversible by rolling forward.
   */
  rollbackPublishedCatalog(body: unknown): Promise<CatalogRollbackSummary>;
  /**
   * Unpublishes a catalog — out of the live registry and out of the store, so
   * it does not replay at the next boot. Retained snapshots survive, which is
   * what makes a mistaken delete recoverable.
   */
  deletePublishedCatalog(body: unknown): Promise<CatalogDeleteSummary>;
  /**
   * Executes every published capability once, minimally, and reports which
   * ones the upstream actually answers.
   *
   * Exists because a schema can lie: Saleor declares `ProductVariant.revenue`'s
   * `period` argument optional and its resolver requires it, so the field
   * passes discovery, passes approval, publishes cleanly — and then every
   * product row errors in front of a visitor. No static analysis catches a
   * resolver contradicting its own SDL; one cheap execution per capability
   * does, at the moment the host can still act on it.
   */
  probePublishedCatalog(body: unknown): Promise<CatalogProbeResult>;
  /**
   * Async because a configured `catalogStore` is written before this resolves.
   * With no store the work is still synchronous; the signature does not change
   * with configuration, so a host writes one call either way.
   */
  publishReviewedCatalog(body: unknown): Promise<CatalogPublicationSummary>;
  listPublishedCatalogs(): PublishedCatalogSummary[];
  publishUiCatalog(body: unknown): Promise<UiCatalogPublicationSummary>;
  /**
   * Replays stored publishes into the registries. Resolves to a no-op summary
   * when no `catalogStore` is configured, so a host can call it unconditionally.
   *
   * Not routed over HTTP, and named in `LIBRARY_ONLY_METHODS` to say so: this is
   * a boot step, and exposing it would let a caller re-run every publish on a
   * running server.
   *
   * It cannot happen inside `createViewServer` because a store's `list` is async
   * and the factory is not. Making the factory async would be the tidier API and
   * a breaking change for every existing caller, for one `await` a host writes
   * once — so instead, forgetting this call is diagnosed: see the message in
   * `requirePublishedCatalog`.
   */
  restorePublishedCatalogs(): Promise<RestoreSummary>;
  listPublishedSites(): PublishedSiteSummary[];
  /**
   * Reports each configured provider's id and model, and whether its
   * `apiKeyEnv` is currently set — never the key. A host's own `/api/providers`
   * route (or equivalent) is normally just this, returned as JSON.
   */
  listPlanProviders(): Array<{ id: string; model: string; available: boolean }>;
  planAgainstPublishedCatalog(input: {
    catalogId: string;
    prompt: string;
    request: unknown;
    /**
     * Selects among `config.planProviders` by id, defaulting to the first
     * entry. An id naming nothing configured throws, as does planning with no
     * `planProviders` at all — there is no fallback provider.
     */
    providerId?: string;
    /** Escape hatch: bypasses `planProviders` and `providerId` entirely. Mainly for tests. */
    createProvider?: (
      provider: { id: string },
      fallback: () => PlanProvider,
    ) => PlanProvider;
  }): Promise<PlanResult>;
  composeAgainstPublishedCatalogs(input: {
    catalogId: string;
    surfaceId?: string;
    prompt: string;
    request: unknown;
    providerId?: string;
    createProvider?: (
      provider: { id: string },
      fallback: () => PlanProvider,
    ) => PlanProvider;
    /**
     * Must match the caller's `ViewProvider` config `uiCatalogId` exactly, or
     * the client's local A2UI `Catalog` and the emitted `createSurface`
     * message name different catalogs and binding silently fails. Defaults to
     * the same `${catalogId}:ui` convention the client falls back to.
     */
    uiCatalogId?: string;
    /**
     * Revises an existing composed view instead of starting fresh. The prompt
     * is then read as a change to what is already on screen ("drop the chart",
     * "only open tickets") rather than as a standalone request, which is what
     * makes a second turn feel like a conversation rather than a reset.
     */
    previousPlanId?: string;
    /**
     * Observes the compose as it runs. Changes nothing about what the compose
     * does or returns — a transport that streams folds these events into a
     * wire format, one that does not omits the callback.
     */
    onEvent?: (event: ComposeEvent) => void;
    /** Correlates every event of one run; supplied by the transport. */
    runId?: string;
  }): Promise<ComposeResult>;
  getCoverageReport(catalogId: string): CoverageReport;
  /**
   * Everything this server can verify about an install without calling a
   * model — published catalogs, capability/component pairing, which configured
   * providers hold credentials.
   *
   * None of it can be mistaken for an answer to a prompt.
   */
  describePlanningWiring(catalogId: string): PlanningWiringReport;
  /**
   * Persists the plan behind an already-composed view so the visitor can
   * return to it. Takes a `planId` from a prior compose rather than a plan
   * body, so a caller cannot save a plan the server never validated.
   *
   * `nodeIds` turns the save into a *pin*: the stored plan is sliced
   * server-side down to the named top-level nodes (with their slot children)
   * and only the data requests, joins, and compositions those nodes reference
   * — see `slicePlanToNodes`. The slice is re-validated with the same pass a
   * composed plan gets before it is stored. The caller still sends only ids;
   * an unknown nodeId is rejected. Omitted, the whole plan is saved exactly as
   * before.
   */
  saveComposedView(input: {
    catalogId: string;
    planId: string;
    label?: string;
    nodeIds?: readonly string[];
    request: unknown;
  }): Promise<SaveViewResult>;
  /**
   * Re-executes a saved plan against current data and returns fresh A2UI
   * messages. Reopening is a replay, not a snapshot restore.
   */
  reopenSavedView(input: { viewId: string; request: unknown }): Promise<ComposeResult>;
  listSavedViews(input: { request: unknown }): Promise<SavedViewSummary[]>;
  deleteSavedView(input: { viewId: string; request: unknown }): Promise<{ ok: boolean }>;
  /**
   * Applies deterministic edits — sort, filter, limit, remove, reorder — to an
   * already-composed plan and re-renders it, with no model call. This is what
   * makes ordinary interface interactions instant instead of costing a
   * multi-second composition each.
   */
  refineComposedView(input: {
    catalogId: string;
    planId: string;
    operations: readonly RefineOperation[];
    request: unknown;
  }): Promise<ComposeResult>;
}

/**
 * A compose the host's `allowCompose` gate declined.
 *
 * Its own class so the HTTP handler can answer 429 instead of the generic
 * 400 every other rejection gets — a rate limit is the one refusal a client
 * is supposed to retry, and a status that says "your request was wrong"
 * teaches it not to. The message is visitor-safe.
 */
export class ComposeRateLimitedError extends Error {
  constructor(message = "Too many requests right now. Try again in a moment.") {
    super(message);
    this.name = "ComposeRateLimitedError";
  }
}

/**
 * Codes whose executor-written message is itself derived from the code — a
 * fixed sentence, or a sentence plus an HTTP status — with nothing in it an
 * upstream authored. Forwarded unchanged because deployed hosts match on
 * these exact strings.
 */
const FORWARDED_ERROR_CODES = new Set(["TIMEOUT", "GRAPHQL_TRANSPORT_ERROR"]);

/**
 * The one sentence per failure code a visitor's envelope may carry. Every
 * message here is derived from the code alone: the executor's own message is
 * written for an operator — joined upstream GraphQL errors and paths,
 * validator field and type names, the params of a null result — and this
 * envelope, its `reason`, and the streamed frames all serialize straight to
 * the browser. The operator's copy keeps flowing untouched to the host's own
 * logging and the admin-gated probe; only the code crosses this seam.
 */
const VISITOR_ERROR_BY_CODE: Record<string, string> = {
  AUTHENTICATION_REQUIRED: "Sign in to see this data.",
  MISSING_IDENTITY: "Sign in to see this data.",
  PERMISSION_DENIED: "You do not have access to this data.",
  RATE_LIMITED: "The data source is receiving too many requests. Try again shortly.",
  ABORTED: "The data request was cancelled.",
  INVALID_QUERY: "The data request was not valid.",
  INVALID_PARAMS: "The data request was not valid.",
  GRAPHQL_REQUEST_REJECTED: "The data request was not valid.",
  GRAPHQL_NULL_RESULT: "No matching data was found.",
};

/** A code the map does not know — a missing one included — says no more than this. */
const DEFAULT_VISITOR_ERROR = "The data request failed.";

function visitorRequestError(error: { code?: string; message: string }): string {
  if (typeof error.code === "string" && FORWARDED_ERROR_CODES.has(error.code)) {
    return error.message;
  }
  return (
    (typeof error.code === "string" ? VISITOR_ERROR_BY_CODE[error.code] : undefined) ??
    DEFAULT_VISITOR_ERROR
  );
}

/**
 * What each planned request delivered, and what the envelope may claim.
 *
 * At module scope so the rule can be tested on its own. It decides whether a
 * view reports success, and it was wrong in a way no test could reach from
 * outside: `ok` meant "did not throw", so a view whose every slot executed
 * cleanly and returned nothing reported success with no partial flag.
 */
export function summarizeRequests(
  plan: { dataRequests?: ReadonlyArray<{ requestId: string; capabilityId: string }> },
  executed: {
    results: Record<
      string,
      {
        ok: boolean;
        error?: { code: string; message: string };
        data?: unknown;
        provenance?: { narrowedAfterFetch?: boolean };
      }
    >;
  },
): ComposedRequestSummary[] {
  return (plan.dataRequests ?? []).map((request) => {
    const result = executed.results[request.requestId];
    // Rows, or a value: a scalar capability delivering `0` or `false` has
    // delivered. Only an empty collection, or nothing at all, has not.
    const delivered =
      result?.ok === true &&
      result.data !== undefined &&
      result.data !== null &&
      (!Array.isArray(result.data) || result.data.length > 0);
    return {
      requestId: request.requestId,
      capabilityId: request.capabilityId,
      ok: result?.ok ?? false,
      // Same derivation as the streamed frames': a failure is `error`, no rows
      // is `empty`, rows are `ready`. Both paths describing a slot the same way
      // is the point — a client should not have to know which one produced the
      // view it is looking at.
      state: result?.ok !== true ? "error" : delivered ? "ready" : "empty",
      ...(result?.ok === true ? { delivered } : {}),
      ...(result?.ok === true &&
      !delivered &&
      result.provenance?.narrowedAfterFetch === true
        ? { emptyUnconfirmed: true }
        : {}),
      // Through the redactor, never the executor's own message: that one is
      // written for an operator — joined upstream errors, validator paths — and
      // this envelope goes to a browser.
      ...(result?.ok === false && result.error
        ? { error: visitorRequestError(result.error), errorCode: result.error.code }
        : {}),
    };
  });
}

export function deliveryOf(
  requests: readonly ComposedRequestSummary[],
): "all" | "partial" | "none" {
  if (requests.length === 0) return "all";
  // Counted on rows, not on the absence of an error. This used to count any
  // request that did not fail, so a view whose every slot executed cleanly
  // and returned nothing reported `ok: true` with no partial flag — a
  // complete-looking answer holding no data, against a documented contract
  // that says `ok: false, kind: "data-unavailable"`.
  //
  // A clean empty result is still delivery when the narrowing that produced
  // it happened at the source: nothing matched, and that is an answer the
  // visitor should be given rather than an error. Only an empty produced by
  // narrowing one fetched page is withheld — see `emptyUnconfirmed`.
  // `emptyUnconfirmed` is only ever set on a request that succeeded and
  // returned nothing, so this reads as: succeeded, and not an empty nobody
  // can vouch for.
  const delivered = requests.filter(
    (request) => request.ok && !request.emptyUnconfirmed,
  ).length;
  if (delivered === 0) return "none";
  return delivered === requests.length ? "all" : "partial";
}

export function firstRequestError(requests: readonly ComposedRequestSummary[]): string {
  const explained = requests.find((request) => !request.ok && request.error);
  if (explained?.error) return explained.error;
  // Nothing failed, and nothing was delivered: every request narrowed here,
  // over one page, and matched none of it. Said plainly rather than as a load
  // failure, because the data may well exist — this view cannot tell, and
  // presenting "no results" would answer a question nobody could check.
  if (requests.length > 0 && requests.every((request) => request.emptyUnconfirmed)) {
    return (
      "No rows matched, but the matching was done here over one page of each " +
      "collection rather than by the source, so this cannot be reported as an " +
      "answer. Approve a filter argument on these capabilities, or narrow the ask."
    );
  }
  return "The approved data for this view could not be loaded.";
}

/**
 * Every option this factory takes, so one it does not can be refused by name.
 *
 * Types do not reach here. The mount `init` scaffolds is `server.mjs` — plain
 * JavaScript — so a key that belongs somewhere else was accepted and dropped in
 * silence. `onEvent` is the one that costs the most: it is an option of
 * `compose()`, wired per call, and passing it here produced no events and no
 * complaint, which reads exactly like a hook that does not work.
 */
const VIEW_SERVER_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "host",
  "resolveSession",
  "graphql",
  "operationClassifier",
  "operationClassificationCache",
  "planCache",
  "planProviders",
  "onComposeMetrics",
  "allowCompose",
  "onModelCall",
  "captureModelPrompts",
  "planDeadlineMs",
  "composeDeadlineMs",
  "contractTokenBudget",
  "contractTokenCeiling",
  "upstreamCredentials",
  "allowedUpstreamOrigins",
  "viewStore",
  "resolveViewOwner",
  "formatVisitorError",
  "catalogStore",
]);

/** Options that belong on a `compose()` call, named so the error can say so. */
const COMPOSE_CALL_OPTIONS: ReadonlySet<string> = new Set([
  "onEvent",
  "runId",
  "previousPlanId",
  "uiCatalogId",
  "providerId",
]);

export function createViewServer<Session>(
  config: ViewServerConfig<Session>,
): ViewServer<Session> {
  const unknownKeys = Object.keys(config ?? {}).filter(
    (key) => !VIEW_SERVER_CONFIG_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    const perCall = unknownKeys.filter((key) => COMPOSE_CALL_OPTIONS.has(key));
    throw new Error(
      `createViewServer received ${unknownKeys.length === 1 ? "an option" : "options"} it ` +
        `does not take: ${unknownKeys.map((key) => `"${key}"`).join(", ")}.` +
        (perCall.length > 0
          ? ` ${perCall.map((key) => `"${key}"`).join(", ")} ${
              perCall.length === 1 ? "is an option" : "are options"
            } of \`compose()\`, supplied per call — ` +
            `\`server.compose({ catalogId, prompt, ${perCall[0]} })\` — not of this factory.`
          : "") +
        ` Configuring one that does nothing is indistinguishable from one that does not work.`,
    );
  }
  const store = createCapabilityCatalogStore();
  const uiStore = createSiteCatalogStore();

  /**
   * Whether anything has published or replayed into the registries yet.
   *
   * Exists only to make one specific mistake diagnosable. A host that configures
   * `catalogStore` but never calls `restorePublishedCatalogs()` gets empty
   * registries after every restart, and the symptom is `No capability catalog
   * "x" has been published` — which is true, and points at publishing rather
   * than at the missing boot step. Since the boot step cannot be made automatic
   * (see `restorePublishedCatalogs`), it is at least made to name itself.
   */
  let restoreAttempted = false;

  /**
   * The message for a catalog that is not in the registry, with the cause named
   * when it can be inferred.
   */
  function unpublishedCatalogMessage(
    catalogId: string,
    kind: "capability" | "UI",
  ): string {
    const base = `No ${kind} catalog "${catalogId}" has been published.`;
    if (config.catalogStore && !restoreAttempted) {
      return (
        `${base} A catalogStore is configured but restorePublishedCatalogs() has not been ` +
        `called, so nothing stored on a previous run has been replayed. Await it once at boot, ` +
        `before serving requests.`
      );
    }
    // A UI catalog is filed under the capability catalog it declares, and a host
    // who publishes without declaring one gets the site id as the default. If
    // that default is wrong the catalog is registered under a name nothing looks
    // up, and this sentence reads as "you forgot to publish" while the thing is
    // plainly published. Showing what is registered, under which key, is what
    // turns that into a one-line diagnosis.
    if (kind === "UI") {
      const published = uiStore.list();
      if (published.length > 0) {
        return (
          `${base} A UI catalog is found by the capability catalog id it declares. ` +
          `Published: ${published
            .map((entry) =>
              entry.catalogId === entry.siteId
                ? `"${entry.catalogId}"`
                : `"${entry.catalogId}" (site "${entry.siteId}")`,
            )
            .join(
              ", ",
            )}. Pass catalogId: "${catalogId}" when publishing the UI catalog ` +
          `if its site is named something else.`
        );
      }
    }
    return base;
  }

  /**
   * What a non-admin caller is told when the catalog it addressed cannot be
   * served. One fixed sentence, byte-identical for an id that never existed
   * and one that exists unpublished, naming no other catalog or site: compose
   * answers before any credential is resolved, so anything variable here is
   * an unauthenticated oracle over which ids this server knows. The detailed
   * diagnosis — the restore-at-boot hint, what is registered under which key
   * — stays on the admin-gated routes and goes to the server's own log below,
   * where the person it helps can actually read it.
   */
  function catalogUnavailableError(catalogId: string, kind: "capability" | "UI"): Error {
    console.error(`[renderyes] ${unpublishedCatalogMessage(catalogId, kind)}`);
    return new Error("This catalog is not available.");
  }

  /**
   * `compilePlanDataSurfaceMessages` clones each failed result's error into
   * the data model's `__renderyes` request envelopes, and the data model is
   * serialized to the browser — in the batch response and in the streamed
   * STATE frames alike. So every result set a projection sees goes through
   * here first: the message becomes the sentence its code derives, the code
   * and retryability survive for clients that branch on them, and the
   * unredacted original stays on the executed data for the host's own
   * logging. Compositions and joins are left alone — their failure messages
   * are written by this runtime from catalog vocabulary, never by an
   * upstream.
   */
  function redactExecutedResults<
    T extends { results: Record<string, ExecutionResult> },
  >(executed: T): T {
    let changed = false;
    const results: Record<string, ExecutionResult> = {};
    for (const [requestId, result] of Object.entries(executed.results)) {
      const safeMessage = result.ok ? undefined : visitorRequestError(result.error);
      if (result.ok || result.error.message === safeMessage) {
        results[requestId] = result;
        continue;
      }
      changed = true;
      results[requestId] = {
        ...result,
        error: { ...result.error, message: safeMessage as string },
      };
    }
    return changed ? { ...executed, results } : executed;
  }


  /**
   * Plans this server composed recently, so `saveComposedView` can take a
   * `planId` instead of a plan body — the caller can only ever save something
   * already validated here.
   *
   * Bounded and process-local on purpose. It is a short-lived handoff between
   * "composed" and "saved", not storage: a visitor who waits past the eviction
   * window simply recomposes. Making it durable would mean persisting every
   * plan anyone ever composed in order to support the few that get saved.
   */
  const recentPlans = new Map<
    string,
    {
      plan: PlanV3_1;
      catalogId: string;
      surfaceId: string;
      prompt: string;
      catalogHash: string;
      /**
       * Who composed this plan, when the host declared `resolveViewOwner`.
       *
       * Every lookup by `planId` is an authorization decision: an entry
       * carries the visitor's own `prompt`, so handing it to another visitor
       * leaks what they asked, and letting them save or refine it lets them
       * act on a plan that was never theirs. `planId` is a v4 UUID and so not
       * guessable, but an authorization check that depends on an identifier
       * staying secret is not an authorization check — it is the classic
       * insecure-direct-object-reference shape, one leaked log line from
       * being real.
       *
       * Undefined only for an entry remembered before the host declared a
       * resolver. `requireOwnedPlan` treats that as a refusal, not as a pass.
       */
      ownerKey?: string;
      /**
       * The A2UI catalog this plan was composed against.
       *
       * Stored rather than re-derived, because a refinement or a reopen that
       * recomputes `${catalogId}:ui` names a different catalog than the one the
       * client registered under whenever the host overrode `uiCatalogId` — and
       * component binding then resolves nothing, silently. Reading it from here
       * also keeps it out of the caller's hands: a plan composed against one UI
       * catalog has no business being refined against another.
       */
      uiCatalogId: string;
    }
  >();
  const MAX_RECENT_PLANS = 200;

  /**
   * Spread into every surface projection so a host's visitor-facing wording is
   * applied on compose, refine, reopen and the streamed path alike. Omitted from
   * config, each projection falls back to the library's fixed safe sentence.
   */
  const visitorErrorOption = config.formatVisitorError
    ? { formatVisitorError: config.formatVisitorError }
    : {};

  function rememberPlan(entry: {
    plan: PlanV3_1;
    catalogId: string;
    surfaceId: string;
    prompt: string;
    catalogHash: string;
    ownerKey?: string;
    uiCatalogId: string;
  }) {
    if (recentPlans.size >= MAX_RECENT_PLANS) {
      const oldest = recentPlans.keys().next();
      if (!oldest.done) recentPlans.delete(oldest.value);
    }
    recentPlans.set(entry.plan.planId, entry);
  }

  /**
   * Looks up a remembered plan and refuses it to anyone but the visitor who
   * composed it.
   *
   * Returns the same "no such plan" error for a wrong owner as for a missing
   * entry, deliberately: distinguishing them would turn this into an oracle
   * that confirms another visitor's `planId` exists.
   */
  function requireOwnedPlan(
    planId: string,
    catalogId: string,
    session: Session,
    action: string,
  ) {
    // Absence is a refusal, not a pass. The comparison used to apply only when
    // both sides carried a key, so a host that declared no resolver got a check
    // that matched everyone — holding any planId was enough to refine or save
    // another visitor's view, which is the shape the comment above warns about.
    // Required here rather than in the config type: a host doing stateless
    // compose only never needs an owner, and the requirement should appear when
    // the feature that depends on it is used.
    if (!config.resolveViewOwner) {
      throw new VisitorIdentityRequiredError(action);
    }
    const remembered = recentPlans.get(planId);
    const ownerKey = config.resolveViewOwner(session);
    // `undefined !== ownerKey` for an entry remembered before the resolver
    // existed, so those are refused too rather than being open to everyone.
    const mismatched = remembered?.ownerKey !== ownerKey;
    if (!remembered || remembered.catalogId !== catalogId || mismatched) {
      throw new Error(
        `No recently composed plan "${planId}" for catalog "${catalogId}" to ${action}.`,
      );
    }
    return remembered;
  }
  const executionContext = new AsyncLocalStorage<{
    request: unknown;
    session: Session;
    /**
     * Runs this request without the host's upstream credential.
     *
     * Set only by `probePublishedCatalog`, and only for its second pass. A
     * catalog records `authentication: "session"` because someone typed it into
     * the review form, and nothing has ever checked it against the upstream —
     * so a host can believe their API key is what stands between a visitor and
     * their orders while the endpoint answers anybody. This is how that belief
     * gets tested: ask the same question with the credential withheld and see
     * whether the data comes back.
     */
    withoutUpstreamCredential?: boolean;
  }>();
  const operationClassificationCache =
    config.operationClassificationCache ?? new MemoryOperationClassificationCache();

  function listPlanProviders() {
    return (config.planProviders ?? []).map((provider) =>
      isScriptedProvider(provider)
        ? // Named as what it is. A scripted provider reported as an available
          // model is the mock's own failure mode rebuilt one level up.
          { id: provider.id, model: "scripted", available: provider.plans.length > 0 }
        : {
            id: provider.id,
            model: provider.model,
            available: Boolean(process.env[provider.apiKeyEnv]),
          },
    );
  }

  // One `PlanProvider` instance per configured id, built once and reused for
  // the life of this server. `createModelPlanProvider` gives each instance its
  // own schema-fallback memory (see providers.ts) — building a fresh instance
  // per call, as an earlier version of this function did, would silently
  // reset that memory every request and re-pay for a rejected structured
  // schema on every single call instead of once per provider.
  const modelProviders = new Map<string, PlanProvider>(
    (config.planProviders ?? []).map((provider) => [
      provider.id,
      isScriptedProvider(provider)
        ? createScriptedPlanProvider(provider)
        : createModelPlanProvider(provider),
    ]),
  );

  /**
   * Wraps a provider so every call it makes is observed.
   *
   * Applied at `resolvePlanProvider`'s single exit rather than inside the
   * built-in adapters, because that is the one point every path passes
   * through — the configured OpenAI/Gemini providers, a scripted provider,
   * and a provider a host builds itself with `createProvider`. Instrumenting
   * the adapters would have traced only the calls we happen to own.
   *
   * The observer never sees a credential: it is handed the resolved prompts
   * and usage, never the provider config.
   */
  function observeProvider(
    provider: PlanProvider,
    context: { traceId: string; catalogId?: string; attemptRef: { value: number } },
  ): PlanProvider {
    if (!config.onModelCall) return provider;
    return {
      id: provider.id,
      async generatePlan(request) {
        const startedAt = Date.now();
        const attempt = context.attemptRef.value;
        try {
          const result = await provider.generatePlan(request);
          emitModelCall({
            operation: "plan",
            traceId: context.traceId,
            providerId: provider.id,
            modelId: result.modelId,
            attempt,
            startedAt,
            durationMs: Date.now() - startedAt,
            outcome: "ok",
            ...(result.usage?.inputTokens !== undefined
              ? { inputTokens: result.usage.inputTokens }
              : {}),
            ...(result.usage?.outputTokens !== undefined
              ? { outputTokens: result.usage.outputTokens }
              : {}),
            ...(result.usage?.calls !== undefined
              ? { httpCalls: result.usage.calls }
              : {}),
            ...(context.catalogId ? { catalogId: context.catalogId } : {}),
            ...(config.captureModelPrompts
              ? {
                  systemPrompt: request.systemPrompt,
                  userPrompt: request.userPrompt,
                  completion: safeCompletionText(result.value),
                }
              : {}),
          });
          return result;
        } catch (cause) {
          emitModelCall({
            operation: "plan",
            traceId: context.traceId,
            providerId: provider.id,
            attempt,
            startedAt,
            durationMs: Date.now() - startedAt,
            outcome: "error",
            // Reuses the provider diagnostic redaction rather than the raw
            // message: some providers echo part of the failing request back,
            // and this string is on its way to a third-party backend.
            error: providerDiagnostic(cause),
            ...(context.catalogId ? { catalogId: context.catalogId } : {}),
            ...(config.captureModelPrompts
              ? { systemPrompt: request.systemPrompt, userPrompt: request.userPrompt }
              : {}),
          });
          throw cause;
        }
      },
    };
  }

  /** Emits without ever letting a tracing failure break a request. */
  function emitModelCall(event: ModelCallEvent) {
    try {
      config.onModelCall?.(event);
    } catch (cause) {
      console.error(`[compose:trace] observer threw: ${String(cause)}`);
    }
  }

  /**
   * Resolves which `PlanProvider` a compose/plan call actually uses.
   *
   * `createProvider` is an escape hatch that bypasses `planProviders`
   * entirely — tests use it for scripted providers, and an advanced host could
   * use it for per-tenant routing. Everyone else names a `providerId` or takes
   * the default, which is the first configured provider. With none configured
   * there is nothing to fall back to, so this throws
   * `PlanProviderNotConfiguredError`.
   */
  function resolvePlanProvider(
    providerId: string | undefined,
    createProvider:
      | ((provider: { id: string }, fallback: () => PlanProvider) => PlanProvider)
      | undefined,
    catalogId: string,
  ): PlanProvider {
    if (createProvider) {
      // The scripted-provider seam: a caller supplying its own plans is the
      // supported way to exercise this pipeline without a model. It gets no
      // fallback to fall back to, because there is no longer one to give.
      return createProvider({ id: providerId ?? "scripted" }, () => {
        throw new PlanProviderNotConfiguredError(describeWiring(catalogId));
      });
    }
    if (providerId) {
      const selected = modelProviders.get(providerId);
      if (!selected) {
        throw new Error(`No plan provider configured with id "${providerId}"`);
      }
      return selected;
    }
    const first = config.planProviders?.[0];
    if (!first) throw new PlanProviderNotConfiguredError(describeWiring(catalogId));
    return modelProviders.get(first.id)!;
  }

  /**
   * What is wired up, for a host who has just been told planning is not.
   *
   * This replaces the offline mock, and is the argument for removing it: the
   * mock returned the first approved capability with empty params and no
   * reading of the prompt, rendered through a real component, and nothing in
   * the response said so. A host evaluating without an API key — the
   * documented zero-config path — saw plausible domain data in a working view
   * and concluded the wiring was correct. Measured on one production install: a
   * request for the newest items in one section returned the unfiltered first
   * page of the whole archive, and looked right because the data happened to
   * open on that section.
   *
   * Everything below is a fact this server can check without a model, and
   * together they verify strictly more of an install than the mock ever did —
   * while being impossible to mistake for an answer.
   */
  /**
   * Runs data execution under a wall-clock ceiling measured from `startedAt`.
   *
   * Every path that fetches — compose, refine, reopen — draws from one budget,
   * because "nothing caps the request" was never specific to compose. The
   * signal reaches each upstream call, so an expired budget cancels work in
   * flight rather than waiting for it and discarding the result.
   */
  async function executeWithinBudget<T>(
    startedAt: number,
    budgetMs: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Request exceeded its ${budgetMs}ms budget.`)),
      Math.max(budgetMs - (Date.now() - startedAt), 0),
    );
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  function describeWiring(catalogId: string): PlanningWiringReport {
    const registered = store.get(catalogId);
    const ui = uiStore.get(catalogId);
    // The pairing that decides whether a prompt is answerable at all: a
    // capability no component accepts is invisible to a planner, and reported
    // by the same function `/api/coverage` already answers with, rather than
    // by a second opinion computed here.
    const coverage =
      registered && ui
        ? matchCatalogToComponents(registered.plannerManifest, ui.site)
        : [];
    return {
      catalogId,
      capabilityCatalogPublished: Boolean(registered),
      capabilityCount: registered?.plannerManifest.capabilities.length ?? 0,
      uiCatalogPublished: Boolean(ui),
      componentIds: ui?.site.components.map((component) => component.id) ?? [],
      unrenderableCapabilityIds: coverage
        .filter((entry) => entry.unrenderable)
        .flatMap((entry) => entry.producedByCapabilityIds),
      configuredProviderIds: (config.planProviders ?? []).map((provider) => provider.id),
      // Which of them could actually make a call. The distinction matters
      // here: a configured provider whose key is unset is the single most
      // likely reason someone is reading this report.
      providersWithCredentials: (config.planProviders ?? [])
        .filter((provider) =>
          isScriptedProvider(provider)
            ? provider.plans.length > 0
            : Boolean(process.env[provider.apiKeyEnv]),
        )
        .map((provider) => provider.id),
    };
  }

  async function classifyOperations(body: unknown) {
    const payload = assertRecord(body, "Operation classification request");
    if (!Array.isArray(payload.operations)) {
      throw new Error("Operation classification request.operations must be an array");
    }
    const classifications = await classifyOperationEffects({
      operations: payload.operations as never[],
      ...(config.operationClassifier ? { classifier: config.operationClassifier } : {}),
      cache: operationClassificationCache,
    });
    return { classifications };
  }

  async function suggestSemanticTypes(body: unknown) {
    const payload = assertRecord(body, "Semantic suggestion request");
    if (!Array.isArray(payload.fields)) {
      throw new Error("Semantic suggestion request.fields must be an array");
    }
    const live = (config.planProviders ?? [])[0];
    const provider = live ? modelProviders.get(live.id) : undefined;
    if (!provider) return { suggestions: [], usedLiveModel: false };
    const suggestions = await suggestFieldSemanticTypes({
      fields: payload.fields as never[],
      provider: {
        generateClassification: (request) => provider.generatePlan(request),
      },
    });
    return { suggestions, usedLiveModel: true };
  }

  /**
   * Proposes which discovered fields a visitor-facing view would use.
   *
   * Same trust rule and same degradation as the semantic suggestions above:
   * with no live provider this returns nothing rather than falling back to
   * name patterns. A pattern list would be a guess about one schema's naming
   * conventions, and it is wrong in a way nobody can see — it looks like it
   * works on the API it was written against.
   */
  async function proposeFieldSelection(
    body: unknown,
  ): Promise<FieldSelectionProposalResult> {
    const payload = assertRecord(body, "Field selection request");
    if (!Array.isArray(payload.fields)) {
      throw new Error("Field selection request.fields must be an array");
    }
    const capability = assertRecord(payload.capability, "Field selection capability");
    const live = (config.planProviders ?? [])[0];
    const provider = live ? modelProviders.get(live.id) : undefined;
    if (!provider) return { proposals: [], usedLiveModel: false };
    const proposals = await proposeApprovedFields({
      capability: capability as never,
      fields: payload.fields as never[],
      provider: {
        generateClassification: (request) => provider.generatePlan(request),
      },
    });
    return { proposals, usedLiveModel: true };
  }

  async function loadReviewExport(body: unknown): Promise<ReviewExportLoadSummary> {
    const parsed = ReviewExportEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        `Review export rejected: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .slice(0, 3)
          .join("; ")}`,
      );
    }
    const bundle = parsed.data;
    if (bundle.formatVersion > REVIEW_EXPORT_VERSION) {
      throw new Error(
        `Review export format v${bundle.formatVersion} is newer than this server understands (v${REVIEW_EXPORT_VERSION}). Update @renderyes/server before loading it.`,
      );
    }
    // Check the declared requirements before publishing anything, so a
    // failure here leaves the server unchanged and tells the host exactly
    // what to configure.
    const allowed = new Set(
      (config.allowedUpstreamOrigins ?? []).flatMap((candidate) => {
        try {
          return [new URL(candidate).origin];
        } catch {
          return [];
        }
      }),
    );
    const missing = bundle.requirements.upstreamOrigins.filter((origin) => {
      try {
        return !allowed.has(new URL(origin).origin);
      } catch {
        return true;
      }
    });
    if (missing.length > 0) {
      throw new Error(
        `Review export for "${bundle.catalogId}" needs upstream origins this server has not allowed: ${missing.join(", ")}. Add them to allowedUpstreamOrigins and retry; nothing was published.`,
      );
    }
    const capability = await publishReviewedCatalog({
      bindingKind: bundle.bindingKind,
      catalog: bundle.capability.catalog,
      bindings: bundle.capability.bindings,
      schema: bundle.capability.schema,
      endpoint: bundle.capability.endpoint,
      ...(bundle.capability.credentialId
        ? { credentialId: bundle.capability.credentialId }
        : {}),
    });
    // Capability first, then UI. Both half-published states fail closed at
    // compose — one reports a missing UI catalog, the other a missing
    // capability catalog — so neither renders anything wrong, and the order is
    // not load-bearing. (It was previously justified by the opposite claim:
    // that capability-first leaves the inert half. It leaves data without UI,
    // which is the half that same sentence called breaking.)
    //
    // `catalogId` is forwarded, not defaulted. Without it the UI catalog is
    // filed under whatever `site.id` the bundle carries, which is exactly the
    // misfiling the parameter exists to prevent — a bundle whose site is named
    // `<catalog>-ui` publishes successfully and fails at compose. The review UI
    // happens to set both to the same string, so this was latent for bundles it
    // produced and live for hand-built ones.
    const ui = await publishUiCatalog({
      manifest: bundle.ui.manifest,
      catalogId: capability.catalogId,
    });
    return {
      ok: true,
      catalogId: capability.catalogId,
      executableCapabilityCount: capability.executableCapabilityCount,
      componentIds: [...(ui.componentIds ?? [])],
    };
  }

  /**
   * The single gate for every outbound capability destination.
   *
   * Compares parsed origins — scheme, host, and port together — never string
   * prefixes, so a lookalike host (`https://api.internal.example.attacker.com`)
   * cannot pass by starting with an allowed value, and an allowlisted
   * `https://api.example` never also admits `http://api.example` or another
   * port on the same host.
   *
   * Fails closed on an absent or empty list. An unconfigured host is not a
   * host that has decided to trust everything; it is one that hasn't decided
   * at all, and the cost of guessing wrong here is this process sending a
   * credential wherever a publish call names.
   */
  function assertAllowedUpstream(value: unknown, label: string): string {
    const url = assertHttpUrl(value, label);
    const allowed = new Set(
      (config.allowedUpstreamOrigins ?? []).flatMap((candidate) => {
        try {
          return [new URL(candidate).origin];
        } catch {
          // A malformed entry is dropped rather than throwing: it can only
          // ever narrow what is permitted, never widen it.
          return [];
        }
      }),
    );
    if (allowed.size === 0) {
      throw new Error(
        `${label} was rejected because no allowedUpstreamOrigins are configured. ` +
          "Name every origin this deployment may call, including its own if it serves capabilities in-process.",
      );
    }
    const origin = new URL(url).origin;
    if (!allowed.has(origin)) {
      throw new Error(`${label} origin ${origin} is not in allowedUpstreamOrigins`);
    }
    return url;
  }

  /**
   * An OpenAPI binding names a destination in two further places, and both
   * outrank the `baseUrl` the gate above checks. In `openapi-adapter.ts`:
   *
   *   `const base = binding.serverUrl ?? baseUrl`   — serverUrl wins outright
   *   `new URL(path, base)`                         — an absolute path wins too
   *
   * So gating `baseUrl` alone left the allowlist bypassable by a binding
   * rather than by the field the allowlist appeared to guard: a publish call
   * carrying `serverUrl: "https://attacker.example"` still routed the
   * resolved credential there. Bindings are fixed at publication, so checking
   * them once here covers every request that catalog will ever make.
   */
  function assertAllowedBindings(bindings: Record<string, unknown>): void {
    for (const [name, binding] of Object.entries(bindings)) {
      if (!isRecord(binding)) continue;
      if (binding.serverUrl !== undefined) {
        assertAllowedUpstream(binding.serverUrl, `Binding "${name}" serverUrl`);
      }
      if (typeof binding.path === "string") {
        // Relative by design: the base is what the allowlist actually checked.
        // `new URL("https://elsewhere/x", base)` discards that base silently,
        // and a protocol-relative `//host/x` keeps only the scheme.
        let isAbsolute = false;
        try {
          new URL(binding.path);
          isAbsolute = true;
        } catch {
          isAbsolute = false;
        }
        if (isAbsolute || binding.path.startsWith("//")) {
          throw new Error(
            `Binding "${name}" path must be relative to the approved server, not an absolute URL`,
          );
        }
      }
    }
  }

  /**
   * Turns a publish call's `credentialId` into a header factory, or undefined
   * when none was referenced. The caller never names the environment variable
   * — only an id the host mapped in `upstreamCredentials` — so an unknown id
   * fails closed instead of reading whatever it asked for.
   *
   * The token is read per request rather than captured at publish time, so
   * rotating the environment variable takes effect without republishing.
   */
  function resolveUpstreamCredential(
    credentialId: unknown,
  ): (() => Record<string, string>) | undefined {
    if (credentialId === undefined || credentialId === null) return undefined;
    if (typeof credentialId !== "string" || !credentialId.trim()) {
      throw new Error("credentialId must be a non-empty string");
    }
    const id = credentialId.trim();
    const envName = config.upstreamCredentials?.[id];
    if (!envName) {
      throw new Error(
        `Unknown credentialId "${id}". Declare it in the server's upstreamCredentials.`,
      );
    }
    return () => {
      const token = process.env[envName];
      if (!token) throw new Error(`Environment variable ${envName} is not set`);
      return { authorization: `Bearer ${token}` };
    };
  }

  function publicationSummary(
    registered: ReturnType<typeof store.publish>,
  ): CatalogPublicationSummary {
    const unbound = registered.catalog.capabilities
      .map((capability) => capability.id)
      .filter((id) => !registered.runtimes.has(id));

    // No bindings, endpoint, schema, credentials, or planner-unsafe detail is
    // returned because this response may go to the onboarding browser.
    return {
      ok: true,
      catalogId: registered.catalogId,
      version: registered.version,
      catalogHash: registered.catalogHash,
      bindingKind: registered.bindingKind,
      publishedAt: registered.publishedAt,
      capabilityCount: registered.catalog.capabilities.length,
      executableCapabilityCount: registered.runtimes.size,
      unboundCapabilities: unbound,
      dataTypes: registered.catalog.dataTypes.map((dataType) => dataType.id),
      ...publishInsights(registered),
    };
  }

  /**
   * What publish already knows and used to make the host discover later.
   */
  function publishInsights(registered: {
    catalogId: string;
    plannerManifest: Parameters<typeof createDataPlanningContract>[0];
  }): {
    uiCatalogRegistered: boolean;
    unrenderableDataTypes: string[];
    contractBytes: number;
    approximateTokens: number;
    contractCost: ContractCost;
    contractBudget: ContractBudgetVerdict;
  } {
    const site = uiStore.get(registered.catalogId);
    const unrenderable = site
      ? matchCatalogToComponents(registered.plannerManifest, site.site)
          .filter((row) => row.unrenderable)
          .map((row) => `${row.dataTypeId} (${row.shape})`)
      : [];
    // Measured rather than estimated, and attributed rather than totalled. The
    // bare total was already here and told a host their catalog was large
    // without saying what made it large — see `describeContractCost`.
    const contractCost = describeContractCost(registered.plannerManifest);
    return {
      uiCatalogRegistered: Boolean(site),
      unrenderableDataTypes: unrenderable,
      // Kept as their own fields: they are the published shape of this summary
      // and a host reading `contractBytes` should not have to move.
      contractBytes: contractCost.bytes,
      approximateTokens: contractCost.approximateTokens,
      contractCost,
      contractBudget: judgeContractCost(contractCost, config.contractTokenBudget),
    };
  }

  /**
   * Refuses a catalog whose planning contract is larger than the host said they
   * are willing to send.
   *
   * Before anything is published or persisted, because the alternative is a
   * catalog that is live and unusable: the contract is resent on every plan
   * attempt, and a provider that rejects it does not fail the compose — it
   * silently retries in unconstrained mode, at double the calls and worse
   * decoding. That is the failure this ceiling exists to turn into a sentence.
   *
   * Opt-in, and no default. A publish that starts refusing a catalog a host has
   * been serving for weeks is a worse outcome than the cost they already have;
   * the budget warning on the summary is what speaks by default.
   */
  function assertContractWithinCeiling(catalog: unknown): void {
    const ceiling = config.contractTokenCeiling;
    if (ceiling === undefined) return;
    const cost = describeContractCost(createPlannerManifest(assertCapabilityCatalog(catalog)));
    if (cost.approximateTokens <= ceiling) return;
    throw new Error(
      `Refusing to publish: ${judgeContractCost(cost, ceiling).advice} ` +
        "Raise ViewServerConfig.contractTokenCeiling if this cost is one you accept.",
    );
  }

  function publishReviewedCatalogInMemory(body: unknown) {
    const payload = assertRecord(body, "Catalog publication");
    const bindings = assertRecord(payload.bindings ?? {}, "bindings");
    assertContractWithinCeiling(payload.catalog);
    if (
      payload.bindingKind !== undefined &&
      payload.bindingKind !== "openapi" &&
      payload.bindingKind !== "graphql"
    ) {
      throw new Error('bindingKind must be "openapi" or "graphql"');
    }
    const bindingKind = payload.bindingKind === "graphql" ? "graphql" : "openapi";

    if (bindingKind === "graphql") {
      if (!config.graphql) {
        throw new Error(
          "GraphQL publication requires a host GraphQL adapter with provenance resolution",
        );
      }
      // Checked here rather than left to the first request that has data to
      // attribute. An adapter supplying `fetchImpl` and `resolveHeaders` but
      // not this one is truthy, so publication used to succeed and the gap
      // surfaced later as PROVENANCE_UNAVAILABLE — a failure that needs a
      // request to get far enough to produce rows, which means any unrelated
      // failure in front of it (a permission, a page cap) hides it completely.
      // It stayed hidden for a day that way.
      if (typeof config.graphql.resolveProvenance !== "function") {
        throw new Error(
          "ViewServerConfig.graphql.resolveProvenance is required to publish a GraphQL " +
            "catalog: every returned row is attributed to an approved source, and without " +
            "it each request fails with PROVENANCE_UNAVAILABLE once it already has data.",
        );
      }
      const endpoint = assertAllowedUpstream(
        payload.endpoint as string,
        "GraphQL endpoint",
      );
      const schema = payload.schema;
      if (typeof schema !== "string" && !isRecord(schema)) {
        throw new Error("GraphQL schema must be SDL text or introspection JSON");
      }
      const graphBindings = bindings as unknown as Readonly<
        Record<string, GraphQlOperationBinding>
      >;
      const permissionEnvelope = new Set(
        assertRecord(payload.catalog, "catalog").capabilities instanceof Array
          ? (assertRecord(payload.catalog, "catalog").capabilities as unknown[]).flatMap(
              (entry) => {
                if (!isRecord(entry) || !isRecord(entry.policy)) return [];
                return Array.isArray(entry.policy.requiredPermissions)
                  ? entry.policy.requiredPermissions.filter(
                      (value): value is string => typeof value === "string",
                    )
                  : [];
              },
            )
          : [],
      );
      const runtime: GraphQlRuntimeConfig = {
        schema,
        permissions: permissionEnvelope,
        transport: async (operation) => {
          const active = executionContext.getStore();
          if (!active) {
            throw new Error("GraphQL execution requires a trusted request context");
          }
          const binding = Object.values(graphBindings).find(
            (candidate) => candidate.operationName === operation.operationName,
          );
          if (!binding) throw new Error("Approved GraphQL operation was not found");
          // Re-checked here, not only at publish time: credentials are about
          // to be attached and this is the last point before they leave the
          // process. Narrowing the allowlist must revoke an already published
          // catalog rather than wait for it to be republished.
          assertAllowedUpstream(endpoint, "GraphQL endpoint");
          const requestContext: GraphQlHostRequestContext<Session> = {
            ...active,
            catalogId: assertRecord(payload.catalog, "catalog").id as string,
            capabilityId: binding.capabilityId,
            sourceId: binding.sourceId,
            endpoint,
            destinationOrigin: new URL(endpoint).origin,
          };
          // The credential is withheld here rather than by asking the host's
          // `resolveHeaders` to withhold it: a host cannot be relied on to
          // honour a flag correctly when the whole point of the measurement is
          // that their beliefs about their own credentials may be wrong.
          const hostHeaders =
            config.graphql?.resolveHeaders && !active.withoutUpstreamCredential
              ? await config.graphql.resolveHeaders(requestContext)
              : {};
          let response: Response;
          try {
            response = await (config.graphql?.fetchImpl ?? fetch)(endpoint, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json",
                ...hostHeaders,
              },
              body: JSON.stringify({
                query: operation.document,
                operationName: operation.operationName,
                variables: operation.variables,
              }),
              signal: operation.signal,
              // Not followed: the endpoint was checked against
              // `allowedUpstreamOrigins` both at publish and again just above,
              // and a redirect would re-send this credentialed request to a
              // destination that passed neither check. `fetch` carries the
              // Authorization header across a same-scheme redirect, so
              // following one hands the token to whoever the approved host
              // points at.
              redirect: "manual",
            });
          } catch (cause) {
            // No response at all: DNS, connection refused, TLS, abort. Worth
            // retrying, and there is no status to report.
            throw new GraphQlTransportError("GraphQL upstream request failed", {
              retryable: true,
              cause,
            });
          }
          if (response.status >= 300 && response.status < 400) {
            throw new GraphQlTransportError(
              "GraphQL upstream redirected; publish the final endpoint instead",
              { httpStatus: response.status, retryable: false },
            );
          }
          if (!response.ok) {
            // 4xx and 5xx are different failures and were reported as the same
            // one. "Rejected" reads as a decision the upstream made about the
            // request, which is true of a 4xx and false of a 5xx — a 500 means
            // the upstream itself failed, and calling that "rejected" sends
            // whoever is debugging it to look at the request instead of at the
            // upstream. That mislabelling cost a full afternoon on a gateway that
            // was simply missing an environment variable.
            //
            // 408 and 429 are the two 4xx that a retry can legitimately fix.
            const serverSide = response.status >= 500;
            const worthRetrying =
              serverSide || response.status === 408 || response.status === 429;
            // 401 and 403 are split out for the same reason 5xx is: they name a
            // different thing to go and look at. Folded into "rejected the
            // request" they read as a bad query, when the request was fine and
            // the credential was not — and the host who forwarded that
            // credential is the only party who can fix it. This is the failure
            // that otherwise reappears downstream as an empty permission set
            // and then as "missing permission", three hops from the cause.
            const credentialRejected = response.status === 401 || response.status === 403;
            throw new GraphQlTransportError(
              serverSide
                ? "GraphQL upstream failed to handle the request"
                : credentialRejected
                  ? "GraphQL upstream rejected the forwarded credential, not the query — " +
                    "check that resolveHeaders supplies a token that is still valid"
                  : "GraphQL upstream rejected the request",
              { httpStatus: response.status, retryable: worthRetrying },
            );
          }
          try {
            const result = await response.json();
            if (!isRecord(result)) throw new Error("invalid response");
            return result as GraphQlTransportResponse;
          } catch (cause) {
            // A 2xx whose body is not a JSON object is not a transient fault —
            // it means something is answering that is not the GraphQL endpoint
            // (a proxy, a login interstitial, an error page). Retrying returns
            // the same page.
            throw new GraphQlTransportError("GraphQL upstream returned invalid JSON", {
              httpStatus: response.status,
              retryable: false,
              cause,
            });
          }
        },
        resolveProvenance: async ({ capabilityId, data }) => {
          const active = executionContext.getStore();
          if (!active) {
            throw new Error("GraphQL provenance requires a trusted request context");
          }
          const binding = graphBindings[capabilityId];
          if (!binding) throw new Error("Approved GraphQL operation was not found");
          return config.graphql!.resolveProvenance({
            ...active,
            endpoint,
            destinationOrigin: new URL(endpoint).origin,
            catalogId: assertRecord(payload.catalog, "catalog").id as string,
            capabilityId,
            sourceId: binding.sourceId,
            data,
          });
        },
      };
      const registered = store.publish({
        bindingKind: "graphql",
        catalog: payload.catalog,
        bindings: graphBindings,
        runtime,
      });
      return publicationSummary(registered);
    }

    // The host owns where approved operations actually live, so `baseUrl` is
    // accepted from the publish call itself — but only after being checked
    // against `allowedUpstreamOrigins`. The credential is never accepted here
    // at all: the publish call may only reference a `credentialId` the host
    // declared in `upstreamCredentials`, so a token can neither travel through
    // the browser nor be chosen by the caller.
    //
    // The bindings carry destinations of their own that outrank `baseUrl`, so
    // they pass the same gate — see `assertAllowedBindings`.
    assertAllowedBindings(bindings as Record<string, unknown>);
    const runtime: OpenApiRuntimeConfig = {
      ...(payload.baseUrl === undefined
        ? {}
        : { baseUrl: assertAllowedUpstream(payload.baseUrl, "baseUrl") }),
      // Re-checked per request, not only here: the GraphQL transport has always
      // done this so that narrowing the allowlist revokes an already published
      // catalog rather than waiting for a republish. The OpenAPI path enforced
      // the allowlist at publish alone, so a revoked origin kept being called.
      assertAllowedUpstream: (url) => {
        assertAllowedUpstream(url, "OpenAPI request URL");
      },
    };
    const credentialHeaders = resolveUpstreamCredential(payload.credentialId);
    if (credentialHeaders) {
      // Wrapped so the credential can be withheld for one probe request without
      // republishing the catalog. Withheld here rather than by asking the host's
      // resolver to withhold it: the whole point of the measurement is that a
      // host's beliefs about their own credential may be wrong, so a resolver
      // that honours the flag correctly is exactly what cannot be assumed. The
      // GraphQL transport withholds at the same seam.
      runtime.headers = () => {
        if (executionContext.getStore()?.withoutUpstreamCredential) return {};
        return credentialHeaders();
      };
    }

    const registered = store.publish({
      bindingKind: "openapi",
      catalog: payload.catalog as never,
      bindings: bindings as never,
      runtime,
    });
    return publicationSummary(registered);
  }

  /**
   * Publishes, then records the publish input so a restart can replay it.
   *
   * Async because persisting is IO, and the alternative — starting the write and
   * returning — would report a successful publish whose only durable trace
   * failed to be written. The symptom of that is a catalog that is present until
   * the next restart and then silently gone, which is the exact failure this
   * store exists to prevent.
   *
   * Order matters: the in-memory publish runs first, so an invalid catalog is
   * rejected before anything is written. Nothing unreplayable is ever stored.
   */
  async function publishReviewedCatalog(
    body: unknown,
  ): Promise<CatalogPublicationSummary> {
    const summary = publishReviewedCatalogInMemory(body);
    await config.catalogStore?.put({
      kind: "capability",
      id: summary.catalogId,
      body,
      publishedAt: summary.publishedAt,
    });
    restoreAttempted = true;
    return summary;
  }

  /**
   * Prior publishes of one catalog, newest first.
   *
   * The snapshots were already being written — every publish since retention
   * landed — and nothing could read them. Captured and unreachable is worse
   * than absent: it looks like the feature is there.
   */
  async function listCatalogHistory(body: unknown): Promise<CatalogHistoryResult> {
    const payload = assertRecord(body, "Catalog history request");
    const catalogId = assertNonEmptyString(payload.catalogId, "catalogId");
    const kind = assertCatalogKind(payload.kind);
    if (!config.catalogStore?.history) {
      throw new Error(
        "This deployment's catalogStore does not retain history, so there is " +
          "nothing to list. createFileCatalogStore retains every publish.",
      );
    }
    return {
      ok: true,
      catalogId,
      kind,
      snapshots: await config.catalogStore.history(kind, catalogId),
    };
  }

  /**
   * Republishes a retained snapshot, through the ordinary publish path.
   *
   * Rollback is a publish, not a special mode: the snapshot is the exact body
   * that was accepted before, it is re-validated on the way in like any other,
   * and it is itself retained — so rolling back is reversible by rolling
   * forward, and no state exists that a normal publish could not also produce.
   */
  async function rollbackPublishedCatalog(
    body: unknown,
  ): Promise<CatalogRollbackSummary> {
    const payload = assertRecord(body, "Catalog rollback request");
    const catalogId = assertNonEmptyString(payload.catalogId, "catalogId");
    const stamp = assertNonEmptyString(payload.stamp, "stamp");
    const kind = assertCatalogKind(payload.kind);
    if (!config.catalogStore?.readSnapshot) {
      throw new Error(
        "This deployment's catalogStore does not retain history, so there is " +
          "nothing to roll back to.",
      );
    }
    const snapshot = await config.catalogStore.readSnapshot(kind, catalogId, stamp);
    if (!snapshot) {
      throw new Error(
        `No retained publish "${stamp}" for ${kind} catalog "${catalogId}". ` +
          "List them first: POST /api/catalog/history.",
      );
    }
    if (kind === "capability") {
      const summary = await publishReviewedCatalog(snapshot.body);
      return { ok: true, kind, catalogId: summary.catalogId, restoredFrom: stamp };
    }
    const summary = await publishUiCatalog(snapshot.body);
    return { ok: true, kind, catalogId: summary.catalogId, restoredFrom: stamp };
  }

  /**
   * Unpublishes a catalog: out of the live registry, and out of the store so it
   * does not return at the next boot.
   *
   * Publishing was the only way to change a registry, so a catalog published by
   * mistake could be replaced and never removed — the only way to clear a trial
   * run was restarting the process, which is not a thing to tell a host to do.
   *
   * Retained snapshots survive, so this is reversible by rollback.
   */
  async function deletePublishedCatalog(body: unknown): Promise<CatalogDeleteSummary> {
    const payload = assertRecord(body, "Catalog delete request");
    const catalogId = assertNonEmptyString(payload.catalogId, "catalogId");
    const kind = assertCatalogKind(payload.kind);
    const unregistered =
      kind === "capability" ? store.remove(catalogId) : uiStore.remove(catalogId);
    // Attempted regardless of whether the registry held it: a record can
    // outlive its registration when the process restarted between the two, and
    // that is exactly the case a host is trying to clean up.
    const forgotten = (await config.catalogStore?.remove?.(kind, catalogId)) ?? false;
    return {
      ok: true,
      kind,
      catalogId,
      unregistered,
      forgotten,
      // Said plainly, because "ok: true" over two falses would read as success.
      ...(unregistered || forgotten
        ? {}
        : {
            note:
              `Nothing was published under "${catalogId}" as a ${kind} catalog. ` +
              "Check the id with GET /api/catalog.",
          }),
    };
  }

  function assertCatalogKind(value: unknown): "capability" | "ui" {
    if (value === undefined || value === "capability") return "capability";
    if (value === "ui") return "ui";
    throw new Error('kind must be "capability" or "ui"');
  }

  function listPublishedCatalogs() {
    return store.list().map((registered) => ({
      catalogId: registered.catalogId,
      version: registered.version,
      catalogHash: registered.catalogHash,
      publishedAt: registered.publishedAt,
      capabilityCount: registered.catalog.capabilities.length,
      executableCapabilityCount: registered.runtimes.size,
      bindingKind: registered.bindingKind,
    }));
  }

  function publishUiCatalogInMemory(body: unknown): UiCatalogPublicationSummary {
    const payload = assertRecord(body, "UI catalog publication");
    const manifest = assertRecord(
      payload.manifest,
      "manifest",
    ) as unknown as SiteManifest;
    // A UI catalog is looked up by the *capability* catalog id everywhere it is
    // used, so a host whose site is named anything else needs a way to say which
    // catalog it renders. Defaults to the site id, which is what it silently had
    // to be before.
    if (payload.catalogId !== undefined && typeof payload.catalogId !== "string") {
      throw new Error(
        "catalogId must be a string naming the capability catalog this UI renders",
      );
    }
    const registered = uiStore.publish({
      manifest,
      ...(payload.catalogId ? { catalogId: payload.catalogId } : {}),
    });
    return {
      ok: true,
      siteId: registered.siteId,
      catalogId: registered.catalogId,
      version: registered.version,
      registrationFingerprint: registered.registrationFingerprint,
      publishedAt: registered.publishedAt,
      componentIds: registered.site.components.map((component) => component.id),
      surfaceIds: registered.site.surfaces.map((surface) => surface.id),
      ...uiPublishInsights(registered.catalogId, registered.site),
    };
  }

  /**
   * The same question `publishInsights` answers, asked from the other side.
   *
   * Deliberately shares `matchCatalogToComponents` with the capability path
   * rather than reimplementing the comparison: two answers to "can anything
   * render this" that could disagree is worse than none.
   */
  function uiPublishInsights(
    catalogId: string,
    site: Parameters<typeof matchCatalogToComponents>[1],
  ): { capabilityCatalogRegistered: boolean; unrenderableDataTypes: string[] } {
    const registered = store.get(catalogId);
    return {
      capabilityCatalogRegistered: Boolean(registered),
      unrenderableDataTypes: registered
        ? matchCatalogToComponents(registered.plannerManifest, site)
            .filter((row) => row.unrenderable)
            .map((row) => `${row.dataTypeId} (${row.shape})`)
        : [],
    };
  }

  /**
   * See `publishReviewedCatalog` for why this is async.
   *
   * Filed under the capability catalog id, the key `uiStore` and every lookup
   * use, so a restore lands where a later lookup will search.
   */
  async function publishUiCatalog(body: unknown): Promise<UiCatalogPublicationSummary> {
    const summary = publishUiCatalogInMemory(body);
    await config.catalogStore?.put({
      kind: "ui",
      id: summary.catalogId,
      body,
      publishedAt: summary.publishedAt,
    });
    restoreAttempted = true;
    return summary;
  }

  /**
   * Replays every stored publish, so the registries hold what they held before
   * the process restarted. Call once at boot, before serving.
   *
   * A failed record is reported, not thrown. One catalog that no longer
   * validates should not stop a process from starting and serving the others —
   * but it must not vanish quietly either, because the visible symptom is
   * "that capability isn't available", which points nowhere near a stored body.
   */
  async function restorePublishedCatalogs(): Promise<RestoreSummary> {
    restoreAttempted = true;
    const summary: RestoreSummary = {
      capabilityCatalogs: 0,
      uiCatalogs: 0,
      failures: [],
    };
    if (!config.catalogStore) return summary;

    for (const record of await config.catalogStore.list()) {
      try {
        if (record.kind === "capability") {
          publishReviewedCatalogInMemory(record.body);
          summary.capabilityCatalogs += 1;
        } else {
          publishUiCatalogInMemory(record.body);
          summary.uiCatalogs += 1;
        }
      } catch (error) {
        summary.failures.push({
          kind: record.kind,
          id: record.id,
          reason: error instanceof Error ? error.message : "unknown error",
        });
      }
    }
    return summary;
  }

  function listPublishedSites() {
    return uiStore.list().map((registered) => ({
      siteId: registered.siteId,
      catalogId: registered.catalogId,
      version: registered.version,
      registrationFingerprint: registered.registrationFingerprint,
      publishedAt: registered.publishedAt,
      componentIds: registered.site.components.map((component) => component.id),
    }));
  }

  async function planAgainstPublishedCatalog({
    catalogId,
    prompt,
    providerId,
    request,
    createProvider,
  }: {
    catalogId: string;
    prompt: string;
    providerId?: string;
    request: unknown;
    createProvider?: (
      provider: { id: string },
      fallback: () => PlanProvider,
    ) => PlanProvider;
  }) {
    assertPrompt(prompt);
    const registered = store.get(catalogId);
    if (!registered) {
      throw new Error(
        `${unpublishedCatalogMessage(catalogId, "capability")} Publish one from the review UI first.`,
      );
    }

    const contract = createDataPlanningContract(registered.plannerManifest);
    const planProvider = resolvePlanProvider(providerId, createProvider, catalogId);

    // Traced too. `planAgainstPublishedCatalog` is a smaller path than
    // compose, but it is still a real model call someone is paying for — a
    // model call that does not appear in the traces is worse than no traces,
    // because it makes the total look lower than it is.
    const completion = await observeProvider(planProvider, {
      traceId: newTraceId(),
      catalogId,
      attemptRef: { value: 0 },
    }).generatePlan({
      systemPrompt: contract.systemPrompt,
      userPrompt: prompt,
      jsonSchema: contract.jsonSchema,
    });

    const draft = assertRecord(completion.value, "Provider output");
    if (!Array.isArray(draft.dataRequests) || draft.dataRequests.length === 0) {
      throw new Error("Provider output contained no data requests");
    }

    const issues: Array<{ path: string; message: string }> = [];
    for (const [index, dataRequest] of (
      draft.dataRequests as Array<Record<string, unknown>>
    ).entries()) {
      const validation = validateDataRequestQuery(
        registered.plannerManifest,
        dataRequest as never,
      );
      if (!validation.ok) {
        issues.push(
          ...validation.issues.map((issue) => ({
            path: `dataRequests.${index}.${issue.path}`,
            message: issue.message,
          })),
        );
      }
    }
    if (issues.length > 0) {
      return { ok: false, kind: "invalid", issues };
    }

    const session = await config.resolveSession(request);

    const plan = {
      schemaVersion: "3.1",
      planId: `published-${registered.catalogHash}`,
      siteId: registered.catalogId,
      sourcePrompt: prompt,
      catalog: {
        id: registered.catalogId,
        version: registered.version,
        fingerprint: registered.catalogHash,
      },
      dataCatalog: {
        id: registered.catalogId,
        version: registered.version,
        hash: registered.catalogHash,
      },
      dataRequests: draft.dataRequests,
      surfaces: [{ id: "published", nodes: [] }],
      generation: {
        providerId: planProvider.id,
        modelId: completion.modelId,
        createdAt: new Date().toISOString(),
        repairCount: 0,
      },
    };

    const executed = await executionContext.run({ request, session }, () =>
      executePlanDataRequests({
        plan: plan as never,
        catalog: registered.catalog,
        runtimes: registered.runtimes,
        session,
        host: config.host,
      }),
    );

    return {
      ok: true,
      catalogId: registered.catalogId,
      dataRequests: draft.dataRequests,
      results: executed.results,
    };
  }

  /**
   * The actual `/api/compose` pipeline: prompt -> full planner contract (data
   * and components together) -> provider draft -> deterministic validation
   * -> live capability execution -> immutable data projection -> A2UI
   * messages.
   *
   * Takes one `catalogId` only, matching `ViewLauncher`'s request body
   * exactly: a host publishes their capability catalog and UI catalog under
   * the same id, and `ViewProvider`'s A2UI catalog id already defaults
   * to `${catalogId}:ui` for the same reason — one identifier a host
   * configures once, not two ids to keep in sync by hand.
   */
  async function composeAgainstPublishedCatalogs({
    catalogId,
    surfaceId,
    prompt,
    providerId,
    request,
    createProvider,
    uiCatalogId,
    previousPlanId,
    answersClarification,
    onEvent,
    runId,
  }: {
    catalogId: string;
    surfaceId?: string;
    prompt: string;
    providerId?: string;
    request: unknown;
    createProvider?: (
      provider: { id: string },
      fallback: () => PlanProvider,
    ) => PlanProvider;
    /**
     * Must match the caller's `ViewProvider` config `uiCatalogId` exactly, or
     * the client's local A2UI `Catalog` and this message's `a2uiCatalogId`
     * name different catalogs and binding silently fails. Defaults to the
     * same `${catalogId}:ui` convention the client falls back to when it has
     * no override configured either.
     */
    uiCatalogId?: string;
    previousPlanId?: string;
    /**
     * True when this prompt carries the answer to a question the planner asked.
     *
     * Removes the clarification branch from the contract for this call, so a
     * second question is impossible rather than merely discouraged. Without it a
     * model that keeps finding the prompt ambiguous can ask indefinitely, and
     * the visitor is in a loop whose only exit is reloading the page.
     */
    answersClarification?: boolean;
    /**
     * Receives progress events as the compose runs. Supplying it changes what
     * the caller *observes*, never what the compose does or returns: the batch
     * response is the same object either way, and this pipeline stays the only
     * one. A transport that streams folds these into a wire format; one that
     * does not omits the callback and pays nothing.
     *
     * Never let this throw — see `emit`.
     */
    onEvent?: (event: ComposeEvent) => void;
    /** Correlates every event of one run. Supplied by the transport so it can report a failure under the same id. */
    runId?: string;
  }) {
    const composeRunId = runId ?? `run-${globalThis.crypto.randomUUID()}`;
    /**
     * Emits without ever letting an observer break a compose — the same rule
     * `reportMetrics` follows, for the same reason: a visitor's view must not
     * be lost because something watching it failed.
     */
    const emit = (event: ComposeEvent): void => {
      if (!onEvent) return;
      try {
        onEvent(event);
      } catch (cause) {
        console.error(`[compose:events] observer threw: ${String(cause)}`);
      }
    };
    const event = <T extends ComposeEvent["type"]>(
      type: T,
      fields: Omit<Extract<ComposeEvent, { type: T }>, "type" | "runId" | "timestamp">,
    ): void =>
      emit({
        type,
        runId: composeRunId,
        timestamp: Date.now(),
        ...fields,
      } as ComposeEvent);

    assertPrompt(prompt);
    const registeredCatalog = store.get(catalogId);
    if (!registeredCatalog) {
      throw catalogUnavailableError(catalogId, "capability");
    }
    const registeredSite = uiStore.get(catalogId);
    if (!registeredSite) {
      throw catalogUnavailableError(catalogId, "UI");
    }
    const site = registeredSite.site;
    const resolvedSurfaceId = surfaceId ?? site.surfaces[0]?.id;
    if (!resolvedSurfaceId || !site.getSurface(resolvedSurfaceId)) {
      throw new Error(`Site "${catalogId}" has no surface "${resolvedSurfaceId ?? ""}"`);
    }

    event("RUN_STARTED", {
      catalogId,
      surfaceId: resolvedSurfaceId as string,
      ...(previousPlanId ? { previousPlanId } : {}),
      // The earliest point a streaming client can learn the budget — before
      // any model call, so it can arm its own timeout from the server's number
      // rather than from a constant compiled into the bundle.
      deadlineMs: config.composeDeadlineMs ?? DEFAULT_COMPOSE_DEADLINE_MS,
    });

    // Before the planner, not after it. Resolving the session late meant an
    // unauthenticated request ran a full model call and was rejected on the
    // way out: the host paid for a compose that could never be returned, and
    // anyone able to reach the route could spend that budget without ever
    // holding a credential. Resolved once and reused rather than called again
    // below — a host's `resolveSession` may hit their own auth service, and
    // one request should cost one lookup.
    const session = await config.resolveSession(request);

    // Same placement rationale: a denied compose must cost nothing a model
    // bills for. The host's gate decides; this is only the enforcement point.
    if (config.allowCompose && !(await config.allowCompose({ session, catalogId }))) {
      throw new ComposeRateLimitedError();
    }

    const planProvider = resolvePlanProvider(providerId, createProvider, catalogId);

    // A revision is never cached. The cache is keyed by prompt text, but a
    // revision's meaning depends on the plan it revises — "only open ones"
    // against two different views is two different results, and serving one
    // for the other would silently hand the visitor someone else's layout.
    const cacheKey =
      config.planCache && !previousPlanId
        ? planCacheKey({
            catalogId,
            catalogHash: registeredCatalog.plannerManifest.catalogHash,
            siteVersion: site.version,
            catalogFingerprint: site.catalog.fingerprint,
            surfaceId: resolvedSurfaceId,
            prompt,
            // Identifies which model wrote the cached plan. `planProvider.id`
            // alone is not enough: two configs can share an id while pointing at
            // different models.
            providerKey: `${planProvider.id}:${(() => {
              const configured = config.planProviders?.find(
                (candidate) => candidate.id === planProvider.id,
              );
              if (!configured) return "unknown";
              // A scripted provider has no model, and its plans are its
              // identity: two scripts under one id are two different planners
              // as far as a cached plan is concerned.
              return isScriptedProvider(configured)
                ? `scripted:${configured.plans.length}`
                : configured.model;
            })()}`,
          })
        : undefined;

    // Timing starts here rather than at function entry: everything before this
    // is in-memory map lookups and string validation, microseconds against the
    // seconds this is built to measure.
    const composeStartedAt = Date.now();

    // One budget for the request, with planning drawing from inside it. Stated
    // once here so that every phase below reads the same clock, and so the
    // number can be reported to the caller rather than guessed at by them.
    const composeDeadlineMs = config.composeDeadlineMs ?? DEFAULT_COMPOSE_DEADLINE_MS;
    const remainingBudgetMs = () => composeDeadlineMs - (Date.now() - composeStartedAt);
    const planDeadlineMs = Math.min(
      config.planDeadlineMs ?? DEFAULT_PLAN_DEADLINE_MS,
      composeDeadlineMs,
    );
    let planMs: number | undefined;
    // Accumulated, not overwritten. Each repair attempt is a separate model
    // call that resends the whole contract, so only a running total describes
    // what a compose actually cost.
    const totalUsage: { inputTokens?: number; outputTokens?: number; calls: number } = {
      calls: 0,
    };
    let lastModelId: string | undefined;
    // Whether the winning call ran under a provider-enforced schema. Tracked
    // here because a provider that falls back to prompt-embedded JSON reports
    // it per call and nothing downstream kept it: a deployment whose every
    // plan came from the degraded path looked identical to one where none did.
    let constrainedDecoding: boolean | undefined;
    let repairCount: number | undefined;
    // One id for the whole compose, so every repair attempt lands in the same
    // trace rather than looking like unrelated traffic.
    const composeTraceId = newTraceId();
    /** Set when planning failed but a previous view is being served instead. */
    let fellBackFrom:
      | {
          kind: "unsupported" | "invalid" | "provider-error" | "needs-clarification";
          reason: string;
          issues: DataPlanIssue[];
          question?: string;
          options?: readonly string[];
        }
      | undefined;

    /**
     * One snapshot of the catalog for everything below, so a republish landing
     * mid-compose cannot make two reads disagree — and so the non-null narrowing
     * from the guard above survives into these closures.
     */
    const manifest = registeredCatalog.plannerManifest;

    /**
     * Distinct data types the plan drew on. Read from the manifest rather than
     * the executed rows, so it describes what was asked for even when a request
     * failed.
     */
    function dataTypesSpanned(): number {
      const requests = plan?.dataRequests ?? [];
      const byId = new Map(
        manifest.capabilities.map((capability) => [capability.id, capability]),
      );
      const types = new Set<string>();
      for (const request of requests) {
        const dataTypeId = byId.get(request.capabilityId)?.output?.dataTypeId;
        if (dataTypeId) types.add(dataTypeId);
      }
      return types.size;
    }

    /** Emits metrics without ever letting a telemetry failure break a compose. */
    function reportMetrics(
      outcome: ComposeMetrics["outcome"],
      capabilityCount: number,
      dataMs: number,
      failedRequestCount?: number,
    ) {
      if (!config.onComposeMetrics) return;
      try {
        config.onComposeMetrics({
          catalogId,
          surfaceId: resolvedSurfaceId as string,
          promptLength: prompt.length,
          cached,
          outcome,
          ...(lastModelId ? { modelId: lastModelId } : {}),
          ...(planMs !== undefined ? { planMs } : {}),
          ...(totalUsage.inputTokens !== undefined
            ? { inputTokens: totalUsage.inputTokens }
            : {}),
          ...(totalUsage.outputTokens !== undefined
            ? { outputTokens: totalUsage.outputTokens }
            : {}),
          ...(totalUsage.calls > 0 ? { modelCalls: totalUsage.calls } : {}),
          ...(repairCount !== undefined ? { repairCount } : {}),
          ...(constrainedDecoding !== undefined ? { constrainedDecoding } : {}),
          capabilityCount,
          ...(failedRequestCount !== undefined ? { failedRequestCount } : {}),
          dataTypesSpanned: dataTypesSpanned(),
          // To-one only, matching what the runtime will actually execute
          // (`joinOne`) and what the planner will accept. Counting a
          // one-to-many relationship here would report a join as available
          // that both layers refuse.
          joinableRelationshipCount: manifest.relationships.filter(
            (relationship) =>
              relationship.cardinality === "one-to-one" ||
              relationship.cardinality === "many-to-one",
          ).length,
          dataMs,
          totalMs: Date.now() - composeStartedAt,
        });
      } catch (cause) {
        console.error(`[compose:metrics] sink threw: ${String(cause)}`);
      }
    }

    event("STEP_STARTED", { step: "plan" });
    // Host-supplied storage, held to the same rule as the observers: a cache
    // that throws costs a cache miss, loudly, never the compose.
    let plan: PlanV3_1 | undefined;
    if (cacheKey) {
      try {
        plan = config.planCache?.get(cacheKey);
      } catch (cause) {
        console.error(`[compose:cache] planCache.get threw: ${String(cause)}`);
      }
    }
    const cached = plan !== undefined;

    if (!plan) {
      // Wrapped so usage/model id survive out of the planner, which returns
      // only the validated plan and has no reason to carry billing data.
      // Observation sits *under* metering so a traced call is the same call
      // that gets billed: one span per provider round trip, with the attempt
      // number the repair loop is on. Without that number a three-attempt
      // compose reads as three unrelated calls, which is exactly why the
      // 23-57s latency question was unanswerable from logs.
      const attemptRef = { value: 0 };
      const tracedProvider = observeProvider(planProvider, {
        traceId: composeTraceId,
        catalogId,
        attemptRef,
      });
      const meteredProvider: PlanProvider = {
        id: planProvider.id,
        async generatePlan(planRequest) {
          const result = await tracedProvider.generatePlan(planRequest);
          attemptRef.value += 1;
          // `calls` defaults to 1 rather than 0: a provider that reports no
          // usage still made this call, and counting it as zero would report
          // a compose that reached the model as having made none.
          totalUsage.calls += result.usage?.calls ?? 1;
          if (result.usage?.inputTokens !== undefined) {
            totalUsage.inputTokens =
              (totalUsage.inputTokens ?? 0) + result.usage.inputTokens;
          }
          if (result.usage?.outputTokens !== undefined) {
            totalUsage.outputTokens =
              (totalUsage.outputTokens ?? 0) + result.usage.outputTokens;
          }
          lastModelId = result.modelId;
          if (result.constrainedDecoding !== undefined) {
            constrainedDecoding = result.constrainedDecoding;
          }
          return result;
        },
      };
      // A revision reads the prompt as a change to the current view rather
      // than a fresh request. The previous plan also becomes the fallback, so
      // a failed revision leaves the visitor on what they already had instead
      // of on nothing.
      // Ownership-checked: a revision reads the previous plan's nodes and
      // prompt into the new model call, so accepting another visitor's
      // `planId` here would compose against their view and echo their request
      // back through the summary.
      const previous = previousPlanId
        ? requireOwnedPlan(previousPlanId, catalogId, session, "revise")
        : undefined;
      const effectivePrompt = previous
        ? `${summarizePlanForRevision(previous.plan, resolvedSurfaceId)}\n\nRequested change: ${prompt}`
        : prompt;

      const planStartedAt = Date.now();
      const planned = await composeDataPlan({
        site,
        plannerManifest: registeredCatalog.plannerManifest,
        surfaceId: resolvedSurfaceId,
        prompt: effectivePrompt,
        ...(previous ? { previousPlan: previous.plan } : {}),
        provider: meteredProvider as never,
        deadlineMs: planDeadlineMs,
        ...(answersClarification ? { allowClarification: false } : {}),
      });
      planMs = Date.now() - planStartedAt;
      if (!planned.ok) {
        // A failed plan has no `generation` block to read a repair count from —
        // so derive it from the planner attempts actually made. Attempts, not
        // billed calls: `usage.calls` counts HTTP round trips, and a provider's
        // internal schema fallback makes two of those in one attempt — which
        // reported every refusal that hit the fallback as one "repair" the
        // planner never ran. A refusal returned on the first attempt is zero
        // repairs however many HTTP calls it cost.
        repairCount = Math.max(0, attemptRef.value - 1);
        // A failed revision falls back to the view the visitor already had, so
        // the plan below is executed and compiled exactly as a successful one
        // would be — the difference is only in what the caller is told. Ending
        // here instead would take the visitor's current view away as the price
        // of a rephrasing that did not work.
        // A question is not a repair candidate and not an error; it rides the
        // same terminal event because `parseComposeEvent` drops frames whose
        // type it does not know, so a third terminal type would leave every
        // existing client waiting for one that never arrives.
        const asked: { question?: string; options?: readonly string[] } =
          planned.kind === "needs-clarification"
            ? {
                question: planned.question,
                ...(planned.options ? { options: planned.options } : {}),
              }
            : {};
        if (!planned.fallbackPlan) {
          reportMetrics(planned.kind as ComposeMetrics["outcome"], 0, 0);
          event("RUN_ERROR", {
            kind: planned.kind,
            reason: planned.reason,
            issues: planned.issues,
            ...(asked.question ? { question: asked.question } : {}),
            ...(asked.options ? { options: [...asked.options] } : {}),
          });
          return {
            ok: false,
            kind: planned.kind,
            reason: planned.reason,
            issues: planned.issues,
            ...asked,
          };
        }
        // A revision that produced a question keeps the visitor's current view
        // on screen and asks alongside it, which is the best of the three
        // outcomes here: they can answer, or ignore it and keep looking.
        fellBackFrom = {
          kind: planned.kind,
          reason: planned.reason,
          issues: planned.issues,
          ...asked,
        };
        plan = planned.fallbackPlan;
      } else {
        plan = planned.plan;
      }
      repairCount = plan.generation.repairCount;
      // Only successful plans are cached. A rejected draft is exactly the case
      // where retrying the model is worth the money.
      if (cacheKey) {
        try {
          config.planCache?.set(cacheKey, plan);
        } catch (cause) {
          console.error(`[compose:cache] planCache.set threw: ${String(cause)}`);
        }
      }
    } else {
      // A cached plan is reused, but its identity is not: `planId` is what a
      // saved view is keyed by, so handing two visitors the same one would
      // conflate their saves.
      plan = {
        ...plan,
        planId: `plan-${globalThis.crypto.randomUUID()}`,
        generation: { ...plan.generation, createdAt: new Date().toISOString() },
      };
    }

    event("STEP_FINISHED", {
      step: "plan",
      durationMs: planMs ?? 0,
      planId: plan.planId,
      cached,
    });

    const a2uiCatalogIdForRun = uiCatalogId ?? `${catalogId}:ui`;
    const compileWith = (
      executed: Parameters<typeof compilePlanDataSurfaceMessages>[1]["executedData"],
      pending: boolean,
    ): CompiledSiteSurface[] =>
      compilePlanDataSurfaceMessages(site, {
        ...visitorErrorOption,
        plan: plan as PlanV3_1,
        plannerManifest: registeredCatalog.plannerManifest,
        executedData: redactExecutedResults(executed),
        baseDataModel: {},
        surfaceId: resolvedSurfaceId as string,
        a2uiCatalogId: a2uiCatalogIdForRun,
        ...(pending ? { treatMissingAsPending: true } : {}),
      });
    const dataModelOf = (messages: CompiledSiteSurface[]): Record<string, unknown> =>
      (messages.find((message) => message.updateDataModel)?.updateDataModel?.value ??
        {}) as Record<string, unknown>;

    /**
     * The frame a skeleton renders: the surface and its components, with every
     * slot still pending. Compiled from the same function that compiles the
     * finished view, so a client applies one shape of message throughout and
     * the first frame cannot drift from the last.
     *
     * Only built when someone is watching — it is real work, and a batch caller
     * would never see it.
     */
    const settled: Record<string, unknown> = {};
    let lastDataModel: Record<string, unknown> = {};
    if (onEvent) {
      const skeleton = compileWith({ planId: plan.planId, results: {} } as never, true);
      lastDataModel = dataModelOf(skeleton);
      event("STATE_SNAPSHOT", { messages: skeleton as unknown[] });
    }

    event("STEP_STARTED", { step: "execute" });
    const dataStartedAt = Date.now();
    const requestStartedAt = new Map<string, number>();
    const capabilityOf = new Map(
      (plan.dataRequests ?? []).map((dataRequest) => [
        dataRequest.requestId,
        dataRequest.capabilityId,
      ]),
    );
    // Execution inherits whatever planning left of the budget. Without this the
    // deadline bounded the cheap half of a compose and not the half that talks
    // to upstreams — so a repair loop that ran to its own limit could still be
    // followed by a full set of data requests, and the measured tail was the
    // sum of the two.
    const executedData = await executeWithinBudget(
      composeStartedAt,
      composeDeadlineMs,
      (signal) =>
        executionContext.run({ request, session }, () =>
          executePlanData({
            plan,
            catalog: registeredCatalog.catalog,
            runtimes: registeredCatalog.runtimes,
            session,
            host: config.host,
            signal,
            ...(onEvent
              ? {
                  onRequestStarted: (requestId: string) => {
                    requestStartedAt.set(requestId, Date.now());
                    event("TOOL_CALL_START", {
                      requestId,
                      capabilityId: capabilityOf.get(requestId) ?? "",
                    });
                  },
                  onRequestSettled: (requestId: string, result: ExecutionResult) => {
                    settled[requestId] = result;
                    const state: DataRequestState = !result.ok
                      ? "error"
                      : Array.isArray(result.data) && result.data.length === 0
                        ? "empty"
                        : "ready";
                    event("TOOL_CALL_END", {
                      requestId,
                      capabilityId: capabilityOf.get(requestId) ?? "",
                      state,
                      durationMs:
                        Date.now() - (requestStartedAt.get(requestId) ?? dataStartedAt),
                      ...(result.ok ? {} : { errorMessage: visitorRequestError(result.error) }),
                    });
                    // Re-project against everything settled so far. Compositions
                    // and joins are computed only once every request has landed,
                    // so they stay pending here and arrive in the final delta —
                    // partial inputs would produce a *wrong* aggregate, which is
                    // worse than a late one.
                    try {
                      const partial = compileWith(
                        { planId: (plan as PlanV3_1).planId, results: settled } as never,
                        true,
                      );
                      const next = dataModelOf(partial);
                      const patch = diffDataModel(lastDataModel, next);
                      if (patch.length > 0) {
                        lastDataModel = next;
                        event("STATE_DELTA", { patch });
                      }
                    } catch (cause) {
                      // A partial projection that cannot be built is not a failed
                      // compose: the complete one still runs below. Skipping the
                      // delta costs this slot its early render, nothing more.
                      console.error(
                        `[compose:events] partial projection failed: ${String(cause)}`,
                      );
                    }
                  },
                }
              : {}),
          }),
        ),
    );
    const dataMs = Date.now() - dataStartedAt;
    event("STEP_FINISHED", { step: "execute", durationMs: dataMs });

    const messages = compilePlanDataSurfaceMessages(site, {
      ...visitorErrorOption,
      plan,
      plannerManifest: registeredCatalog.plannerManifest,
      executedData: redactExecutedResults(executedData),
      baseDataModel: {},
      surfaceId: resolvedSurfaceId,
      // Must match the caller's `ViewProvider` config `uiCatalogId` exactly, or
      // the client's Catalog and the server's createSurface message name
      // different catalogs and A2UI silently fails to bind them.
      a2uiCatalogId: uiCatalogId ?? `${catalogId}:ui`,
    });

    // `cached` reports only whether the *plan* was reused — the data in these
    // messages was fetched on this request either way. No bindings, endpoints,
    // schemas, or credentials cross this boundary; the response goes to a
    // browser.
    // Metrics record what planning actually did, not what the visitor sees: a
    // fallback render is still a failed compose and must not inflate the
    // success rate the eval corpus is meant to measure.
    reportMetrics(
      fellBackFrom ? fellBackFrom.kind : "ready",
      plan.dataRequests?.length ?? 0,
      dataMs,
      summarizeRequests(plan, executedData).filter((entry) => !entry.ok).length,
    );
    rememberPlan({
      plan,
      catalogId,
      surfaceId: resolvedSurfaceId as string,
      prompt,
      catalogHash: registeredCatalog.plannerManifest.catalogHash,
      ...(config.resolveViewOwner ? { ownerKey: config.resolveViewOwner(session) } : {}),
      // The value this run actually rendered against, so a later refinement
      // reuses it instead of recomputing a default that may not match.
      uiCatalogId: a2uiCatalogIdForRun,
    });
    // Everything the incremental deltas could not carry: compositions, joins,
    // and any slot whose partial projection was skipped. A client that applied
    // every delta and this one holds exactly the batch data model.
    if (onEvent) {
      const patch = diffDataModel(lastDataModel, dataModelOf(messages));
      if (patch.length > 0) {
        lastDataModel = dataModelOf(messages);
        event("STATE_DELTA", { patch });
      }
    }

    if (fellBackFrom) {
      // A view the visitor can use, but not the one they asked for. Reported as
      // finished-with-fallback rather than as an error (there is a view) and
      // never as a plain success (the request failed).
      event("RUN_FINISHED", {
        planId: plan.planId,
        cached,
        fellBack: true,
        kind: fellBackFrom.kind,
        reason: fellBackFrom.reason,
        issues: fellBackFrom.issues,
        ...(fellBackFrom.question ? { question: fellBackFrom.question } : {}),
        ...(fellBackFrom.options ? { options: [...fellBackFrom.options] } : {}),
      });
      return {
        ok: false,
        kind: fellBackFrom.kind,
        reason: fellBackFrom.reason,
        issues: fellBackFrom.issues,
        ...(fellBackFrom.question ? { question: fellBackFrom.question } : {}),
        ...(fellBackFrom.options ? { options: fellBackFrom.options } : {}),
        fellBack: true,
        planId: plan.planId,
        requests: summarizeRequests(plan, executedData),
        messages,
      };
    }
    const requests = summarizeRequests(plan, executedData);
    const delivery = deliveryOf(requests);
    if (delivery === "none") {
      // Planned, executed, delivered nothing. Reported as a failure that still
      // carries its view: the per-slot error text is the most useful thing the
      // visitor can be shown, and the host needs the envelope to say what the
      // reader already knows.
      const reason = firstRequestError(requests);
      event("RUN_FINISHED", {
        planId: plan.planId,
        cached,
        kind: "data-unavailable",
        reason,
        issues: [],
      });
      return {
        ok: false,
        kind: "data-unavailable",
        reason,
        issues: [],
        planId: plan.planId,
        requests,
        messages,
      };
    }
    event("RUN_FINISHED", {
      planId: plan.planId,
      cached,
      ...(delivery === "partial" ? { partial: true } : {}),
    });
    return {
      ok: true,
      catalogId,
      cached,
      planId: plan.planId,
      requests,
      ...(delivery === "partial" ? { partial: true as const } : {}),
      deadlineMs: composeDeadlineMs,
      messages,
    };
  }

  /**
   * Whether the view a compose produced actually carries data.
   *
   * Read from the request summaries rather than the data model because they
   * share one source — the executor's per-request result is what writes a
   * slot's `state` — and this way the envelope, the summaries and the slot a
   * visitor sees cannot disagree.
   *
   * A plan with no data requests is `all`: a view built entirely from static
   * props delivered everything it had.
   */

  /** The first real explanation among failed requests, for the envelope's `reason`. */

  /**
   * The host-visible answer to "why did my prompt return nothing": for a
   * published capability + UI catalog pair, reports every data type the
   * capability catalog can actually produce and which registered
   * components (if any) can render it. An approved capability with no
   * matching component used to be silently invisible — the planner simply
   * never selected it — with nothing telling the host the real cause was a
   * missing renderer rather than a bad prompt.
   */
  /**
   * Whether one approved dotted field path is null/absent on a sampled row.
   *
   * Mirrors the runtime's dotted-path semantics closely enough for a probe: a
   * path crossing a list counts as present when any element carries a value.
   * Diagnostics only — the runtime's own `readField` stays the authority for
   * what a component receives.
   */
  function probedFieldIsNull(row: unknown, path: string): boolean {
    let current: unknown[] = [row];
    for (const segment of path.split(".")) {
      const next: unknown[] = [];
      for (const value of current) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item !== null && typeof item === "object") {
              next.push((item as Record<string, unknown>)[segment]);
            }
          }
        } else if (value !== null && typeof value === "object") {
          next.push((value as Record<string, unknown>)[segment]);
        }
      }
      current = next;
    }
    return current.every(
      (value) =>
        value === null ||
        value === undefined ||
        (Array.isArray(value) &&
          value.every((item) => item === null || item === undefined)),
    );
  }

  async function probePublishedCatalog(body: unknown): Promise<CatalogProbeResult> {
    const payload = assertRecord(body, "Catalog probe");
    if (typeof payload.catalogId !== "string" || payload.catalogId.length === 0) {
      throw new Error("Catalog probe requires a catalogId");
    }
    const registered = store.get(payload.catalogId);
    if (!registered) {
      throw new Error(unpublishedCatalogMessage(payload.catalogId, "capability"));
    }
    const session = await config.resolveSession(payload.request);
    /**
     * Whether to repeat each successful probe with the host's upstream
     * credential withheld.
     *
     * On by default, because the question it answers is one nobody thinks to
     * ask: a catalog says `authentication: "session"` because a reviewer chose
     * it from a dropdown, and nothing between that dropdown and a visitor's
     * screen ever checks it against the upstream.
     *
     * Both binding kinds. This was GraphQL-only while the OpenAPI runtime baked
     * its credential in at publish, which made withholding it mean republishing;
     * the publish path now wraps the credential so one request can drop it, so
     * the measurement is available on the path that was never measured at all.
     */
    const checkCredential = payload.checkUpstreamCredential !== false;

    /** Visitor parameters the capability accepts but does not require. */
    function optionalParameterNames(capability: { inputSchema: unknown }): string[] {
      const schema = capability.inputSchema as {
        properties?: Record<string, unknown>;
        required?: readonly string[];
      };
      const required = new Set(schema.required ?? []);
      return Object.keys(schema.properties ?? {}).filter((name) => !required.has(name));
    }

    // Sequentially, not concurrently: this is diagnostics against someone
    // else's API, run by an operator, and forty parallel requests from a
    // health check is how a probe becomes an incident.
    const results: CapabilityProbeEntry[] = [];
    for (const capability of registered.catalog.capabilities) {
      const required = (capability.inputSchema as { required?: readonly string[] })
        .required;
      if (required && required.length > 0) {
        results.push({
          capabilityId: capability.id,
          status: "skipped",
          reason: `requires parameters (${required.join(", ")}) the probe will not invent`,
        });
        continue;
      }
      const runOnce = (withoutUpstreamCredential: boolean) =>
        executionContext.run(
          {
            request: payload.request,
            session,
            ...(withoutUpstreamCredential ? { withoutUpstreamCredential: true } : {}),
          },
          () =>
            executeDataRequest({
              request: {
                requestId: `probe-${capability.id}`,
                capabilityId: capability.id,
                params: {},
                // No query, deliberately: the probe exists to predict what a
                // real compose will get, and a compose with no stated limit is
                // the common case. Probing with `limit: 1` sent a page size no
                // visitor request sends, so a catalog could probe clean and
                // then fail every real query on the page-size path the probe
                // never touched — the exact way an earlier build's page-cap
                // footgun stayed hidden.
              },
              dataCatalog: {
                id: registered.catalogId,
                version: registered.version,
                hash: registered.catalogHash,
              },
              catalog: registered.catalog,
              runtimes: registered.runtimes,
              session,
              host: config.host,
            }),
        );

      const result = await runOnce(false);
      const degradedFields = result.ok ? (result.provenance.degradedFields ?? []) : [];

      // Fields that answered null on every sampled row. A raising resolver is
      // `degraded`; a null-answering one probes clean and renders blanks.
      const sampledRows: unknown[] = !result.ok
        ? []
        : Array.isArray(result.data)
          ? result.data
          : result.data !== null && typeof result.data === "object"
            ? [result.data]
            : [];
      const approvedFieldPaths = Object.keys(
        registered.catalog.dataTypes.find(
          (dataType) => dataType.id === capability.output.dataTypeId,
        )?.fields ?? {},
      );
      // Leaves only: approving `total.gross.amount` lists its ancestors too,
      // and a null subtree would otherwise warn three times for one fact.
      const leafFieldPaths = approvedFieldPaths.filter(
        (path) =>
          !approvedFieldPaths.some(
            (other) => other !== path && other.startsWith(`${path}.`),
          ),
      );
      const alwaysNullFields =
        sampledRows.length === 0
          ? []
          : leafFieldPaths.filter((path) =>
              sampledRows.every((row) => probedFieldIsNull(row, path)),
            );
      const nullFieldWarnings = alwaysNullFields.map(
        (path) =>
          `approved field "${path}" was null on every sampled row (${sampledRows.length}); ` +
          `if an argument the schema declares optional actually populates it (a channel, ` +
          `a period), views selecting this field will render blanks until a plan supplies it`,
      );

      /**
       * The measured answer to "does anything actually guard this data".
       *
       * Only asked when the credentialed call worked: if the capability is
       * broken, a failure without the credential says nothing about access
       * control, and reporting `enforced` on the strength of it would be the
       * most dangerous kind of wrong — a reassurance derived from a bug.
       */
      let upstreamCredential: CapabilityProbeEntry["upstreamCredential"];
      if (checkCredential && result.ok) {
        const anonymous = await runOnce(true);
        upstreamCredential = anonymous.ok ? "not-required" : "enforced";
      } else if (checkCredential) {
        upstreamCredential = "unknown";
      }

      results.push(
        result.ok
          ? {
              capabilityId: capability.id,
              status: degradedFields.length > 0 ? "degraded" : "ok",
              ...(Array.isArray(result.data) ? { rowCount: result.data.length } : {}),
              ...(upstreamCredential ? { upstreamCredential } : {}),
              ...(alwaysNullFields.length > 0
                ? { alwaysNullFields, warnings: nullFieldWarnings }
                : {}),
              ...(degradedFields.length > 0
                ? {
                    degradedFields: [...degradedFields],
                    reason: `the upstream errored on ${degradedFields.join(", ")}`,
                  }
                : {}),
            }
          : {
              capabilityId: capability.id,
              status: "failed",
              ...(upstreamCredential ? { upstreamCredential } : {}),
              // A capability whose every parameter is formally optional gets no
              // `skipped` — there was nothing the probe refused to invent — but
              // a schema can declare an argument optional that the resolver
              // requires, and then this failure is that requirement, not a
              // broken capability. Say so, because from the outside the two are
              // indistinguishable and the difference is the whole diagnosis.
              reason: `${result.error.code}: ${result.error.message}${optionalParameterNames(capability).length > 0 ? ` (probed without its optional parameters — ${optionalParameterNames(capability).join(", ")} — so if the upstream requires one in practice, this failure is that requirement)` : ""}`,
            },
      );
    }
    return { ok: true, catalogId: payload.catalogId, results };
  }

  function getCoverageReport(catalogId: string) {
    const registeredCatalog = store.get(catalogId);
    if (!registeredCatalog) {
      throw new Error(unpublishedCatalogMessage(catalogId, "capability"));
    }
    const registeredSite = uiStore.get(catalogId);
    if (!registeredSite) {
      throw new Error(unpublishedCatalogMessage(catalogId, "UI"));
    }
    return {
      ok: true,
      catalogId,
      coverage: matchCatalogToComponents(
        registeredCatalog.plannerManifest,
        registeredSite.site,
      ),
      /**
       * Capabilities a prompt can never select, however well it is written.
       *
       * The compile knows this — an approved argument the planner must set and
       * cannot obtain, a non-null id with no default and no approved path
       * returning one — and used to only warn, at a moment nobody was reading.
       * A report that counts such a capability as covered says the catalog can
       * answer questions it cannot, and the host goes looking at their prompts.
       *
       * Reaching one needs a component that carries the value through from a
       * row already on screen, so this is a fact about routes into the data,
       * not a defect in the capability.
       */
      promptUnreachable: registeredCatalog.plannerManifest.capabilities
        .filter((capability) => (capability.supports?.unknowableArguments?.length ?? 0) > 0)
        .map((capability) => ({
          capabilityId: capability.id,
          dataTypeId: capability.output.dataTypeId,
          requiresArguments: [...(capability.supports?.unknowableArguments ?? [])],
        })),
      filtering: registeredCatalog.plannerManifest.capabilities.map((capability) => {
        const sourceNarrowingArguments =
          capability.supports?.sourceNarrowingArguments ?? [];
        return {
          capabilityId: capability.id,
          dataTypeId: capability.output.dataTypeId,
          promptReachable: (capability.supports?.unknowableArguments?.length ?? 0) === 0,
          pageScopedFilterFieldCount: capability.supports?.filterFields?.length ?? 0,
          sourceNarrowingArguments: [...sourceNarrowingArguments],
          noSourceNarrowing: sourceNarrowingArguments.length === 0,
        };
      }),
    };
  }

  /**
   * Reads the store and owner key together, failing loudly when a host wired
   * one without the other. Saving without an owner would file every view under
   * the same key and make them mutually readable, so an incomplete
   * configuration must not silently half-work.
   */
  function requireViewStore(): {
    store: ViewStore;
    resolveOwner: (session: Session) => string;
  } {
    if (!config.viewStore) {
      throw new Error("Saved views are not enabled: set ViewServerConfig.viewStore.");
    }
    if (!config.resolveViewOwner) {
      throw new Error(
        "ViewServerConfig.resolveViewOwner is required whenever viewStore is set.",
      );
    }
    return { store: config.viewStore, resolveOwner: config.resolveViewOwner };
  }

  async function saveComposedView({
    catalogId,
    planId,
    label,
    nodeIds,
    request,
  }: {
    catalogId: string;
    planId: string;
    label?: string;
    nodeIds?: readonly string[];
    request: unknown;
  }): Promise<SaveViewResult> {
    const { store: viewStore, resolveOwner } = requireViewStore();
    const session = await config.resolveSession(request);
    // Only a plan this server composed and validated can be saved. Accepting a
    // plan body from the caller here would hand them a way to store an
    // arbitrary plan and have it executed on reopen. And only the visitor who
    // composed it may save it — otherwise holding someone else's `planId` is
    // enough to copy their view, and its `prompt`, into your own saved list.
    // A pin follows the same rule: `nodeIds` names nodes *within* that owned
    // plan, and the slicing below is the only place a stored plan can differ
    // from a composed one.
    const remembered = requireOwnedPlan(planId, catalogId, session, "save");
    let plan = remembered.plan;
    if (nodeIds !== undefined) {
      // Rejects unknown node ids and drops everything the kept nodes don't
      // reference. The new planId keeps the pin's identity distinct from the
      // full view's — the same reason a cache-served plan is re-identified.
      plan = slicePlanToNodes(
        remembered.plan,
        remembered.surfaceId,
        nodeIds,
        `plan-${globalThis.crypto.randomUUID()}`,
      );
      // The slice is validated with the exact pass a composed plan gets, not
      // trusted because its parts once passed. Slicing is deterministic, so a
      // failure here is a bug in the slicer — reported as such rather than
      // stored and discovered as a broken reopen weeks later.
      const registeredCatalog = store.get(catalogId);
      const registeredSite = uiStore.get(catalogId);
      if (!registeredCatalog) {
        throw catalogUnavailableError(catalogId, "capability");
      }
      if (!registeredSite) {
        throw catalogUnavailableError(catalogId, "UI");
      }
      const issues = validateComposedPlan(
        {
          site: registeredSite.site,
          plannerManifest: registeredCatalog.plannerManifest,
          surfaceId: remembered.surfaceId,
        },
        plan,
      );
      if (issues.length > 0) {
        throw new Error(
          `Pinning produced an invalid plan — a bug in the server's slicer, not in this request: ` +
            issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
        );
      }
    }
    const now = new Date().toISOString();
    const view: SavedView = {
      id: `view-${globalThis.crypto.randomUUID()}`,
      catalogId,
      surfaceId: remembered.surfaceId,
      ownerKey: resolveOwner(session),
      prompt: remembered.prompt,
      ...(label ? { label } : {}),
      plan,
      createdAt: now,
      updatedAt: now,
      catalogHash: remembered.catalogHash,
      // Provenance only — replay never reads it. See `SavedView.pinnedFromPlanId`.
      ...(nodeIds !== undefined ? { pinnedFromPlanId: remembered.plan.planId } : {}),
      // Absent when no UI catalog is published for this id, which compose
      // would already have rejected — recorded defensively rather than
      // asserted, since a save has no business failing on it.
      ...(uiStore.get(catalogId)
        ? { siteFingerprint: uiStore.get(catalogId)!.registrationFingerprint }
        : {}),
      // Carried from the composed plan so reopen replays against the same A2UI
      // catalog rather than a recomputed default.
      uiCatalogId: remembered.uiCatalogId,
    };
    await viewStore.save(view);
    return { ok: true, viewId: view.id, createdAt: now };
  }

  async function listSavedViews({
    request,
  }: {
    request: unknown;
  }): Promise<SavedViewSummary[]> {
    const { store, resolveOwner } = requireViewStore();
    const session = await config.resolveSession(request);
    const views = await store.list(resolveOwner(session));
    return views.map((view) => {
      const registered = store2CatalogHash(view.catalogId);
      return {
        id: view.id,
        catalogId: view.catalogId,
        surfaceId: view.surfaceId,
        prompt: view.prompt,
        ...(view.label ? { label: view.label } : {}),
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
        stale: describeDrift(view) !== undefined,
      };
    });
  }

  /** Current hash of a published catalog, or undefined if it is gone. */
  function store2CatalogHash(catalogId: string): string | undefined {
    return store.get(catalogId)?.plannerManifest.catalogHash;
  }

  /**
   * Why a saved view no longer matches what is published, or `undefined` when
   * it still does.
   *
   * Returns the reason rather than a boolean so `reopenSavedView` can say which
   * half drifted when a replay fails. "This view was saved against an older
   * catalog" and "the component this view uses has changed" send a host looking
   * in completely different places.
   *
   * An unknown catalog or missing fingerprint counts as drift: neither can be
   * shown to still match, and asserting freshness on absent evidence is the
   * wrong direction to fail.
   */
  function describeDrift(view: SavedView): string | undefined {
    const currentCatalogHash = store2CatalogHash(view.catalogId);
    if (currentCatalogHash === undefined) {
      return `catalog "${view.catalogId}" is no longer published`;
    }
    if (currentCatalogHash !== view.catalogHash) {
      return `the "${view.catalogId}" capability catalog has changed since this view was saved`;
    }

    const site = uiStore.get(view.catalogId);
    if (!site) return `no UI catalog is published for "${view.catalogId}"`;
    if (view.siteFingerprint === undefined) {
      return "this view was saved before component registrations were fingerprinted";
    }
    if (site.registrationFingerprint !== view.siteFingerprint) {
      return "the host's component registrations have changed since this view was saved";
    }
    return undefined;
  }

  async function deleteSavedView({
    viewId,
    request,
  }: {
    viewId: string;
    request: unknown;
  }): Promise<{ ok: boolean }> {
    const { store: viewStore, resolveOwner } = requireViewStore();
    const session = await config.resolveSession(request);
    return { ok: await viewStore.delete(viewId, resolveOwner(session)) };
  }

  async function reopenSavedView({
    viewId,
    request,
  }: {
    viewId: string;
    request: unknown;
  }): Promise<ComposeResult> {
    const { store: viewStore, resolveOwner } = requireViewStore();
    const session = await config.resolveSession(request);
    const view = await viewStore.get(viewId, resolveOwner(session));
    // Absent covers both "no such view" and "not yours" — see the store's own
    // note on why those are deliberately indistinguishable.
    if (!view) throw new Error(`No saved view "${viewId}".`);

    // Drift is checked before anything is executed, so the failure below can
    // name it as the cause. A drifted view is still *attempted*: a changed
    // catalog usually leaves most of a plan intact, and refusing outright would
    // discard views that would have replayed perfectly.
    const drift = describeDrift(view);

    const registeredCatalog = store.get(view.catalogId);
    const registeredSite = uiStore.get(view.catalogId);
    // Unpublished is the one drift that cannot be attempted — there is nothing
    // to execute against. Returned as a failure rather than thrown: a reopen
    // that can't be served is an outcome a host renders, not an exception it
    // has to catch to keep the page alive.
    if (!registeredCatalog || !registeredSite) {
      return {
        ok: false,
        kind: "unsupported",
        reason:
          drift ??
          `Nothing is published for catalog "${view.catalogId}", so this view cannot be reopened.`,
        issues: [],
      };
    }

    try {
      // Same ceiling as a fresh compose. Replaying a saved view fetches from
      // the same upstreams and was bounded by nothing at all — the budget was
      // never a property of composing, only of fetching.
      const replayStartedAt = Date.now();
      const executedData = await executeWithinBudget(
        replayStartedAt,
        config.composeDeadlineMs ?? DEFAULT_COMPOSE_DEADLINE_MS,
        (signal) =>
          executionContext.run({ request, session }, () =>
            executePlanData({
              plan: view.plan,
              catalog: registeredCatalog.catalog,
              runtimes: registeredCatalog.runtimes,
              signal,
              session,
              host: config.host,
            }),
          ),
      );

      const messages = compilePlanDataSurfaceMessages(registeredSite.site, {
        ...visitorErrorOption,
        plan: view.plan,
        plannerManifest: registeredCatalog.plannerManifest,
        executedData: redactExecutedResults(executedData),
        baseDataModel: {},
        surfaceId: view.surfaceId,
        // Stored with the view. Views saved before this field existed fall back
        // to the derived default, which is what they were reopened with before.
        a2uiCatalogId: view.uiCatalogId ?? `${view.catalogId}:ui`,
        // A stored plan pins the fingerprint of the site it was composed
        // against, so without this every saved view stops replaying the moment a
        // host adds a single component — the pin is there to stop a *fresh* plan
        // being validated against a catalog it wasn't generated from, and for a
        // saved view the mismatch is the expected condition. Every structural
        // check still runs, so a plan whose components no longer fit still
        // fails, on the specific thing that no longer fits.
        allowCatalogDrift: true,
      });

      // `cached` is false because no plan cache was consulted — the plan came
      // from durable storage, and the data behind it was fetched just now.
      return {
        ok: true,
        catalogId: view.catalogId,
        cached: false,
        deadlineMs: config.composeDeadlineMs ?? DEFAULT_COMPOSE_DEADLINE_MS,
        planId: view.plan.planId,
        requests: summarizeRequests(view.plan, executedData),
        messages,
        // Replayed successfully, but against something other than what it was
        // built on. Individual data slots degrade on their own (a withdrawn
        // capability fails that slot, not the view), so "it rendered" does not
        // mean "it is the same view" — a host that shows this can badge it
        // instead of quietly presenting an older answer as current.
        ...(drift ? { stale: true as const, staleReason: drift } : {}),
      };
    } catch (cause) {
      // A stored plan can reference a component or field the published site no
      // longer has, and compilation throws on it. Left uncaught, reopening one
      // stale view took down the request with a message about an unknown
      // component id and no hint that the view was simply old.
      const detail = cause instanceof Error ? cause.message : String(cause);
      return {
        ok: false,
        kind: "invalid",
        reason: drift
          ? `This view can no longer be replayed: ${drift}. (${detail})`
          : `This view could not be replayed: ${detail}`,
        issues: [],
      };
    }
  }

  async function refineComposedView({
    catalogId,
    planId,
    operations,
    request,
  }: {
    catalogId: string;
    planId: string;
    operations: readonly RefineOperation[];
    request: unknown;
  }): Promise<ComposeResult> {
    const session = await config.resolveSession(request);
    const remembered = requireOwnedPlan(planId, catalogId, session, "refine");
    const registeredCatalog = store.get(catalogId);
    if (!registeredCatalog) {
      throw catalogUnavailableError(catalogId, "capability");
    }
    const registeredSite = uiStore.get(catalogId);
    if (!registeredSite) {
      throw catalogUnavailableError(catalogId, "UI");
    }

    const refined = applyRefineOperations(
      remembered.plan,
      operations,
      remembered.surfaceId,
    );
    if (!refined.ok) {
      return { ok: false, kind: "invalid", reason: refined.reason, issues: [] };
    }

    // A refinement is visitor input, so its queries get the same catalog check
    // a model-produced plan gets. Without this, a hand-built filter could sort
    // or filter on a field the catalog never approved for querying.
    const issues: DataPlanIssue[] = [];
    for (const [index, dataRequest] of (refined.plan.dataRequests ?? []).entries()) {
      const validation = validateDataRequestQuery(
        registeredCatalog.plannerManifest,
        dataRequest as never,
      );
      if (!validation.ok) {
        issues.push(
          ...validation.issues.map((issue) => ({
            path: `dataRequests.${index}.${issue.path}`,
            message: issue.message,
          })),
        );
      }
    }
    if (issues.length > 0) {
      // The issue messages ride in `reason` as well as in host-only `issues`:
      // they are plan-constraint sentences built from catalog vocabulary the
      // visitor already sees ("Limit 5000 exceeds capability maximum 100"),
      // never data — and a refinement is the visitor's own click, so the one
      // sentence that lets them correct it must be the one they are shown.
      return {
        ok: false,
        kind: "invalid",
        reason: `The refined view is not valid against the approved catalog: ${issues
          .map((issue) => issue.message)
          .join("; ")}`,
        issues,
      };
    }

    // `session` is already resolved above, for the ownership check.
    const refineStartedAt = Date.now();
    const executedData = await executeWithinBudget(
      refineStartedAt,
      config.composeDeadlineMs ?? DEFAULT_COMPOSE_DEADLINE_MS,
      (signal) =>
        executionContext.run({ request, session }, () =>
          executePlanData({
            plan: refined.plan,
            catalog: registeredCatalog.catalog,
            runtimes: registeredCatalog.runtimes,
            signal,
            session,
            host: config.host,
          }),
        ),
    );

    const messages = compilePlanDataSurfaceMessages(registeredSite.site, {
      ...visitorErrorOption,
      plan: refined.plan,
      plannerManifest: registeredCatalog.plannerManifest,
      executedData: redactExecutedResults(executedData),
      baseDataModel: {},
      surfaceId: remembered.surfaceId,
      // From the remembered plan, not recomputed. Recomputing the default here
      // meant a host that overrode `uiCatalogId` got a working first compose and
      // an empty surface on every refinement, with no error to follow.
      a2uiCatalogId: remembered.uiCatalogId,
    });

    // Remembered so a refinement can itself be refined again or saved, which
    // is what makes successive adjustments feel like one continuous view.
    rememberPlan({
      plan: refined.plan,
      catalogId,
      surfaceId: remembered.surfaceId,
      prompt: remembered.prompt,
      catalogHash: registeredCatalog.plannerManifest.catalogHash,
      uiCatalogId: remembered.uiCatalogId,
      // Carried from the source plan rather than re-derived: a refinement
      // inherits the original visitor's ownership, and the lookup above has
      // already established that this caller is that visitor.
      ...(remembered.ownerKey !== undefined ? { ownerKey: remembered.ownerKey } : {}),
    });

    // A raised limit can only grow the view as far as one fetch reaches. When
    // fewer rows than the limit arrived and the set provably continues, saying
    // nothing presents "all one fetch returns" as "all there is" — the visitor
    // raised 5 to 50, got 5, and the same response knew 2500 exist.
    const notices: string[] = [];
    for (const dataRequest of refined.plan.dataRequests ?? []) {
      const limit = dataRequest.query?.limit;
      if (typeof limit !== "number") continue;
      const result = executedData.results[dataRequest.requestId];
      if (!result?.ok || !Array.isArray(result.data)) continue;
      if (result.data.length >= limit) continue;
      const provenance = result.provenance;
      const knownIncomplete =
        provenance.moreAvailable === true ||
        provenance.truncated === true ||
        provenance.narrowedAfterFetch === true;
      if (!knownIncomplete) continue;
      notices.push(
        `Limit ${limit} could only be filled to ${result.data.length} row(s): more rows ` +
          `exist${
            provenance.totalRowsBeforeTruncation !== undefined
              ? ` (${provenance.totalRowsBeforeTruncation} in total)`
              : ""
          }, but refining cannot load beyond what one fetch returns here. Ask again to compose a view that reaches more of them.`,
      );
    }

    // A refinement produces a *new* planId (see `applyRefineOperations`), so a
    // client that refines twice chains from the latest view rather than
    // repeatedly re-refining the original.
    return {
      ok: true,
      catalogId,
      cached: false,
      planId: refined.plan.planId,
      requests: summarizeRequests(refined.plan, executedData),
      messages,
      ...(notices.length > 0 ? { notices } : {}),
    };
  }

  return {
    classifyOperations,
    suggestSemanticTypes,
    proposeFieldSelection,
    loadReviewExport,
    listCatalogHistory,
    rollbackPublishedCatalog,
    deletePublishedCatalog,
    probePublishedCatalog,
    publishReviewedCatalog,
    listPublishedCatalogs,
    publishUiCatalog,
    listPublishedSites,
    listPlanProviders,
    planAgainstPublishedCatalog,
    composeAgainstPublishedCatalogs,
    getCoverageReport,
    describePlanningWiring: describeWiring,
    saveComposedView,
    reopenSavedView,
    listSavedViews,
    deleteSavedView,
    refineComposedView,
    restorePublishedCatalogs,
  } as ViewServer<Session>;
}
