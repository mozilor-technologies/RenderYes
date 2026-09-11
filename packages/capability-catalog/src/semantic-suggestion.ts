import { z } from "zod";
import type { FieldDescriptor } from "./schema.js";

/**
 * AI-assisted semantic-type suggestions for the curated-review queue.
 *
 * The trust rule mirrors operation-effect classification: a suggestion is
 * never an approval. The model proposes a semantic type with a confidence
 * and a reason; only a host clicking the queue's dropdown turns that into a
 * catalog decision. Nothing here writes to a catalog.
 */

export interface SemanticSuggestionField {
  /** The queue row's override key, e.g. "Query.recipes.match.score". */
  key: string;
  label: string;
  /** GraphQL type, e.g. "Float!". */
  type: string;
  description?: string;
  /** Root query the field belongs to — context the model may use. */
  fieldName: string;
}

const DECIDABLE_SEMANTIC_TYPES = [
  "identifier",
  "text",
  "rich-text",
  "image-url",
  "url",
  "money",
  "quantity",
  "percentage",
  "date",
  "date-time",
  "status",
  "boolean",
  "location",
] as const;

export type DecidableSemanticType = (typeof DECIDABLE_SEMANTIC_TYPES)[number];

export interface SemanticTypeSuggestion {
  key: string;
  semanticType: DecidableSemanticType;
  confidence: number;
  reason: string;
}

/** Same generic structured-output contract the effect classifier uses. */
export interface SemanticSuggestionModelProvider {
  generateClassification(request: {
    systemPrompt: string;
    userPrompt: string;
    jsonSchema: Record<string, unknown>;
  }): Promise<{ value: unknown }>;
}

const SUGGESTION_SYSTEM_PROMPT = `You classify the meaning of data fields so a UI can format them correctly.

For each field you receive its name/path, GraphQL type, root query, and any schema description. Choose the single best semantic type:

- identifier: opaque ids and keys
- text: plain prose or names
- rich-text: formatted/markup text
- image-url / url: links (image-url only when it points at an image)
- money: monetary amounts
- quantity: counts, sizes, durations, and other plain magnitudes
- percentage: proportions and ratios, whether expressed 0-1 or 0-100
- date / date-time: calendar values (date-time when it carries a time of day)
- status: closed sets of states or categories
- boolean: yes/no flags
- location: geographic places or coordinates

Rules:
- Use the description first; it is the author's own statement of meaning.
- confidence is your honest probability the suggestion is right, 0 to 1. If a field is genuinely ambiguous, keep the suggestion but lower the confidence — do not guess high.
- reason must be one short sentence a reviewer can verify at a glance.
- These are suggestions for a human reviewer, never final decisions.`;

function suggestionJsonSchema(keys: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["suggestions"],
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "semanticType", "confidence", "reason"],
          properties: {
            key: { enum: [...keys] },
            semanticType: { enum: [...DECIDABLE_SEMANTIC_TYPES] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string", minLength: 1 },
          },
        },
      },
    },
  };
}

const SemanticSuggestionFieldSchema = z.strictObject({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.string().min(1),
  description: z.string().min(1).optional(),
  fieldName: z.string().min(1),
});

const SemanticTypeSuggestionSchema = z.strictObject({
  key: z.string().min(1),
  semanticType: z.enum(DECIDABLE_SEMANTIC_TYPES),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

/**
 * Asks the provider for one suggestion per field. Suggestions for keys that
 * were not requested are dropped rather than trusted; at most one suggestion
 * per key survives (the first). The caller decides what to do below any
 * confidence threshold — this function reports, it does not filter.
 */
export async function suggestFieldSemanticTypes(options: {
  fields: readonly SemanticSuggestionField[];
  provider: SemanticSuggestionModelProvider;
}): Promise<SemanticTypeSuggestion[]> {
  const fields = options.fields.map((field) => SemanticSuggestionFieldSchema.parse(field));
  if (fields.length === 0) return [];
  const keys = fields.map((field) => field.key);
  const completion = await options.provider.generateClassification({
    systemPrompt: SUGGESTION_SYSTEM_PROMPT,
    userPrompt: JSON.stringify({ fields }),
    jsonSchema: suggestionJsonSchema(keys),
  });
  const envelope = z
    .strictObject({ suggestions: z.array(SemanticTypeSuggestionSchema) })
    .parse(completion.value);
  const requested = new Set(keys);
  const byKey = new Map<string, SemanticTypeSuggestion>();
  for (const suggestion of envelope.suggestions) {
    if (!requested.has(suggestion.key) || byKey.has(suggestion.key)) continue;
    byKey.set(suggestion.key, suggestion);
  }
  return [...byKey.values()];
}

// Compile-time guarantee that every decidable type really is a legal
// FieldDescriptor semantic type (minus "unknown", which is not a decision).
type _DecidableIsLegal = DecidableSemanticType extends Exclude<
  FieldDescriptor["semanticType"],
  "unknown"
>
  ? true
  : never;
const _decidableIsLegal: _DecidableIsLegal = true;
void _decidableIsLegal;
