import { type JsonValue } from "@renderyes/core";
import type { FieldDefinition } from "./index.js";

const idPattern = /^[A-Za-z][A-Za-z0-9._-]*$/;
const fieldNamePattern = /^[A-Za-z][A-Za-z0-9._-]*$/;
const knownFieldTypes = new Set(["string", "number", "boolean", "enum", "stringArray"]);

/**
 * A registered field on a typed data source. The `type` reuses the site SDK's
 * closed `FieldDefinition` helpers (`field.*`) so the model never sees an open
 * schema. The capability flags describe intent only:
 *
 * - `displayable` — may appear in renderer rows and the model-safe summary.
 * - `filterable` / `sortable` — DECLARED for the Phase 5 query engine. Phase 4
 *   does not execute filters or multi-field sorts.
 * - `sensitive` — renderer-only. A sensitive field may reach the trusted
 *   renderer but never the planning model or a persisted Plan.
 */
export interface SourceFieldDefinition {
  type: FieldDefinition;
  label?: string;
  displayable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  sensitive?: boolean;
}

export type SourceRow = Record<string, JsonValue>;

export type ResolvedState = "ready" | "empty" | "error";

/**
 * What a data slot's `state` can be in the data model a host component reads.
 *
 * Wider than `ResolvedState` by exactly one value. A resolver never returns
 * `pending` — it is not a resolution — but a streamed compose emits the surface
 * before its requests settle, so every slot starts there and a host component
 * sees it first on every streamed run.
 *
 * Split out rather than widening `ResolvedState`, which is the resolver's return
 * type and correctly excludes it. The host-facing type used to say
 * `"ready" | "empty" | "error"`, so an exhaustive switch compiled clean and then
 * fell through on the first frame of every stream — TypeScript actively telling
 * the host a case it always receives could not happen.
 */
export type DataSlotState = ResolvedState | "pending";

export interface ResolverInput<Session = unknown> {
  /**
   * The trusted, authenticated session supplied by the host. Resolvers derive
   * the user and their permissions from here — never from the model or a
   * model-authored plan.
   */
  session: Session;
  /**
   * Already-validated, allowlisted request options the host chooses to pass
   * (for example a subset selector or pagination cursor). Phase 4 does NOT
   * interpret these as a query language — the host validates them and the
   * resolver decides how to use them. Typed cross-source queries are Phase 5.
   */
  params?: Readonly<Record<string, JsonValue>>;
}

export interface ResolverResult {
  /** Optional explicit state. Defaults to `ready`/`empty` from `rows.length`. */
  state?: ResolvedState;
  /** Authorized rows for the current session. May include sensitive fields. */
  rows: SourceRow[];
  errorMessage?: string;
}

export type SourceResolver<Session = unknown> = (
  input: ResolverInput<Session>,
) => ResolverResult | Promise<ResolverResult>;

/**
 * A typed data source registered by a customer. It declares what an entity is,
 * how rows are keyed, which fields exist and their capabilities, the permission
 * required, and a resolver that returns authorized rows for a trusted session.
 *
 * Phase 4 scope: registration + a resolver contract + loading/empty/error
 * message contracts. It intentionally does NOT include filter/intersection/
 * difference execution (Phase 5) or a permission enforcement engine (Phase 6).
 */
export interface DataSourceDefinition<Session = unknown> {
  id: string;
  entity: string;
  description: string;
  matchKey: string;
  fields: Readonly<Record<string, SourceFieldDefinition>>;
  requiredPermission?: string;
  contracts?: {
    loadingMessage?: string;
    emptyMessage?: string;
    errorMessage?: string;
  };
  resolver: SourceResolver<Session>;
}

export function defineSource<Session = unknown>(
  definition: DataSourceDefinition<Session>,
): DataSourceDefinition<Session> {
  assertId(definition.id, "Source id");
  assertNonEmpty(definition.entity, `Source ${definition.id} entity`);
  assertNonEmpty(definition.description, `Source ${definition.id} description`);

  const fieldEntries = Object.entries(definition.fields ?? {});
  if (fieldEntries.length === 0) {
    throw new Error(`Source ${definition.id} must declare at least one field`);
  }
  for (const [name, field] of fieldEntries) {
    if (!fieldNamePattern.test(name)) {
      throw new Error(`Source ${definition.id} field name is invalid: ${name}`);
    }
    if (
      !field ||
      typeof field !== "object" ||
      !field.type ||
      typeof field.type !== "object" ||
      !knownFieldTypes.has((field.type as { type?: string }).type ?? "")
    ) {
      throw new Error(`Source ${definition.id} field ${name} needs a valid field type`);
    }
  }

  if (!definition.matchKey || !(definition.matchKey in definition.fields)) {
    throw new Error(`Source ${definition.id} matchKey must name a declared field`);
  }
  if (typeof definition.resolver !== "function") {
    throw new Error(`Source ${definition.id} resolver must be a function`);
  }
  if (definition.requiredPermission !== undefined) {
    assertNonEmpty(
      definition.requiredPermission,
      `Source ${definition.id} requiredPermission`,
    );
  }

  return Object.freeze({
    ...definition,
    fields: Object.freeze({ ...definition.fields }),
    contracts: definition.contracts
      ? Object.freeze({ ...definition.contracts })
      : undefined,
  });
}

/** Model-safe projection of a resolved source. Never carries row values. */
export interface ResolvedSourceSummary {
  sourceId: string;
  entity: string;
  state: ResolvedState;
  rowCount: number;
  /** Non-sensitive, displayable field ids only. */
  fields: string[];
}

/**
 * The two output channels of a resolved source:
 *
 * - `rows` — RENDERER-ONLY. The full authorized rows, including any sensitive
 *   fields, delivered to the trusted renderer via `updateDataModel`.
 * - `summary` — MODEL-SAFE. The only thing a planner is ever handed: counts and
 *   non-sensitive field names, never sensitive values or raw private rows.
 */
export interface ResolvedSource {
  sourceId: string;
  entity: string;
  state: ResolvedState;
  rows: SourceRow[];
  summary: ResolvedSourceSummary;
}

/**
 * Resolve a source asynchronously. This is the canonical contract: real
 * resolvers backed by an API, database, cache, or SDK are async. Resolver
 * exceptions propagate (they are not swallowed); a resolver that wants graceful
 * degradation returns `{ state: "error", rows: [] }` explicitly.
 */
export async function resolveSource<Session = unknown>(
  source: DataSourceDefinition<Session>,
  input: ResolverInput<Session>,
): Promise<ResolvedSource> {
  const result = await source.resolver(input);
  return finalizeResolved(source, result);
}

/**
 * Resolve a source synchronously. Convenience for synchronous fixture/demo and
 * simple test contexts. Throws if the resolver returns a Promise — asynchronous
 * resolvers must use {@link resolveSource}.
 */
export function resolveSourceSync<Session = unknown>(
  source: DataSourceDefinition<Session>,
  input: ResolverInput<Session>,
): ResolvedSource {
  const result = source.resolver(input);
  if (isPromiseLike(result)) {
    throw new Error(
      `Source ${source.id} resolver is asynchronous; use resolveSource instead`,
    );
  }
  return finalizeResolved(source, result);
}

/** Serializable source metadata for an owner/agent manifest. */
export interface SourceFieldSnapshot {
  id: string;
  label?: string;
  type: string;
  displayable: boolean;
  filterable: boolean;
  sortable: boolean;
  sensitive: boolean;
}

export interface DataSourceSnapshot {
  id: string;
  entity: string;
  description: string;
  matchKey: string;
  requiredPermission?: string;
  contracts?: {
    loadingMessage?: string;
    emptyMessage?: string;
    errorMessage?: string;
  };
  fields: SourceFieldSnapshot[];
}

/**
 * Project a source into a serializable snapshot for the owner/agent manifest.
 * Excludes the resolver function and all row data — resolvers stay server-side.
 */
export function toSourceSnapshot(source: DataSourceDefinition): DataSourceSnapshot {
  return {
    id: source.id,
    entity: source.entity,
    description: source.description,
    matchKey: source.matchKey,
    requiredPermission: source.requiredPermission,
    contracts: source.contracts ? { ...source.contracts } : undefined,
    fields: Object.entries(source.fields).map(([id, field]) => ({
      id,
      label: field.label,
      type: (field.type as { type: string }).type,
      displayable: field.displayable !== false,
      filterable: field.filterable === true,
      sortable: field.sortable === true,
      sensitive: field.sensitive === true,
    })),
  };
}

function finalizeResolved<Session>(
  source: DataSourceDefinition<Session>,
  result: ResolverResult,
): ResolvedSource {
  if (!result || !Array.isArray(result.rows)) {
    throw new Error(`Source ${source.id} resolver must return a rows array`);
  }
  const rows = result.rows.map((row) => ({ ...row }));
  const state: ResolvedState = result.state ?? (rows.length > 0 ? "ready" : "empty");
  return {
    sourceId: source.id,
    entity: source.entity,
    state,
    rows,
    summary: {
      sourceId: source.id,
      entity: source.entity,
      state,
      rowCount: rows.length,
      fields: modelSafeFields(source),
    },
  };
}

/** Non-sensitive, displayable field ids — the only fields a planner may see. */
function modelSafeFields<Session>(source: DataSourceDefinition<Session>): string[] {
  return Object.entries(source.fields)
    .filter(([, field]) => field.displayable !== false && field.sensitive !== true)
    .map(([id]) => id);
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function assertId(value: string, label: string) {
  if (!idPattern.test(value)) {
    throw new Error(`${label} must match ${idPattern.source}`);
  }
}

function assertNonEmpty(value: string, label: string) {
  if (!value || !value.trim()) throw new Error(`${label} is required`);
}
