import type { PlanProvider, PlanProviderResult } from "./index.js";

const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Configures a real model as a `PlanProvider` without ever taking the key
 * itself: the host names an environment variable, and this process resolves it
 * per call. A key in this config object would be one `JSON.stringify` away
 * from a log line; a name cannot leak the same way.
 *
 * Note this is trusted server configuration, not a request payload — unlike
 * catalog publication, which takes a `credentialId` the host declared rather
 * than an environment variable name, because that input is attacker-reachable.
 */
/**
 * A host-supplied plan, configured like a provider.
 *
 * The supported way to exercise an install without a model — and reachable
 * over HTTP, which `createProvider` is not: that is a per-call library
 * argument, so a host testing their own mount had no seam at all once the
 * offline mock was removed.
 *
 * The plans are the *host's*. That is the whole difference from the mock this
 * replaces, which invented one by taking the first approved capability with
 * empty params: a double that guesses tells you nothing when it passes, and
 * lies about your install when it looks right.
 */
export interface ScriptedProviderConfig {
  id: string;
  /**
   * Returned in order, one per plan call; the last repeats once exhausted.
   * A single-element array is the common case.
   */
  plans: readonly unknown[];
}

/** Distinguishes a scripted entry from a real model at the config boundary. */
export function isScriptedProvider(
  provider: ModelProviderConfig | ScriptedProviderConfig,
): provider is ScriptedProviderConfig {
  return Array.isArray((provider as ScriptedProviderConfig).plans);
}

/** Builds the provider a `ScriptedProviderConfig` describes. */
export function createScriptedPlanProvider(config: ScriptedProviderConfig) {
  let index = 0;
  return {
    id: config.id,
    async generatePlan() {
      if (config.plans.length === 0) {
        throw new Error(
          `Scripted plan provider "${config.id}" was configured with no plans.`,
        );
      }
      const plan = config.plans[Math.min(index, config.plans.length - 1)];
      index += 1;
      return { modelId: `scripted:${config.id}`, value: plan };
    },
  };
}

export interface ModelProviderConfig {
  id: "openai" | "gemini";
  /** Environment variable NAME the API key is read from — never the key. */
  apiKeyEnv: string;
  /** The provider's own model name, passed through unchanged — this package keeps no list to age. */
  model: string;
  /** Overrides the default endpoint (an enterprise proxy, a compatible API). */
  baseUrl?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Resolve recursive input types into the schema instead of sending them as
   * `$defs`/`$ref`. Defaults to false: the references go out.
   *
   * Forwarding is the default because both live endpoints were probed and both
   * accept it, in constrained mode, with a self-referential `$ref`
   * (`providers-live.test.mjs`). Inlining is what the contract used to pay for
   * — the same recursive type written out again at every level, measured at
   * 93% of a real host's contract.
   *
   * The escape hatch exists for `baseUrl`: an enterprise proxy or a
   * "compatible" API is not covered by those probes, and a decoder that refuses
   * a reference would otherwise fall back to JSON mode on every compose.
   */
  inlineSchemaRefs?: boolean;
  /**
   * Ceiling on a single model call, in milliseconds. Defaults to
   * `DEFAULT_MODEL_TIMEOUT_MS`.
   *
   * Without this a stalled provider holds the request open indefinitely: the
   * caller's own timeout fires, the browser gives up, but this process keeps
   * waiting and the tokens are still spent. Note that one compose can make
   * more than one model call — a structured-schema rejection retries in plain
   * JSON mode — so the worst case is this budget per attempt, not per compose.
   */
  timeoutMs?: number;
}

/**
 * Default per-model-call ceiling. Chosen against measured behaviour rather
 * than taste: single-capability prompts complete in 11-13s and
 * three-capability prompts have been observed between 23s and 57s on an
 * otherwise identical request, so anything under ~60s would abort work that
 * was going to succeed. This bounds the pathological case without cutting off
 * the merely slow one.
 */
export const DEFAULT_MODEL_TIMEOUT_MS = 60_000;

/**
 * Whether the plan contract can be sent as a provider-*enforced* schema.
 *
 * False, and not as a preference: OpenAI's strict structured-output mode
 * accepts a documented subset of JSON Schema, and the plan contract is outside
 * it in three independent ways. Every property of an object must appear in
 * `required` — `query` declares none of `filter`/`sort`/`limit` as required
 * because they genuinely are optional. `oneOf` is unsupported, and a filter
 * condition is a `oneOf` of a leaf condition and a nested group. And the
 * keyword subset excludes `minLength`, `minItems` and `maxItems`, all of which
 * the contract uses to bound what the planner may ask for.
 *
 * So the schema goes out as guidance, and the decoder is free to ignore it.
 * The consequence is not theoretical: a live gpt-4o compose emitted a filter
 * field outside the schema's enum on three consecutive attempts, local
 * validation refused each one, and the repair loop spent three model calls and
 * ~28k input tokens before failing the compose. The constant exists so the
 * request flag and the reported decode mode are derived from one value and
 * cannot drift apart — reporting enforcement we did not ask for is what made
 * that look like a model problem rather than an adapter one.
 */
export const STRICT_SCHEMA_SUPPORTED = false;

/** Stable short hash of the schema actually serialized into the request. */
export function schemaFingerprint(schema: unknown): string {
  let hash = 0x811c9dc5;
  const text = JSON.stringify(schema) ?? "";
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

/**
 * What the winning call actually decoded under — never what it asked for.
 *
 * `structured` only records which response format was requested. A schema sent
 * with strict off binds nothing, so it is advisory, and saying so is the whole
 * point of this function.
 */
export function decodeModeOf(
  structured: boolean,
): "schema-enforced" | "schema-advisory" | "json-object" {
  if (!structured) return "json-object";
  return STRICT_SCHEMA_SUPPORTED ? "schema-enforced" : "schema-advisory";
}

/** Said once per distinct schema, so a diagnosis has something to grep for. */
const advisedSchemas = new Set<string>();
export function warnSchemaAdvisoryOnce(provider: string, schema: unknown): void {
  const fingerprint = schemaFingerprint(schema);
  if (advisedSchemas.has(fingerprint)) return;
  advisedSchemas.add(fingerprint);
  console.warn(
    `[planner:${provider}] Response schema ${fingerprint} was sent for guidance, ` +
      `not enforcement (strict mode off): the decoder may emit values this schema ` +
      `forbids, and only local validation will catch them.`,
  );
}

/**
 * Runs `call` with an abort signal that fires after `timeoutMs`, translating
 * the resulting `AbortError` into a message that names the provider and the
 * budget rather than surfacing a bare "This operation was aborted".
 */
async function withTimeout<T>(
  label: string,
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await call(controller.signal);
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new Error(`${label} request exceeded its ${timeoutMs}ms timeout`);
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

function resolveApiKey(envName: string, label: string): string {
  if (!ENV_NAME_PATTERN.test(envName)) {
    throw new Error(`${label} apiKeyEnv must be an environment variable name`);
  }
  const value = process.env[envName];
  if (!value) throw new Error(`Environment variable ${envName} is not set`);
  return value;
}

/**
 * True when a provider rejected a request because of the structured-output
 * schema itself, rather than the request's content. Some providers cannot
 * express every schema this contract can produce — a deep `$defs.node`
 * recursion for nested slots, or a large `oneOf` before surface scoping — and
 * reject the call outright instead of degrading. Detecting that lets the
 * caller retry once in plain JSON mode instead of failing the whole request.
 */
export function shouldRetryWithoutStructuredSchema(
  status: number,
  payload: unknown,
): boolean {
  if (status !== 400) return false;
  const record = payload as {
    error?: { message?: unknown; status?: unknown };
    message?: unknown;
  } | null;
  const detail = String(
    record?.error?.message ?? record?.error?.status ?? record?.message ?? "",
  ).toLowerCase();
  return ["schema", "response_format", "json_schema", "oneof", "anyof", "required"].some(
    (marker) => detail.includes(marker),
  );
}

/**
 * The provider's own sentence about why it rejected the structured schema.
 *
 * It was discarded, so a fallback that fired on 49 of 49 measured composes —
 * one wasted round trip each — logged nothing anyone could act on. Redacted
 * and bounded the same way `providerDiagnostic` is, because a 400 body can
 * echo request fragments.
 */
export function structuredRejectionDetail(payload: unknown): string {
  const record = payload as {
    error?: { message?: unknown; status?: unknown };
    message?: unknown;
  } | null;
  const detail = String(
    record?.error?.message ?? record?.error?.status ?? record?.message ?? "no detail",
  );
  return providerDiagnostic(new Error(detail)).slice(0, 300);
}

/**
 * Keywords structured-output decoding rejects, dropped from the schema sent in
 * structured mode. Sourced from the failure mode — the full plan contract was
 * refused on every measured compose — not from vendor-doc paraphrase: bound
 * and format keywords, and everything a validator (not a decoder) needs.
 */
const STRUCTURED_MODE_DROPPED_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "$schema",
  "$defs",
]);

/**
 * Below this depth every subtree becomes a permissive schema.
 *
 * Deep enough to carry the whole plan contract, which is a *fixed* shape: the
 * plan, its data requests, the per-capability branch, that capability's query,
 * its filter, a condition, and the operator enum inside it — measured at depth
 * 18 for the operator, plus a host's approved argument schemas below `params`.
 *
 * It was 8, which is shallower than the contract this package compiles, so six
 * constraints never reached the model at all: the filter-operator vocabulary,
 * the null-check operators, the per-capability list of filterable fields (the
 * host's own `supports.filterFields`), and the `required` keys of a condition.
 * The model was asked to fill in a filter and told only that conditions are
 * objects. It wrote `"equals"` and `"="` — good guesses at a list it was never
 * shown — and the local validator, which does have the list, rejected every
 * one. Three model calls per compose, spent rediscovering this.
 *
 * Depth is no longer doing the job it was set low for. The unbounded thing in
 * this schema is `$ref` recursion — the component `node` tree — and that is cut
 * on its own line below, whatever the depth. So this only has to be larger than
 * the deepest *finite* nesting we actually emit, with headroom.
 */
const STRUCTURED_MODE_MAX_DEPTH = 28;

/**
 * A floor under a capability's `params`, counted from the argument root.
 *
 * Kept even though `STRUCTURED_MODE_MAX_DEPTH` now covers it, because these two
 * numbers answer to different things: the budget above tracks the depth of
 * *our* plan contract, and this tracks how deep a *host's* approved argument
 * schema may go. Raising one for a reason that belongs to the other is how the
 * budget came to be shallower than the contract in the first place.
 *
 * Bounded on the other side by `DEFAULT_MAX_INPUT_RECURSION` and, since
 * `approvedInputFields`, by the host's own allowlist.
 */
const STRUCTURED_MODE_PARAMS_DEPTH = 12;

/**
 * Rewrites the plan contract into the restricted JSON-Schema dialect
 * structured-output decoding accepts, keeping local validation the authority.
 *
 * The full contract — each capability's fully-expanded input schema, a `oneOf`
 * per component, recursive `$defs.node` slots, numeric bounds throughout — was
 * rejected by structured mode on 100% of measured composes, so every plan ever
 * produced came from the JSON fallback after a wasted round trip. This keeps
 * the plan's structural shape and relaxes exactly what tripped the dialect:
 *
 * - `oneOf` becomes `anyOf` (same acceptance, decoder-friendly);
 * - bound/format keywords are dropped (see the set above) — they are
 *   validation, and the local validator still enforces every one of them;
 * - `$ref`/`$defs` recursion is cut: a `$ref` becomes a permissive object;
 * - depth is bounded by construction.
 *
 * `params` used to be replaced with a permissive object here, on the reasoning
 * that the expanded input schemas were the size offender and the executor
 * re-validates them anyway. Both halves were true and the conclusion was
 * wrong: re-validating catches a bad plan, it does not produce a good one, and
 * a model told only `params: {type: "object"}` has to guess the shape. Traced
 * on a real host, it guessed `sort` as `[{field, direction}]` against a schema
 * that says String on 12 of 25 consecutive plans — every one rejected before
 * execution, which was the whole of that install's ~50% failure rate. The size
 * problem is real and belongs to whoever compiled the catalog:
 * `oversizedParamsSchemas` names it instead of silently deleting the schema.
 *
 * A draft the relaxed schema admits and the real contract refuses fails local
 * validation and repairs — exactly what happens to a JSON-mode draft today.
 */
export function structuredOutputSchema(
  schema: unknown,
  maxDepth = STRUCTURED_MODE_MAX_DEPTH,
  { forwardRefs = true }: { forwardRefs?: boolean } = {},
): Record<string, unknown> {
  const defsForRoot = definitionsOf(schema);
  const known: ReadonlyMap<string, unknown> = defsForRoot
    ? new Map(Object.entries(defsForRoot))
    : EMPTY_DEFINITIONS;
  const root = withObjectRoot(simplifyForStructuredMode(schema, maxDepth, known, forwardRefs));
  if (!forwardRefs || !defsForRoot) return root;
  // The definitions travel with the references, or every one of them dangles.
  return {
    ...root,
    $defs: Object.fromEntries(
      Object.entries(defsForRoot).map(([name, definition]) => [
        name,
        simplifyForStructuredMode(definition, maxDepth, known, forwardRefs),
      ]),
    ),
  };
}

const EMPTY_DEFINITIONS: ReadonlyMap<string, unknown> = new Map();

/** The `$defs` entry a local reference names, or undefined for anything else. */
function definitionNameOf(ref: string): string | undefined {
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) return undefined;
  const name = ref.slice(prefix.length);
  return name.length > 0 && !name.includes("/") ? name : undefined;
}

/** The `$defs` a schema carries at its root, when it carries any. */
function definitionsOf(schema: unknown): Record<string, unknown> | undefined {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return undefined;
  const defs = (schema as Record<string, unknown>).$defs;
  if (typeof defs !== "object" || defs === null || Array.isArray(defs)) return undefined;
  return defs as Record<string, unknown>;
}

/**
 * Gives the rewritten schema an object root, which structured-output decoding
 * requires: `schema must be a JSON Schema of 'type: "object"', got
 * 'type: "None"'`. The plan contract's root is a union — one arm per outcome
 * (ready / unsupported / needs-clarification) — so relaxing the dialect above
 * is not enough on its own; a root `anyOf` has no `type` either and is refused
 * before the model runs. Measured: the plan route, whose single outcome gives
 * it an object root, is accepted at a *larger* size than the compose route the
 * decoder rejects, so this is the root's shape and not the contract's size.
 *
 * Flattened on `status` rather than nested under a property. The arms are
 * disjoint apart from the discriminator and every consumer already dispatches
 * on `status`, so one object with an enum discriminator leaves the response
 * shape unchanged; nesting would move `status` a level down and make structured
 * mode return something JSON mode does not.
 *
 * Which fields each status requires is dropped here and stays with the local
 * validator, exactly as the bound keywords are: a `ready` draft missing
 * `dataRequests` fails validation and repairs.
 */
function withObjectRoot(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type === "object") return schema;
  const arms = Array.isArray(schema.anyOf) ? schema.anyOf : [schema];

  const properties: Record<string, unknown> = {};
  const statuses: string[] = [];
  for (const arm of arms) {
    if (typeof arm !== "object" || arm === null) continue;
    const armProperties = (arm as Record<string, unknown>).properties;
    if (typeof armProperties !== "object" || armProperties === null) continue;
    for (const [name, subschema] of Object.entries(
      armProperties as Record<string, unknown>,
    )) {
      if (name === "status") {
        const literal =
          (subschema as { const?: unknown })?.const ??
          (subschema as { enum?: unknown[] })?.enum?.[0];
        if (typeof literal === "string" && !statuses.includes(literal)) {
          statuses.push(literal);
        }
        continue;
      }
      properties[name] ??= subschema;
    }
  }
  if (statuses.length === 0) return { type: "object" };

  return {
    type: "object",
    properties: { status: { type: "string", enum: statuses }, ...properties },
    required: ["status"],
    additionalProperties: false,
  };
}

/**
 * Largest `params` schema that goes to a model without comment.
 *
 * ~16KB is roughly 4,000 tokens, resent on every repair attempt. The measured
 * pathological case was 324,698 bytes for one argument; a well-pruned one on
 * the same schema is under 10,000.
 */
const OVERSIZED_PARAMS_BYTES = 16_384;

/** One capability whose compiled params schema is large enough to be a problem. */
export interface OversizedParamsSchema {
  capabilityId: string;
  bytes: number;
  /** The argument contributing most of it — where a host would start pruning. */
  largestArgument?: string;
}

/**
 * Names capabilities whose `params` schema is large, so the size can be
 * reported instead of silently resolved.
 *
 * The lesson from the substitution this replaces is not "keep params" — it is
 * "never silently substitute". A contract too big to send is a real problem
 * with a real owner: it means an approved argument was never narrowed, and the
 * host who approved it is the only one who can say which fields a visitor
 * needs (`approvedInputFields` in the decisions file). Deleting the schema on
 * their behalf moved the cost from a log line nobody had to read to a failure
 * rate nobody could explain.
 *
 * Walks the contract rather than the catalog because this is the last point
 * before the wire, which is the only place the true sent size is known.
 */
export function oversizedParamsSchemas(
  schema: unknown,
  threshold = OVERSIZED_PARAMS_BYTES,
): OversizedParamsSchema[] {
  const found: OversizedParamsSchema[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (typeof properties === "object" && properties !== null) {
      const bag = properties as Record<string, unknown>;
      const params = bag.params;
      if (params !== undefined) {
        const bytes = JSON.stringify(params)?.length ?? 0;
        if (bytes >= threshold) {
          const identifier = bag.capabilityId as { const?: unknown } | undefined;
          const capabilityId =
            typeof identifier?.const === "string" ? identifier.const : "(unnamed capability)";
          found.push({
            capabilityId,
            bytes,
            ...(largestArgumentOf(params) ? { largestArgument: largestArgumentOf(params) } : {}),
          });
        }
      }
    }
    Object.values(record).forEach(walk);
  };

  walk(schema);
  return found;
}

/** Which approved argument accounts for most of a params schema. */
function largestArgumentOf(params: unknown): string | undefined {
  const properties = (params as { properties?: unknown } | null)?.properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  let largest: { name: string; bytes: number } | undefined;
  for (const [name, schema] of Object.entries(properties as Record<string, unknown>)) {
    const bytes = JSON.stringify(schema)?.length ?? 0;
    if (!largest || bytes > largest.bytes) largest = { name, bytes };
  }
  return largest?.name;
}

/**
 * Logs any oversized `params` schema on the way to the wire, and passes the
 * contract through unchanged.
 *
 * Loud rather than corrective on purpose. Nothing here can decide which fields
 * a visitor should be able to filter on — that is the host's approval — so the
 * only honest action is to say the size, name the capability and the argument
 * carrying it, and let the plan go. A silent fix is what put this comment here.
 */
function reportOversizedParams(schema: Record<string, unknown>): Record<string, unknown> {
  for (const oversized of oversizedParamsSchemas(schema)) {
    console.warn(
      `[renderyes] capability "${oversized.capabilityId}" sends ` +
        `${oversized.bytes.toLocaleString()} bytes of params schema to the planner on every ` +
        `attempt` +
        (oversized.largestArgument
          ? `, most of it the "${oversized.largestArgument}" argument`
          : "") +
        `. Narrow it with approvedInputFields in the decisions file.`,
    );
  }
  return schema;
}

function simplifyForStructuredMode(
  schema: unknown,
  depth: number,
  /** The root's `$defs`, so a reference can be resolved rather than discarded. */
  known: ReadonlyMap<string, unknown> = EMPTY_DEFINITIONS,
  /** Forward a resolvable reference instead of inlining what it points at. */
  forwardRefs = true,
): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return {};
  if (depth <= 0) {
    // The depth budget bounds *structure*, and an enum is not structure — it
    // is the one keyword where losing it changes what the decoder emits, not
    // just what it checks. The plan contract's filter operators sit below the
    // budget, and truncating them to {} let structured mode emit "equals"
    // against a local validator that only accepts "eq": three model calls per
    // compose spent rediscovering a list this schema already carries.
    const leaf = schema as Record<string, unknown>;
    return Array.isArray(leaf.enum) ? { enum: leaf.enum } : {};
  }
  const node = schema as Record<string, unknown>;
  if (typeof node.$ref === "string") {
    // Resolved and inlined, not flattened to `{ type: "object" }`. That
    // flattening discarded every constraint the reference carried, and the plan
    // contract already emits `$defs`/`$ref` for recursive component slots — so
    // a nested slot reached the model with no shape at all, leaving only
    // downstream validation to catch it, as repair attempts.
    //
    // Inlined rather than forwarded as `$ref`, because whether this API accepts
    // a reference is a claim about a live service and nothing here has probed
    // it. Inlining is the version that cannot be wrong about that: the output
    // dialect is unchanged, and the remaining depth budget bounds the
    // recursion exactly as it bounds everything else. Forwarding the reference
    // is what would make the contract smaller as well as truer, and that is
    // one live probe away.
    const name = definitionNameOf(node.$ref);
    const target = name === undefined ? undefined : known.get(name);
    if (target === undefined) return { type: "object" };
    if (forwardRefs) return { $ref: node.$ref };
    return simplifyForStructuredMode(target, depth - 1, known, forwardRefs);
  }

  const out: Record<string, unknown> = {};
  const branches: unknown[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (STRUCTURED_MODE_DROPPED_KEYWORDS.has(key)) continue;
    switch (key) {
      case "oneOf":
      case "anyOf":
        if (Array.isArray(value)) {
          branches.push(
            ...value.map((branch) => simplifyForStructuredMode(branch, depth - 1, known, forwardRefs)),
          );
        }
        break;
      case "allOf":
        if (Array.isArray(value)) {
          out.allOf = value.map((branch) => simplifyForStructuredMode(branch, depth - 1, known, forwardRefs));
        }
        break;
      case "items":
        out.items = simplifyForStructuredMode(value, depth - 1, known, forwardRefs);
        break;
      case "properties":
        if (typeof value === "object" && value !== null) {
          out.properties = Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([name, sub]) => [
              name,
              simplifyForStructuredMode(
                sub,
                // The one place the budget restarts. Everything above `params`
                // is this package's own plan skeleton, whose depth is fixed and
                // known; everything below it is the host's approved arguments,
                // whose shape is the entire reason for sending a schema at all.
                // Spending the skeleton's depth on the way down and truncating
                // the payload is the wrong end to economize.
                name === "params"
                  ? Math.max(depth - 1, STRUCTURED_MODE_PARAMS_DEPTH)
                  : depth - 1,
                known,
                forwardRefs,
              ),
            ]),
          );
        }
        break;
      case "additionalProperties":
        out.additionalProperties =
          typeof value === "boolean"
            ? value
            : simplifyForStructuredMode(value, depth - 1, known, forwardRefs);
        break;
      default:
        // type, enum, const, required, description, and the rest of the
        // dialect-safe vocabulary pass through untouched.
        out[key] = value;
    }
  }
  if (branches.length > 0) out.anyOf = branches;
  return out;
}

/** The degraded prompt used once a provider has rejected the structured-output schema. */
export function jsonModeSystemPrompt(body: {
  systemPrompt: string;
  jsonSchema: unknown;
}): string {
  return [
    body.systemPrompt,
    "",
    "Return one JSON object only. It will be rejected unless it validates against this canonical JSON Schema:",
    JSON.stringify(body.jsonSchema),
  ].join("\n");
}

/**
 * A message safe to log. Some providers echo part of the failing request back
 * in their error body, so this redacts the two credential shapes that could
 * appear there — an `Authorization: Bearer` header and a `key=` query
 * parameter — rather than trusting that a provider never will.
 */
export function providerDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : "Provider failed";
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/key=[^&\s]+/gi, "key=[redacted]")
    .slice(0, 500);
}

function parseModelJson(label: string, text: string | undefined): unknown {
  if (!text) throw new Error(`${label} returned no plan.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned an invalid JSON plan.`);
  }
}

function cleanApiError(
  label: string,
  payload: { error?: { message?: unknown; status?: unknown }; message?: unknown },
  status: number,
): string {
  const detail = payload?.error?.message ?? payload?.error?.status ?? payload?.message;
  return `${label} request failed (${status})${detail ? `: ${String(detail).slice(0, 280)}` : ""}`;
}

interface SchemaFallbackState {
  /**
   * Set when a provider rejects the structured schema, and read by NOTHING
   * that decides — every call attempts structured mode first regardless.
   *
   * This used to be sticky per provider instance: one rejection at any point
   * flipped every later compose in the process into unconstrained JSON mode,
   * permanently and silently. A provider instance can live as long as the
   * server, so a transient rejection at boot became a standing quality
   * downgrade nobody could attribute — the metrics now record which mode each
   * plan ran under, and a sticky flag shows up there as an unexplained
   * permanent run of unconstrained plans. The cost of not remembering is one
   * extra HTTP call per attempt against a provider that genuinely cannot take
   * the schema, which is the rare case and the one worth paying to keep every
   * other host constrained. Kept as a field only so the retry is observable in
   * one place; do not branch on it.
   */
  structuredRejected: boolean;
}

async function requestOpenAI(
  body: { systemPrompt: string; userPrompt: string; jsonSchema: unknown },
  config: ModelProviderConfig,
  structured: boolean,
): Promise<{ apiResponse: Response; payload: Record<string, unknown> }> {
  const apiKey = resolveApiKey(config.apiKeyEnv, "OpenAI");
  const apiResponse = await withTimeout(
    "OpenAI",
    config.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
    (signal) =>
      (config.fetchImpl ?? fetch)(
        config.baseUrl ?? "https://api.openai.com/v1/responses",
        {
          signal,
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            input: [
              {
                role: "system",
                content: structured ? body.systemPrompt : jsonModeSystemPrompt(body),
              },
              { role: "user", content: body.userPrompt },
            ],
            text: {
              format: structured
                ? {
                    type: "json_schema",
                    name: "renderyes_plan",
                    strict: STRICT_SCHEMA_SUPPORTED,
                    // The dialect-safe rewrite, not the full contract — the
                    // full contract was rejected on every measured compose.
                    // Local validation still enforces the real one.
                    schema: reportOversizedParams(
                      structuredOutputSchema(body.jsonSchema, undefined, {
                        forwardRefs: config.inlineSchemaRefs !== true,
                      }),
                    ),
                  }
                : { type: "json_object" },
            },
          }),
        },
      ),
  );
  const payload = (await apiResponse.json()) as Record<string, unknown>;
  return { apiResponse, payload };
}

async function callOpenAI(
  body: { systemPrompt: string; userPrompt: string; jsonSchema: unknown },
  config: ModelProviderConfig,
  fallback: SchemaFallbackState,
): Promise<{
  value: unknown;
  usage: PlanProviderResult["usage"];
  constrainedDecoding: boolean;
  decodeMode: "schema-enforced" | "schema-advisory" | "json-object";
}> {
  let structured = true;
  let calls = 1;
  let { apiResponse, payload } = await requestOpenAI(body, config, structured);
  if (
    structured &&
    !apiResponse.ok &&
    shouldRetryWithoutStructuredSchema(apiResponse.status, payload)
  ) {
    fallback.structuredRejected = true;
    structured = false;
    calls += 1;
    console.warn(
      `[planner:openai] Structured schema was rejected (${structuredRejectionDetail(payload)}); retrying with validated JSON mode.`,
    );
    ({ apiResponse, payload } = await requestOpenAI(body, config, false));
  }
  if (!apiResponse.ok) {
    throw new Error(cleanApiError("OpenAI", payload, apiResponse.status));
  }
  const text =
    (payload.output_text as string | undefined) ??
    (
      payload.output as
        Array<{ content?: Array<{ type: string; text?: string }> }> | undefined
    )
      ?.flatMap((item) => item.content ?? [])
      .find((item) => item.type === "output_text")?.text;
  const usage = payload.usage as
    { input_tokens?: number; output_tokens?: number } | undefined;
  const decodeMode = decodeModeOf(structured);
  if (decodeMode === "schema-advisory") warnSchemaAdvisoryOnce("openai", body.jsonSchema);
  return {
    value: parseModelJson("OpenAI", text),
    // Only a decoder that could not have produced a violating value counts.
    constrainedDecoding: decodeMode === "schema-enforced",
    decodeMode,
    usage: {
      ...(typeof usage?.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage?.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
      calls,
    },
  };
}

/** First numeric candidate, so an absent field stays absent instead of 0. */
function firstNumber(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "number") return candidate;
  }
  return undefined;
}

async function requestGemini(
  body: { systemPrompt: string; userPrompt: string; jsonSchema: unknown },
  config: ModelProviderConfig,
  structured: boolean,
): Promise<{ apiResponse: Response; payload: Record<string, unknown> }> {
  const apiKey = resolveApiKey(config.apiKeyEnv, "Gemini");
  const apiResponse = await withTimeout(
    "Gemini",
    config.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
    (signal) =>
      (config.fetchImpl ?? fetch)(
        // `v1beta`, verified by live probe (2026-08-07): POST to this path
        // without a key returns 403 "unregistered callers" — the route exists
        // and is auth-gated — while `/v1beta2/interactions` returns 404. This
        // path was previously "fixed" to v1beta2 off a documentation summary,
        // which moved the adapter from a real endpoint to a nonexistent one.
        // Endpoint claims about this adapter get settled by probing the live
        // service, never by assertion; see the key-gated smoke test.
        config.baseUrl ??
          "https://generativelanguage.googleapis.com/v1beta/interactions",
        {
          signal,
          method: "POST",
          headers: {
            "x-goog-api-key": apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            input: body.userPrompt,
            system_instruction: structured
              ? body.systemPrompt
              : jsonModeSystemPrompt(body),
            response_format: {
              type: "text",
              mime_type: "application/json",
              ...(structured ? { schema: body.jsonSchema } : {}),
            },
          }),
        },
      ),
  );
  const payload = (await apiResponse.json()) as Record<string, unknown>;
  return { apiResponse, payload };
}

async function callGemini(
  body: { systemPrompt: string; userPrompt: string; jsonSchema: unknown },
  config: ModelProviderConfig,
  fallback: SchemaFallbackState,
): Promise<{
  value: unknown;
  usage: PlanProviderResult["usage"];
  constrainedDecoding: boolean;
  decodeMode: "schema-enforced" | "schema-advisory" | "json-object";
}> {
  let structured = true;
  let calls = 1;
  let { apiResponse, payload } = await requestGemini(body, config, structured);
  if (
    structured &&
    !apiResponse.ok &&
    shouldRetryWithoutStructuredSchema(apiResponse.status, payload)
  ) {
    fallback.structuredRejected = true;
    structured = false;
    calls += 1;
    console.warn(
      `[planner:gemini] Structured schema was rejected (${structuredRejectionDetail(payload)}); retrying with validated JSON mode.`,
    );
    ({ apiResponse, payload } = await requestGemini(body, config, false));
  }
  if (!apiResponse.ok) {
    throw new Error(cleanApiError("Gemini", payload, apiResponse.status));
  }
  type GeminiStep = { type: string; content?: Array<{ type: string; text?: string }> };
  const text =
    (payload.output_text as string | undefined) ??
    [...((payload.steps as GeminiStep[] | undefined) ?? [])]
      .reverse()
      .find((step) => step.type === "model_output")
      ?.content?.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
  // Read from both shapes on purpose. `usageMetadata.promptTokenCount` is
  // what `generateContent` returns; `usage.input_tokens` is the newer
  // Interactions-generation naming. Which one Interactions actually emits is
  // not something this adapter should guess wrong and silently report zero
  // spend for, and `usage` is documented as optional throughout — an absent
  // field must stay absent rather than become 0, since 0 reads as "this call
  // was free" in the metrics that now sum across attempts.
  const legacyUsage = payload.usageMetadata as
    { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
  const currentUsage = payload.usage as
    { input_tokens?: number; output_tokens?: number } | undefined;
  const inputTokens = firstNumber(
    currentUsage?.input_tokens,
    legacyUsage?.promptTokenCount,
  );
  const outputTokens = firstNumber(
    currentUsage?.output_tokens,
    legacyUsage?.candidatesTokenCount,
  );
  // Gemini's structured request carries the schema with no enforcement flag of
  // its own, so it binds the decoder no more than OpenAI's does with strict off.
  const decodeMode = decodeModeOf(structured);
  if (decodeMode === "schema-advisory") warnSchemaAdvisoryOnce("gemini", body.jsonSchema);
  return {
    value: parseModelJson("Gemini", text),
    constrainedDecoding: decodeMode === "schema-enforced",
    decodeMode,
    usage: {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      calls,
    },
  };
}

/**
 * Builds a `PlanProvider` backed by a real model, resolving the key per call
 * from `config.apiKeyEnv` rather than holding one.
 *
 * Each call to this function creates its own schema-fallback memory. Two
 * providers must not share it: one model's structured-output limitation says
 * nothing about another's, and a shared fallback would degrade a model that
 * never needed it.
 */
export function createModelPlanProvider(config: ModelProviderConfig): PlanProvider {
  const fallback: SchemaFallbackState = { structuredRejected: false };
  return {
    id: config.id,
    async generatePlan(request) {
      try {
        const { value, usage, constrainedDecoding, decodeMode } =
          config.id === "openai"
            ? await callOpenAI(request, config, fallback)
            : await callGemini(request, config, fallback);
        return {
          value,
          modelId: config.model,
          constrainedDecoding,
          decodeMode,
          ...(usage ? { usage } : {}),
        };
      } catch (error) {
        console.error(`[planner:${config.id}] ${providerDiagnostic(error)}`);
        throw error;
      }
    },
  };
}
