import { hashContent } from "./hash.js";
import type {
  CapabilityCatalog,
  CapabilityDescriptor,
  CapabilitySupport,
  JsonSchema,
  ResultShape,
} from "./schema.js";
import { CapabilityCatalogSchema } from "./schema.js";

export interface CatalogIssue {
  path: string;
  message: string;
}

export class CatalogDefinitionError extends Error {
  readonly issues: CatalogIssue[];

  constructor(issues: CatalogIssue[]) {
    super(
      `Invalid capability catalog: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
    this.name = "CatalogDefinitionError";
    this.issues = issues;
  }
}

function duplicateIssues(
  values: readonly { id: string }[],
  path: string,
): CatalogIssue[] {
  const seen = new Set<string>();
  const issues: CatalogIssue[] = [];

  values.forEach((value, index) => {
    if (seen.has(value.id)) {
      issues.push({
        path: `${path}[${index}].id`,
        message: `Duplicate id "${value.id}"`,
      });
    }
    seen.add(value.id);
  });

  return issues;
}

function topLevelProperties(schema: JsonSchema): Set<string> {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return new Set();
  }
  return new Set(Object.keys(properties));
}

export function validateCapabilityCatalogDefinition(
  input: unknown,
): { ok: true; value: CapabilityCatalog } | { ok: false; issues: CatalogIssue[] } {
  const parsed = CapabilityCatalogSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  const catalog = parsed.data;
  const issues: CatalogIssue[] = [
    ...duplicateIssues(catalog.dataTypes, "dataTypes"),
    ...duplicateIssues(catalog.sources, "sources"),
    ...duplicateIssues(catalog.capabilities, "capabilities"),
    ...duplicateIssues(catalog.relationships, "relationships"),
  ];

  const dataTypes = new Map(catalog.dataTypes.map((entry) => [entry.id, entry]));
  const sourceIds = new Set(catalog.sources.map((entry) => entry.id));
  const capabilityIds = new Set(catalog.capabilities.map((entry) => entry.id));

  catalog.dataTypes.forEach((dataType, index) => {
    if (dataType.matchKey && !dataType.fields[dataType.matchKey]) {
      issues.push({
        path: `dataTypes[${index}].matchKey`,
        message: `Unknown match key field "${dataType.matchKey}" on data type "${dataType.id}"`,
      });
    }
  });

  catalog.capabilities.forEach((capability, index) => {
    const path = `capabilities[${index}]`;

    const outputDataType = dataTypes.get(capability.output.dataTypeId);
    if (!outputDataType) {
      issues.push({
        path: `${path}.output.dataTypeId`,
        message: `Unknown data type "${capability.output.dataTypeId}"`,
      });
    }

    capability.sourceIds.forEach((sourceId, sourceIndex) => {
      if (!sourceIds.has(sourceId)) {
        issues.push({
          path: `${path}.sourceIds[${sourceIndex}]`,
          message: `Unknown source "${sourceId}"`,
        });
      }
    });

    if (capability.inputSchema.type !== "object") {
      issues.push({
        path: `${path}.inputSchema`,
        message: "Capability inputSchema must be a JSON Schema object",
      });
    }

    if (capability.inputSchema.additionalProperties !== false) {
      issues.push({
        path: `${path}.inputSchema.additionalProperties`,
        message: "Capability inputSchema must reject additional properties",
      });
    }

    const contentKeys = topLevelProperties(capability.inputSchema);
    capability.requiredSessionKeys.forEach((sessionKey, sessionIndex) => {
      if (contentKeys.has(sessionKey)) {
        issues.push({
          path: `${path}.requiredSessionKeys[${sessionIndex}]`,
          message: `Session key "${sessionKey}" is also exposed as a planner-controlled content parameter`,
        });
      }
    });

    if (
      capability.policy.authentication === "public" &&
      (capability.policy.requiredPermissions?.length ?? 0) > 0
    ) {
      issues.push({
        path: `${path}.policy.requiredPermissions`,
        message: "A capability with required permissions must use session authentication",
      });
    }

    if (outputDataType && capability.supports) {
      const declaredFieldGroups: Array<
        [
          keyof Pick<
            NonNullable<CapabilityDescriptor["supports"]>,
            "filterFields" | "sortFields" | "groupFields"
          >,
          string[] | undefined,
        ]
      > = [
        ["filterFields", capability.supports.filterFields],
        ["sortFields", capability.supports.sortFields],
        ["groupFields", capability.supports.groupFields],
      ];
      declaredFieldGroups.forEach(([supportName, fields]) => {
        fields?.forEach((field, fieldIndex) => {
          if (!outputDataType.fields[field]) {
            issues.push({
              path: `${path}.supports.${supportName}[${fieldIndex}]`,
              message: `Unknown ${supportName} field "${field}" on data type "${outputDataType.id}"`,
            });
          }
        });
      });

      if ((capability.supports.setOperations?.length ?? 0) > 0) {
        if (!outputDataType.matchKey) {
          issues.push({
            path: `${path}.supports.setOperations`,
            message: `Data type "${outputDataType.id}" must declare a matchKey for set operations`,
          });
        }
        if (
          !["collection", "search-results", "media-collection"].includes(
            capability.output.shape,
          )
        ) {
          issues.push({
            path: `${path}.supports.setOperations`,
            message: `Set operations require a collection result, not "${capability.output.shape}"`,
          });
        }
      }
    }
  });

  catalog.relationships.forEach((relationship, index) => {
    const path = `relationships[${index}]`;
    const fromType = dataTypes.get(relationship.from.dataTypeId);
    const toType = dataTypes.get(relationship.to.dataTypeId);

    if (!fromType) {
      issues.push({
        path: `${path}.from.dataTypeId`,
        message: `Unknown data type "${relationship.from.dataTypeId}"`,
      });
    } else if (!fromType.fields[relationship.from.field]) {
      issues.push({
        path: `${path}.from.field`,
        message: `Unknown field "${relationship.from.field}" on data type "${fromType.id}"`,
      });
    }

    if (!toType) {
      issues.push({
        path: `${path}.to.dataTypeId`,
        message: `Unknown data type "${relationship.to.dataTypeId}"`,
      });
    } else if (!toType.fields[relationship.to.field]) {
      issues.push({
        path: `${path}.to.field`,
        message: `Unknown field "${relationship.to.field}" on data type "${toType.id}"`,
      });
    }

    if (
      relationship.resolverCapabilityId &&
      !capabilityIds.has(relationship.resolverCapabilityId)
    ) {
      issues.push({
        path: `${path}.resolverCapabilityId`,
        message: `Unknown resolver capability "${relationship.resolverCapabilityId}"`,
      });
    }
  });

  return issues.length === 0 ? { ok: true, value: catalog } : { ok: false, issues };
}

export function assertCapabilityCatalog(input: unknown): CapabilityCatalog {
  const result = validateCapabilityCatalogDefinition(input);
  if (!result.ok) {
    throw new CatalogDefinitionError(result.issues);
  }
  return result.value;
}



export function hashCapabilityCatalog(catalog: CapabilityCatalog): string {
  return hashContent(catalog);
}

export interface PlannerCapability {
  id: string;
  version: string;
  purpose: string;
  inputSchema: JsonSchema;
  output: CapabilityDescriptor["output"];
  supports?: CapabilityDescriptor["supports"];
  constraints: {
    authentication: CapabilityDescriptor["policy"]["authentication"];
    maximumRows?: number;
  };
}

export interface PlannerManifest {
  schemaVersion: "1.0";
  catalogId: string;
  catalogVersion: string;
  catalogHash: string;
  description: string;
  dataTypes: CapabilityCatalog["dataTypes"];
  capabilities: PlannerCapability[];
  relationships: Array<{
    id: string;
    description: string;
    fromDataTypeId: string;
    toDataTypeId: string;
    cardinality: CapabilityCatalog["relationships"][number]["cardinality"];
  }>;
}

/**
 * Projects the trusted server catalog into the only form a planner may receive. Loader code,
 * session-key names, endpoint details, source URLs, cache settings, and join keys stay server-side.
 */
export function createPlannerManifest(catalog: CapabilityCatalog): PlannerManifest {
  return {
    schemaVersion: "1.0",
    catalogId: catalog.id,
    catalogVersion: catalog.version,
    catalogHash: hashCapabilityCatalog(catalog),
    description: catalog.description,
    dataTypes: catalog.dataTypes,
    capabilities: catalog.capabilities.map((capability) => ({
      id: capability.id,
      version: capability.version,
      purpose: capability.purpose,
      inputSchema: capability.inputSchema,
      output: capability.output,
      ...(capability.supports ? { supports: capability.supports } : {}),
      constraints: {
        authentication: capability.policy.authentication,
        ...(capability.policy.maximumRows !== undefined
          ? { maximumRows: capability.policy.maximumRows }
          : {}),
      },
    })),
    relationships: catalog.relationships.map((relationship) => ({
      id: relationship.id,
      description: relationship.description,
      fromDataTypeId: relationship.from.dataTypeId,
      toDataTypeId: relationship.to.dataTypeId,
      cardinality: relationship.cardinality,
    })),
  };
}

export function findCapability(
  catalog: CapabilityCatalog,
  capabilityId: string,
): CapabilityDescriptor | undefined {
  return catalog.capabilities.find((capability) => capability.id === capabilityId);
}

/** Shapes that are a list of rows, and therefore the only ones a filter or sort means anything against. */
const LIST_RESULT_SHAPES = new Set<ResultShape>([
  "collection",
  "search-results",
  "media-collection",
]);

/**
 * Whether a result shape is row-oriented — the shapes `query.limit`, filters
 * and sorts apply to. Exported so a caller building a synthetic request (the
 * catalog probe does) can decide whether `limit` is legal without restating
 * this list and drifting from it.
 */
export function isListResultShape(shape: ResultShape): boolean {
  return LIST_RESULT_SHAPES.has(shape);
}

/**
 * Relay paging arguments. They choose how much of a connection to read, not
 * which records qualify, so they are excluded from source-narrowing facts.
 */
const PAGING_ARGUMENT_NAMES = new Set(["first", "last", "after", "before"]);

/**
 * The approved visitor arguments that narrow the result at the source.
 *
 * Everything a visitor-approved argument does, it does at the origin, over
 * the whole dataset — a `filter`, a `search`, a `sortBy`, a channel selector.
 * The only approved arguments that do not are the paging ones. Measured live:
 * 146 of 165 advertised `filterFields` across one catalog could never reach
 * the upstream, while the arguments that could were advertised nowhere — so
 * the planner filtered fetched pages and called the survivors the answer.
 */
export function sourceNarrowingArgumentNames(
  approvedVisitorArguments: readonly string[],
  // A non-Relay API's own paging vocabulary (`limit`, `page`, `offset`), when
  // the host declared one. Advertising a page size as an argument that
  // "narrows which records qualify" is the exact false claim this function
  // exists to end, so the declared names are excluded the same way the Relay
  // set is.
  alsoPaging: readonly string[] = [],
): string[] {
  const declared = new Set(alsoPaging);
  return approvedVisitorArguments.filter(
    (name) => !PAGING_ARGUMENT_NAMES.has(name) && !declared.has(name),
  );
}

/**
 * Records the derived source-narrowing arguments on a capability's `supports`.
 *
 * Fills the field only when the reviewer's own `supports` did not state one:
 * the derivation is a fact of the decisions, not a preference, but an explicit
 * declaration is the reviewer's and wins. Never invents an empty list — a
 * capability with no narrowing arguments carries no field, so its absence
 * stays meaningful.
 */
export function withSourceNarrowingArguments(
  supports: CapabilitySupport | undefined,
  narrowingArguments: readonly string[],
): CapabilitySupport | undefined {
  if (narrowingArguments.length === 0) return supports;
  if (supports?.sourceNarrowingArguments !== undefined) return supports;
  return { ...(supports ?? {}), sourceNarrowingArguments: [...narrowingArguments] };
}

/**
 * What a capability supports when the reviewer didn't say.
 *
 * Filtering, sorting, grouping and aggregating were fully built — declared in
 * the catalog schema, advertised to the planner, enforced by validation,
 * executed by the runtime — and reachable only by hand-authoring a catalog
 * object. Every catalog produced by an importer had no `supports` at all, so
 * every "show me only the open ones" degraded silently into "show me
 * everything", and the visitor could not tell the difference. A 33-capability
 * production catalog had zero filterable fields.
 *
 * Defaulting rather than requiring a declaration, because the declaration adds
 * no safety here. These operations run *locally*, over rows the owner already
 * approved for display and that have already been fetched: filtering exposes no
 * field that was not already visible, sorting reorders what was already sent,
 * and neither reaches the upstream, so there is no extra load to authorize. The
 * owner's real decision — which fields may be seen at all — was already made
 * when they chose the approved output fields, and this follows it exactly.
 *
 * A reviewer who wants a narrower set still passes `supports` explicitly and
 * this is not consulted.
 *
 * Deliberately not defaulted: `aggregates`, which needs the owner to say which
 * arithmetic is meaningful for their data, and `pagination`, which is a claim
 * about the *upstream's* behaviour that nothing here can verify.
 */
export function defaultSupportsForApprovedFields(
  resultShape: ResultShape,
  approvedFields: readonly string[],
  /**
   * The result's own schema, when the caller has it. Without it every leaf is
   * offered for sorting, including one inside a nested list — see
   * `sortablePaths`.
   */
  outputSchema?: JsonSchema,
): CapabilitySupport | undefined {
  if (!LIST_RESULT_SHAPES.has(resultShape) || approvedFields.length === 0) {
    return undefined;
  }
  const filterFields = leafFieldsOnly(approvedFields);
  if (filterFields.length === 0) return undefined;
  const sortFields = outputSchema
    ? sortablePaths(filterFields, outputSchema)
    : filterFields;
  return {
    filterFields,
    ...(sortFields.length > 0 ? { sortFields } : {}),
  };
}

/**
 * The leaves that can order rows.
 *
 * A leaf inside a nested list — `lines.productName` on an order with many lines
 * — has one value per *line*, not one per row, so "sort orders by
 * lines.productName" names no ordering: which line's product would decide it?
 * The query engine would accept it (it checks membership in this list and
 * nothing more) and produce whatever comparing the first encountered value
 * happens to give.
 *
 * Filtering is left alone, because there the same path does mean something
 * definite: "any line matches" is a well-formed question about a row.
 */
function sortablePaths(paths: readonly string[], outputSchema: JsonSchema): string[] {
  return paths.filter((path) => !crossesList(path, outputSchema));
}

/**
 * Which segments of a projected path pass through a list, outermost first.
 *
 * One entry per segment *before* the leaf — the objects on the way to the
 * value. `categories.title` on a row whose `categories` is an array reads
 * `[true]`: the value is one per related row rather than one per row.
 *
 * `undefined` when the path does not resolve against the schema at all, which
 * is a different fact from "resolves and crosses nothing" and the only honest
 * answer when the objects on the way are unknown.
 *
 * Shared with the filter push-down, which needs the same fact for a different
 * reason: a condition on a path that crosses a list means "any related row
 * matches", so only the operators whose post-fetch behaviour is already
 * existential can be compiled into the source without changing which rows
 * qualify.
 */
export function listCrossingSegments(
  path: string,
  outputSchema: JsonSchema,
): boolean[] | undefined {
  // The result's own array wrapper is the row boundary, not a nesting to
  // report: every path is relative to a row.
  let node = unwrapArray(outputSchema);
  const segments = path.split(".");
  const crossings: boolean[] = [];
  // The last segment is the value itself; only the objects on the way to it can
  // introduce a list.
  for (const segment of segments.slice(0, -1)) {
    const properties = (node as { properties?: Record<string, JsonSchema> }).properties;
    const next = properties?.[segment];
    if (!next) return undefined;
    crossings.push(isArraySchema(next));
    node = unwrapArray(next);
  }
  return crossings;
}

function crossesList(path: string, outputSchema: JsonSchema): boolean {
  return listCrossingSegments(path, outputSchema)?.some(Boolean) ?? false;
}

function isArraySchema(schema: JsonSchema): boolean {
  return (schema as { type?: unknown }).type === "array";
}

function unwrapArray(schema: JsonSchema): JsonSchema {
  return isArraySchema(schema)
    ? (((schema as { items?: JsonSchema }).items ?? schema) as JsonSchema)
    : schema;
}

/**
 * Approved field paths include the objects on the way to a value — approving
 * `total.gross.amount` puts `total` and `total.gross` in the list too. Comparing
 * or ordering by one of those means comparing objects, which the query engine
 * will accept (it checks membership in this list, nothing more) and which has no
 * meaningful answer. A path is offerable only when nothing extends it.
 */
function leafFieldsOnly(paths: readonly string[]): string[] {
  const prefixes = new Set<string>();
  for (const path of paths) {
    const segments = path.split(".");
    for (let index = 1; index < segments.length; index += 1) {
      prefixes.add(segments.slice(0, index).join("."));
    }
  }
  return paths.filter((path) => !prefixes.has(path));
}
