import {
  CapabilityCatalogSchema,
  ReviewExportEnvelopeSchema,
  createPlannerManifest,
  type CapabilityCatalog,
  type CapabilityDescriptor,
  type DataTypeDescriptor,
  type PlannerManifest,
  type RelationshipDescriptor,
} from "@renderyes/capability-catalog";
import {
  compileApprovedGraphQlCatalog,
  createGraphQlCatalogInventory,
  listGraphQlQueries,
  type GraphQlCatalogInventory,
  type GraphQlSchemaInput,
} from "@renderyes/capability-catalog/graphql";
import type { SiteManifest } from "@renderyes/site-sdk";

/**
 * The generator's whole input, whichever door it came in through.
 *
 * Two doors on purpose (see the plan's architecture table): a review-export
 * bundle already carries the compiled catalog, the planner manifest, and the
 * host's registered UI manifest; a `--schema + --decisions` pair is recompiled
 * locally through the same functions the review CLI uses, so both doors
 * produce the identical trusted artifacts. What is deliberately *not* a door:
 * `GET /api/catalog` (serves summaries without field descriptors) and
 * importing a host's service file (executes its publishes as a side effect).
 */
export interface DataContract {
  catalogId: string;
  catalog: CapabilityCatalog;
  plannerManifest: PlannerManifest;
  /** The host's registered components, when the input carried them (export bundles do). */
  uiManifest?: SiteManifest;
  /** Per capability: approved fields the executor always includes. */
  requiredOutputFieldsByCapability: Readonly<Record<string, readonly string[]>>;
}

/** Everything about one capability the prompt and the verifier need. */
export interface CapabilitySlice {
  catalogId: string;
  capability: CapabilityDescriptor;
  dataType: DataTypeDescriptor;
  /** Relationships whose either end touches the capability's data type. */
  relationships: readonly RelationshipDescriptor[];
  /** Ids already registered — a generated id colliding with one is refused. */
  existingComponentIds: readonly string[];
  requiredOutputFields: readonly string[];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * A loose structural check on the export's `ui.manifest` before treating it as
 * a `SiteManifest`. The manifest is re-validated component by component when
 * the verifier reconstructs a site from it; this only rejects inputs that are
 * not even the right shape, with a message naming what is missing.
 */
function toSiteManifest(manifest: Record<string, unknown>): SiteManifest {
  if (!Array.isArray(manifest.components)) {
    throw new Error("Review export ui.manifest has no components array");
  }
  if (!Array.isArray(manifest.surfaces)) {
    throw new Error("Review export ui.manifest has no surfaces array");
  }
  return manifest as unknown as SiteManifest;
}

export function loadDataContractFromExport(bundleInput: unknown): DataContract {
  const envelope = ReviewExportEnvelopeSchema.parse(bundleInput);
  const catalog = CapabilityCatalogSchema.parse(envelope.capability.catalog);
  // Recomputed rather than trusted: the manifest in the bundle was projected
  // by the same function from the same catalog, so recomputing costs nothing
  // and removes a hand-edited bundle as a way to feed the generator a manifest
  // that disagrees with its catalog.
  const plannerManifest = createPlannerManifest(catalog);

  const requiredOutputFieldsByCapability: Record<string, readonly string[]> = {};
  for (const [capabilityId, binding] of Object.entries(envelope.capability.bindings)) {
    const required = asRecord(binding, `binding ${capabilityId}`).requiredOutputFields;
    if (Array.isArray(required) && required.every((entry) => typeof entry === "string")) {
      requiredOutputFieldsByCapability[capabilityId] = required;
    }
  }

  return {
    catalogId: envelope.catalogId,
    catalog,
    plannerManifest,
    uiManifest: toSiteManifest(envelope.ui.manifest),
    requiredOutputFieldsByCapability,
  };
}

export interface ApprovalContractOptions {
  schema: GraphQlSchemaInput;
  approval: unknown;
  /**
   * The review draft the approval was made against. Optional: without it the
   * draft is reconstructed with the same defaults `renderyes-catalog inventory`
   * uses, which reproduces the hash for approvals that came from that CLI. An
   * approval drafted with non-default options fails the hash check inside
   * `compileApprovedGraphQlCatalog` — pass the stored draft file then.
   */
  draft?: unknown;
  /** Required when no draft is given: the reconstruction needs the catalog id the draft used. */
  catalogId?: string;
  sourceLabel?: string;
  /** Restrict the reconstructed draft to these root query fields, like `--queries`. */
  queries?: readonly string[];
  discoveryDepth?: number;
  scalarMappings?: Record<string, { schema: Record<string, unknown> }>;
}

/**
 * Mirrors `renderyes-catalog inventory` (capability-catalog/bin/catalog.mjs)
 * exactly — same catalog version/description/source defaults, same
 * per-query defaults — because `compileApprovedGraphQlCatalog` verifies the
 * approval's `reviewSourceHash` against the draft, and any divergence here
 * would reject approvals that CLI produced.
 */
function reconstructInventory(options: ApprovalContractOptions): GraphQlCatalogInventory {
  const catalogId = options.catalogId;
  if (!catalogId) {
    throw new Error(
      "Recompiling from --schema/--decisions without --inventory requires --catalog-id " +
        "(the id `renderyes-catalog inventory` was given).",
    );
  }
  const scalarMappings = options.scalarMappings ?? {};
  const discovered = listGraphQlQueries(options.schema, {
    ...(options.discoveryDepth === undefined
      ? {}
      : { maximumDiscoveryDepth: options.discoveryDepth }),
    scalarMappings,
  });
  const supported = discovered.filter((query) => query.support.status === "supported");
  const selected = options.queries
    ? supported.filter((query) => options.queries?.includes(query.fieldName))
    : supported;
  if (selected.length === 0) {
    throw new Error("No supported root query fields to reconstruct a draft from");
  }
  const label = options.sourceLabel ?? catalogId;
  return createGraphQlCatalogInventory({
    schema: options.schema,
    catalog: {
      id: catalogId,
      version: "1.0.0",
      description: `Approved reads from ${label}.`,
    },
    source: {
      id: `${catalogId}-source`,
      label,
      description: `The ${label} GraphQL API.`,
    },
    ...(options.discoveryDepth === undefined
      ? {}
      : { discoveryMaxDepth: options.discoveryDepth }),
    queries: selected.map((query) => {
      const hasId = query.outputFields.some((field) => field.path === "id");
      return {
        fieldName: query.fieldName,
        capabilityId: `graphql.${query.fieldName}`,
        purpose:
          query.description ??
          `Review the purpose of graphql.${query.fieldName} before publishing.`,
        dataTypeId: query.connection?.nodeTypeName ?? query.fieldName,
        dataTypeDescription: `One record from ${query.fieldName}.`,
        resultShape: query.suggestedResultShape,
        ...(hasId ? { matchKey: "id" } : {}),
        ...(Object.keys(scalarMappings).length > 0 ? { scalarMappings } : {}),
      };
    }),
  });
}

export function loadDataContractFromDecisions(
  options: ApprovalContractOptions,
): DataContract {
  const draft = (options.draft as GraphQlCatalogInventory) ?? reconstructInventory(options);
  const compiled = compileApprovedGraphQlCatalog(options.schema, draft, options.approval);

  const requiredOutputFieldsByCapability: Record<string, readonly string[]> = {};
  for (const [capabilityId, binding] of compiled.bindings) {
    requiredOutputFieldsByCapability[capabilityId] = binding.requiredOutputFields;
  }

  return {
    catalogId: compiled.catalog.id,
    catalog: compiled.catalog,
    plannerManifest: compiled.plannerManifest,
    requiredOutputFieldsByCapability,
  };
}

export function sliceCapability(
  contract: DataContract,
  capabilityId: string,
): CapabilitySlice {
  const capability = contract.catalog.capabilities.find(
    (candidate) => candidate.id === capabilityId,
  );
  if (!capability) {
    const known = contract.catalog.capabilities.map((candidate) => candidate.id);
    throw new Error(
      `Capability "${capabilityId}" is not in catalog ${contract.catalogId}. ` +
        `Approved capabilities: ${known.join(", ") || "(none)"}`,
    );
  }
  const dataType = contract.catalog.dataTypes.find(
    (candidate) => candidate.id === capability.output.dataTypeId,
  );
  if (!dataType) {
    throw new Error(
      `Capability ${capabilityId} outputs data type "${capability.output.dataTypeId}", ` +
        "which the catalog does not declare",
    );
  }
  const relationships = contract.catalog.relationships.filter(
    (relationship) =>
      relationship.from.dataTypeId === dataType.id ||
      relationship.to.dataTypeId === dataType.id,
  );
  const existingComponentIds =
    contract.uiManifest?.components.map((component) => component.id) ?? [];

  return {
    catalogId: contract.catalogId,
    capability,
    dataType,
    relationships,
    existingComponentIds,
    requiredOutputFields: contract.requiredOutputFieldsByCapability[capabilityId] ?? [],
  };
}
