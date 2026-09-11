import { hashCapabilityCatalog, validateCapabilityCatalogDefinition } from "./compile.js";
import type { CapabilityCatalog, JsonSchema } from "./schema.js";

export type CatalogReviewSeverity = "error" | "warning" | "info";

export interface CatalogReviewIssue {
  severity: CatalogReviewSeverity;
  path: string;
  message: string;
}

export interface CatalogReviewReport {
  catalogId?: string;
  catalogHash?: string;
  issues: CatalogReviewIssue[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
  };
  readyToPublish: boolean;
}

export interface ReviewableItem {
  id: string;
  label: string;
  description?: string;
  approved: boolean;
  /** A candidate can be visible in the local review tool without being part of the catalog. */
  availableForApproval?: boolean;
}

export interface CapabilityInventory {
  capabilityId: string;
  purpose: string;
  visitorParameters: ReviewableItem[];
  serverOnlyKeys: string[];
  outputFields: ReviewableItem[];
}

export interface CatalogInventory {
  catalog: CapabilityCatalog;
  capabilities: CapabilityInventory[];
  report: CatalogReviewReport;
}

export interface CapabilityReviewCandidate {
  capabilityId: string;
  visitorParameters?: Array<Omit<ReviewableItem, "approved"> & { approved?: boolean }>;
  outputFields?: Array<Omit<ReviewableItem, "approved"> & { approved?: boolean }>;
}

export interface CatalogDecisionsExport {
  schemaVersion: "1.0";
  catalogId: string;
  catalogHash: string;
  exportedAt: string;
  capabilities: Array<{
    capabilityId: string;
    approvedVisitorParameters: string[];
    approvedOutputFields: string[];
  }>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectProperties(schema: JsonSchema): UnknownRecord {
  return isRecord(schema.properties) ? schema.properties : {};
}

function outputItemSchema(
  catalog: CapabilityCatalog,
  capabilityIndex: number,
): JsonSchema | undefined {
  const capability = catalog.capabilities[capabilityIndex];
  if (!capability) return undefined;
  const schema = capability.outputSchema;
  if (
    (capability.output.shape === "collection" ||
      capability.output.shape === "media-collection" ||
      capability.output.shape === "search-results") &&
    schema.type === "array" &&
    isRecord(schema.items)
  ) {
    return schema.items;
  }
  return capability.output.shape === "entity" ? schema : undefined;
}

function descriptionFromSchema(value: unknown): string | undefined {
  return isRecord(value) && typeof value.description === "string"
    ? value.description
    : undefined;
}

function reportForValidCatalog(catalog: CapabilityCatalog): CatalogReviewIssue[] {
  const issues: CatalogReviewIssue[] = [];

  catalog.sources.forEach((source, index) => {
    if (!source.description) {
      issues.push({
        severity: "warning",
        path: `sources[${index}].description`,
        message: `Source "${source.id}" has no description for host reviewers`,
      });
    }
  });

  catalog.dataTypes.forEach((dataType, typeIndex) => {
    if (Object.keys(dataType.fields).length === 0) {
      issues.push({
        severity: "error",
        path: `dataTypes[${typeIndex}].fields`,
        message: `Data type "${dataType.id}" exposes no approved fields`,
      });
    }

    Object.entries(dataType.fields).forEach(([fieldId, field]) => {
      if (!field.description) {
        issues.push({
          severity: "warning",
          path: `dataTypes[${typeIndex}].fields.${fieldId}.description`,
          message: `Approved field "${dataType.id}.${fieldId}" has no planner-facing description`,
        });
      }
      if (field.semanticType === "unknown") {
        issues.push({
          severity: "warning",
          path: `dataTypes[${typeIndex}].fields.${fieldId}.semanticType`,
          message: `Approved field "${dataType.id}.${fieldId}" has an unknown semantic type`,
        });
      }
    });
  });

  catalog.capabilities.forEach((capability, capabilityIndex) => {
    const inputProperties = objectProperties(capability.inputSchema);
    Object.entries(inputProperties).forEach(([parameter, definition]) => {
      if (!descriptionFromSchema(definition)) {
        issues.push({
          severity: "warning",
          path: `capabilities[${capabilityIndex}].inputSchema.properties.${parameter}.description`,
          message: `Visitor parameter "${capability.id}.${parameter}" has no description`,
        });
      }
    });

    if (capability.policy.maximumRows === undefined) {
      issues.push({
        severity: "warning",
        path: `capabilities[${capabilityIndex}].policy.maximumRows`,
        message: `Capability "${capability.id}" has no maximum row limit`,
      });
    }

    const dataType = catalog.dataTypes.find(
      (candidate) => candidate.id === capability.output.dataTypeId,
    );
    const itemSchema = outputItemSchema(catalog, capabilityIndex);
    if (dataType && itemSchema) {
      Object.keys(objectProperties(itemSchema)).forEach((field) => {
        if (!dataType.fields[field]) {
          issues.push({
            severity: "error",
            path: `capabilities[${capabilityIndex}].outputSchema.properties.${field}`,
            message: `Output field "${field}" is not declared as an approved field on data type "${dataType.id}"`,
          });
        }
      });
    }
  });

  return issues;
}

/**
 * Run deterministic host-facing checks before a catalog is approved or projected to a planner.
 * This function never performs network calls and never inspects raw records.
 */
export function reviewCapabilityCatalog(input: unknown): CatalogReviewReport {
  const validation = validateCapabilityCatalogDefinition(input);
  const issues: CatalogReviewIssue[] = validation.ok
    ? reportForValidCatalog(validation.value)
    : validation.issues.map((issue) => ({ ...issue, severity: "error" as const }));

  const summary = { errors: 0, warnings: 0, infos: 0 };
  issues.forEach((issue) => {
    if (issue.severity === "error") summary.errors += 1;
    else if (issue.severity === "warning") summary.warnings += 1;
    else summary.infos += 1;
  });

  if (!validation.ok) {
    return { issues, summary, readyToPublish: false };
  }

  return {
    catalogId: validation.value.id,
    catalogHash: hashCapabilityCatalog(validation.value),
    issues,
    summary,
    readyToPublish: summary.errors === 0,
  };
}

/**
 * Creates the serializable model used by a local host-review UI. Candidate fields/parameters may
 * be shown locally as unapproved, but they are never added to the canonical catalog or planner
 * manifest until the host changes its registration/import allow-list and recompiles.
 */
export function createCatalogInventory(
  catalog: CapabilityCatalog,
  candidates: readonly CapabilityReviewCandidate[] = [],
): CatalogInventory {
  const candidateByCapability = new Map(
    candidates.map((candidate) => [candidate.capabilityId, candidate]),
  );

  return {
    catalog,
    report: reviewCapabilityCatalog(catalog),
    capabilities: catalog.capabilities.map((capability) => {
      const candidate = candidateByCapability.get(capability.id);
      const inputProperties = objectProperties(capability.inputSchema);
      const dataType = catalog.dataTypes.find(
        (entry) => entry.id === capability.output.dataTypeId,
      );
      const approvedParameters: ReviewableItem[] = Object.entries(inputProperties).map(
        ([id, definition]) => {
          const description = descriptionFromSchema(definition);
          return {
            id,
            label: id,
            approved: true,
            ...(description ? { description } : {}),
          };
        },
      );
      const approvedFields: ReviewableItem[] = Object.entries(dataType?.fields ?? {}).map(
        ([id, field]) => ({
          id,
          label: field.label,
          approved: true,
          ...(field.description ? { description: field.description } : {}),
        }),
      );

      const addCandidates = (
        approved: ReviewableItem[],
        proposed:
          | readonly (Omit<ReviewableItem, "approved"> & { approved?: boolean })[]
          | undefined,
      ): ReviewableItem[] => {
        const seen = new Set(approved.map((item) => item.id));
        const extra = (proposed ?? [])
          .filter((item) => !seen.has(item.id))
          .map((item) => ({
            ...item,
            approved: item.approved ?? false,
            availableForApproval: true,
          }));
        return [...approved, ...extra];
      };

      return {
        capabilityId: capability.id,
        purpose: capability.purpose,
        visitorParameters: addCandidates(
          approvedParameters,
          candidate?.visitorParameters,
        ),
        serverOnlyKeys: [...capability.requiredSessionKeys],
        outputFields: addCandidates(approvedFields, candidate?.outputFields),
      };
    }),
  };
}

/** Export the current review choices. The host applies this to its source registration/import config. */
export function createCatalogDecisionsExport(
  inventory: CatalogInventory,
  exportedAt = new Date().toISOString(),
): CatalogDecisionsExport {
  const catalogHash = inventory.report.catalogHash ?? hashCapabilityCatalog(inventory.catalog);
  return {
    schemaVersion: "1.0",
    catalogId: inventory.catalog.id,
    catalogHash,
    exportedAt,
    capabilities: inventory.capabilities.map((capability) => ({
      capabilityId: capability.capabilityId,
      approvedVisitorParameters: capability.visitorParameters
        .filter((parameter) => parameter.approved)
        .map((parameter) => parameter.id),
      approvedOutputFields: capability.outputFields
        .filter((field) => field.approved)
        .map((field) => field.id),
    })),
  };
}
