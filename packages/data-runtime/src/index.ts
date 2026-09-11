import {
  canPushFilter,
  canPushOrdering,
  validateCapabilityPreflight,
  validateCapabilityResult,
  type CapabilityRuntime,
} from "@renderyes/capability-catalog/server";
import {
  DEFAULT_MAX_ROWS,
  NUMERIC_SEMANTIC_TYPES,
  createPlannerManifest,
  declaredFieldEnumValues,
  effectiveLimitCeiling,
  findCapability,
  hashCapabilityCatalog,
  pagingArgumentCap,
  type CapabilityCatalog,
  type CapabilityExecutionResult,
  type DataProvenance,
  type PlannerManifest,
} from "@renderyes/capability-catalog";
import type {
  CapabilityCatalogReference,
  DataRequest,
  FilterCondition,
  FilterGroup,
  FilterOperator,
  JsonPrimitive,
  PlanV3_1,
  QuerySpec,
} from "@renderyes/core";
import { validateQuerySpec } from "@renderyes/core";
import { applyValidatedQuery, firstOrderingViolation, isRow } from "./query.js";
import { composeExecutedData, type CompositionResult } from "./compose.js";
import { joinExecutedData, type JoinResult } from "./join.js";
export * from "./compose.js";
export * from "./join.js";
export * from "./openapi-adapter.js";
export * from "./registry.js";
// The planning contract moved to `@renderyes/capability-catalog` (see the
// note on `createDataPlanningContract` there); re-exported so this package's
// public surface is unchanged.
export {
  DEFAULT_MAX_ROWS,
  createDataPlanningContract,
} from "@renderyes/capability-catalog";
export type { DataPlanningContract } from "@renderyes/capability-catalog";

type MaybePromise<T> = T | Promise<T>;

export interface QueryIssue {
  path: string;
  message: string;
}

export type QueryValidationResult = { ok: true } | { ok: false; issues: QueryIssue[] };

// Type-aware operator compatibility, keyed off the catalog field semanticType.
const ORDERED_OPERATORS = new Set<FilterOperator>(["gt", "gte", "lt", "lte", "between"]);
const TEXT_OPERATORS = new Set<FilterOperator>(["contains", "starts-with", "ends-with"]);
const ORDERED_TYPES = new Set(["money", "quantity", "percentage", "date", "date-time"]);
const TEXT_TYPES = new Set(["text", "rich-text", "url", "identifier", "status"]);

/**
 * Operators for which a declared `allowedValues` list is the complete set of
 * legal values.
 *
 * Equality and membership only. `contains`/`starts-with`/`ends-with` take a
 * substring, and "sta" is a perfectly sensible substring query against a status
 * enum of `["started", "stalled"]` — enforcing membership there would reject
 * valid plans. `is-null`/`is-not-null` carry no value at all. Range operators
 * are excluded for the same reason: a bound need not itself be a member.
 */
const ENUMERATED_VALUE_OPERATORS = new Set<FilterOperator>([
  "eq",
  "not-eq",
  "in",
  "not-in",
]);

/**
 * Checks a filter value against the field's declared enum.
 *
 * The catalog's `allowedValues` reached the model as advice in the planner
 * manifest and was enforced nowhere, so a plan filtering `status eq "Open"`
 * against an enum of `["open", "closed"]` executed happily and returned zero
 * rows. An empty result is indistinguishable from a correct answer, which is the
 * worst way for this to fail: the visitor sees "no tickets" and believes it.
 */
function allowedValueIssues(
  condition: FilterCondition,
  nodePath: string,
  allowed: ReadonlySet<JsonPrimitive> | undefined,
): QueryIssue[] {
  if (!allowed || !ENUMERATED_VALUE_OPERATORS.has(condition.operator)) return [];
  if (!("value" in condition) || condition.value === undefined) return [];

  // `in`/`not-in` carry a list; every member has to be legal.
  const candidates = Array.isArray(condition.value) ? condition.value : [condition.value];
  const rejected = candidates.filter(
    (candidate) => !allowed.has(candidate as JsonPrimitive),
  );
  if (rejected.length === 0) return [];

  const legal = [...allowed].map((value) => JSON.stringify(value)).join(", ");
  return [
    {
      path: `${nodePath}.value`,
      message:
        `Value ${rejected.map((value) => JSON.stringify(value)).join(", ")} is not an ` +
        `allowed value for field "${condition.field}". Allowed: ${legal}`,
    },
  ];
}

function operatorAllowedForType(operator: FilterOperator, semanticType: string): boolean {
  if (ORDERED_OPERATORS.has(operator)) return ORDERED_TYPES.has(semanticType);
  if (TEXT_OPERATORS.has(operator)) return TEXT_TYPES.has(semanticType);
  // eq/not-eq/in/not-in/is-null/is-not-null apply to any type.
  return true;
}


/**
 * Semantically checks model-selected query fields against the exact
 * planner-safe manifest. This does not execute the query.
 */
export function validateDataRequestQuery(
  manifest: PlannerManifest,
  request: DataRequest,
): QueryValidationResult {
  if (!request.query) return { ok: true };

  const structural = validateQuerySpec(request.query);
  if (!structural.ok) {
    return {
      ok: false,
      issues: structural.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    };
  }
  const query = structural.query;
  const capability = manifest.capabilities.find(
    (candidate) => candidate.id === request.capabilityId,
  );
  if (!capability) {
    return {
      ok: false,
      issues: [
        {
          path: "capabilityId",
          message: `Unknown planner capability "${request.capabilityId}"`,
        },
      ],
    };
  }

  const issues: QueryIssue[] = [];
  const allowedFilterFields = new Set(capability.supports?.filterFields ?? []);
  const allowedSortFields = new Set(capability.supports?.sortFields ?? []);
  const dataType = manifest.dataTypes.find(
    (candidate) => candidate.id === capability.output.dataTypeId,
  );
  const allowedProjectionFields = new Set(Object.keys(dataType?.fields ?? {}));
  const fieldSemanticType = (field: string): string | undefined =>
    (dataType?.fields as Record<string, { semanticType?: string }> | undefined)?.[field]
      ?.semanticType;
  // `declaredFieldEnumValues` is the same derivation `createDataPlanningContract`
  // uses for the `allowedValues` it shows the model, so validation enforces
  // exactly the list the model was given rather than a second, independently-
  // computed one.
  const fieldAllowedValues = (field: string): ReadonlySet<JsonPrimitive> | undefined => {
    if (!dataType) return undefined;
    const values = declaredFieldEnumValues(dataType, field);
    return values ? new Set(values as JsonPrimitive[]) : undefined;
  };

  const walkFilter = (group: FilterGroup, path: string): void => {
    for (const [index, node] of group.conditions.entries()) {
      const nodePath = `${path}.conditions.${index}`;
      if ("combine" in node) {
        walkFilter(node, nodePath);
        continue;
      }
      if (!allowedFilterFields.has(node.field)) {
        issues.push({
          path: `${nodePath}.field`,
          message: `Capability "${capability.id}" does not advertise filter field "${node.field}"`,
        });
        continue;
      }
      const semanticType = fieldSemanticType(node.field);
      if (semanticType && !operatorAllowedForType(node.operator, semanticType)) {
        issues.push({
          path: `${nodePath}.operator`,
          message: `Operator "${node.operator}" is not valid for ${semanticType} field "${node.field}"`,
        });
      }
      for (const issue of allowedValueIssues(
        node,
        nodePath,
        fieldAllowedValues(node.field),
      )) {
        issues.push(issue);
      }
    }
  };
  if (query.filter) {
    walkFilter(query.filter, "query.filter");
  }

  // Grouping + aggregation. When present, the query's output columns become the
  // group-by fields plus the aggregate output names, and sort/project validate
  // against those instead of the source fields.
  const allowedGroupFields = new Set(capability.supports?.groupFields ?? []);
  const allowedAggregateOps = new Set(capability.supports?.aggregates ?? []);
  const outputColumns = new Set<string>();
  const isAggregating = Boolean(query.groupBy?.length || query.aggregates?.length);

  for (const [index, field] of (query.groupBy ?? []).entries()) {
    if (!allowedGroupFields.has(field)) {
      issues.push({
        path: `query.groupBy.${index}`,
        message: `Capability "${capability.id}" does not advertise group field "${field}"`,
      });
    }
    outputColumns.add(field);
  }
  for (const [index, aggregate] of (query.aggregates ?? []).entries()) {
    const aggPath = `query.aggregates.${index}`;
    if (!allowedAggregateOps.has(aggregate.op)) {
      issues.push({
        path: `${aggPath}.op`,
        message: `Capability "${capability.id}" does not advertise aggregate "${aggregate.op}"`,
      });
    }
    if (aggregate.op !== "count") {
      const field = aggregate.field ?? "";
      const semanticType = fieldSemanticType(field);
      if (!allowedProjectionFields.has(field)) {
        issues.push({
          path: `${aggPath}.field`,
          message: `Output data type "${capability.output.dataTypeId}" does not expose field "${field}"`,
        });
      } else if (!semanticType || !NUMERIC_SEMANTIC_TYPES.has(semanticType)) {
        issues.push({
          path: `${aggPath}.field`,
          message: `Aggregate "${aggregate.op}" requires a numeric field, not ${semanticType ?? "unknown"} "${field}"`,
        });
      }
    }
    outputColumns.add(aggregate.as);
  }

  for (const [index, sort] of (query.sort ?? []).entries()) {
    const allowed = isAggregating
      ? outputColumns.has(sort.field)
      : allowedSortFields.has(sort.field);
    if (!allowed) {
      issues.push({
        path: `query.sort.${index}.field`,
        message: isAggregating
          ? `Sort field "${sort.field}" is not an aggregated output column`
          : `Capability "${capability.id}" does not advertise sort field "${sort.field}"`,
      });
    }
  }
  for (const [index, field] of (query.project ?? []).entries()) {
    const allowed = isAggregating
      ? outputColumns.has(field)
      : allowedProjectionFields.has(field);
    if (!allowed) {
      issues.push({
        path: `query.project.${index}`,
        message: isAggregating
          ? `Projection field "${field}" is not an aggregated output column`
          : `Output data type "${capability.output.dataTypeId}" does not expose field "${field}"`,
      });
    }
  }
  if (query.offset !== undefined && !capability.supports?.pagination) {
    issues.push({
      path: "query.offset",
      message: `Capability "${capability.id}" does not support pagination`,
    });
  }
  // The same effective ceiling `createDataPlanningContract` advertises as the
  // `limit` maximum, including the `DEFAULT_MAX_ROWS` fallback.
  //
  // This used to check `maximumRows` only when a capability declared one, so a
  // capability without that constraint accepted any limit at all — and then
  // `applyRowBudget` silently cut the result to the default. A plan asking for
  // 50,000 rows was accepted, returned 1,000, and the component rendered them
  // with nothing to indicate it wasn't the whole answer. Validation now enforces
  // exactly what the model was told the bound was, so the plan is rejected and
  // repaired instead of quietly answering a different question.
  const effectiveMaximumRows = effectiveLimitCeiling(capability);
  if (query.limit !== undefined && query.limit > effectiveMaximumRows) {
    issues.push({
      path: "query.limit",
      message:
        capability.constraints.maximumRows !== undefined ||
        pagingArgumentCap(capability.inputSchema) !== undefined
          ? `Limit ${query.limit} exceeds capability maximum ${effectiveMaximumRows}`
          : `Limit ${query.limit} exceeds the default maximum of ${DEFAULT_MAX_ROWS} rows for capabilities that declare no maximumRows`,
    });
  }

  return issues.length ? { ok: false, issues } : { ok: true };
}

export type ExecutionFailureCode =
  | "DATA_CATALOG_MISMATCH"
  | "UNKNOWN_CAPABILITY"
  | "INVALID_QUERY"
  | "RUNTIME_NOT_FOUND"
  | "AUTHENTICATION_REQUIRED"
  | "PERMISSION_DENIED"
  | "MISSING_IDENTITY"
  /**
   * The capability and its runtime disagree in a way no session could satisfy —
   * currently, identity-scoped results bound to a runtime that cannot forward
   * identity. Distinct from `MISSING_IDENTITY`, which a different session would
   * fix; this one is the deployment's own wiring and every session hits it.
   */
  | "CONFIGURATION_ERROR"
  | "INVALID_PARAMS"
  | "RATE_LIMITED"
  | "ABORTED"
  | "TIMEOUT"
  | "RUNTIME_ERROR"
  | "INVALID_RUNTIME_RESULT"
  /**
   * The plan aggregates over a result the upstream cut short. Refused because
   * an aggregate over a partial dataset is not a partial answer — it is a
   * plausible-looking wrong one, and no `truncated` footnote fixes a number
   * that was computed over the wrong rows.
   */
  | "TRUNCATED_AGGREGATION"
  /**
   * The ordering the host declared was sent to the source, and the rows came
   * back in some other order — so the declared grammar is not the grammar the
   * upstream parses, and it ignored what it could not read.
   *
   * Refused for the same reason as `TRUNCATED_AGGREGATION`: the executor
   * pushed the plan's limit alongside the ordering because ordering at the
   * source is what makes that safe, so what came back is not a
   * differently-ordered answer, it is the wrong rows. A declaration is
   * trustworthy exactly as far as it is checked, and this is the check.
   */
  | "ORDERING_NOT_APPLIED";

export interface ExecutionFailure {
  ok: false;
  error: {
    code: ExecutionFailureCode;
    message: string;
    retryable: boolean;
  };
}

export type ExecutionResult = CapabilityExecutionResult<unknown> | ExecutionFailure;

export interface ExecutionAuditEvent {
  planId?: string;
  requestId: string;
  capabilityId: string;
  outcome: "succeeded" | "failed";
  failureCode?: string;
  durationMs: number;
}

/**
 * The only adapter allowed to inspect the complete host session. The executor
 * asks for authentication, required permissions, and individual declared
 * session keys; it never forwards the session object to a capability runtime.
 */
export interface TrustedExecutionHost<Session> {
  /** Whether this session is signed in at all. Asked before any `session` capability runs. */
  isAuthenticated(session: Session): MaybePromise<boolean>;
  /**
   * Whether this session holds one permission a capability declared in
   * `policy.requiredPermissions`. Asked once per declared permission, and a
   * single `false` refuses the request.
   */
  hasPermission(session: Session, permission: string): MaybePromise<boolean>;
  /**
   * One declared session key's value — the identity a capability is scoped by.
   *
   * Returns `unknown` because the key is a runtime string from the catalog and
   * only the host knows what it holds: a user id here, a tenant id there, an
   * account number somewhere else. The executor never inspects the value; it
   * passes it to the capability's own identity argument, so the shape is an
   * agreement between the host and its own catalog rather than something this
   * package could type.
   */
  getSessionValue(session: Session, requiredSessionKey: string): MaybePromise<unknown>;
  /**
   * An optional last veto, after authentication and permissions have passed.
   *
   * For policy this package cannot express as a declared permission — a
   * per-tenant feature flag, a rate decision, a capability disabled during an
   * incident. Returning `false` refuses that one request without failing the
   * rest of the plan.
   */
  allowExecution?(input: {
    session: Session;
    requestId: string;
    capabilityId: string;
  }): MaybePromise<boolean>;
  /**
   * Called once per capability execution, after it settles, with the outcome
   * and duration. The hook a host wires their own audit log or metrics to; it
   * never receives rows or session values.
   */
  audit?(event: ExecutionAuditEvent): MaybePromise<void>;
}

export interface DataExecutorOptions {
  /** Used when a capability does not declare timeoutMs. Defaults to 10 seconds. */
  defaultTimeoutMs?: number;
  /** Caps both catalog and default timeouts. Defaults to 30 seconds. */
  maximumTimeoutMs?: number;
  /**
   * Composition row budget. Caps combined input rows and merged output rows so a
   * multi-dataset composition cannot blow up memory. Defaults to 5000.
   */
  maxComposedRows?: number;
  /**
   * Most capability requests to run at once. Defaults to
   * `DEFAULT_MAX_CONCURRENT_REQUESTS`.
   *
   * A plan's requests were previously all issued together, so a plan naming
   * twelve capabilities opened twelve simultaneous upstream connections. That
   * is the host's own API being hit by its own feature, and the visitor sees
   * the slowest of them regardless — bounding it trades no real latency for a
   * predictable ceiling on load.
   */
  maxConcurrentRequests?: number;
  /**
   * Hard ceiling on rows returned for one data request, applied after
   * validation and after the query runs. Defaults to `DEFAULT_MAX_ROWS`.
   *
   * The planner's `limit` bounds what a plan may *ask* for, which is not the
   * same as what an upstream returns: a capability that ignores paging, or one
   * whose collection grew past what the catalog assumed, hands back everything
   * it has. That payload then crosses the wire to a browser and gets rendered.
   * This bounds the result rather than the request.
   *
   * Truncation is reported, never silent — `provenance.truncated` and
   * `provenance.totalRowsBeforeTruncation` let a component say "showing the
   * first N" instead of quietly presenting a partial answer as a whole one.
   */
  maxRowsPerRequest?: number;
  /** Clock injection, so freshness and timeout behaviour can be tested without waiting. */
  now?: () => number;
}

/**
 * Default ceiling on simultaneous capability requests. Six matches what
 * browsers historically allowed per host: enough that an ordinary
 * three-or-four-capability view still runs fully in parallel, low enough that
 * a pathological plan cannot storm an upstream.
 */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 6;

/**
 * Runs `task` over every item with at most `limit` in flight.
 *
 * Results keep input order regardless of completion order, because callers
 * index them positionally. Rejections propagate like `Promise.all` — this
 * bounds concurrency and changes nothing about error semantics.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length <= 1 || limit <= 1) {
    const sequential: R[] = [];
    for (const item of items) sequential.push(await task(item));
    return sequential;
  }
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface ExecuteDataRequestInput<Session> {
  request: DataRequest;
  dataCatalog: CapabilityCatalogReference;
  catalog: CapabilityCatalog;
  runtimes: ReadonlyMap<string, CapabilityRuntime>;
  session: Session;
  host: TrustedExecutionHost<Session>;
  signal?: AbortSignal;
  planId?: string;
  options?: DataExecutorOptions;
}

export interface ExecutePlanDataInput<Session> {
  plan: PlanV3_1;
  catalog: CapabilityCatalog;
  runtimes: ReadonlyMap<string, CapabilityRuntime>;
  session: Session;
  host: TrustedExecutionHost<Session>;
  signal?: AbortSignal;
  options?: DataExecutorOptions;
  /**
   * Called as each request settles, rather than only when all of them have.
   *
   * Requests run concurrently and finish out of order, so without this the
   * caller learns nothing until the slowest one returns — which is precisely
   * the wait a streaming compose exists to break up. A row that took 300ms
   * should reach the visitor then, not after the 40-second one beside it.
   *
   * Never receives a rejection: a failed request is an `ExecutionResult` with
   * `ok: false`, the same value it occupies in `results`. A throw from this
   * callback would fail the whole execution, so callers must not let one out.
   */
  onRequestSettled?: (requestId: string, result: ExecutionResult) => void;
  /**
   * Called as each request is dispatched. Fires when a concurrency slot frees,
   * not when the plan is read, so the gap between this and `onRequestSettled`
   * is the request's own duration rather than its time spent queued.
   */
  onRequestStarted?: (requestId: string) => void;
}

export interface ExecutedPlanData {
  planId: string;
  results: Record<string, ExecutionResult>;
}

export async function executeDataRequest<Session>(
  input: ExecuteDataRequestInput<Session>,
): Promise<ExecutionResult> {
  const startedAt = (input.options?.now ?? Date.now)();
  let result: ExecutionResult;

  try {
    result = await executeTrusted(input);
  } catch {
    result = failure("RUNTIME_ERROR", "Capability execution failed", true);
  }

  await auditSafely(input, result, startedAt);
  return result;
}

export async function executePlanDataRequests<Session>(
  input: ExecutePlanDataInput<Session>,
): Promise<ExecutedPlanData> {
  const entries = await mapWithConcurrency(
    input.plan.dataRequests,
    input.options?.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
    async (request) => {
      input.onRequestStarted?.(request.requestId);
      const result = await executeDataRequest({
        request,
        dataCatalog: input.plan.dataCatalog,
        catalog: input.catalog,
        runtimes: input.runtimes,
        session: input.session,
        host: input.host,
        signal: input.signal,
        planId: input.plan.planId,
        options: input.options,
      });
      input.onRequestSettled?.(request.requestId, result);
      return [request.requestId, result] as const;
    },
  );

  return {
    planId: input.plan.planId,
    results: Object.fromEntries(entries),
  };
}

export interface ExecutedPlanDataWithCompositions extends ExecutedPlanData {
  compositions: Record<string, CompositionResult>;
  joins: Record<string, JoinResult>;
}

/**
 * Runs every request, then applies the plan's declared compositions
 * (union/intersection/difference) and relationship joins over the per-request
 * results. Both are pure steps layered on top of execution; the two-channel and
 * trust boundaries in executeDataRequest are unchanged.
 */
export async function executePlanData<Session>(
  input: ExecutePlanDataInput<Session>,
): Promise<ExecutedPlanDataWithCompositions> {
  const executed = await executePlanDataRequests(input);
  const compositions = composeExecutedData({
    plan: input.plan,
    executed,
    catalog: input.catalog,
    options: input.options,
  });
  const joins = joinExecutedData({
    plan: input.plan,
    executed,
    catalog: input.catalog,
    options: input.options,
  });
  return { ...executed, compositions, joins };
}

async function executeTrusted<Session>(
  input: ExecuteDataRequestInput<Session>,
): Promise<ExecutionResult> {
  // `RUNTIME_NOT_FOUND` below already answers "this capability has no runtime".
  // This answers "there is no runtime map at all", which is a different
  // mistake with a much worse report: `input.runtimes.get(...)` throws a
  // TypeError, the outer catch turns any throw into RUNTIME_ERROR, and a
  // caller passing the wrong key is told the data request failed and is worth
  // retrying. A host's retry logic then repeats a call that can never succeed.
  if (typeof (input.runtimes as { get?: unknown } | undefined)?.get !== "function") {
    return failure(
      "RUNTIME_NOT_FOUND",
      "ExecuteDataRequestInput.runtimes must be a Map of capabilityId to runtime. " +
        "This is a caller mistake, not a data failure: nothing was executed.",
      false,
    );
  }

  const expectedHash = hashCapabilityCatalog(input.catalog);
  if (
    input.dataCatalog.id !== input.catalog.id ||
    input.dataCatalog.version !== input.catalog.version ||
    input.dataCatalog.hash !== expectedHash
  ) {
    return failure(
      "DATA_CATALOG_MISMATCH",
      "The plan capability catalog does not match the registered server catalog",
      false,
    );
  }

  const capability = findCapability(input.catalog, input.request.capabilityId);
  if (!capability) {
    return failure(
      "UNKNOWN_CAPABILITY",
      `Unknown capability "${input.request.capabilityId}"`,
      false,
    );
  }

  const queryValidation = validateDataRequestQuery(
    createPlannerManifest(input.catalog),
    input.request,
  );
  if (!queryValidation.ok) {
    return failure(
      "INVALID_QUERY",
      queryValidation.issues.map((issue) => issue.message).join("; "),
      false,
    );
  }

  const runtime = input.runtimes.get(capability.id);
  if (!runtime || runtime.capabilityId !== capability.id) {
    return failure(
      "RUNTIME_NOT_FOUND",
      `No trusted runtime is registered for "${capability.id}"`,
      false,
    );
  }

  if (
    capability.policy.authentication === "session" &&
    !(await input.host.isAuthenticated(input.session))
  ) {
    return failure(
      "AUTHENTICATION_REQUIRED",
      "Authentication is required for this data request",
      false,
    );
  }

  const permissions = new Set<string>();
  for (const permission of capability.policy.requiredPermissions ?? []) {
    if (!(await input.host.hasPermission(input.session, permission))) {
      // The bare sentence is true about the resolved session and a false lead
      // about the cause. A host that resolves permissions by asking its own API
      // resolves *none* when the visitor's credential is rejected — a token that
      // expired while the page sat open is still an authenticated session, just
      // an empty one — and the visitor is then told they lack a permission they
      // hold. Naming the other cause costs nothing and is where the time goes.
      return failure(
        "PERMISSION_DENIED",
        `Missing required permission "${permission}". If the visitor should hold it, ` +
          `check that their credential still authenticates upstream: a rejected or ` +
          `expired token usually resolves to a session with no permissions at all, ` +
          `which is indistinguishable here from one permission being absent.`,
        false,
      );
    }
    permissions.add(permission);
  }

  // A capability whose results are declared identity-scoped, bound to a runtime
  // that cannot act on identity, is a misconfiguration and not a request to
  // answer. Refusing is the only safe reading: the alternative is returning
  // every row the upstream will serve, under the name of a capability the
  // catalog says is scoped to one user — an over-broad answer that looks
  // exactly like a correct one.
  if (capability.requiredSessionKeys.length > 0 && runtime.forwardsIdentity === false) {
    return failure(
      "CONFIGURATION_ERROR",
      `Capability "${capability.id}" requires trusted session keys ` +
        `(${capability.requiredSessionKeys.join(", ")}) but its runtime cannot forward them ` +
        "to the upstream, so its results would not be scoped to the session. Supply the " +
        "runtime with a way to use identity, or remove requiredSessionKeys from the capability.",
      false,
    );
  }

  const identity: Record<string, unknown> = {};
  for (const key of capability.requiredSessionKeys) {
    const value = await input.host.getSessionValue(input.session, key);
    if (value === undefined) {
      return failure(
        "MISSING_IDENTITY",
        `Missing required trusted session key "${key}"`,
        false,
      );
    }
    identity[key] = value;
  }

  if (
    input.host.allowExecution &&
    !(await input.host.allowExecution({
      session: input.session,
      requestId: input.request.requestId,
      capabilityId: capability.id,
    }))
  ) {
    return failure("RATE_LIMITED", "The data request is temporarily rate limited", true);
  }

  const preflight = validateCapabilityPreflight(
    input.catalog,
    capability.id,
    input.request.params,
    { identity, permissions },
  );
  if (!preflight.ok) {
    return failure(
      "INVALID_PARAMS",
      preflight.issues.map((issue) => issue.message).join("; "),
      false,
    );
  }

  // Ordering reaches the source only when the host declared how this upstream
  // spells one and the plan's terms are ones that spelling can carry. Asked
  // once, here, so the same answer decides all three things that follow: what
  // the runtime is sent, whether the limit may ride along, and whether the
  // result gets reported as ordered beyond the fetched page.
  const pushesOrdering = canPushOrdering(runtime.ordering, input.request.query?.sort);
  // Whether the plan's narrowing reaches the database or runs here over one
  // fetched page. It used to always run here, while the planner was separately
  // offered the upstream's own filter argument in `params` and left to choose
  // between them — so seven matching articles out of five hundred could arrive
  // as zero rows, reported as a success. The choice is not the planner's; it is
  // this line.
  const pushesFilter = canPushFilter(runtime.filter, input.request.query?.filter);

  const timeoutMs = effectiveTimeout(capability.policy.timeoutMs, input.options);
  const executionSignal = createExecutionSignal(input.signal, timeoutMs);
  try {
    const runtimeResult = await raceWithAbort(
      runtime.execute(input.request.params, {
        identity: Object.freeze({ ...identity }),
        signal: executionSignal.signal,
        // The plan's own limit, so a runtime that can push paging upstream
        // does. `applyValidatedQuery` and the row budget below still run: this
        // narrows what is fetched, it does not replace what bounds it.
        //
        // Pushed only when the limit is the sole list operation. Every other
        // operation runs *before* the limit in `applyValidatedQuery`, so the
        // limit bounds the derived set, not the fetch: pushing it under a
        // filter turned `number == "2486", limit: 1` into "fetch the newest
        // row and filter it", which reports any record outside that one row
        // as nonexistent.
        ...(typeof input.request.query?.limit === "number" &&
        limitBoundsFetch(input.request.query, pushesOrdering, pushesFilter)
          ? { limit: input.request.query.limit }
          : {}),
        // The plan's ordering terms, never a rendered ordering expression: the
        // runtime holds the grammar its host declared and writes the value.
        ...(pushesOrdering ? { sort: input.request.query?.sort } : {}),
        // The plan's typed conditions, never a compiled filter expression: the
        // runtime holds its own schema's operator names and writes the value.
        ...(pushesFilter ? { filter: input.request.query?.filter } : {}),
      }),
      executionSignal.signal,
    );
    const validation = validateCapabilityResult(
      input.catalog,
      capability.id,
      runtimeResult,
    );
    if (!validation.ok) {
      return failure(
        "INVALID_RUNTIME_RESULT",
        "The capability runtime returned data that failed its approved contract",
        false,
      );
    }
    if (!runtimeResult.ok) return runtimeResult;
    // Applied whether or not the plan carried a query: an upstream that
    // ignores paging returns everything it has, and a plan with no `limit` is
    // exactly the case with nothing else bounding it.
    //
    // A null result — an entity lookup that matched nothing — skips query
    // application entirely: every operation applies vacuously to no record,
    // and running them used to convert a valid "no such record" into an
    // INVALID_QUERY error on its way to the visitor.
    if (runtimeResult.data === null) return runtimeResult;
    if (!input.request.query) return applyRowBudget(runtimeResult, input.options);
    // An aggregate over a truncated result is not a smaller answer, it is a
    // wrong one: "count by status" over the one page a capped upstream returned
    // reports the page's counts as the dataset's. Every other failure this
    // executor guards against is visible in some way — this one produces a
    // clean number that looks exactly like the answer. Refused rather than
    // footnoted, because `truncated: true` next to an aggregate does not mean
    // "these counts cover part of the data", it means the counts are wrong.
    //
    // `moreAvailable` alone does not trip this: a plan that asked for the top
    // 10 and aggregates over them got precisely what it asked for.
    if (
      (input.request.query.groupBy?.length || input.request.query.aggregates?.length) &&
      runtimeResult.provenance.truncated === true
    ) {
      return failure(
        "TRUNCATED_AGGREGATION",
        `Aggregating "${capability.id}" would compute over ${
          Array.isArray(runtimeResult.data) ? runtimeResult.data.length : "a subset of"
        } fetched rows while the upstream holds more${
          runtimeResult.provenance.totalRowsBeforeTruncation !== undefined
            ? ` (${runtimeResult.provenance.totalRowsBeforeTruncation} in total)`
            : ""
        }; the result would look like an answer and be wrong. Narrow the question with a filter, or raise the capability's page allowance.`,
        false,
      );
    }
    // A declared ordering grammar is trustworthy exactly as far as it is
    // checked, and this is the only place it can be. The grammar lives outside
    // the schema, so nothing at compile time can tell a correct spelling from a
    // plausible one — and the failure mode is silence: an upstream handed an
    // ordering expression it cannot parse typically drops it and answers in its
    // default order. Everything downstream then behaves as though the ordering
    // held, including the limit this executor pushed alongside it, so "the
    // three newest" comes back as three arbitrary rows sorted convincingly.
    //
    // Checked only when the ordering was pushed: a page sorted here is sorted
    // by construction, and asking whether our own sort worked would be theatre.
    if (pushesOrdering && Array.isArray(runtimeResult.data)) {
      const rows = runtimeResult.data.filter(isRow);
      const violation = firstOrderingViolation(rows, input.request.query.sort ?? []);
      if (violation) {
        return failure(
          "ORDERING_NOT_APPLIED",
          `"${capability.id}" was asked to order by ${(input.request.query.sort ?? [])
            .map((entry) => `${entry.field} ${entry.direction}`)
            .join(", ")} and returned rows ${violation.index} and ${violation.index + 1} out of ` +
            `order on "${violation.field}", so the upstream did not apply the ordering it was ` +
            `sent. The usual cause is an orderingArgument grammar that this upstream does not ` +
            `parse — it ignores an expression it cannot read rather than rejecting it. Check the ` +
            `ascending and descending templates against the upstream's own documentation, and ` +
            `that "${violation.field}" is a field it will order by. Refused rather than returned ` +
            `because the plan's limit was pushed down with the ordering: these are not the rows ` +
            `in a different order, they are different rows.`,
          false,
        );
      }
    }
    try {
      return applyRowBudget(
        {
          ...runtimeResult,
          data: applyValidatedQuery(
            runtimeResult.data,
            input.request.query,
            capability.supports?.requiredFields,
          ),
          provenance: withNarrowingProvenance(
            runtimeResult.provenance,
            input.request.query,
            runtimeResult.data,
            pushesOrdering,
            pushesFilter,
          ),
        },
        input.options,
      );
    } catch {
      return failure(
        "INVALID_QUERY",
        "The validated query is incompatible with the capability result",
        false,
      );
    }
  } catch {
    if (executionSignal.timedOut()) {
      return failure("TIMEOUT", "The data request timed out", true);
    }
    if (executionSignal.signal.aborted) {
      return failure("ABORTED", "The data request was cancelled", true);
    }
    return failure("RUNTIME_ERROR", "Capability execution failed", true);
  } finally {
    executionSignal.cleanup();
  }
}

/**
 * Whether the plan's limit may bound the fetch itself.
 *
 * True only when the limit is the sole list operation. `applyValidatedQuery`
 * runs filter, aggregation, sort, and offset all *before* the limit, so with
 * any of them present the limit bounds a derived set: a fetch of `limit` rows
 * would run the operation over an arbitrary prefix of the collection and call
 * the result the answer. An unsatisfiable window aside, a bare limit and the
 * fetch bound are the same quantity, which is the one case pushing down is
 * sound.
 *
 * A sort is the one operation that can stop disqualifying the limit: when the
 * source applies the ordering, its first `limit` rows *are* the plan's top
 * `limit`, so the two quantities line up again. That is the whole value of
 * pushing ordering down — without it, "the three most recent" means the three
 * most recent of whatever page came back. It is also why the executor verifies
 * the rows actually came back ordered: this function's soundness now rests on
 * the upstream having honoured the declared grammar, and an upstream that
 * silently ignored it would have the limit applied to arbitrary rows.
 */
function limitBoundsFetch(
  query: QuerySpec,
  orderingPushed: boolean,
  filterPushed: boolean,
): boolean {
  return (
    // A pushed filter narrows before the limit is applied upstream, so the
    // limit bounds the qualifying rows rather than an unfiltered prefix — the
    // exact condition that made pushing a limit under a local filter wrong.
    (query.filter === undefined || filterPushed) &&
    (orderingPushed || !query.sort?.length) &&
    !query.groupBy?.length &&
    !query.aggregates?.length &&
    query.offset === undefined
  );
}

/**
 * Marks provenance when post-fetch query operations ran over a provably
 * incomplete fetch.
 *
 * A filter, sort, or aggregation over one page of a larger collection cannot
 * be presented as the whole answer: the matching rows may live entirely in the
 * pages never fetched, and the narrowed result — even an empty one — looks
 * exactly like a complete answer otherwise. The pre-narrowing provenance
 * (`truncated`, `totalRowsBeforeTruncation`, `moreAvailable`) is carried
 * through untouched; narrowing adds a fact, it never erases one.
 */
function withNarrowingProvenance(
  provenance: DataProvenance,
  query: QuerySpec,
  fetched: unknown,
  orderingPushed: boolean,
  filterPushed: boolean,
): DataProvenance {
  const fetchIncomplete =
    provenance.moreAvailable === true || provenance.truncated === true;
  if (!fetchIncomplete || !Array.isArray(fetched)) return provenance;
  if (!narrowsBeyondFetch(query, fetched.length, orderingPushed, filterPushed)) return provenance;
  return {
    ...provenance,
    narrowedAfterFetch: true,
    rowsBeforeNarrowing: fetched.length,
  };
}

/**
 * Whether a query's list operations could change the answer relative to the
 * full collection when only a prefix of it was fetched.
 *
 * A bare offset/limit window is deliberately excluded while it fits inside the
 * fetched rows: taking the first N of a fetch that is itself the collection's
 * prefix *is* the first N of the collection, which is why `moreAvailable`
 * alone on a limit-only result keeps meaning "answer complete, dataset goes
 * on". A window running off the end of an incomplete fetch is the opposite —
 * rows the ask covers exist beyond what was fetched.
 *
 * Aggregation is deliberately not listed: an aggregate over a cut-short fetch
 * is refused outright as TRUNCATED_AGGREGATION, and one over a merely-bounded
 * fetch summarizes exactly the rows the plan asked for — the guard above owns
 * that judgment, keyed on `truncated`.
 */
function narrowsBeyondFetch(
  query: QuerySpec,
  fetchedRows: number,
  orderingPushed: boolean,
  filterPushed: boolean,
): boolean {
  // A filter the source applied is not narrowing done here: the rows that
  // arrived are the rows that qualified, out of the whole collection. Reporting
  // that as page-bounded would understate a complete answer, and — since an
  // empty page-bounded result is refused — would turn a correct "nothing
  // matched" into a failure.
  if (query.filter !== undefined && !filterPushed) return true;
  // A sort the source applied is not narrowing: the rows arrived in the order
  // the plan asked for, so the local sort re-runs over an already-ordered page
  // and changes nothing. Reporting it as page-bounded would understate an
  // answer that is complete — the opposite of the mistake this function exists
  // to prevent, and just as misleading.
  if (query.sort?.length && !orderingPushed) return true;
  if (query.offset !== undefined || query.limit !== undefined) {
    const windowEnd =
      (query.offset ?? 0) + (query.limit ?? Number.POSITIVE_INFINITY);
    return fetchedRows < windowEnd;
  }
  return false;
}

/**
 * Truncates an oversized collection and records that it happened.
 *
 * Only root arrays are budgeted. A single entity or a metric object has no row
 * count to cap, and slicing an object's keys would corrupt it rather than
 * shorten it.
 */
function applyRowBudget(
  result: ExecutionResult,
  options: DataExecutorOptions | undefined,
): ExecutionResult {
  if (!result.ok || !Array.isArray(result.data)) return result;
  const budget = positiveInteger(options?.maxRowsPerRequest, DEFAULT_MAX_ROWS);
  if (result.data.length <= budget) return result;
  return {
    ...result,
    data: result.data.slice(0, budget),
    provenance: {
      ...result.provenance,
      truncated: true,
      // The rows exist — this process fetched them and cut the excess — so the
      // dataset provably extends past what is returned.
      moreAvailable: true,
      totalRowsBeforeTruncation: result.data.length,
    },
  };
}

function effectiveTimeout(
  capabilityTimeoutMs: number | undefined,
  options: DataExecutorOptions | undefined,
): number {
  const maximum = positiveInteger(options?.maximumTimeoutMs, 30_000);
  const requested = positiveInteger(
    capabilityTimeoutMs,
    positiveInteger(options?.defaultTimeoutMs, 10_000),
  );
  return Math.min(requested, maximum);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function createExecutionSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  timedOut(): boolean;
  cleanup(): void;
} {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);

  if (externalSignal?.aborted) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  }

  const timer = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new Error("RenderYes capability timeout"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? new Error("Aborted")),
        { once: true },
      );
    }),
  ]);
}

function failure(
  code: ExecutionFailureCode,
  message: string,
  retryable: boolean,
): ExecutionFailure {
  return { ok: false, error: { code, message, retryable } };
}

async function auditSafely<Session>(
  input: ExecuteDataRequestInput<Session>,
  result: ExecutionResult,
  startedAt: number,
): Promise<void> {
  if (!input.host.audit) return;
  const finishedAt = (input.options?.now ?? Date.now)();
  try {
    await input.host.audit({
      planId: input.planId,
      requestId: input.request.requestId,
      capabilityId: input.request.capabilityId,
      outcome: result.ok ? "succeeded" : "failed",
      ...(result.ok ? {} : { failureCode: result.error.code }),
      durationMs: Math.max(0, finishedAt - startedAt),
    });
  } catch {
    // Audit adapters are observability sinks. They never receive params,
    // identity, session, or result rows and cannot alter an execution result.
  }
}
