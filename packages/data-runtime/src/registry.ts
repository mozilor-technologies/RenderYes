import {
  assertCapabilityCatalog,
  createPlannerManifest,
  hashCapabilityCatalog,
  type CapabilityCatalog,
  type PlannerManifest,
} from "@renderyes/capability-catalog";
import type { CapabilityRuntime } from "@renderyes/capability-catalog/server";
import type { OpenApiOperationBinding } from "@renderyes/capability-catalog/openapi";
import {
  createGraphQlCapabilityRuntime,
  type ExecuteApprovedGraphQlRequestOptions,
  type GraphQlOperationBinding,
  type GraphQlSchemaInput,
  type GraphQlTransport,
} from "@renderyes/capability-catalog/graphql";
import { createOpenApiRuntime } from "./openapi-adapter.js";

/**
 * The missing link between host approval and the planner.
 *
 * The review UI compiles an approved `CapabilityCatalog` plus the server-only
 * operation `bindings` needed to execute it. Until now nothing consumed those:
 * the planner received a `PlannerManifest` built at import time from a
 * hard-coded literal, so an approved catalog could not reach it even in
 * principle. This registry closes that gap — a published catalog becomes a
 * planner contract and an executable runtime map.
 *
 * Deliberately in-memory and dependency-free. Durable storage is a host
 * concern; `CapabilityCatalogStore` is the seam to implement against.
 */

export interface RegisteredCatalog {
  catalogId: string;
  version: string;
  /** Content hash of the approved catalog. Detects drift across republishes. */
  catalogHash: string;
  catalog: CapabilityCatalog;
  /** Planner-safe projection. Never contains session keys, permissions, or endpoints. */
  plannerManifest: PlannerManifest;
  /** Server-only execution bindings. Never include this object in planner input. */
  bindings: Readonly<Record<string, OpenApiOperationBinding | GraphQlOperationBinding>>;
  /** Identifies the deterministic adapter used to execute this publication. */
  bindingKind: "openapi" | "graphql";
  runtimes: ReadonlyMap<string, CapabilityRuntime>;
  publishedAt: string;
}

export interface OpenApiRuntimeConfig {
  /** Used when a binding carries no `serverUrl` of its own. */
  baseUrl?: string;
  /**
   * Resolves server-only auth headers per attempt. This is where a host
   * injects its own token; it never comes from planner input.
   */
  headers?: () => Promise<Record<string, string>> | Record<string, string>;
  /**
   * Re-checks the resolved URL against the host's upstream allowlist on every
   * request. See `OpenApiRuntimeOptions.assertAllowedUpstream` — without it,
   * narrowing the allowlist does not revoke an already published catalog.
   */
  assertAllowedUpstream?: (url: string) => void;
  fetchImpl?: typeof fetch;
}

export interface GraphQlRuntimeConfig {
  /** The exact reviewed schema. Runtime compilation rejects schema drift. */
  schema: GraphQlSchemaInput;
  /** Host-owned network transport. Credentials and endpoint remain outside the catalog. */
  transport: GraphQlTransport;
  /** Host-owned provenance resolution for returned facts. */
  resolveProvenance: ExecuteApprovedGraphQlRequestOptions["resolveProvenance"];
  permissions?: ReadonlySet<string>;
  now?: () => Date;
}

interface PublishCatalogBase {
  /** Unvalidated input — typically parsed straight from the review UI's export. */
  catalog: unknown;
  now?: () => Date;
}

export interface PublishOpenApiCatalogInput extends PublishCatalogBase {
  /** Omitted for backward compatibility with the original OpenAPI-only API. */
  bindingKind?: "openapi";
  bindings: Readonly<Record<string, OpenApiOperationBinding>>;
  runtime?: OpenApiRuntimeConfig;
}

export interface PublishGraphQlCatalogInput extends PublishCatalogBase {
  bindingKind: "graphql";
  bindings: Readonly<Record<string, GraphQlOperationBinding>>;
  runtime: GraphQlRuntimeConfig;
}

export type PublishCatalogInput = PublishOpenApiCatalogInput | PublishGraphQlCatalogInput;

export interface CapabilityCatalogStore {
  publish(input: PublishCatalogInput): RegisteredCatalog;
  get(catalogId: string): RegisteredCatalog | undefined;
  list(): RegisteredCatalog[];
  /**
   * Unregisters a catalog. Returns false when nothing was filed under that id.
   *
   * Publishing was the only way to change a registry, so a catalog published by
   * mistake — a trial run, a wrong id — could only be replaced, never removed,
   * and the only way to clear one was restarting the process. That is fine on a
   * laptop and not a thing to tell a host to do.
   */
  remove(catalogId: string): boolean;
}

/**
 * Both sides of the capability-id agreement exist at registration, so check it
 * here rather than at request time.
 *
 * A binding filed under one key while naming another capability produces a
 * runtime whose `capabilityId` never matches the key it is stored under. The
 * executor does catch this — `runtime.capabilityId !== capability.id` fails
 * closed with `RUNTIME_NOT_FOUND` — but only once a visitor asks for that
 * capability, by which point a typo in host config has already been published.
 */
function assertBindingMatchesCapability(
  capabilityId: string,
  binding: { capabilityId: string },
): void {
  if (binding.capabilityId !== capabilityId) {
    throw new Error(
      `Binding for capability ${capabilityId} declares capabilityId ` +
        `${binding.capabilityId}. A binding must be filed under the id it names, ` +
        "or the runtime is unreachable.",
    );
  }
}

/**
 * Builds one `CapabilityRuntime` per approved capability from its binding.
 *
 * A capability with no binding is skipped rather than stubbed: the executor
 * already fails closed with `RUNTIME_NOT_FOUND`, which is a clearer signal
 * than a runtime that exists but cannot work.
 */
export function createRuntimesFromBindings(
  catalog: CapabilityCatalog,
  bindings: Readonly<Record<string, OpenApiOperationBinding>>,
  config: OpenApiRuntimeConfig = {},
): {
  runtimes: Map<string, CapabilityRuntime>;
  unbound: string[];
} {
  const runtimes = new Map<string, CapabilityRuntime>();
  const unbound: string[] = [];

  for (const capability of catalog.capabilities) {
    const binding = bindings[capability.id];
    if (!binding) {
      unbound.push(capability.id);
      continue;
    }
    assertBindingMatchesCapability(capability.id, binding);
    // sourceId must be one the catalog declares, so provenance on every
    // returned row resolves to an approved source.
    const sourceId = capability.sourceIds[0];
    if (!sourceId) {
      unbound.push(capability.id);
      continue;
    }
    runtimes.set(
      capability.id,
      createOpenApiRuntime({
        binding,
        sourceId,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.headers ? { headers: config.headers } : {}),
        ...(config.assertAllowedUpstream
          ? { assertAllowedUpstream: config.assertAllowedUpstream }
          : {}),
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      }),
    );
  }

  return { runtimes, unbound };
}

/** Builds trusted runtimes from host-approved GraphQL operation bindings. */
export function createGraphQlRuntimesFromBindings(
  catalog: CapabilityCatalog,
  bindings: Readonly<Record<string, GraphQlOperationBinding>>,
  config: GraphQlRuntimeConfig,
): {
  runtimes: Map<string, CapabilityRuntime>;
  unbound: string[];
} {
  const runtimes = new Map<string, CapabilityRuntime>();
  const unbound: string[] = [];

  for (const capability of catalog.capabilities) {
    const binding = bindings[capability.id];
    if (!binding) {
      unbound.push(capability.id);
      continue;
    }
    assertBindingMatchesCapability(capability.id, binding);

    runtimes.set(
      capability.id,
      createGraphQlCapabilityRuntime({
        catalog,
        schema: config.schema,
        binding,
        transport: config.transport,
        resolveProvenance: config.resolveProvenance,
        ...(config.permissions ? { permissions: config.permissions } : {}),
        ...(config.now ? { now: config.now } : {}),
      }),
    );
  }

  return { runtimes, unbound };
}

export function createCapabilityCatalogStore(): CapabilityCatalogStore {
  const byId = new Map<string, RegisteredCatalog>();

  return {
    publish(input: PublishCatalogInput): RegisteredCatalog {
      // The published catalog is untrusted input, exactly like a model plan:
      // re-validate it here rather than trusting that the UI compiled it.
      const catalog = assertCapabilityCatalog(input.catalog);
      // Publishing replaces by id, so an empty catalog does not merely serve
      // nothing — it silently disables whatever working catalog held the id.
      // Seen live from a caller-side bug that sliced a catalog to zero entries
      // and shipped the remainder; the shape is valid, the publish is never a
      // real intent.
      if (catalog.capabilities.length === 0) {
        throw new Error(
          `Catalog "${catalog.id}" declares no capabilities. Publishing it would ` +
            "replace any working catalog under the same id with one that can " +
            "answer nothing; publish at least one capability.",
        );
      }
      const bindingKind = input.bindingKind ?? "openapi";
      const { runtimes } =
        input.bindingKind === "graphql"
          ? createGraphQlRuntimesFromBindings(catalog, input.bindings, input.runtime)
          : createRuntimesFromBindings(catalog, input.bindings, input.runtime ?? {});

      const registered: RegisteredCatalog = {
        catalogId: catalog.id,
        version: catalog.version,
        catalogHash: hashCapabilityCatalog(catalog),
        catalog,
        plannerManifest: createPlannerManifest(catalog),
        bindings: { ...input.bindings },
        bindingKind,
        runtimes,
        publishedAt: (input.now ?? (() => new Date()))().toISOString(),
      };

      byId.set(registered.catalogId, registered);
      return registered;
    },

    get(catalogId: string): RegisteredCatalog | undefined {
      return byId.get(catalogId);
    },

    remove(catalogId: string): boolean {
      return byId.delete(catalogId);
    },

    list(): RegisteredCatalog[] {
      return [...byId.values()];
    },
  };
}
