import { z } from "zod";
import type { PlannerManifest } from "./compile.js";
import type { CapabilityCatalog } from "./schema.js";
import type {
  CompiledGraphQlCatalog,
  GraphQlOperationBinding,
  GraphQlSchemaInput,
} from "./graphql.js";

/**
 * The one artifact a review produces and a host loads.
 *
 * Before this contract, "publishing a review" meant a human carrying loose
 * pieces across the seam by hand: POST the capability catalog, separately
 * build and POST a UI catalog under the same id, and know out-of-band which
 * origins the host must allowlist. Each forgotten piece failed later and
 * mysteriously (a compose with no components, a fetch refused at runtime).
 * The export bundles every piece with a format version, so a host can load
 * it in one call and be told up front what is missing.
 *
 * The format is versioned independently of package versions: a stored
 * export outlives the code that wrote it, and a loader must be able to say
 * "this bundle is newer than me" rather than half-loading it.
 */
export const REVIEW_EXPORT_FORMAT = "renderyes-review-export";
export const REVIEW_EXPORT_VERSION = 1;

export interface ReviewExport {
  format: typeof REVIEW_EXPORT_FORMAT;
  formatVersion: typeof REVIEW_EXPORT_VERSION;
  catalogId: string;
  bindingKind: "graphql";
  capability: {
    catalog: CapabilityCatalog;
    plannerManifest: PlannerManifest;
    bindings: Record<string, GraphQlOperationBinding>;
    schema: GraphQlSchemaInput;
    endpoint: string;
    /** Opaque key into the host's upstreamCredentials, never a secret. */
    credentialId?: string;
  };
  /** A site manifest (`toSiteManifest`) whose siteId is the catalogId. */
  ui: { manifest: Record<string, unknown> };
  /**
   * What the host must already have configured for this export to run.
   * Deliberately declarative: the loader checks these and fails with the
   * checklist instead of letting the first compose fail mysteriously.
   */
  requirements: { upstreamOrigins: string[] };
}

/** Envelope-level validation; catalog/manifest internals are re-validated by the publish path. */
export const ReviewExportEnvelopeSchema = z.object({
  format: z.literal(REVIEW_EXPORT_FORMAT),
  formatVersion: z.number().int().positive(),
  catalogId: z.string().min(1),
  bindingKind: z.literal("graphql"),
  capability: z.object({
    catalog: z.record(z.string(), z.unknown()),
    plannerManifest: z.record(z.string(), z.unknown()),
    bindings: z.record(z.string(), z.unknown()),
    schema: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
    endpoint: z.string().url(),
    credentialId: z.string().min(1).optional(),
  }),
  ui: z.object({ manifest: z.record(z.string(), z.unknown()) }),
  requirements: z.object({ upstreamOrigins: z.array(z.string().min(1)) }),
});

export function buildGraphQlReviewExport(options: {
  catalogId: string;
  compiled: CompiledGraphQlCatalog;
  schema: GraphQlSchemaInput;
  endpoint: string;
  credentialId?: string;
  uiManifest: Record<string, unknown>;
}): ReviewExport {
  const endpointUrl = new URL(options.endpoint);
  return {
    format: REVIEW_EXPORT_FORMAT,
    formatVersion: REVIEW_EXPORT_VERSION,
    catalogId: options.catalogId,
    bindingKind: "graphql",
    capability: {
      catalog: options.compiled.catalog,
      plannerManifest: options.compiled.plannerManifest,
      bindings: Object.fromEntries(options.compiled.bindings),
      schema: options.schema,
      endpoint: options.endpoint,
      ...(options.credentialId ? { credentialId: options.credentialId } : {}),
    },
    ui: { manifest: options.uiManifest },
    requirements: { upstreamOrigins: [endpointUrl.origin] },
  };
}
