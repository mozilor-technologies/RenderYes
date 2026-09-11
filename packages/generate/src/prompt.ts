import { z } from "zod";
import { ResultShapeSchema, SemanticTypeSchema } from "@renderyes/capability-catalog";
import type { SemanticType } from "@renderyes/capability-catalog";
import type { CapabilitySlice } from "./inputs.js";
import type { HostConvention, StyleCorpus } from "./style-corpus.js";

/**
 * The output envelope: deliberately shallow.
 *
 * The planner's structured-output schema gets rejected by OpenAI because of
 * its recursive `$defs.node` and wide `oneOf`s; this envelope has neither — a
 * string, one two-level object, and a string array — so it never trips that
 * rejection, and the validated-JSON fallback in the provider still exists if
 * a model finds another reason.
 */
export const EnvelopePropSchema = z.strictObject({
  type: z.enum(["string", "number", "boolean", "enum", "stringArray"]),
  /** Enum props only. */
  values: z.array(z.string().min(1)).optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  required: z.boolean().optional(),
});

export const EnvelopeAcceptanceSchema = z
  .strictObject(
    {
      /** Nominal acceptance: this exact data type in these shapes. */
      dataTypeId: z.string().min(1).optional(),
      shapes: z.array(ResultShapeSchema).optional(),
      /** Structural acceptance: any data type of this shape. */
      shape: ResultShapeSchema.optional(),
      requires: z.array(z.strictObject({ semanticType: SemanticTypeSchema })).optional(),
      minFields: z.number().int().positive().optional(),
    },
    {
      // The live acceptance run showed the model returning `"pantry"` and
      // `{type: ...}` here. A bare string is NOT coerced — {dataTypeId} vs
      // {shape} is a real decision the model must make — but the error must
      // say the legal shape, not just "expected object".
      error: (issue) => {
        if (issue.code === "invalid_type") {
          return (
            "Each accepts entry must be an OBJECT: nominal " +
            '{"dataTypeId": "<id>", "shapes": ["collection"]} or structural ' +
            '{"shape": "<shape>"} — never a bare string'
          );
        }
        if (issue.code === "unrecognized_keys") {
          return (
            `Unrecognized key(s) in accepts entry: ${(issue as { keys?: string[] }).keys?.join(", ") ?? "?"}. ` +
            "Allowed keys: dataTypeId, shapes, shape, requires, minFields"
          );
        }
        return undefined;
      },
    },
  )
  .refine(
    (value) =>
      (value.dataTypeId !== undefined && value.shapes !== undefined) !==
      (value.shape !== undefined),
    { message: "Acceptance must be either {dataTypeId, shapes} or {shape, ...}" },
  );

const ACCEPTANCE_KEYS = new Set(["dataTypeId", "shapes", "shape", "requires", "minFields"]);

/**
 * Coerces the two UNAMBIGUOUS near-misses observed in live runs, and only
 * those:
 * - an acceptance object placed directly on the slot (`{dataTypeId, shapes}`
 *   with no `accepts` and no keys outside the acceptance vocabulary) is
 *   normalized to `{accepts: [entry]}` — there is exactly one place it can
 *   have been meant to go;
 * - `accepts` given as a single object instead of a one-element array is
 *   wrapped.
 * A bare string like "pantry" is deliberately NOT coerced (it does not say
 * whether nominal or structural acceptance was meant); it fails with an error
 * message that states the legal shape instead.
 */
function normalizeDataSlot(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if ("accepts" in record) {
    const accepts = record.accepts;
    if (accepts !== null && typeof accepts === "object" && !Array.isArray(accepts)) {
      return { ...record, accepts: [accepts] };
    }
    return value;
  }
  const keys = Object.keys(record);
  if (
    keys.length > 0 &&
    keys.every((key) => ACCEPTANCE_KEYS.has(key)) &&
    ("dataTypeId" in record || "shape" in record)
  ) {
    return { accepts: [record] };
  }
  return value;
}

export const EnvelopeDataSlotSchema = z.preprocess(
  normalizeDataSlot,
  z.strictObject({ accepts: z.array(EnvelopeAcceptanceSchema).min(1) }),
);

export const EnvelopeSpecSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1).optional(),
  description: z.string().min(1),
  props: z.record(z.string().min(1), EnvelopePropSchema).optional(),
  dataSlots: z.record(z.string().min(1), EnvelopeDataSlotSchema),
  accessibility: z
    .strictObject({ label: z.string().min(1), description: z.string().min(1).optional() })
    .optional(),
});

export const GenerateEnvelopeSchema = z.strictObject({
  /** The complete view file: `export const spec = defineView({...})` + default component. */
  componentFile: z.string().min(1),
  /** The same contract as data, so the server twin can be derived without re-parsing code. */
  spec: EnvelopeSpecSchema,
  notes: z.array(z.string()),
});

export type GenerateEnvelope = z.infer<typeof GenerateEnvelopeSchema>;
export type GenerateSpec = z.infer<typeof EnvelopeSpecSchema>;

/**
 * The provider-facing JSON Schema for the same envelope. Non-recursive by
 * design.
 *
 * Sent with `strict: false` (advisory), and that is a decision, not an
 * oversight: OpenAI's strict structured-output mode requires
 * `additionalProperties: false` on every object and every property listed in
 * `required`, which makes map-typed objects — `props` and `dataSlots` below,
 * whose keys are model-chosen names carried via `additionalProperties:
 * {schema}` — inexpressible. Flipping `strict: true` gets the request
 * rejected with a 400 before any tokens are generated. The compensations are
 * (a) the concrete envelope example in the user prompt, (b) the
 * near-miss-coercing zod schema above, and (c) repair rounds that re-show the
 * full original prompt.
 */
export const GENERATE_ENVELOPE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["componentFile", "spec", "notes"],
  properties: {
    componentFile: { type: "string" },
    spec: {
      type: "object",
      additionalProperties: false,
      required: ["id", "description", "dataSlots"],
      properties: {
        id: { type: "string" },
        version: { type: "string" },
        description: { type: "string" },
        props: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            required: ["type"],
            properties: {
              type: {
                type: "string",
                enum: ["string", "number", "boolean", "enum", "stringArray"],
              },
              values: { type: "array", items: { type: "string" } },
              default: {},
              required: { type: "boolean" },
            },
          },
        },
        dataSlots: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            required: ["accepts"],
            properties: {
              accepts: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    dataTypeId: { type: "string" },
                    shapes: { type: "array", items: { type: "string" } },
                    shape: { type: "string" },
                    requires: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["semanticType"],
                        properties: { semanticType: { type: "string" } },
                      },
                    },
                    minFields: { type: "integer" },
                  },
                },
              },
            },
          },
        },
        accessibility: {
          type: "object",
          additionalProperties: false,
          required: ["label"],
          properties: {
            label: { type: "string" },
            description: { type: "string" },
          },
        },
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
} as const;

/**
 * The compilation table this whole product exists to apply: what each of the
 * 14 semantic types means for rendering, stated as treatment + anti-treatment.
 * Every entry traces to a catalogued failure of the generic components (the
 * "p_9" title, the "Name: Spinach · Quantity: 120 · Unit: g" dump, the raw
 * ISO date, the id-labeled axis).
 */
export const SEMANTIC_TREATMENTS: Readonly<Record<SemanticType, string>> = {
  identifier:
    "An opaque key. Use it ONLY as a React key or inside an activation href. Never render it as a title, card heading, tile label, or chart axis — an identifier shown to a person is a bug, not information.",
  text: "Human-readable text. The usual candidate for a row's title or primary line.",
  "rich-text":
    "HTML-bearing text. Sanitize or render as plain text, and clamp its length; never inject it unsanitized.",
  "image-url":
    "Render as an <img> with a meaningful alt from a text field, object-fit cover, fixed aspect box. Never print the URL string.",
  url: "Render as a short anchor labeled by the host (e.g. the link's purpose or hostname), only via host-approved activation patterns. Never print the raw URL as text.",
  money:
    "Format with Intl.NumberFormat using style 'currency' and the field's declared currency. Never concatenate a symbol by hand, never render the bare number.",
  quantity:
    'Compose the number with the field\'s declared unit as one visual token (e.g. "120 g"), not two separate key/value lines.',
  percentage:
    'A ratio in [0,1] unless the description says otherwise. Render as "62%", and add a progress affordance when it means match/completion.',
  date: 'Format for the locale (toLocaleDateString), never raw ISO. When the field\'s description implies expiry or recency, add relative urgency ("expires in 2 days", "expired").',
  "date-time":
    "Format for the locale, keep it brief (no seconds/timezone noise unless the description demands precision).",
  status:
    "Render as a badge with visible text — never color alone. A status field is the natural grouping or sectioning key when it partitions the rows meaningfully.",
  boolean:
    "Render as an indicator or use it to split rows into sections. Never render a checkbox — this UI is read-only.",
  location:
    "Human-readable place text. Render as-is with a location affordance if the house style has one.",
  unknown: "No semantic information. Render defensively as text with a dash fallback.",
};

const AUTHORING_RULES = `AUTHORING RULES (from docs/AUTHORING_VIEWS.md — violations fail mechanical verification):
- One file, two exports: \`export const spec = defineView({...})\` and the component as the DEFAULT export. Import { defineView, field } from "@renderyes/react".
- Take data through props; NEVER fetch. No fetch/XMLHttpRequest/WebSocket.
- No context, environment, or globals: no window, document, localStorage, sessionStorage, import.meta, process.env, require().
- Handle \`state\`: "error" renders the errorMessage (role="alert"), "empty" renders a purposeful empty message, "pending"/undefined must not crash.
- Handle \`sources\`: when it is an empty array, say the data is not attributed to a source; do not present it as authoritative.
- Handle \`completeness\`: when complete === false, disclose "showing the first {rowCount} of {totalRows}".
- Defensive field access everywhere: hosts approve field SUBSETS, so any field may be missing from any row. Missing optional values render as a dash, never throw.
- UI state (sort, expansion) is fine; held data is not.`;

const FIDELITY_RULES = `STYLE FIDELITY RULES:
- Use ONLY the host's own tokens, classes, and idiom as shown in the style corpus. Zero hex colors, zero invented spacing values, when the corpus demonstrates tokens.
- Inline style attributes only for genuinely data-driven values (a width from a percentage, an image url) — and even then compose them from host tokens where possible.
- Extend minimally and in the host's idiom: if the corpus is plain CSS classes, use those classes; if it is Tailwind utilities, use utilities the corpus already demonstrates; if it is shadcn, compose the shown ui primitives.`;

const READ_ONLY_RULES = `READ-ONLY RULES:
- This component renders an answer; it is not an app. Indicators, not controls: no <button>, <input>, <select>, <textarea>, <form>.
- Navigation only via host activation patterns (record hrefs the host supplies); never invent links.`;

export function buildSystemPrompt(): string {
  const treatments = Object.entries(SEMANTIC_TREATMENTS)
    .map(([type, treatment]) => `- ${type}: ${treatment}`)
    .join("\n");
  return `You are generating ONE bespoke React view component for a host website that uses RenderYes. The component is dev-time output: a human reviews and registers it; it never runs code at visitor time beyond rendering.

You will be given the approved data contract for one capability (its data type's field descriptors with semantic types, units, currencies, and descriptions), sample rows synthesized from those descriptors, and a corpus of the host's own styling. Compile the field descriptors into rendering decisions — the descriptors are ground truth, not hints.

SEMANTIC TYPE -> TREATMENT (apply per field, using each field's declared unit/currency):
${treatments}

${AUTHORING_RULES}

${FIDELITY_RULES}

${READ_ONLY_RULES}

QUALITY BAR:
- The heading restates what the data is, in words a person would use — never an identifier, never the capability id.
- Every approved field is rendered type-appropriately, or deliberately omitted with a code comment saying why.
- No "Key: value · Key: value" dumps beyond two fields; design a layout.
- Group rows by a status/boolean field when it partitions them meaningfully.
- Accessibility floor: alt text, roles where semantics need them, text alongside any color signal.
- Responsive: grids via auto-fill/minmax, wide content inside overflow containers.

OUTPUT: one JSON object only, matching the provided schema:
- "componentFile": the COMPLETE view file source. It must export \`spec\` via defineView(...) and the component as the default export. No markdown fences.
- "spec": the same contract as structured data. It MUST be exactly what the file's defineView declares — same id, version, description, props (as {type, values?, default?, required?}), dataSlots, accessibility. The server-side registration twin is derived from this, so any drift fails verification.
- "notes": short notes for the human reviewer (deliberate omissions, layout choices).`;
}

function formatFields(slice: CapabilitySlice): string {
  return Object.entries(slice.dataType.fields)
    .map(([path, descriptor]) => {
      const parts = [
        `label "${descriptor.label}"`,
        `semanticType ${descriptor.semanticType}`,
      ];
      if (descriptor.unit) parts.push(`unit "${descriptor.unit}"`);
      if (descriptor.currency) parts.push(`currency "${descriptor.currency}"`);
      if (descriptor.description) parts.push(`description "${descriptor.description}"`);
      return `- ${path}: ${parts.join(", ")}`;
    })
    .join("\n");
}

export interface BuildUserPromptOptions {
  slice: CapabilitySlice;
  corpus: StyleCorpus;
  convention: HostConvention;
  sampleRows: Record<string, unknown>[];
  /** The id the component should use, already checked against existing ids. */
  componentId: string;
  fileExtension: ".tsx" | ".jsx";
}

export function buildUserPrompt(options: BuildUserPromptOptions): string {
  const { slice, corpus } = options;
  const relationships =
    slice.relationships.length > 0
      ? slice.relationships
          .map(
            (relationship) =>
              `- ${relationship.id}: ${relationship.from.dataTypeId}.${relationship.from.field} -> ${relationship.to.dataTypeId}.${relationship.to.field} (${relationship.cardinality}) — ${relationship.description}`,
          )
          .join("\n")
      : "(none)";
  const corpusText =
    corpus.pieces.length > 0
      ? corpus.pieces
          .map((piece) => `--- ${piece.kind}: ${piece.path} ---\n${piece.content}`)
          .join("\n\n")
      : "(no style corpus found — use semantic HTML with minimal, token-free styling)";

  return `CAPABILITY
- id: ${slice.capability.id}
- purpose: ${slice.capability.purpose}
- output: dataTypeId "${slice.dataType.id}", shape "${slice.capability.output.shape}"

DATA TYPE ${slice.dataType.id} — ${slice.dataType.description}
Approved fields (dotted paths arrive restored to nested objects):
${formatFields(slice)}
Fields the executor always includes: ${
    slice.requiredOutputFields.length > 0
      ? slice.requiredOutputFields.join(", ")
      : "(none declared)"
  }

RELATIONSHIPS TOUCHING THIS TYPE
${relationships}

SAMPLE ROWS (synthesized from the descriptors; the real rows have this shape)
${JSON.stringify(options.sampleRows, null, 2)}

HOST STYLE CORPUS (system: ${corpus.system})
${corpusText}

COMPONENT TO WRITE
- id: "${options.componentId}" (already-registered ids you must NOT use: ${
    slice.existingComponentIds.length > 0
      ? slice.existingComponentIds.join(", ")
      : "(none)"
  })
- file type: ${options.fileExtension === ".tsx" ? "TypeScript JSX (.tsx)" : "plain JSX (.jsx) — no TypeScript syntax"}
- one data slot accepting {dataTypeId: "${slice.dataType.id}", shapes: ["${slice.capability.output.shape}"]}
- registration convention: ${options.convention}

ENVELOPE EXAMPLE (structure only — your ids, props, and content will differ):
${JSON.stringify(
    {
      componentFile:
        'import { defineView, field } from "@renderyes/react";\n… the complete view file …',
      spec: {
        id: options.componentId,
        version: "1.0.0",
        description: "One reviewer-facing sentence saying what this view shows.",
        props: { heading: { type: "string", default: "…" } },
        dataSlots: {
          items: {
            accepts: [
              {
                dataTypeId: slice.dataType.id,
                shapes: [slice.capability.output.shape],
              },
            ],
          },
        },
        accessibility: { label: "…" },
      },
      notes: ["…"],
    },
    null,
    2,
  )}
Common envelope mistakes — all of these fail validation:
- Every dataSlots entry MUST nest its acceptance under "accepts": [ … ]. Never put dataTypeId/shapes directly on the slot object, and never use a bare string ("${slice.dataType.id}") or a {type: …} object as an accepts entry.
- "props" declares only the component's OWN configurable props (each as {type, values?, default?, required?} with type one of string|number|boolean|enum|stringArray). The data slot, state, errorMessage, sources, asOf, completeness are runtime inputs — never declare them as props.

Return the JSON envelope now.`;
}

/**
 * The follow-up prompt for a repair round: the FULL original prompt (data
 * contract, style corpus, envelope example — a repair round that hides the
 * contract is why the first live run thrashed on the accepts shape), then the
 * exact failures, nothing softened, then the most recent envelope only.
 * Because every repair prompt is rebuilt from the original, envelopes never
 * accumulate across rounds — the prompt carries at most one componentFile of
 * history.
 */
export function buildRepairPrompt(options: {
  originalUserPrompt: string;
  previousEnvelopeJson: string;
  failures: readonly string[];
}): string {
  return `${options.originalUserPrompt}

=== REPAIR ROUND ===
Your previous draft failed mechanical verification. Everything above — the data contract, style corpus, envelope example, and rules — still applies unchanged. Fix every failure below and return the corrected JSON envelope (same schema, complete componentFile — not a diff).

FAILURES (exact messages from the checks):
${options.failures.map((failure) => `- ${failure}`).join("\n")}

YOUR PREVIOUS ENVELOPE (the most recent attempt; earlier ones are superseded):
${options.previousEnvelopeJson}`;
}
