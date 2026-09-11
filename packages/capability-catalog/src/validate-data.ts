import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import {
  CapabilityFailureResultSchema,
  CapabilitySuccessResultSchema,
  type CapabilityCatalog,
  type JsonSchema,
} from "./schema.js";
import { findCapability } from "./compile.js";

export interface DataValidationIssue {
  path: string;
  message: string;
}

export type DataValidationResult =
  { ok: true } | { ok: false; issues: DataValidationIssue[] };

export interface CapabilityPreflightContext {
  /** Trusted session values. These never come from planner-controlled parameters. */
  identity: Readonly<Record<string, unknown>>;
  /** Trusted permission names already resolved by the host application. */
  permissions?: ReadonlySet<string>;
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

const validatorCache = new WeakMap<JsonSchema, ValidateFunction>();

function validatorFor(schema: JsonSchema): ValidateFunction {
  const cached = validatorCache.get(schema);
  if (cached) return cached;
  const validator = ajv.compile(schema);
  validatorCache.set(schema, validator);
  return validator;
}

function issuesFromAjv(errors: ErrorObject[] | null | undefined): DataValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || "/",
    message: error.message ?? "Invalid value",
  }));
}

/**
 * How deeply a plan's params may nest.
 *
 * The schema used to bound this by construction: a recursive input type was
 * written out a fixed number of times, so nesting past that had nowhere to go.
 * Referencing the type instead removed the ceiling along with the duplication —
 * a reference nests forever — so the bound moves here, from something the
 * schema made impossible to something validation refuses.
 *
 * Sixteen is far past any real filter (`A AND (B OR C)` is three) and far short
 * of what would cost anything to walk. What it stops is a plan whose nesting is
 * pathological rather than meant: a validator, a serializer, and an upstream
 * parser all have their own limits, and finding them one at a time in
 * production is worse than one refusal here that names the number.
 */
export const MAXIMUM_PARAMS_DEPTH = 16;

function depthOf(value: unknown, depth = 0): number {
  if (depth > MAXIMUM_PARAMS_DEPTH) return depth;
  if (Array.isArray(value)) {
    let deepest = depth;
    for (const item of value) {
      deepest = Math.max(deepest, depthOf(item, depth + 1));
      if (deepest > MAXIMUM_PARAMS_DEPTH) return deepest;
    }
    return deepest;
  }
  if (typeof value !== "object" || value === null) return depth;
  let deepest = depth;
  for (const item of Object.values(value as Record<string, unknown>)) {
    deepest = Math.max(deepest, depthOf(item, depth + 1));
    if (deepest > MAXIMUM_PARAMS_DEPTH) return deepest;
  }
  return deepest;
}

export function validateCapabilityParams(
  catalog: CapabilityCatalog,
  capabilityId: string,
  input: unknown,
): DataValidationResult {
  const capability = findCapability(catalog, capabilityId);
  if (!capability) {
    return {
      ok: false,
      issues: [{ path: "/", message: `Unknown capability "${capabilityId}"` }],
    };
  }

  // Before the schema, because the schema no longer bounds this and a
  // pathologically nested value is cheaper to refuse than to walk twice.
  if (depthOf(input) > MAXIMUM_PARAMS_DEPTH) {
    return {
      ok: false,
      issues: [
        {
          path: "/",
          message:
            `Params nest deeper than ${MAXIMUM_PARAMS_DEPTH} levels. A filter this deep is ` +
            `not something a visitor's question produces; express the same predicate with ` +
            `fewer groupings.`,
        },
      ],
    };
  }

  const validator = validatorFor(capability.inputSchema);
  return validator(input)
    ? { ok: true }
    : { ok: false, issues: issuesFromAjv(validator.errors) };
}

export function validateCapabilityOutput(
  catalog: CapabilityCatalog,
  capabilityId: string,
  output: unknown,
): DataValidationResult {
  const capability = findCapability(catalog, capabilityId);
  if (!capability) {
    return {
      ok: false,
      issues: [{ path: "/", message: `Unknown capability "${capabilityId}"` }],
    };
  }

  // "No such record" is part of an entity capability's contract, not a
  // violation of it: an entity lookup whose id matches nothing returns null,
  // and every validation layer must agree (this function backs both the
  // GraphQL executor and the data runtime's re-validation — fixing only one
  // gate moved the raw "must be object" error one layer down, it didn't
  // remove it). The renderer maps a null entity to the "empty" state.
  if (output === null && capability.output.shape === "entity") {
    return { ok: true };
  }

  const validator = validatorFor(capability.outputSchema);
  return validator(output)
    ? { ok: true }
    : { ok: false, issues: issuesFromAjv(validator.errors) };
}

/**
 * Checks the portable, host-independent part of execution policy. The host still owns
 * authentication, authorization, rate limiting, timeouts, and audit behavior.
 */
export function validateCapabilityPreflight(
  catalog: CapabilityCatalog,
  capabilityId: string,
  input: unknown,
  context: CapabilityPreflightContext,
): DataValidationResult {
  const capability = findCapability(catalog, capabilityId);
  if (!capability) {
    return {
      ok: false,
      issues: [{ path: "/", message: `Unknown capability "${capabilityId}"` }],
    };
  }

  const issues: DataValidationIssue[] = [];
  const params = validateCapabilityParams(catalog, capabilityId, input);
  if (!params.ok) issues.push(...params.issues);

  capability.requiredSessionKeys.forEach((key) => {
    if (
      !Object.prototype.hasOwnProperty.call(context.identity, key) ||
      context.identity[key] === undefined
    ) {
      issues.push({
        path: `/identity/${key}`,
        message: `Missing required trusted session key "${key}"`,
      });
    }
  });

  capability.policy.requiredPermissions?.forEach((permission) => {
    if (!context.permissions?.has(permission)) {
      issues.push({
        path: "/permissions",
        message: `Missing required permission "${permission}"`,
      });
    }
  });

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * Validates the complete runtime result. Successful data is checked against the capability's
 * output schema, and provenance is restricted to the capability's approved sources.
 */
export function validateCapabilityResult(
  catalog: CapabilityCatalog,
  capabilityId: string,
  result: unknown,
): DataValidationResult {
  const capability = findCapability(catalog, capabilityId);
  if (!capability) {
    return {
      ok: false,
      issues: [{ path: "/", message: `Unknown capability "${capabilityId}"` }],
    };
  }

  const failure = CapabilityFailureResultSchema.safeParse(result);
  if (failure.success) return { ok: true };

  const success = CapabilitySuccessResultSchema.safeParse(result);
  if (!success.success) {
    return {
      ok: false,
      issues: success.error.issues.map((issue) => ({
        path: `/${issue.path.join("/")}`,
        message: issue.message,
      })),
    };
  }

  const output = validateCapabilityOutput(catalog, capabilityId, success.data.data);
  const issues = output.ok ? [] : [...output.issues];
  const approvedSources = new Set(capability.sourceIds);

  if (
    Array.isArray(success.data.data) &&
    capability.policy.maximumRows !== undefined &&
    success.data.data.length > capability.policy.maximumRows
  ) {
    issues.push({
      path: "/data",
      message: `Result contains ${success.data.data.length} rows; maximumRows is ${capability.policy.maximumRows}`,
    });
  }

  success.data.provenance.sources.forEach((source, index) => {
    if (!approvedSources.has(source.sourceId)) {
      issues.push({
        path: `/provenance/sources/${index}/sourceId`,
        message: `Source "${source.sourceId}" is not approved for capability "${capabilityId}"`,
      });
    }
  });

  const { asOf, staleAt } = success.data.provenance.freshness;
  if (staleAt && Date.parse(staleAt) < Date.parse(asOf)) {
    issues.push({
      path: "/provenance/freshness/staleAt",
      message: "staleAt must not be earlier than asOf",
    });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
