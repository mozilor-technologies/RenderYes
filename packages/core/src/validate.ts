import {
  isJsonValue,
  isRecord,
  type SurfaceNode,
  type Plan,
  type QuerySpec,
  type Surface,
} from "./plan.js";
import type { Registry } from "./registry.js";

export type PlanIssueCode =
  | "invalid-plan"
  | "catalog-mismatch"
  | "duplicate-data-request"
  | "unknown-data-request"
  | "duplicate-data-composition"
  | "unknown-data-composition"
  | "unknown-composition-input"
  | "duplicate-data-join"
  | "unknown-data-join"
  | "unknown-join-input"
  | "composition-too-few-inputs"
  | "too-many-composition-inputs"
  | "composition-filter-unsupported"
  | "max-compositions"
  | "filter-too-deep"
  | "filter-too-large"
  | "duplicate-surface"
  | "duplicate-node"
  | "unknown-component"
  | "invalid-props"
  | "unknown-slot"
  | "slot-cardinality"
  | "slot-component"
  | "max-instances"
  | "max-depth"
  | "max-nodes";

const MAX_COMPOSITION_INPUTS = 8;
const MAX_COMPOSITIONS = 16;
const MAX_FILTER_DEPTH = 5;

/**
 * Hard bound on structural node nesting, enforced during `parsePlan` before any
 * option-driven limit applies.
 *
 * `ValidatePlanOptions.maxDepth` bounds the *semantic* walk, which runs only
 * after the structural parse has already recursed the whole tree — so a deeply
 * nested candidate overflowed the stack inside `parseNode` and threw RangeError
 * out of a function whose contract is to return issues. This cap is deliberately
 * far above any sensible `maxDepth` (default 12): it exists to keep the parse
 * total, not to express a policy.
 */
const MAX_STRUCTURAL_NODE_DEPTH = 100;
const MAX_FILTER_CONDITIONS = 32;

export interface PlanIssue {
  code: PlanIssueCode;
  path: string;
  message: string;
}

export type PlanValidationResult =
  { ok: true; plan: Plan } | { ok: false; issues: PlanIssue[] };

export type QuerySpecValidationResult =
  { ok: true; query: QuerySpec } | { ok: false; issues: PlanIssue[] };

export interface ValidatePlanOptions {
  maxDepth?: number;
  maxNodes?: number;
  allowCatalogMismatch?: boolean;
}

export function validatePlan(
  input: unknown,
  registry: Registry,
  options: ValidatePlanOptions = {},
): PlanValidationResult {
  const structural = parsePlan(input);
  if (!structural.ok) return structural;
  const plan = structural.plan;
  const issues: PlanIssue[] = [];
  const maxDepth = options.maxDepth ?? 12;
  const maxNodes = options.maxNodes ?? 200;
  const instanceCounts = new Map<string, number>();
  const surfaceIds = new Set<string>();
  const dataRequestIds = new Set(
    plan.schemaVersion === "3.1"
      ? plan.dataRequests.map((request) => request.requestId)
      : [],
  );
  const dataCompositionIds = new Set(
    plan.schemaVersion === "3.1"
      ? (plan.dataCompositions ?? []).map((composition) => composition.compositionId)
      : [],
  );
  const dataJoinIds = new Set(
    plan.schemaVersion === "3.1" ? (plan.dataJoins ?? []).map((join) => join.joinId) : [],
  );
  let nodeCount = 0;

  if (
    !options.allowCatalogMismatch &&
    (plan.catalog.id !== registry.id ||
      plan.catalog.version !== registry.version ||
      plan.catalog.fingerprint !== registry.fingerprint)
  ) {
    // Naming the part that actually differs. The message used to print only
    // `id@version` while the comparison also covered the fingerprint, so a
    // registration change with no version bump — the ordinary case — produced
    // "Plan catalog x@1.0.0 does not match x@1.0.0": two identical strings
    // declared unequal, with the differing fingerprint nowhere in sight.
    const mismatched =
      plan.catalog.id !== registry.id || plan.catalog.version !== registry.version
        ? `${plan.catalog.id}@${plan.catalog.version} does not match ${registry.id}@${registry.version}`
        : `${plan.catalog.id}@${plan.catalog.version} has fingerprint ${plan.catalog.fingerprint} ` +
          `but the registered site's is ${registry.fingerprint} — the component registrations ` +
          "changed without a version change";
    issues.push({
      code: "catalog-mismatch",
      path: "catalog",
      message: `Plan catalog ${mismatched}`,
    });
  }

  for (const [surfaceIndex, surface] of plan.surfaces.entries()) {
    const surfacePath = `surfaces.${surfaceIndex}`;
    if (surfaceIds.has(surface.id)) {
      issues.push({
        code: "duplicate-surface",
        path: `${surfacePath}.id`,
        message: `Duplicate surface id: ${surface.id}`,
      });
    }
    surfaceIds.add(surface.id);

    const nodeIds = new Set<string>();
    for (const [nodeIndex, node] of surface.nodes.entries()) {
      visitNode(node, `${surfacePath}.nodes.${nodeIndex}`, 1, nodeIds);
    }
  }

  for (const component of registry.components) {
    const count = instanceCounts.get(component.id) ?? 0;
    const limit = component.policy?.maxInstances;
    if (limit !== undefined && count > limit) {
      issues.push({
        code: "max-instances",
        path: "surfaces",
        message: `${component.id} appears ${count} times but allows at most ${limit}`,
      });
    }
  }

  if (nodeCount > maxNodes) {
    issues.push({
      code: "max-nodes",
      path: "surfaces",
      message: `Plan contains ${nodeCount} nodes but the limit is ${maxNodes}`,
    });
  }

  return issues.length ? { ok: false, issues } : { ok: true, plan };

  function visitNode(
    node: SurfaceNode,
    path: string,
    depth: number,
    nodeIds: Set<string>,
  ): void {
    nodeCount++;
    if (depth > maxDepth) {
      issues.push({
        code: "max-depth",
        path,
        message: `Node depth ${depth} exceeds the limit of ${maxDepth}`,
      });
      // Stop descending. Recording the issue and recursing anyway meant the
      // depth limit bounded the report but not the walk, so a deep enough plan
      // threw RangeError out of a function whose contract is to return issues —
      // the caller cannot catch that as a validation failure. `parseFilterNode`
      // returns here for the same reason.
      return;
    }

    if (nodeIds.has(node.nodeId)) {
      issues.push({
        code: "duplicate-node",
        path: `${path}.nodeId`,
        message: `Duplicate node id in surface: ${node.nodeId}`,
      });
    }
    nodeIds.add(node.nodeId);

    const component = registry.get(node.componentId);
    if (!component) {
      issues.push({
        code: "unknown-component",
        path: `${path}.componentId`,
        message: `Unknown component: ${node.componentId}`,
      });
      return;
    }

    instanceCounts.set(component.id, (instanceCounts.get(component.id) ?? 0) + 1);

    for (const [bindingName, binding] of Object.entries(node.dataBindings ?? {})) {
      if ("requestId" in binding) {
        if (!dataRequestIds.has(binding.requestId)) {
          issues.push({
            code: "unknown-data-request",
            path: `${path}.dataBindings.${bindingName}.requestId`,
            message: `Unknown data request: ${binding.requestId}`,
          });
        }
      } else if ("compositionId" in binding) {
        if (!dataCompositionIds.has(binding.compositionId)) {
          issues.push({
            code: "unknown-data-composition",
            path: `${path}.dataBindings.${bindingName}.compositionId`,
            message: `Unknown data composition: ${binding.compositionId}`,
          });
        }
      } else if (!dataJoinIds.has(binding.joinId)) {
        issues.push({
          code: "unknown-data-join",
          path: `${path}.dataBindings.${bindingName}.joinId`,
          message: `Unknown data join: ${binding.joinId}`,
        });
      }
    }

    const props = component.props.safeParse(node.props);
    if (!props.success) {
      for (const issue of props.issues) {
        issues.push({
          code: "invalid-props",
          path: `${path}.props${issue.path.length ? `.${issue.path.map(String).join(".")}` : ""}`,
          message: issue.message,
        });
      }
    } else {
      node.props = props.data;
    }

    for (const [slotName, children] of Object.entries(node.slots ?? {})) {
      const slot = component.slots?.[slotName];
      if (!slot) {
        issues.push({
          code: "unknown-slot",
          path: `${path}.slots.${slotName}`,
          message: `${component.id} does not declare slot ${slotName}`,
        });
        continue;
      }
      if (slot.cardinality === "one" && children.length > 1) {
        issues.push({
          code: "slot-cardinality",
          path: `${path}.slots.${slotName}`,
          message: `${component.id}.${slotName} accepts at most one child`,
        });
      }
      for (const [childIndex, child] of children.entries()) {
        if (slot.accepts && !slot.accepts.includes(child.componentId)) {
          issues.push({
            code: "slot-component",
            path: `${path}.slots.${slotName}.${childIndex}`,
            message: `${component.id}.${slotName} does not accept ${child.componentId}`,
          });
        }
        visitNode(child, `${path}.slots.${slotName}.${childIndex}`, depth + 1, nodeIds);
      }
    }
  }
}

export function assertValidPlan(
  input: unknown,
  registry: Registry,
  options?: ValidatePlanOptions,
): Plan {
  const result = validatePlan(input, registry, options);
  if (result.ok) return result.plan;
  throw new Error(
    result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
  );
}

export function validateQuerySpec(input: unknown): QuerySpecValidationResult {
  const issues: PlanIssue[] = [];
  parseQuerySpec(input, "query", issues);
  return issues.length
    ? { ok: false, issues }
    : { ok: true, query: cloneJson(input) as QuerySpec };
}

function parsePlan(input: unknown): PlanValidationResult {
  const issues: PlanIssue[] = [];
  if (!isRecord(input)) return invalid("", "Plan must be an object");
  const schemaVersion =
    input.schemaVersion === "3.0" || input.schemaVersion === "3.1"
      ? input.schemaVersion
      : undefined;
  if (!schemaVersion) {
    issues.push(issue("schemaVersion", 'Expected "3.0" or "3.1"'));
  }
  if (schemaVersion === "3.1") {
    rejectUnknownKeys(
      input,
      [
        "schemaVersion",
        "planId",
        "siteId",
        "sourcePrompt",
        "catalog",
        "dataCatalog",
        "dataRequests",
        "dataCompositions",
        "dataJoins",
        "surfaces",
        "generation",
      ],
      "",
      issues,
    );
  }
  if (!nonEmptyString(input.planId)) issues.push(issue("planId", "Plan id is required"));
  if (!nonEmptyString(input.siteId)) issues.push(issue("siteId", "Site id is required"));
  if (input.sourcePrompt !== undefined && typeof input.sourcePrompt !== "string") {
    issues.push(issue("sourcePrompt", "Source prompt must be a string"));
  }

  const catalog = input.catalog;
  if (!isRecord(catalog)) {
    issues.push(issue("catalog", "Catalog must be an object"));
  } else {
    if (schemaVersion === "3.1") {
      rejectUnknownKeys(catalog, ["id", "version", "fingerprint"], "catalog", issues);
    }
    if (!nonEmptyString(catalog.id))
      issues.push(issue("catalog.id", "Catalog id is required"));
    if (!nonEmptyString(catalog.version))
      issues.push(issue("catalog.version", "Catalog version is required"));
    if (!nonEmptyString(catalog.fingerprint)) {
      issues.push(issue("catalog.fingerprint", "Catalog fingerprint is required"));
    }
  }

  const dataRequestIds = new Set<string>();
  if (schemaVersion === "3.1") {
    parseCapabilityCatalogReference(input.dataCatalog, "dataCatalog", issues);
    if (!Array.isArray(input.dataRequests)) {
      issues.push(issue("dataRequests", "Data requests must be an array"));
    } else {
      for (const [requestIndex, request] of input.dataRequests.entries()) {
        const requestPath = `dataRequests.${requestIndex}`;
        const requestId = parseDataRequest(request, requestPath, issues);
        if (!requestId) continue;
        if (dataRequestIds.has(requestId)) {
          issues.push({
            code: "duplicate-data-request",
            path: `${requestPath}.requestId`,
            message: `Duplicate data request id: ${requestId}`,
          });
        }
        dataRequestIds.add(requestId);
      }
    }

    const compositionIds = new Set<string>();
    if (input.dataCompositions !== undefined) {
      if (!Array.isArray(input.dataCompositions)) {
        issues.push(issue("dataCompositions", "Data compositions must be an array"));
      } else {
        if (input.dataCompositions.length > MAX_COMPOSITIONS) {
          issues.push({
            code: "max-compositions",
            path: "dataCompositions",
            message: `Plan contains ${input.dataCompositions.length} compositions but the limit is ${MAX_COMPOSITIONS}`,
          });
        }
        for (const [index, composition] of input.dataCompositions.entries()) {
          const compositionId = parseDataComposition(
            composition,
            `dataCompositions.${index}`,
            dataRequestIds,
            issues,
          );
          if (!compositionId) continue;
          if (compositionIds.has(compositionId) || dataRequestIds.has(compositionId)) {
            issues.push({
              code: "duplicate-data-composition",
              path: `dataCompositions.${index}.compositionId`,
              message: `Duplicate data source id: ${compositionId}`,
            });
          }
          compositionIds.add(compositionId);
        }
      }
    }

    if (input.dataJoins !== undefined) {
      if (!Array.isArray(input.dataJoins)) {
        issues.push(issue("dataJoins", "Data joins must be an array"));
      } else {
        const joinIds = new Set<string>();
        for (const [index, join] of input.dataJoins.entries()) {
          const joinId = parseDataJoin(
            join,
            `dataJoins.${index}`,
            dataRequestIds,
            issues,
          );
          if (!joinId) continue;
          if (
            joinIds.has(joinId) ||
            dataRequestIds.has(joinId) ||
            compositionIds.has(joinId)
          ) {
            issues.push({
              code: "duplicate-data-join",
              path: `dataJoins.${index}.joinId`,
              message: `Duplicate data source id: ${joinId}`,
            });
          }
          joinIds.add(joinId);
        }
      }
    }
  } else if (schemaVersion === "3.0") {
    if (input.dataCatalog !== undefined) {
      issues.push(issue("dataCatalog", "Plan 3.0 cannot contain a data catalog"));
    }
    if (input.dataRequests !== undefined) {
      issues.push(issue("dataRequests", "Plan 3.0 cannot contain data requests"));
    }
    if (input.dataCompositions !== undefined) {
      issues.push(issue("dataCompositions", "Plan 3.0 cannot contain data compositions"));
    }
    if (input.dataJoins !== undefined) {
      issues.push(issue("dataJoins", "Plan 3.0 cannot contain data joins"));
    }
  }

  const generation = input.generation;
  if (!isRecord(generation)) {
    issues.push(issue("generation", "Generation must be an object"));
  } else {
    if (schemaVersion === "3.1") {
      rejectUnknownKeys(
        generation,
        ["providerId", "modelId", "createdAt", "repairCount", "constrainedDecoding"],
        "generation",
        issues,
      );
    }
    if (
      generation.constrainedDecoding !== undefined &&
      typeof generation.constrainedDecoding !== "boolean"
    ) {
      issues.push(
        issue(
          "generation.constrainedDecoding",
          "Constrained decoding must be a boolean when present",
        ),
      );
    }
    if (!nonEmptyString(generation.providerId)) {
      issues.push(issue("generation.providerId", "Provider id is required"));
    }
    if (!nonEmptyString(generation.modelId))
      issues.push(issue("generation.modelId", "Model id is required"));
    if (
      !nonEmptyString(generation.createdAt) ||
      Number.isNaN(Date.parse(String(generation.createdAt)))
    ) {
      issues.push(
        issue("generation.createdAt", "Created date must be an ISO date string"),
      );
    }
    if (!Number.isInteger(generation.repairCount) || Number(generation.repairCount) < 0) {
      issues.push(
        issue("generation.repairCount", "Repair count must be a non-negative integer"),
      );
    }
  }

  if (!Array.isArray(input.surfaces)) {
    issues.push(issue("surfaces", "Surfaces must be an array"));
  } else {
    for (const [surfaceIndex, surface] of input.surfaces.entries()) {
      parseSurface(surface, `surfaces.${surfaceIndex}`, issues, schemaVersion);
    }
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, plan: cloneJson(input) as unknown as Plan };
}

function parseSurface(
  input: unknown,
  path: string,
  issues: PlanIssue[],
  schemaVersion: "3.0" | "3.1" | undefined,
): input is Surface {
  if (!isRecord(input)) {
    issues.push(issue(path, "Surface must be an object"));
    return false;
  }
  if (schemaVersion === "3.1") {
    rejectUnknownKeys(input, ["id", "nodes"], path, issues);
  }
  if (!nonEmptyString(input.id))
    issues.push(issue(`${path}.id`, "Surface id is required"));
  if (!Array.isArray(input.nodes)) {
    issues.push(issue(`${path}.nodes`, "Surface nodes must be an array"));
    return false;
  }
  for (const [nodeIndex, node] of input.nodes.entries()) {
    parseNode(node, `${path}.nodes.${nodeIndex}`, issues, schemaVersion, 0);
  }
  return true;
}

function parseNode(
  input: unknown,
  path: string,
  issues: PlanIssue[],
  schemaVersion: "3.0" | "3.1" | undefined,
  depth: number,
): input is SurfaceNode {
  if (depth > MAX_STRUCTURAL_NODE_DEPTH) {
    issues.push(
      issue(path, `Node nesting exceeds the structural limit of ${MAX_STRUCTURAL_NODE_DEPTH}`),
    );
    return false;
  }
  if (!isRecord(input)) {
    issues.push(issue(path, "Node must be an object"));
    return false;
  }
  if (schemaVersion === "3.1") {
    rejectUnknownKeys(
      input,
      ["nodeId", "componentId", "props", "dataBindings", "slots"],
      path,
      issues,
    );
  }
  if (!nonEmptyString(input.nodeId))
    issues.push(issue(`${path}.nodeId`, "Node id is required"));
  if (!nonEmptyString(input.componentId)) {
    issues.push(issue(`${path}.componentId`, "Component id is required"));
  }
  if (!isRecord(input.props) || !isJsonValue(input.props)) {
    issues.push(issue(`${path}.props`, "Props must be a JSON-compatible object"));
  }
  if (input.dataBindings !== undefined) {
    if (schemaVersion !== "3.1") {
      issues.push(issue(`${path}.dataBindings`, "Data bindings require Plan 3.1"));
    } else {
      parseDataBindings(input.dataBindings, `${path}.dataBindings`, issues);
    }
  }
  if (input.slots !== undefined) {
    if (!isRecord(input.slots)) {
      issues.push(issue(`${path}.slots`, "Slots must be an object"));
    } else {
      for (const [slotName, children] of Object.entries(input.slots)) {
        if (!Array.isArray(children)) {
          issues.push(
            issue(`${path}.slots.${slotName}`, "Slot children must be an array"),
          );
          continue;
        }
        for (const [childIndex, child] of children.entries()) {
          parseNode(
            child,
            `${path}.slots.${slotName}.${childIndex}`,
            issues,
            schemaVersion,
            depth + 1,
          );
        }
      }
    }
  }
  return true;
}

function parseCapabilityCatalogReference(
  input: unknown,
  path: string,
  issues: PlanIssue[],
): void {
  if (!isRecord(input)) {
    issues.push(issue(path, "Capability catalog reference must be an object"));
    return;
  }
  rejectUnknownKeys(input, ["id", "version", "hash"], path, issues);
  if (!nonEmptyString(input.id))
    issues.push(issue(`${path}.id`, "Catalog id is required"));
  if (!nonEmptyString(input.version)) {
    issues.push(issue(`${path}.version`, "Catalog version is required"));
  }
  if (!nonEmptyString(input.hash)) {
    issues.push(issue(`${path}.hash`, "Catalog hash is required"));
  }
}

function parseDataRequest(
  input: unknown,
  path: string,
  issues: PlanIssue[],
): string | undefined {
  if (!isRecord(input)) {
    issues.push(issue(path, "Data request must be an object"));
    return undefined;
  }
  rejectUnknownKeys(
    input,
    ["requestId", "capabilityId", "params", "query"],
    path,
    issues,
  );
  const requestId = nonEmptyString(input.requestId) ? input.requestId : undefined;
  if (!requestId) issues.push(issue(`${path}.requestId`, "Request id is required"));
  if (!nonEmptyString(input.capabilityId)) {
    issues.push(issue(`${path}.capabilityId`, "Capability id is required"));
  }
  if (!isRecord(input.params) || !isJsonValue(input.params)) {
    issues.push(issue(`${path}.params`, "Params must be a JSON-compatible object"));
  }
  if (input.query !== undefined) {
    parseQuerySpec(input.query, `${path}.query`, issues);
  }
  return requestId;
}

function parseDataJoin(
  input: unknown,
  path: string,
  dataRequestIds: Set<string>,
  issues: PlanIssue[],
): string | undefined {
  if (!isRecord(input)) {
    issues.push(issue(path, "Data join must be an object"));
    return undefined;
  }
  rejectUnknownKeys(
    input,
    ["joinId", "relationshipId", "left", "right", "as"],
    path,
    issues,
  );
  const joinId = nonEmptyString(input.joinId) ? input.joinId : undefined;
  if (!joinId) issues.push(issue(`${path}.joinId`, "Join id is required"));
  if (!nonEmptyString(input.relationshipId)) {
    issues.push(issue(`${path}.relationshipId`, "Relationship id is required"));
  }
  if (!nonEmptyString(input.as)) {
    issues.push(issue(`${path}.as`, "Join output name is required"));
  }
  for (const side of ["left", "right"]) {
    const value = input[side];
    if (!nonEmptyString(value)) {
      issues.push(issue(`${path}.${side}`, `Join ${side} request id is required`));
    } else if (!dataRequestIds.has(value)) {
      issues.push({
        code: "unknown-join-input",
        path: `${path}.${side}`,
        message: `Join ${side} references unknown data request: ${value}`,
      });
    }
  }
  if (
    nonEmptyString(input.left) &&
    nonEmptyString(input.right) &&
    input.left === input.right
  ) {
    issues.push(issue(`${path}.right`, "Join left and right must differ"));
  }
  return joinId;
}

function parseDataComposition(
  input: unknown,
  path: string,
  dataRequestIds: Set<string>,
  issues: PlanIssue[],
): string | undefined {
  if (!isRecord(input)) {
    issues.push(issue(path, "Data composition must be an object"));
    return undefined;
  }
  rejectUnknownKeys(
    input,
    ["compositionId", "operation", "inputs", "query"],
    path,
    issues,
  );
  const compositionId = nonEmptyString(input.compositionId)
    ? input.compositionId
    : undefined;
  if (!compositionId) {
    issues.push(issue(`${path}.compositionId`, "Composition id is required"));
  }
  if (
    input.operation !== "union" &&
    input.operation !== "intersection" &&
    input.operation !== "difference"
  ) {
    issues.push(
      issue(`${path}.operation`, 'Expected "union", "intersection", or "difference"'),
    );
  }
  if (!Array.isArray(input.inputs)) {
    issues.push(issue(`${path}.inputs`, "Composition inputs must be an array"));
  } else {
    if (input.inputs.length < 2) {
      issues.push({
        code: "composition-too-few-inputs",
        path: `${path}.inputs`,
        message: "A composition requires at least two inputs",
      });
    }
    if (input.inputs.length > MAX_COMPOSITION_INPUTS) {
      issues.push({
        code: "too-many-composition-inputs",
        path: `${path}.inputs`,
        message: `A composition accepts at most ${MAX_COMPOSITION_INPUTS} inputs`,
      });
    }
    for (const [index, requestId] of input.inputs.entries()) {
      if (!nonEmptyString(requestId)) {
        issues.push(issue(`${path}.inputs.${index}`, "Composition input is required"));
        continue;
      }
      if (!dataRequestIds.has(requestId)) {
        issues.push({
          code: "unknown-composition-input",
          path: `${path}.inputs.${index}`,
          message: `Composition input references unknown data request: ${requestId}`,
        });
      }
    }
  }
  if (input.query !== undefined) {
    parseQuerySpec(input.query, `${path}.query`, issues);
    if (isRecord(input.query) && input.query.filter !== undefined) {
      issues.push({
        code: "composition-filter-unsupported",
        path: `${path}.query.filter`,
        message: "Composition queries may sort, project, or limit but not filter",
      });
    }
  }
  return compositionId;
}

const FILTER_OPERATORS = new Set([
  "eq",
  "not-eq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "contains",
  "starts-with",
  "ends-with",
  "in",
  "not-in",
  "is-null",
  "is-not-null",
]);

const AGGREGATE_OPS = new Set(["count", "sum", "average", "minimum", "maximum"]);

function parseQuerySpec(input: unknown, path: string, issues: PlanIssue[]): void {
  if (!isRecord(input)) {
    issues.push(issue(path, "Query must be an object"));
    return;
  }
  rejectUnknownKeys(
    input,
    ["filter", "groupBy", "aggregates", "sort", "project", "offset", "limit"],
    path,
    issues,
  );

  if (input.filter !== undefined) {
    parseFilterGroup(input.filter, `${path}.filter`, issues);
  }

  const groupByFields = new Set<string>();
  if (input.groupBy !== undefined) {
    if (!Array.isArray(input.groupBy) || input.groupBy.length === 0) {
      issues.push(issue(`${path}.groupBy`, "groupBy must contain at least one field"));
    } else {
      for (const [index, field] of input.groupBy.entries()) {
        if (!nonEmptyString(field)) {
          issues.push(issue(`${path}.groupBy.${index}`, "groupBy field is required"));
        } else if (groupByFields.has(field)) {
          issues.push(
            issue(`${path}.groupBy.${index}`, `Duplicate groupBy field: ${field}`),
          );
        } else {
          groupByFields.add(field);
        }
      }
    }
  }

  if (input.aggregates !== undefined) {
    if (!Array.isArray(input.aggregates) || input.aggregates.length === 0) {
      issues.push(
        issue(`${path}.aggregates`, "aggregates must contain at least one entry"),
      );
    } else if (input.aggregates.length > 16) {
      issues.push(issue(`${path}.aggregates`, "aggregates accepts at most 16 entries"));
    } else {
      const asNames = new Set<string>();
      for (const [index, aggregate] of input.aggregates.entries()) {
        const aggPath = `${path}.aggregates.${index}`;
        if (!isRecord(aggregate)) {
          issues.push(issue(aggPath, "Aggregate must be an object"));
          continue;
        }
        rejectUnknownKeys(aggregate, ["op", "field", "as"], aggPath, issues);
        if (!AGGREGATE_OPS.has(aggregate.op as string)) {
          issues.push(issue(`${aggPath}.op`, "Unknown aggregate operator"));
        }
        const needsField = aggregate.op !== "count";
        if (needsField && !nonEmptyString(aggregate.field)) {
          issues.push(
            issue(`${aggPath}.field`, `${String(aggregate.op)} requires a field`),
          );
        } else if (!needsField && aggregate.field !== undefined) {
          issues.push(issue(`${aggPath}.field`, "count cannot take a field"));
        }
        if (!nonEmptyString(aggregate.as)) {
          issues.push(issue(`${aggPath}.as`, "Aggregate output name is required"));
        } else if (asNames.has(aggregate.as) || groupByFields.has(aggregate.as)) {
          issues.push(issue(`${aggPath}.as`, `Duplicate output column: ${aggregate.as}`));
        } else {
          asNames.add(aggregate.as);
        }
      }
    }
  }

  if (input.sort !== undefined) {
    if (!Array.isArray(input.sort)) {
      issues.push(issue(`${path}.sort`, "Sort must be an array"));
    } else if (input.sort.length > 8) {
      issues.push(issue(`${path}.sort`, "Sort accepts at most 8 fields"));
    } else {
      for (const [index, sort] of input.sort.entries()) {
        const sortPath = `${path}.sort.${index}`;
        if (!isRecord(sort)) {
          issues.push(issue(sortPath, "Sort entry must be an object"));
          continue;
        }
        rejectUnknownKeys(sort, ["field", "direction"], sortPath, issues);
        if (!nonEmptyString(sort.field)) {
          issues.push(issue(`${sortPath}.field`, "Sort field is required"));
        }
        if (sort.direction !== "asc" && sort.direction !== "desc") {
          issues.push(issue(`${sortPath}.direction`, 'Expected "asc" or "desc"'));
        }
      }
    }
  }

  if (input.project !== undefined) {
    if (!Array.isArray(input.project) || input.project.length === 0) {
      issues.push(issue(`${path}.project`, "Projection must contain at least one field"));
    } else if (input.project.length > 64) {
      issues.push(issue(`${path}.project`, "Projection accepts at most 64 fields"));
    } else {
      const fields = new Set<string>();
      for (const [index, field] of input.project.entries()) {
        if (!nonEmptyString(field)) {
          issues.push(issue(`${path}.project.${index}`, "Projection field is required"));
        } else if (fields.has(field)) {
          issues.push(
            issue(`${path}.project.${index}`, `Duplicate projection field: ${field}`),
          );
        } else {
          fields.add(field);
        }
      }
    }
  }

  if (
    input.offset !== undefined &&
    (!Number.isInteger(input.offset) || Number(input.offset) < 0)
  ) {
    issues.push(issue(`${path}.offset`, "Offset must be a non-negative integer"));
  }

  if (
    input.limit !== undefined &&
    (!Number.isInteger(input.limit) || Number(input.limit) < 1)
  ) {
    issues.push(issue(`${path}.limit`, "Limit must be a positive integer"));
  }
}

function parseFilterGroup(input: unknown, path: string, issues: PlanIssue[]): void {
  parseFilterNode(input, path, issues, 1, { leaves: 0 });
}

function parseFilterNode(
  input: unknown,
  path: string,
  issues: PlanIssue[],
  depth: number,
  state: { leaves: number },
): void {
  if (!isRecord(input)) {
    issues.push(issue(path, "Filter node must be an object"));
    return;
  }
  const looksLikeGroup = "combine" in input || "conditions" in input;
  const looksLikeCondition = "field" in input || "operator" in input;
  if (looksLikeGroup === looksLikeCondition) {
    issues.push(issue(path, "Filter node must be either a condition or a nested group"));
    return;
  }

  if (looksLikeGroup) {
    if (depth > MAX_FILTER_DEPTH) {
      issues.push({
        code: "filter-too-deep",
        path,
        message: `Filter nesting exceeds the maximum depth of ${MAX_FILTER_DEPTH}`,
      });
      return;
    }
    rejectUnknownKeys(input, ["combine", "conditions"], path, issues);
    if (input.combine !== "all" && input.combine !== "any" && input.combine !== "none") {
      issues.push(issue(`${path}.combine`, 'Expected "all", "any", or "none"'));
    }
    if (!Array.isArray(input.conditions) || input.conditions.length === 0) {
      issues.push(
        issue(`${path}.conditions`, "Filter must contain at least one condition"),
      );
      return;
    }
    for (const [index, child] of input.conditions.entries()) {
      parseFilterNode(child, `${path}.conditions.${index}`, issues, depth + 1, state);
    }
    return;
  }

  // Leaf condition.
  state.leaves += 1;
  if (state.leaves > MAX_FILTER_CONDITIONS) {
    // Report the budget breach once, not per excess leaf.
    if (state.leaves === MAX_FILTER_CONDITIONS + 1) {
      issues.push({
        code: "filter-too-large",
        path,
        message: `Filter contains more than ${MAX_FILTER_CONDITIONS} conditions`,
      });
    }
    return;
  }
  parseFilterCondition(input, path, issues);
}

function parseFilterCondition(
  condition: Record<string, unknown>,
  path: string,
  issues: PlanIssue[],
): void {
  rejectUnknownKeys(condition, ["field", "operator", "value"], path, issues);
  if (!nonEmptyString(condition.field)) {
    issues.push(issue(`${path}.field`, "Filter field is required"));
  }
  if (
    typeof condition.operator !== "string" ||
    !FILTER_OPERATORS.has(condition.operator)
  ) {
    // This message becomes the model's repair prompt, so it must carry the
    // legal set: told only "unknown operator", a model that wrote "equals"
    // plausibly retries "match" and burns every repair attempt rediscovering
    // a list this validator already holds.
    issues.push(
      issue(
        `${path}.operator`,
        `Unknown filter operator${
          typeof condition.operator === "string" ? ` "${condition.operator}"` : ""
        }. Allowed: ${[...FILTER_OPERATORS].join(", ")}`,
      ),
    );
    return;
  }
  const isNullOperator =
    condition.operator === "is-null" || condition.operator === "is-not-null";
  if (isNullOperator && condition.value !== undefined) {
    issues.push(issue(`${path}.value`, `${condition.operator} cannot contain a value`));
  } else if (!isNullOperator && condition.value === undefined) {
    issues.push(issue(`${path}.value`, `${condition.operator} requires a value`));
  } else if (condition.value !== undefined && !isJsonValue(condition.value)) {
    issues.push(issue(`${path}.value`, "Filter value must be JSON-compatible"));
  }
  if (
    (condition.operator === "in" || condition.operator === "not-in") &&
    !Array.isArray(condition.value)
  ) {
    issues.push(issue(`${path}.value`, `${condition.operator} requires an array value`));
  }
  if (
    condition.operator === "between" &&
    (!Array.isArray(condition.value) || condition.value.length !== 2)
  ) {
    issues.push(
      issue(`${path}.value`, "between requires a two-element [min, max] array"),
    );
  }
}

function parseDataBindings(input: unknown, path: string, issues: PlanIssue[]): void {
  if (!isRecord(input)) {
    issues.push(issue(path, "Data bindings must be an object"));
    return;
  }
  for (const [bindingName, binding] of Object.entries(input)) {
    if (!nonEmptyString(bindingName)) {
      issues.push(issue(path, "Data binding names must not be empty"));
    }
    if (!isRecord(binding)) {
      issues.push(issue(`${path}.${bindingName}`, "Data binding must be an object"));
      continue;
    }
    const targetKeys = ["requestId", "compositionId", "joinId"].filter(
      (key) => key in binding,
    );
    if (targetKeys.length !== 1) {
      issues.push(
        issue(
          `${path}.${bindingName}`,
          "Data binding must reference exactly one of requestId, compositionId, or joinId",
        ),
      );
      continue;
    }
    const targetKey = targetKeys[0];
    rejectUnknownKeys(binding, [targetKey], `${path}.${bindingName}`, issues);
    if (!nonEmptyString(binding[targetKey])) {
      issues.push(
        issue(
          `${path}.${bindingName}.${targetKey}`,
          `Data binding ${targetKey} is required`,
        ),
      );
    }
  }
}

function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowed: string[],
  path: string,
  issues: PlanIssue[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      issues.push(issue(path ? `${path}.${key}` : key, `Unknown field: ${key}`));
    }
  }
}

function issue(path: string, message: string): PlanIssue {
  return { code: "invalid-plan", path, message };
}

function invalid(path: string, message: string): PlanValidationResult {
  return { ok: false, issues: [issue(path, message)] };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
