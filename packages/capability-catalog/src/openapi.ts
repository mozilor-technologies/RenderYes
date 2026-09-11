import { z } from "zod";
import {
  assertCapabilityCatalog,
  createPlannerManifest,
  defaultSupportsForApprovedFields,
  type PlannerManifest,
} from "./compile.js";
import { canonicalize, hashContent } from "./hash.js";
import { CapabilityPolicySchema } from "./schema.js";
import type {
  CapabilityCatalog,
  CapabilityPolicy,
  CapabilitySupport,
  DataTypeDescriptor,
  FieldDescriptor,
  JsonSchema,
  RelationshipDescriptor,
  ResultShape,
  SourceDescriptor,
} from "./schema.js";
import {
  inferSemanticType as inferSharedSemanticType,
  type SemanticValueKind,
} from "./semantic-type.js";
import type {
  OperationClassificationInput,
  OperationEffect,
} from "./operation-effect.js";

type UnknownRecord = Record<string, unknown>;

export interface OpenApiOperationSelection {
  /** Preferred stable selector. */
  operationId?: string;
  /** Fallback selector for documents that do not define operationId. */
  path?: string;
  method?: "get" | "post";
  capabilityId: string;
  purpose?: string;
  version?: string;
  dataTypeId: string;
  dataTypeVersion?: string;
  dataTypeDescription?: string;
  /** Stable approved output field for deterministic set composition. */
  matchKey?: string;
  resultShape: ResultShape;
  /** Planner-controlled query/path parameters approved by the host. */
  contentParameters: readonly string[];
  /**
   * Top-level JSON request-body properties approved as planner-controlled
   * inputs. These are kept separate from URL parameters so the server can
   * construct a POST body deterministically.
   */
  bodyParameters?: readonly string[];
  /** Top-level response fields approved for generated views. */
  exposeFields: readonly string[];
  fields?: Record<string, FieldDescriptor>;
  supports?: CapabilitySupport;
  policy: OpenApiOperationPolicy;
  requiredSessionKeys?: readonly string[];
}

/**
 * Host policy for one approved OpenAPI operation.
 *
 * `authentication` is required and has no default, which is the whole point of
 * this type existing. The selection used to carry `policy?: Partial<...>` —
 * optional *and* partial — and compilation fell back to `"public"`. At execution
 * the gate tests `authentication === "session"` and iterates
 * `requiredPermissions ?? []`, so a defaulted `"public"` skipped both checks: a
 * capability nobody had decided about behaved exactly like one deliberately
 * opened, and no reviewer was ever shown the question.
 *
 * The GraphQL importer has always required it — `CuratedGraphQlCatalogPolicy`
 * declares `authentication` non-optional and its compiler consumes the field
 * with no fallback. This is that discipline, not a REST-shaped invention.
 *
 * Every other field stays optional, because each one narrows: omitting
 * `requiredPermissions` grants nothing extra, and omitting `maximumRows` or
 * `timeoutMs` falls back to a bound rather than to no bound.
 */
export interface OpenApiOperationPolicy
  extends Partial<Omit<CapabilityPolicy, "authentication">> {
  authentication: CapabilityPolicy["authentication"];
  /**
   * Largest age the host will accept for a returned result, in seconds.
   *
   * Not on `CapabilityPolicy`, because it is a transport-level limit rather than
   * part of the canonical catalog — the same reason
   * `CuratedGraphQlCatalogPolicy` carries its own copy. It reaches the runtime
   * through `OpenApiOperationBinding.freshnessMaximumAgeSeconds`.
   */
  freshnessMaximumAgeSeconds?: number;
}

export interface OpenApiCatalogImportOptions {
  document: unknown;
  catalog: {
    id: string;
    version: string;
    description: string;
  };
  source: SourceDescriptor;
  /**
   * Explicit allow-list. Importing every operation automatically would silently grant the planner
   * capabilities the host did not review.
   */
  operations: readonly OpenApiOperationSelection[];
  relationships?: readonly RelationshipDescriptor[];
}

export interface OpenApiInventoryIssue {
  severity: "warning" | "error";
  path: string;
  message: string;
}

export interface OpenApiOperationBinding {
  capabilityId: string;
  operationId?: string;
  method: "GET" | "POST";
  path: string;
  serverUrl?: string;
  contentParameters: readonly string[];
  bodyParameters?: readonly string[];
  exposeFields: readonly string[];
  /**
   * Hash of the OpenAPI description this operation was approved against.
   *
   * The GraphQL binding carries `schemaHash` and its compiler re-hashes the
   * schema on every request, because a GraphQL endpoint can be introspected. A
   * REST API generally cannot: the description is a document the host holds, not
   * something the API serves, so there is nothing to re-hash per request and
   * pretending otherwise would mean either trusting a self-reported version or
   * fetching a document on the hot path.
   *
   * So the check moves to where a description actually exists — see
   * `detectOpenApiDocumentDrift`, which a host runs at boot, in CI, or before
   * republishing. The per-request half of the same guarantee is already covered
   * from the other direction: `validateCapabilityResult` validates every
   * response against the approved output schema, so a contract that moved shows
   * up as a rejected response rather than as silently different data.
   */
  documentHash: string;
  /**
   * Largest age, in seconds, the host will accept for a returned result.
   *
   * Enforced against the age the *upstream* reports — `Last-Modified`, or `Date`
   * less `Age` — not against the moment we fetched. Stamping the fetch time and
   * comparing a limit to it would always pass, which is a check that reads as a
   * guarantee and is not one.
   *
   * Omitted, no freshness limit applies.
   *
   * A limit also cannot be enforced against an upstream that reports no age at
   * all — no `Last-Modified`, no `Date`/`Age`. Those results are accepted rather
   * than refused, because most REST APIs report nothing and refusing would make
   * the option unusable; provenance then carries the fetch time, so the value is
   * "when we asked" rather than a claim about the data. That is a deliberate
   * choice not to fail closed, and the one place on this path where a stated
   * limit can be silently inapplicable.
   */
  freshnessMaximumAgeSeconds?: number;
}

export interface CompiledOpenApiCatalog {
  catalog: CapabilityCatalog;
  plannerManifest: PlannerManifest;
  bindings: ReadonlyMap<string, OpenApiOperationBinding>;
  issues: OpenApiInventoryIssue[];
}

/**
 * Metadata required to review an explicitly selected OpenAPI operation before it
 * becomes a capability.
 *
 * `policy` is omitted rather than required here: reviewing is the step where a
 * host decides authentication, so demanding the decision as an input to the
 * review would put it before the question is asked. It becomes required on
 * `OpenApiOperationSelection`, at decisions, which is the point the answer has to
 * exist.
 */
export type OpenApiOperationReviewSelection = Omit<
  OpenApiOperationSelection,
  "contentParameters" | "exposeFields" | "fields" | "policy"
>;

export interface OpenApiCatalogReviewOptions {
  document: unknown;
  catalog: OpenApiCatalogImportOptions["catalog"];
  source: SourceDescriptor;
  /** The host must name each candidate operation. There is no whole-document auto-exposure. */
  operations: readonly OpenApiOperationReviewSelection[];
  relationships?: readonly RelationshipDescriptor[];
}

/**
 * A read-only operation discovered in an OpenAPI document. Discovery is intentionally separate
 * from import: seeing an operation never grants it to a catalog or planner.
 */
export interface OpenApiGetOperation {
  operationId?: string;
  path: string;
  method: "get";
  summary?: string;
  description?: string;
  /** OpenAPI tags are the preferred owner-facing grouping when a source provides them. */
  tags: string[];
  /** Whether Phase 1 can read a JSON success response from this operation. */
  support: {
    status: "supported" | "unsupported";
    reason?: string;
  };
}

/**
 * A GET or POST candidate for semantic-effect classification. This remains a
 * discovery artifact: neither `support` nor a future classifier suggestion is
 * permission to execute it.
 */
export interface OpenApiOperationCandidate {
  operationId?: string;
  path: string;
  method: "get" | "post";
  summary?: string;
  description?: string;
  tags: string[];
  explicitEffect?: OperationEffect;
  classificationInput: OperationClassificationInput;
  classificationIssues: OpenApiInventoryIssue[];
  support: OpenApiGetOperation["support"];
}

export interface OpenApiReviewParameter {
  id: string;
  label: string;
  description?: string;
  location: "query" | "path" | "body";
  /** The planner-safe decisions ID. Body fields use `body.<field>`. */
  transportName: string;
  required: boolean;
}

export interface OpenApiReviewField {
  id: string;
  label: string;
  description?: string;
  semanticType: FieldDescriptor["semanticType"];
}

export interface OpenApiOperationInventory {
  capabilityId: string;
  purpose: string;
  operationId?: string;
  path: string;
  method: "GET" | "POST";
  availableVisitorParameters: OpenApiReviewParameter[];
  serverOnlyKeys: string[];
  availableOutputFields: OpenApiReviewField[];
}

/** Serializable local-review model. It contains source metadata, but no runtime binding or records. */
export interface OpenApiCatalogInventory {
  schemaVersion: "1.0";
  reviewSourceHash: string;
  catalog: OpenApiCatalogImportOptions["catalog"];
  source: SourceDescriptor;
  relationships: readonly RelationshipDescriptor[];
  /** The host-selected operation metadata needed to compile an approved review. */
  operationSelections: readonly OpenApiOperationReviewSelection[];
  operations: OpenApiOperationInventory[];
  issues: OpenApiInventoryIssue[];
}

/** The decisions file a host stores alongside the OpenAPI review configuration. */
export const OpenApiCatalogDecisionsSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  reviewSourceHash: z.string().min(1),
  operations: z.array(
    z.strictObject({
      capabilityId: z.string().min(1),
      approvedVisitorParameters: z.array(z.string().min(1)),
      approvedOutputFields: z.array(z.string().min(1)),
      /**
       * The reviewer's access decision, recorded in the artifact.
       *
       * This field did not exist, which is why compilation had to invent one:
       * the decisions file described *which fields* were approved and said
       * nothing about *who may read them*, so `authentication` was defaulted to
       * `"public"` downstream and both the authentication and permission gates
       * were skipped at execution.
       *
       * `CapabilityPolicySchema` already requires `authentication`, so reusing
       * it means a decisions file that omits the decision fails validation instead of
       * acquiring one. Existing decisions files predate this field and will be
       * rejected — deliberately: a decisions file with no recorded access decision is
       * exactly what should not compile.
       */
      policy: CapabilityPolicySchema,
    }),
  ),
});
export type OpenApiCatalogDecisions = z.infer<typeof OpenApiCatalogDecisionsSchema>;

interface LocatedOperation {
  operation: UnknownRecord;
  pathItem: UnknownRecord;
  path: string;
  method: DiscoverableMethod;
}

type DiscoverableMethod = "get" | "post";

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}



function assertOpenApi3Document(document: unknown): UnknownRecord {
  const parsed = requiredRecord(document, "document");
  if (typeof parsed.openapi !== "string" || !parsed.openapi.startsWith("3.")) {
    throw new Error("Phase 1 supports OpenAPI 3.x documents only");
  }
  return parsed;
}

function explicitEffectFor(operation: UnknownRecord): {
  effect?: OperationEffect;
  issues: OpenApiInventoryIssue[];
} {
  const value = operation["x-renderyes-effect"];
  if (value === undefined) return { issues: [] };
  const normalized =
    value === "query"
      ? "read-only-query"
      : value === "action"
        ? "state-changing-action"
        : value;
  if (
    normalized === "read-only-query" ||
    normalized === "state-changing-action" ||
    normalized === "ambiguous"
  ) {
    return { effect: normalized, issues: [] };
  }
  return {
    issues: [
      {
        severity: "warning",
        path: "x-renderyes-effect",
        message:
          'Expected "query", "action", "read-only-query", "state-changing-action", or "ambiguous"',
      },
    ],
  };
}

function compactSchemaShape(value: unknown, depth = 0): unknown {
  if (!isRecord(value)) return value;
  const summary: UnknownRecord = {};
  for (const key of [
    "type",
    "format",
    "title",
    "description",
    "enum",
    "default",
  ] as const) {
    if (value[key] !== undefined) summary[key] = value[key];
  }
  if (Array.isArray(value.required)) {
    summary.required = value.required.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  if (depth < 2 && isRecord(value.properties)) {
    summary.properties = Object.fromEntries(
      Object.entries(value.properties).map(([name, schema]) => [
        name,
        compactSchemaShape(schema, depth + 1),
      ]),
    );
  }
  if (depth < 2 && value.items !== undefined) {
    summary.items = compactSchemaShape(value.items, depth + 1);
  }
  for (const combinator of ["oneOf", "anyOf", "allOf"] as const) {
    if (depth < 2 && Array.isArray(value[combinator])) {
      summary[combinator] = value[combinator].map((entry) =>
        compactSchemaShape(entry, depth + 1),
      );
    }
  }
  return summary;
}

function requestBodyShapeFor(
  located: LocatedOperation,
  document: UnknownRecord,
): { shape?: unknown; unsupportedReason?: string } {
  if (located.operation.requestBody === undefined) return {};
  const requestBody = requiredRecord(
    dereference(located.operation.requestBody, document),
    `request body for ${located.path}`,
  );
  const content = requiredRecord(
    requestBody.content,
    `request body content for ${located.path}`,
  );
  const mediaType =
    content["application/json"] ??
    Object.entries(content).find(([key]) => key.endsWith("+json"))?.[1];
  if (!mediaType) {
    return {
      unsupportedReason:
        "Read-only POST onboarding currently requires a documented JSON request body",
    };
  }
  const media = requiredRecord(mediaType, `JSON request media type for ${located.path}`);
  const schema = dereference(media.schema, document);
  return {
    shape: {
      required: requestBody.required === true,
      schema: compactSchemaShape(schema),
    },
  };
}

/**
 * Returns the full documented JSON request-body schema. Read-only POST
 * onboarding deliberately supports only top-level object bodies in this
 * first slice: it makes every planner input independently reviewable and
 * prevents the runtime from inventing a nested payload shape.
 */
function requestBodySchemaFor(
  located: LocatedOperation,
  document: UnknownRecord,
): { schema?: JsonSchema; required: boolean } {
  if (located.operation.requestBody === undefined) return { required: false };
  const requestBody = requiredRecord(
    dereference(located.operation.requestBody, document),
    `request body for ${located.path}`,
  );
  const content = requiredRecord(
    requestBody.content,
    `request body content for ${located.path}`,
  );
  const mediaType =
    content["application/json"] ??
    Object.entries(content).find(([key]) => key.endsWith("+json"))?.[1];
  if (!mediaType) {
    throw new Error("Read-only POST onboarding requires a documented JSON request body");
  }
  const media = requiredRecord(mediaType, `JSON request media type for ${located.path}`);
  const rawSchema = dereference(media.schema, document);
  const schema = requiredRecord(
    rawSchema,
    `JSON request body schema for ${located.path}`,
  );
  if (schema.type !== "object" || !isRecord(schema.properties)) {
    throw new Error(
      "Read-only POST onboarding currently requires a documented top-level JSON object body",
    );
  }
  return { schema, required: requestBody.required === true };
}

function classificationInputFor(
  located: LocatedOperation,
  document: UnknownRecord,
  explicitEffect: OperationEffect | undefined,
): OperationClassificationInput {
  const parameters = mergedParameters(located, document).map((parameter) => ({
    ...(typeof parameter.name === "string" ? { name: parameter.name } : {}),
    ...(typeof parameter.in === "string" ? { location: parameter.in } : {}),
    required: parameter.required === true,
    ...(typeof parameter.description === "string"
      ? { description: parameter.description }
      : {}),
    schema: compactSchemaShape(dereference(parameter.schema, document)),
  }));
  const requestBody = requestBodyShapeFor(located, document).shape;
  const outputShape = compactSchemaShape(responseSchemaFor(located, document));
  const security = located.operation.security ?? document.security;
  return {
    operationKey: `${located.method}:${located.path}`,
    protocol: "openapi",
    coordinate: `${located.method.toUpperCase()} ${located.path}`,
    ...(typeof located.operation.operationId === "string"
      ? { operationName: located.operation.operationId }
      : {}),
    ...(typeof located.operation.summary === "string"
      ? { summary: located.operation.summary }
      : {}),
    ...(typeof located.operation.description === "string"
      ? { description: located.operation.description }
      : {}),
    tags: Array.isArray(located.operation.tags)
      ? located.operation.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    inputShape: {
      parameters,
      ...(requestBody ? { requestBody } : {}),
    },
    outputShape,
    ...(security !== undefined ? { security: canonicalize(security) } : {}),
    ...(explicitEffect ? { explicitEffect } : {}),
  };
}

/**
 * Lists typed GET and POST candidates for semantic classification. Discovery
 * never grants planner or runtime access.
 */
export function listOpenApiOperations(
  documentInput: unknown,
): OpenApiOperationCandidate[] {
  const document = assertOpenApi3Document(documentInput);
  const paths = requiredRecord(document.paths, "paths");

  return Object.entries(paths).flatMap(([path, rawPathItem]) => {
    if (!isRecord(rawPathItem)) return [];
    return (["get", "post"] as const).flatMap((method) => {
      if (!isRecord(rawPathItem[method])) return [];
      const operation = rawPathItem[method];
      const located: LocatedOperation = {
        operation,
        pathItem: rawPathItem,
        path,
        method,
      };
      const explicit = explicitEffectFor(operation);
      let support: OpenApiOperationCandidate["support"];
      let classificationInput: OperationClassificationInput;
      try {
        const body = requestBodyShapeFor(located, document);
        if (method === "post" && body.unsupportedReason) {
          throw new Error(body.unsupportedReason);
        }
        const rawOutputSchema = responseSchemaFor(located, document);
        if (!hasReviewableFields(rawOutputSchema)) {
          throw new Error(
            "This operation's success response declares no object shape, so it exposes no reviewable fields. Add a documented response schema to make it onboardable.",
          );
        }
        support = { status: "supported" };
        classificationInput = classificationInputFor(located, document, explicit.effect);
      } catch (error) {
        support = {
          status: "unsupported",
          reason:
            error instanceof Error
              ? error.message
              : "This operation is not structurally supported",
        };
        classificationInput = {
          operationKey: `${method}:${path}`,
          protocol: "openapi",
          coordinate: `${method.toUpperCase()} ${path}`,
          ...(typeof operation.operationId === "string"
            ? { operationName: operation.operationId }
            : {}),
          ...(typeof operation.summary === "string"
            ? { summary: operation.summary }
            : {}),
          ...(typeof operation.description === "string"
            ? { description: operation.description }
            : {}),
          tags: Array.isArray(operation.tags)
            ? operation.tags.filter((tag): tag is string => typeof tag === "string")
            : [],
          ...(explicit.effect ? { explicitEffect: explicit.effect } : {}),
        };
      }

      return [
        {
          path,
          method,
          ...(typeof operation.operationId === "string"
            ? { operationId: operation.operationId }
            : {}),
          ...(typeof operation.summary === "string"
            ? { summary: operation.summary }
            : {}),
          ...(typeof operation.description === "string"
            ? { description: operation.description }
            : {}),
          tags: classificationInput.tags as string[],
          ...(explicit.effect ? { explicitEffect: explicit.effect } : {}),
          classificationInput,
          classificationIssues: explicit.issues.map((issue) => ({
            ...issue,
            path: `paths.${path}.${method}.${issue.path}`,
          })),
          support,
        },
      ];
    });
  });
}

/** @deprecated Use listOpenApiOperations for effect-aware GET/POST discovery. */
export function listOpenApiGetOperations(documentInput: unknown): OpenApiGetOperation[] {
  return listOpenApiOperations(documentInput)
    .filter((operation) => operation.method === "get")
    .map(
      ({
        classificationInput: _input,
        classificationIssues: _issues,
        explicitEffect: _effect,
        ...operation
      }) => ({
        ...operation,
        method: "get" as const,
      }),
    );
}

function requiredRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new Error(`Invalid OpenAPI document: ${label} must be an object`);
  }
  return value;
}

function findOperation(
  document: UnknownRecord,
  selection: Pick<
    OpenApiOperationSelection,
    "operationId" | "path" | "method" | "capabilityId"
  >,
): LocatedOperation {
  const paths = requiredRecord(document.paths, "paths");

  if (selection.operationId) {
    for (const [path, rawPathItem] of Object.entries(paths)) {
      if (!isRecord(rawPathItem)) continue;
      for (const method of ["get", "post"] as const) {
        const operation = rawPathItem[method];
        if (
          isRecord(operation) &&
          operation.operationId === selection.operationId &&
          (selection.method === undefined || selection.method === method)
        ) {
          return { operation, pathItem: rawPathItem, path, method };
        }
      }
    }
    throw new Error(`OpenAPI operationId "${selection.operationId}" was not found`);
  }

  if (!selection.path || (selection.method !== "get" && selection.method !== "post")) {
    throw new Error(
      `OpenAPI selection "${selection.capabilityId}" must provide operationId or path + method`,
    );
  }

  const pathItem = requiredRecord(paths[selection.path], `paths.${selection.path}`);
  const operation = requiredRecord(
    pathItem[selection.method],
    `paths.${selection.path}.${selection.method}`,
  );
  return { operation, pathItem, path: selection.path, method: selection.method };
}

function decodeJsonPointerPart(part: string): string {
  return part.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolvePointer(document: UnknownRecord, pointer: string): unknown {
  if (!pointer.startsWith("#/")) {
    throw new Error(
      `Only local OpenAPI references are supported in Phase 1: "${pointer}"`,
    );
  }

  return pointer
    .slice(2)
    .split("/")
    .map(decodeJsonPointerPart)
    .reduce<unknown>((current, part) => {
      if (!isRecord(current) || !(part in current)) {
        throw new Error(`OpenAPI reference "${pointer}" could not be resolved`);
      }
      return current[part];
    }, document);
}

function dereference(
  value: unknown,
  document: UnknownRecord,
  references: readonly string[] = [],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => dereference(item, document, references));
  }
  if (!isRecord(value)) return value;

  if (typeof value.$ref === "string") {
    if (references.includes(value.$ref)) {
      throw new Error(
        `Circular OpenAPI reference is not supported in Phase 1: "${value.$ref}"`,
      );
    }
    return dereference(resolvePointer(document, value.$ref), document, [
      ...references,
      value.$ref,
    ]);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      dereference(nested, document, references),
    ]),
  );
}

function mergedParameters(
  located: LocatedOperation,
  document: UnknownRecord,
): UnknownRecord[] {
  const pathParameters = Array.isArray(located.pathItem.parameters)
    ? located.pathItem.parameters
    : [];
  const operationParameters = Array.isArray(located.operation.parameters)
    ? located.operation.parameters
    : [];

  return [...pathParameters, ...operationParameters].map((parameter) => {
    const resolved = dereference(parameter, document);
    return requiredRecord(resolved, `parameters for ${located.path}`);
  });
}

function inputSchemaFor(
  located: LocatedOperation,
  document: UnknownRecord,
  approvedParameters: readonly string[],
  approvedBodyParameters: readonly string[] = [],
): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  const available = new Set<string>();

  for (const parameter of mergedParameters(located, document)) {
    // Header and cookie parameters may carry identity or credentials and are never planner input.
    if (parameter.in !== "query" && parameter.in !== "path") continue;
    if (typeof parameter.name !== "string") continue;
    available.add(parameter.name);
    if (!approvedParameters.includes(parameter.name)) continue;

    const rawSchema = dereference(parameter.schema, document);
    const schema = isRecord(rawSchema) ? { ...rawSchema } : {};
    if (typeof parameter.description === "string" && schema.description === undefined) {
      schema.description = parameter.description;
    }
    properties[parameter.name] = schema;
    if (parameter.required === true || parameter.in === "path") {
      required.add(parameter.name);
    }
  }

  const missing = approvedParameters.filter((parameter) => !available.has(parameter));
  if (missing.length > 0) {
    throw new Error(
      `Approved content parameter(s) not found on ${located.path}: ${missing.join(", ")}`,
    );
  }

  const body = requestBodySchemaFor(located, document);
  if (body.schema) {
    const bodyProperties = requiredRecord(
      body.schema.properties,
      `JSON request body properties for ${located.path}`,
    );
    const bodyRequired = new Set(
      Array.isArray(body.schema.required)
        ? body.schema.required.filter((name): name is string => typeof name === "string")
        : [],
    );
    const unknownBody = approvedBodyParameters.filter(
      (name) => !(name in bodyProperties),
    );
    if (unknownBody.length > 0) {
      throw new Error(
        `Approved JSON body parameter(s) not found on ${located.path}: ${unknownBody.join(", ")}`,
      );
    }
    const missingRequiredBody = [...bodyRequired].filter(
      (name) => !approvedBodyParameters.includes(name),
    );
    if (missingRequiredBody.length > 0) {
      throw new Error(
        `Required JSON body parameter(s) must be approved for ${located.path}: ${missingRequiredBody.join(", ")}`,
      );
    }
    for (const name of approvedBodyParameters) {
      if (name in properties) {
        throw new Error(
          `OpenAPI input name "${name}" is used by both URL and JSON body parameters`,
        );
      }
      properties[name] = bodyProperties[name];
      if (bodyRequired.has(name)) required.add(name);
    }
  } else if (approvedBodyParameters.length > 0) {
    throw new Error(`Approved JSON body parameters are not available on ${located.path}`);
  }

  return {
    type: "object",
    properties,
    ...(required.size > 0 ? { required: [...required] } : {}),
    additionalProperties: false,
  };
}

function reviewBodyParametersFor(
  located: LocatedOperation,
  document: UnknownRecord,
): OpenApiReviewParameter[] {
  const body = requestBodySchemaFor(located, document);
  if (!body.schema) return [];
  const properties = requiredRecord(
    body.schema.properties,
    `JSON request body properties for ${located.path}`,
  );
  const required = new Set(
    Array.isArray(body.schema.required)
      ? body.schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  return Object.entries(properties).map(([name, rawSchema]) => {
    const schema = requiredRecord(
      rawSchema,
      `JSON request body property ${name} for ${located.path}`,
    );
    const description = descriptionFrom(schema);
    return {
      id: `body.${name}`,
      transportName: name,
      label: titleForField(name),
      location: "body",
      required: required.has(name),
      ...(description ? { description } : {}),
    };
  });
}

function projectObjectSchema(
  schema: JsonSchema,
  exposeFields: readonly string[],
): JsonSchema {
  if (schema.type !== "object" || !isRecord(schema.properties)) {
    if (exposeFields.length > 0) {
      throw new Error("exposeFields can only be applied to object response records");
    }
    return schema;
  }

  const propertyMap = schema.properties;
  const available = new Set(Object.keys(propertyMap));
  const missing = exposeFields.filter((field) => !available.has(field));
  if (missing.length > 0) {
    throw new Error(
      `Approved output field(s) not found in response schema: ${missing.join(", ")}`,
    );
  }

  const properties = Object.fromEntries(
    exposeFields.map((field) => [field, propertyMap[field]]),
  );
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (field): field is string =>
          typeof field === "string" && exposeFields.includes(field),
      )
    : [];
  const { required: _required, ...schemaWithoutRequired } = schema;

  return {
    ...schemaWithoutRequired,
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function projectOutputSchema(
  outputSchema: JsonSchema,
  shape: ResultShape,
  exposeFields: readonly string[],
): { outputSchema: JsonSchema; itemSchema: JsonSchema } {
  if (
    shape === "collection" ||
    shape === "media-collection" ||
    shape === "search-results"
  ) {
    if (outputSchema.type === "array" && isRecord(outputSchema.items)) {
      const itemSchema = projectObjectSchema(outputSchema.items, exposeFields);
      return {
        outputSchema: { ...outputSchema, items: itemSchema },
        itemSchema,
      };
    }

    const properties = isRecord(outputSchema.properties)
      ? outputSchema.properties
      : undefined;
    const items = properties && isRecord(properties.items) ? properties.items : undefined;
    if (items?.type === "array" && isRecord(items.items)) {
      const itemSchema = projectObjectSchema(items.items, exposeFields);
      return {
        outputSchema: {
          ...outputSchema,
          properties: {
            ...properties,
            items: { ...items, items: itemSchema },
          },
        },
        itemSchema,
      };
    }
  }

  const itemSchema = projectObjectSchema(outputSchema, exposeFields);
  return { outputSchema: itemSchema, itemSchema };
}

function responseSchemaFor(
  located: LocatedOperation,
  document: UnknownRecord,
): JsonSchema {
  const responses = requiredRecord(
    located.operation.responses,
    `responses for ${located.path}`,
  );
  const successKey = Object.keys(responses)
    .filter((key) => /^2\d\d$/.test(key))
    .sort()[0];
  const rawResponse = successKey ? responses[successKey] : responses.default;
  const response = requiredRecord(
    dereference(rawResponse, document),
    `successful response for ${located.path}`,
  );
  const content = requiredRecord(
    response.content,
    `response content for ${located.path}`,
  );
  const mediaType =
    content["application/json"] ??
    Object.entries(content).find(([key]) => key.endsWith("+json"))?.[1];
  const media = requiredRecord(mediaType, `JSON response media type for ${located.path}`);
  const schema = dereference(media.schema, document);
  return requiredRecord(schema, `response schema for ${located.path}`);
}

function titleForField(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Adapts a JSON Schema property into the shared classifier's normalized
 * signal. The classification rules themselves live in `semantic-type.ts` so
 * this path and the GraphQL path cannot disagree about the same field.
 */
function inferSemanticType(
  name: string,
  schema: UnknownRecord,
): FieldDescriptor["semanticType"] {
  const declaredType = typeof schema.type === "string" ? schema.type : undefined;
  const kind: SemanticValueKind = Array.isArray(schema.enum)
    ? "enum"
    : declaredType === "string"
      ? "string"
      : declaredType === "integer"
        ? "integer"
        : declaredType === "number"
          ? "number"
          : declaredType === "boolean"
            ? "boolean"
            : declaredType === "object"
              ? "object"
              : declaredType === "array"
                ? "array"
                : "unknown";

  return inferSharedSemanticType({
    name,
    kind,
    ...(typeof schema.format === "string" ? { format: schema.format } : {}),
    ...(typeof schema.description === "string"
      ? { description: schema.description }
      : {}),
    ...(typeof schema.title === "string" ? { title: schema.title } : {}),
  });
}

function fieldsFromSchema(schema: JsonSchema): Record<string, FieldDescriptor> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return Object.fromEntries(
    Object.entries(properties).map(([name, rawField]) => {
      const field = isRecord(rawField) ? rawField : {};
      return [
        name,
        {
          label: typeof field.title === "string" ? field.title : titleForField(name),
          ...(typeof field.description === "string"
            ? { description: field.description }
            : {}),
          semanticType: inferSemanticType(name, field),
        } satisfies FieldDescriptor,
      ];
    }),
  );
}

function descriptionFrom(value: unknown): string | undefined {
  return isRecord(value) && typeof value.description === "string"
    ? value.description
    : undefined;
}

function reviewParametersFor(
  located: LocatedOperation,
  document: UnknownRecord,
): OpenApiReviewParameter[] {
  return mergedParameters(located, document)
    .filter(
      (parameter): parameter is UnknownRecord & { in: "query" | "path"; name: string } =>
        (parameter.in === "query" || parameter.in === "path") &&
        typeof parameter.name === "string",
    )
    .map((parameter) => {
      const schema = dereference(parameter.schema, document);
      const description =
        (typeof parameter.description === "string" ? parameter.description : undefined) ??
        descriptionFrom(schema);
      return {
        id: parameter.name,
        transportName: parameter.name,
        label: titleForField(parameter.name),
        location: parameter.in,
        required: parameter.required === true || parameter.in === "path",
        ...(description ? { description } : {}),
      };
    });
}

/**
 * Whether any plausible unwrapping of a success response yields reviewable
 * object fields. The listing stage has no host-selected `resultShape` yet, so
 * it tries the same candidate shapes `reviewItemSchemaFor` would: the response
 * itself, its array items, or a `items[]` envelope.
 */
function hasReviewableFields(rawOutputSchema: JsonSchema): boolean {
  const candidates: JsonSchema[] = [rawOutputSchema];
  if (rawOutputSchema.type === "array" && isRecord(rawOutputSchema.items)) {
    candidates.push(rawOutputSchema.items as JsonSchema);
  }
  if (isRecord(rawOutputSchema.properties)) {
    const items = (rawOutputSchema.properties as UnknownRecord).items;
    if (isRecord(items) && items.type === "array" && isRecord(items.items)) {
      candidates.push(items.items as JsonSchema);
    }
  }
  return candidates.some(
    (candidate) => Object.keys(fieldsFromSchema(candidate)).length > 0,
  );
}

function reviewItemSchemaFor(
  rawOutputSchema: JsonSchema,
  shape: ResultShape,
): JsonSchema {
  if (
    (shape === "collection" || shape === "media-collection") &&
    rawOutputSchema.type === "array" &&
    isRecord(rawOutputSchema.items)
  ) {
    return rawOutputSchema.items;
  }

  if (shape === "search-results" && isRecord(rawOutputSchema.properties)) {
    const items = rawOutputSchema.properties.items;
    if (isRecord(items) && items.type === "array" && isRecord(items.items))
      return items.items;
  }

  return rawOutputSchema;
}

function reviewSourceHash(
  document: unknown,
  options: Omit<OpenApiCatalogReviewOptions, "document">,
): string {
  return hashContent({ document, ...options });
}

/**
 * Content hash of an OpenAPI description, independent of key order.
 *
 * Separate from `reviewSourceHash`, which also covers the host's selections: a
 * description can move while the selections stay identical, and that is exactly
 * the case this is for.
 */
export function hashOpenApiDocument(document: unknown): string {
  return hashContent(document);
}

export interface OpenApiDocumentDrift {
  capabilityId: string;
  /** The description hash recorded when this operation was approved. */
  approvedDocumentHash: string;
  /** The hash of the description supplied now. */
  currentDocumentHash: string;
}

/**
 * Reports approved operations whose source description has changed.
 *
 * The REST counterpart to GraphQL's per-request `schemaHash` check. A GraphQL
 * endpoint can be introspected on every call; a REST description is a document
 * the host holds, so this runs where one is available — at boot, in CI, or
 * before republishing — rather than on the hot path.
 *
 * Returns an empty array when nothing moved. Reporting rather than throwing:
 * drift is not automatically a failure. A description can gain an unrelated
 * endpoint, and the useful response is to re-review the affected capabilities,
 * which the caller can only decide with the list in hand.
 *
 * The response side is already guarded from the other direction —
 * `validateCapabilityResult` checks every response against the approved output
 * schema — so this closes the gap where a contract moves in a way that a
 * still-valid response would not reveal: a parameter that changed meaning, a
 * field that became optional, an endpoint that was removed.
 */
export function detectOpenApiDocumentDrift(
  bindings: Iterable<OpenApiOperationBinding>,
  document: unknown,
): OpenApiDocumentDrift[] {
  const currentDocumentHash = hashOpenApiDocument(document);
  const drifted: OpenApiDocumentDrift[] = [];
  for (const binding of bindings) {
    if (binding.documentHash !== currentDocumentHash) {
      drifted.push({
        capabilityId: binding.capabilityId,
        approvedDocumentHash: binding.documentHash,
        currentDocumentHash,
      });
    }
  }
  return drifted;
}

function approvalSelectionFor(
  decisions: OpenApiCatalogDecisions,
  capabilityId: string,
): OpenApiCatalogDecisions["operations"][number] {
  const matches = decisions.operations.filter(
    (entry) => entry.capabilityId === capabilityId,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Decisions must contain exactly one selection for capability "${capabilityId}"; ` +
        `found ${matches.length}. A capability is dropped where the inventory is ` +
        `produced, not here: deselect the operation in the review app so it never ` +
        `enters the inventory.`,
    );
  }
  return matches[0]!;
}

function assertUniqueSubset(
  values: readonly string[],
  allowed: readonly string[],
  label: string,
  capabilityId: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(
        `Decisions repeats ${label} "${value}" for capability "${capabilityId}"`,
      );
    }
    seen.add(value);
    if (!allowed.includes(value)) {
      throw new Error(
        `Decisions selects unknown ${label} "${value}" for capability "${capabilityId}"`,
      );
    }
  }
}

/**
 * Build a local-review model from host-selected read operations. This discovers candidates only;
 * it does not create a planner catalog, expose an endpoint, or make a network request.
 */
export function createOpenApiCatalogInventory(
  options: OpenApiCatalogReviewOptions,
): OpenApiCatalogInventory {
  const document = assertOpenApi3Document(options.document);
  const issues: OpenApiInventoryIssue[] = [];
  const operations = options.operations.map((selection) => {
    const located = findOperation(document, selection);
    const rawOutputSchema = responseSchemaFor(located, document);
    const itemSchema = reviewItemSchemaFor(rawOutputSchema, selection.resultShape);
    const fields = fieldsFromSchema(itemSchema);

    if (Object.keys(fields).length === 0) {
      issues.push({
        severity: "error",
        path: `operations.${selection.capabilityId}.response`,
        message:
          "The selected response does not expose an object shape with reviewable fields",
      });
    }

    Object.entries(fields).forEach(([fieldName, field]) => {
      if (field.semanticType === "unknown") {
        issues.push({
          severity: "warning",
          path: `operations.${selection.capabilityId}.fields.${fieldName}`,
          message:
            "Confirm the field's semantic type before approving it for generated views",
        });
      }
    });

    const purpose = operationPurpose(located.operation, selection, issues);
    return {
      capabilityId: selection.capabilityId,
      purpose,
      ...(typeof located.operation.operationId === "string"
        ? { operationId: located.operation.operationId }
        : {}),
      path: located.path,
      method: located.method.toUpperCase() as "GET" | "POST",
      availableVisitorParameters: [
        ...reviewParametersFor(located, document),
        ...reviewBodyParametersFor(located, document),
      ],
      serverOnlyKeys: [...(selection.requiredSessionKeys ?? [])],
      availableOutputFields: Object.entries(fields).map(([id, field]) => ({
        id,
        label: field.label,
        semanticType: field.semanticType,
        ...(field.description ? { description: field.description } : {}),
      })),
    };
  });

  const optionsWithoutDocument = {
    catalog: options.catalog,
    source: options.source,
    operations: options.operations,
    relationships: options.relationships ?? [],
  };
  return {
    schemaVersion: "1.0",
    reviewSourceHash: reviewSourceHash(options.document, optionsWithoutDocument),
    catalog: options.catalog,
    source: options.source,
    relationships: options.relationships ?? [],
    operationSelections: options.operations,
    operations,
    issues,
  };
}

/**
 * Compiles a reviewed OpenAPI decisions into the canonical catalog. Decisions is validated against
 * the exact reviewed source fingerprint and may only narrow the candidate surface, never expand it.
 */
export function compileApprovedOpenApiCatalog(
  document: unknown,
  inventory: OpenApiCatalogInventory,
  approvalInput: unknown,
): CompiledOpenApiCatalog {
  const decisions = OpenApiCatalogDecisionsSchema.parse(approvalInput);
  const expectedSourceHash = reviewSourceHash(document, {
    catalog: inventory.catalog,
    source: inventory.source,
    operations: inventory.operationSelections,
    relationships: inventory.relationships,
  });
  if (
    decisions.reviewSourceHash !== inventory.reviewSourceHash ||
    inventory.reviewSourceHash !== expectedSourceHash
  ) {
    throw new Error(
      "OpenAPI review drift: decisions does not match the reviewed source document",
    );
  }

  const reviewCapabilityIds = inventory.operations.map((operation) => operation.capabilityId);
  if (
    new Set(decisions.operations.map((operation) => operation.capabilityId)).size !==
    decisions.operations.length
  ) {
    throw new Error("Decisions contains duplicate capability selections");
  }
  decisions.operations.forEach((operation) => {
    if (!reviewCapabilityIds.includes(operation.capabilityId)) {
      throw new Error(`Decisions selects unknown capability "${operation.capabilityId}"`);
    }
  });

  const operations = inventory.operationSelections.map((selection) => {
    const reviewOperation = inventory.operations.find(
      (operation) => operation.capabilityId === selection.capabilityId,
    );
    if (!reviewOperation) {
      throw new Error(`Review inventory is missing capability "${selection.capabilityId}"`);
    }
    const approved = approvalSelectionFor(decisions, selection.capabilityId);
    assertUniqueSubset(
      approved.approvedVisitorParameters,
      reviewOperation.availableVisitorParameters.map((parameter) => parameter.id),
      "visitor parameter",
      selection.capabilityId,
    );
    assertUniqueSubset(
      approved.approvedOutputFields,
      reviewOperation.availableOutputFields.map((field) => field.id),
      "output field",
      selection.capabilityId,
    );
    if (approved.approvedOutputFields.length === 0) {
      throw new Error(
        `Decisions must select at least one output field for capability "${selection.capabilityId}"`,
      );
    }

    const approvedUrlParameters = approved.approvedVisitorParameters
      .map((id) =>
        reviewOperation.availableVisitorParameters.find(
          (parameter) => parameter.id === id,
        ),
      )
      .filter(
        (parameter): parameter is OpenApiReviewParameter =>
          parameter?.location !== "body",
      )
      .map((parameter) => parameter.transportName);
    const approvedBodyParameters = approved.approvedVisitorParameters
      .map((id) =>
        reviewOperation.availableVisitorParameters.find(
          (parameter) => parameter.id === id,
        ),
      )
      .filter(
        (parameter): parameter is OpenApiReviewParameter =>
          parameter?.location === "body",
      )
      .map((parameter) => parameter.transportName);

    return {
      ...selection,
      contentParameters: approvedUrlParameters,
      ...(approvedBodyParameters.length
        ? { bodyParameters: approvedBodyParameters }
        : {}),
      exposeFields: approved.approvedOutputFields,
      // From the decisions artifact, not defaulted here. The reviewer decided it;
      // this step only carries the decision forward.
      policy: approved.policy,
    };
  });

  return importOpenApiCatalogInventory({
    document,
    catalog: inventory.catalog,
    source: inventory.source,
    operations,
    relationships: inventory.relationships,
  });
}

function operationPurpose(
  operation: UnknownRecord,
  selection: Pick<OpenApiOperationSelection, "capabilityId" | "purpose">,
  issues: OpenApiInventoryIssue[],
): string {
  const purpose =
    selection.purpose ??
    (typeof operation.summary === "string" ? operation.summary : undefined) ??
    (typeof operation.description === "string" ? operation.description : undefined);

  if (purpose) return purpose;
  issues.push({
    severity: "warning",
    path: `operations.${selection.capabilityId}.purpose`,
    message: "Add a business-purpose description before owner decisions",
  });
  return `Review the purpose of ${selection.capabilityId}`;
}

/**
 * Imports an explicitly allow-listed, read-only subset of an OpenAPI 3 document into the same
 * canonical catalog used by manual registration. The result is an inventory: operation bindings are
 * retained server-side and semantic gaps are reported for owner review.
 */
export function importOpenApiCatalogInventory(
  options: OpenApiCatalogImportOptions,
): CompiledOpenApiCatalog {
  const document = assertOpenApi3Document(options.document);

  const issues: OpenApiInventoryIssue[] = [];
  const capabilities: CapabilityCatalog["capabilities"] = [];
  const dataTypes = new Map<string, DataTypeDescriptor>();
  const bindings = new Map<string, OpenApiOperationBinding>();
  // Recorded on every binding, so a published catalog can be checked against a
  // later description without the original being kept alongside it.
  const documentHash = hashOpenApiDocument(options.document);
  const serverUrl =
    Array.isArray(document.servers) &&
    isRecord(document.servers[0]) &&
    typeof document.servers[0].url === "string"
      ? document.servers[0].url
      : undefined;

  for (const selection of options.operations) {
    const located = findOperation(document, selection);
    const inputSchema = inputSchemaFor(
      located,
      document,
      selection.contentParameters,
      selection.bodyParameters,
    );
    const rawOutputSchema = responseSchemaFor(located, document);
    const { outputSchema, itemSchema } = projectOutputSchema(
      rawOutputSchema,
      selection.resultShape,
      selection.exposeFields,
    );
    const fields = selection.fields ?? fieldsFromSchema(itemSchema);
    const dataTypeDescription =
      selection.dataTypeDescription ??
      (typeof itemSchema.description === "string" ? itemSchema.description : undefined) ??
      (typeof itemSchema.title === "string" ? itemSchema.title : undefined);

    if (!dataTypeDescription) {
      issues.push({
        severity: "warning",
        path: `dataTypes.${selection.dataTypeId}.description`,
        message: "Add a business description for this data type before owner decisions",
      });
    }

    for (const [fieldName, field] of Object.entries(fields)) {
      if (field.semanticType === "unknown") {
        issues.push({
          severity: "warning",
          path: `dataTypes.${selection.dataTypeId}.fields.${fieldName}`,
          message: "Confirm the field's semantic type for reliable component selection",
        });
      }
    }

    const dataType: DataTypeDescriptor = {
      id: selection.dataTypeId,
      version: selection.dataTypeVersion ?? "1.0",
      description: dataTypeDescription ?? `Data returned for ${selection.capabilityId}`,
      schema: itemSchema,
      fields,
      ...(selection.matchKey ? { matchKey: selection.matchKey } : {}),
    };
    const existing = dataTypes.get(dataType.id);
    if (!existing) {
      dataTypes.set(dataType.id, dataType);
    } else if (JSON.stringify(existing.schema) !== JSON.stringify(dataType.schema)) {
      issues.push({
        severity: "warning",
        path: `dataTypes.${dataType.id}.schema`,
        message:
          "Multiple operations produced different structural schemas for this data type",
      });
    }

    capabilities.push({
      id: selection.capabilityId,
      version: selection.version ?? "1.0",
      purpose: operationPurpose(located.operation, selection, issues),
      kind: "query",
      inputSchema,
      outputSchema,
      output: {
        dataTypeId: selection.dataTypeId,
        shape: selection.resultShape,
      },
      requiredSessionKeys: [...(selection.requiredSessionKeys ?? [])],
      sourceIds: [options.source.id],
      // Same default as the GraphQL importer, for the same reason: filtering
      // and sorting run locally over rows the owner already approved, so
      // requiring a second declaration to enable them bought no safety and
      // silently disabled the feature for every imported catalog. See
      // `defaultSupportsForApprovedFields` in compile.ts.
      //
      // `sourceNarrowingArguments` is deliberately not derived here. Every
      // approved content parameter is source-applied, but OpenAPI has no
      // spec-defined paging vocabulary (GraphQL's `first`/`after` is what
      // makes the Relay derivation sound), so separating "narrows which
      // records qualify" from "pages the response" would be name-guessing —
      // the same class of false advertisement the field exists to end. A
      // reviewer who knows their API states it in `selection.supports`.
      supports:
        selection.supports ??
        defaultSupportsForApprovedFields(selection.resultShape, selection.exposeFields),
      policy: {
        // No fallback, deliberately. See `OpenApiOperationPolicy`.
        authentication: selection.policy.authentication,
        ...(selection.policy.requiredPermissions !== undefined
          ? { requiredPermissions: [...selection.policy.requiredPermissions] }
          : {}),
        ...(selection.policy.maximumRows !== undefined
          ? { maximumRows: selection.policy.maximumRows }
          : {}),
        ...(selection.policy.timeoutMs !== undefined
          ? { timeoutMs: selection.policy.timeoutMs }
          : {}),
        ...(selection.policy.cacheTtlSeconds !== undefined
          ? { cacheTtlSeconds: selection.policy.cacheTtlSeconds }
          : {}),
      },
    });

    bindings.set(selection.capabilityId, {
      capabilityId: selection.capabilityId,
      ...(typeof located.operation.operationId === "string"
        ? { operationId: located.operation.operationId }
        : {}),
      method: located.method.toUpperCase() as "GET" | "POST",
      path: located.path,
      ...(serverUrl ? { serverUrl } : {}),
      contentParameters: [...selection.contentParameters],
      bodyParameters: [...(selection.bodyParameters ?? [])],
      exposeFields: [...selection.exposeFields],
      documentHash,
      ...(selection.policy.freshnessMaximumAgeSeconds !== undefined
        ? { freshnessMaximumAgeSeconds: selection.policy.freshnessMaximumAgeSeconds }
        : {}),
    });
  }

  const catalog = assertCapabilityCatalog({
    schemaVersion: "1.0",
    id: options.catalog.id,
    version: options.catalog.version,
    description: options.catalog.description,
    dataTypes: [...dataTypes.values()],
    sources: [options.source],
    capabilities,
    relationships: options.relationships ?? [],
  });

  return {
    catalog,
    plannerManifest: createPlannerManifest(catalog),
    bindings,
    issues,
  };
}
