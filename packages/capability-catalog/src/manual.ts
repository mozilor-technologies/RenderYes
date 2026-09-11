import { z } from "zod";
import {
  assertCapabilityCatalog,
  createPlannerManifest,
  type PlannerManifest,
} from "./compile.js";
import type { FilterGroup, FilterPushdown } from "./filter-pushdown.js";
import type { OrderingPushdown, OrderingRequest } from "./ordering.js";
import type {
  CapabilityCatalog,
  CapabilityDescriptor,
  CapabilityExecutionResult,
  DataTypeDescriptor,
  RelationshipDescriptor,
  SourceDescriptor,
} from "./schema.js";

export interface CapabilityExecutionContext {
  /**
   * Populated by the deterministic executor from trusted session context. It is a separate
   * argument from planner-controlled input by construction. Authorization remains the host
   * executor's responsibility.
   */
  identity: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
  /**
   * How many rows the plan actually wants, when it says.
   *
   * Passed so a runtime that can bound the request upstream does so, instead of
   * the executor fetching everything and discarding the surplus afterwards. A
   * runtime is free to ignore it — the row budget still applies to whatever
   * comes back — but ignoring it on a cursor-paginated API means fetching a
   * default page size and calling it the answer.
   */
  limit?: number;
  /**
   * The ordering the plan asked for, when the runtime declared it can send one
   * upstream — see `CapabilityRuntime.ordering`.
   *
   * Passed as the typed terms the plan carries, never as an upstream's own
   * spelling: rendering that spelling is the runtime's job, from a grammar the
   * host declared. A runtime that receives this has already been asked whether
   * it can push the ordering, so it is not an invitation to guess.
   */
  sort?: readonly OrderingRequest[];
  /**
   * The plan's narrowing conditions, for a runtime that can push them.
   *
   * The typed condition tree the plan carries, never an upstream's own filter
   * dialect: compiling that dialect is the runtime's job, from the operator
   * names its own schema declares. A runtime that receives this has already
   * been asked whether it can push the filter.
   */
  filter?: FilterGroup;
}

/** @deprecated Use CapabilityExecutionContext. */
export type CapabilityLoadContext = CapabilityExecutionContext;

export type ManualDataTypeRegistration<Schema extends z.ZodType = z.ZodTypeAny> = Omit<
  DataTypeDescriptor,
  "schema"
> & {
  schema: Schema;
};

export type ManualCapabilityRegistration<
  InputSchema extends z.ZodType = z.ZodTypeAny,
  OutputSchema extends z.ZodType = z.ZodTypeAny,
> = Omit<CapabilityDescriptor, "inputSchema" | "outputSchema"> & {
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  execute: (
    input: z.output<InputSchema>,
    context: CapabilityExecutionContext,
  ) => Promise<CapabilityExecutionResult<z.output<OutputSchema>>>;
};

/**
 * A runtime a host supplies for a capability this package cannot compile for
 * them — anything that is not an approved OpenAPI or GraphQL operation.
 *
 * `Input` and `Output` default to `unknown`, so every existing reference keeps
 * its meaning. A host that names them — `CapabilityRuntime<BookQuery, Book[]>`
 * — gets a typed `execute` instead of casting on both sides of a function they
 * wrote themselves. `ManualCapabilityRegistration` above already derives those
 * types from the Zod schemas; this is the same courtesy for the interface the
 * executor actually consumes.
 */
export interface CapabilityRuntime<Input = unknown, Output = unknown> {
  capabilityId: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  execute: (
    input: Input,
    context: CapabilityExecutionContext,
  ) => Promise<CapabilityExecutionResult<Output>>;
  /**
   * Whether this runtime can act on `context.identity` — i.e. whether the
   * resolved session values can actually influence the upstream request.
   *
   * `requiredSessionKeys` on a capability reads as "results are scoped to this
   * identity", but all the executor guarantees is that the keys are *present*
   * in the session. A runtime that receives `identity` and drops it turns that
   * into a false claim: a capability declaring `userId` returns everyone's rows
   * while the catalog says it is user-scoped, and nothing anywhere reports a
   * problem.
   *
   * Set `false` when the runtime provably cannot forward identity — for the
   * OpenAPI adapter, that means no `headers` hook was supplied, so there is no
   * path by which a session value could leave this process. The executor then
   * refuses the request rather than answering a differently-scoped question.
   *
   * `undefined` means "not declared", which is treated as capable: a
   * hand-written runtime receives `identity` as an argument and is presumed to
   * use it. This flag exists to let an adapter admit it can't, not to make
   * every runtime prove it can.
   */
  forwardsIdentity?: boolean;
  /**
   * The ordering grammar this runtime can send upstream, when its host declared
   * one. Absent means ordering is applied here, over the fetched page.
   *
   * Declared rather than attempted for the same reason `forwardsIdentity` is:
   * the executor's own decisions change based on it. Ordering that reaches the
   * source is what makes a limit safe to push with it — the source's first ten
   * are then the plan's top ten — and pushing a limit under an ordering the
   * source ignored would return ten arbitrary rows as the answer.
   */
  ordering?: OrderingPushdown;
  /**
   * The upstream's filter vocabulary, when a planned filter can reach the
   * source through it.
   *
   * Read by the executor rather than acted on by it: whether narrowing happens
   * at the source decides whether a bounded fetch bounds the answer, and
   * whether an empty result is an answer or an artefact.
   */
  filter?: FilterPushdown;
}

export interface ManualCatalogBundle {
  catalog: CapabilityCatalog;
  plannerManifest: PlannerManifest;
  runtimes: ReadonlyMap<string, CapabilityRuntime>;
}

export interface ManualCatalogRegistration {
  id: string;
  version: string;
  description: string;
  dataTypes: readonly ManualDataTypeRegistration<any>[];
  sources: readonly SourceDescriptor[];
  /**
   * `defineCapability` preserves each entry's exact input/output inference. The catalog-level
   * heterogeneous collection intentionally erases those per-entry generics after registration.
   */
  capabilities: readonly ManualCapabilityRegistration<any, any>[];
  relationships?: readonly RelationshipDescriptor[];
}

export function defineDataType<Schema extends z.ZodType>(
  registration: ManualDataTypeRegistration<Schema>,
): ManualDataTypeRegistration<Schema> {
  return registration;
}

export function defineCapability<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
>(
  registration: ManualCapabilityRegistration<InputSchema, OutputSchema>,
): ManualCapabilityRegistration<InputSchema, OutputSchema> {
  return registration;
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
  }) as Record<string, unknown>;
}

/**
 * Compiles ergonomic host-authored Zod registrations into a portable catalog plus a separate
 * executable runtime map. The portable catalog can be serialized; functions never cross into the
 * planner manifest.
 */
export function createManualCatalog(
  registration: ManualCatalogRegistration,
): ManualCatalogBundle {
  const catalog = assertCapabilityCatalog({
    schemaVersion: "1.0",
    id: registration.id,
    version: registration.version,
    description: registration.description,
    dataTypes: registration.dataTypes.map(({ schema, ...definition }) => ({
      ...definition,
      schema: toJsonSchema(schema),
    })),
    sources: registration.sources,
    capabilities: registration.capabilities.map(
      ({ inputSchema, outputSchema, execute: _execute, ...definition }) => ({
        ...definition,
        inputSchema: toJsonSchema(inputSchema),
        outputSchema: toJsonSchema(outputSchema),
      }),
    ),
    relationships: registration.relationships ?? [],
  });

  const runtimes = new Map<string, CapabilityRuntime>(
    registration.capabilities.map((capability) => [
      capability.id,
      {
        capabilityId: capability.id,
        inputSchema: capability.inputSchema,
        outputSchema: capability.outputSchema,
        execute: capability.execute as CapabilityRuntime["execute"],
      },
    ]),
  );

  return {
    catalog,
    plannerManifest: createPlannerManifest(catalog),
    runtimes,
  };
}

export function findCapabilityRuntime(
  runtimes: ReadonlyMap<string, CapabilityRuntime>,
  capabilityId: string,
): CapabilityRuntime | undefined {
  return runtimes.get(capabilityId);
}
