import { isRecord, type Plan, type Surface } from "./plan.js";
import type { Registry } from "./registry.js";
import { validatePlan, type PlanIssue } from "./validate.js";

export interface PlanProviderRequest {
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: Record<string, unknown>;
}

export interface PlanProviderResult {
  value: unknown;
  modelId: string;
  /**
   * What the call cost, when the provider reports it. Optional because not
   * every provider returns usage, and a provider that doesn't must not be
   * forced to invent numbers — an absent field means "unknown", never zero.
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    /**
     * How many HTTP calls this result actually took. Usually 1, but a
     * structured-schema rejection retries in plain JSON mode, so a single
     * `generatePlan` can bill twice.
     */
    calls?: number;
  };
  /**
   * Whether the winning call ran under a provider-enforced response schema
   * (true) or degraded to prompt-embedded JSON mode (false). Optional so a
   * custom provider that doesn't know isn't forced to guess.
   *
   * True means the decoder *could not* emit a value the schema forbids. It is
   * not "we attached a schema to the request": a schema sent for guidance is
   * `decodeMode: "schema-advisory"`, and reporting that as constrained is how a
   * model emitting an out-of-enum value looked like a model problem for as long
   * as it did.
   */
  constrainedDecoding?: boolean;
  /**
   * How the winning call actually decoded, when the provider knows.
   *
   * - `schema-enforced` — the provider constrained generation to the schema.
   * - `schema-advisory` — the schema went with the request but does not bind
   *   the decoder, so output can violate it and only local validation catches
   *   that.
   * - `json-object` — no schema; the provider guaranteed only well-formed JSON.
   * - `prompt-only` — not even that; the shape lives in the prompt alone.
   */
  decodeMode?: "schema-enforced" | "schema-advisory" | "json-object" | "prompt-only";
}

export interface PlanProvider {
  id: string;
  generatePlan(request: PlanProviderRequest): Promise<PlanProviderResult>;
}

export interface ComposePlanInput {
  siteId: string;
  prompt: string;
  surfaceIds: string[];
  registry: Registry;
  provider: PlanProvider;
  previousPlan?: Plan;
  maxRetries?: number;
  createId?: () => string;
  now?: () => Date;
}

export type ComposePlanResult =
  { ok: true; plan: Plan } | { ok: false; fallbackPlan: Plan | null; reason: string };

export async function composePlan(input: ComposePlanInput): Promise<ComposePlanResult> {
  const maxRetries = input.maxRetries ?? 2;
  const systemPrompt = buildSystemPrompt(input.registry, input.surfaceIds);
  const jsonSchema = buildPlanDraftJsonSchema(input.registry, input.surfaceIds);
  let userPrompt = input.prompt;
  let lastIssues: PlanIssue[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const completion = await input.provider.generatePlan({
      systemPrompt,
      userPrompt,
      jsonSchema,
    });

    if (!isRecord(completion.value) || !Array.isArray(completion.value.surfaces)) {
      lastIssues = [
        {
          code: "invalid-plan",
          path: "surfaces",
          message: "Provider output must contain a surfaces array",
        },
      ];
    } else {
      const candidate: Plan = {
        schemaVersion: "3.0",
        planId: (input.createId ?? defaultId)(),
        siteId: input.siteId,
        sourcePrompt: input.prompt,
        catalog: {
          id: input.registry.id,
          version: input.registry.version,
          fingerprint: input.registry.fingerprint,
        },
        surfaces: completion.value.surfaces as Surface[],
        generation: {
          providerId: input.provider.id,
          modelId: completion.modelId,
          createdAt: (input.now ?? (() => new Date()))().toISOString(),
          repairCount: attempt,
        },
      };

      const validation = validatePlan(candidate, input.registry);
      if (validation.ok) return { ok: true, plan: validation.plan };
      lastIssues = validation.issues;
    }

    if (attempt < maxRetries) userPrompt = buildRepairPrompt(input.prompt, lastIssues);
  }

  return {
    ok: false,
    fallbackPlan: input.previousPlan ?? null,
    reason: lastIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
  };
}

export function buildSystemPrompt(registry: Registry, surfaceIds: string[]): string {
  const catalog = registry.components.map((component) => ({
    id: component.id,
    description: component.description,
    props: component.props.jsonSchema,
    slots: component.slots ?? {},
    policy: component.policy ?? {},
  }));

  return [
    "You compose website interfaces from owner-approved components.",
    "Return only a JSON object matching the supplied schema.",
    "Never invent component ids, props, surfaces, or slots.",
    "Use the visitor request only to select, arrange, and configure registered components.",
    `Allowed surfaces: ${surfaceIds.join(", ")}.`,
    `Component catalog: ${JSON.stringify(catalog)}`,
  ].join("\n");
}

export function buildPlanDraftJsonSchema(
  registry: Registry,
  surfaceIds: string[],
): Record<string, unknown> {
  const nodeVariants = registry.components.map((component) => {
    const slotProperties = Object.fromEntries(
      Object.entries(component.slots ?? {}).map(([slotName, slot]) => [
        slotName,
        {
          type: "array",
          items: { $ref: "#/$defs/node" },
          ...(slot.cardinality === "one" ? { maxItems: 1 } : {}),
        },
      ]),
    );

    return {
      type: "object",
      additionalProperties: false,
      required: ["nodeId", "componentId", "props"],
      properties: {
        nodeId: { type: "string", minLength: 1 },
        componentId: { const: component.id },
        props: component.props.jsonSchema,
        slots: {
          type: "object",
          additionalProperties: false,
          properties: slotProperties,
        },
      },
    };
  });

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["surfaces"],
    properties: {
      surfaces: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "nodes"],
          properties: {
            id: { enum: surfaceIds },
            nodes: {
              type: "array",
              items: { $ref: "#/$defs/node" },
            },
          },
        },
      },
    },
    $defs: {
      node: { anyOf: nodeVariants },
    },
  };
}

function buildRepairPrompt(originalPrompt: string, issues: PlanIssue[]): string {
  return [
    originalPrompt,
    "",
    "The previous plan was rejected. Correct these issues and return the full JSON plan draft again:",
    ...issues.map((issue) => `- ${issue.path}: ${issue.message}`),
  ].join("\n");
}

function defaultId(): string {
  const cryptoLike = globalThis.crypto as { randomUUID?: () => string } | undefined;
  return cryptoLike?.randomUUID?.() ?? `plan_${Math.random().toString(36).slice(2)}`;
}
