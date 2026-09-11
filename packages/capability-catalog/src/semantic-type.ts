import type { FieldDescriptor } from "./schema.js";

/**
 * One semantic-type classifier shared by every onboarding adapter.
 *
 * This previously existed as two independent copies — one in `graphql.ts`, one
 * in `openapi.ts` — which drifted apart and were fixed separately. Field
 * semantics decide which filter operators the query engine allows and how a
 * host component renders a value, so two adapters disagreeing about the same
 * field is a correctness bug, not a cosmetic one.
 *
 * Two rules make this reliable where name-only guessing was not:
 *
 * 1. **The declared type is ground truth.** A Boolean is never money, a
 *    quantity, or an identifier no matter what its name contains.
 * 2. **Abstain when ambiguous.** Returning "unknown" surfaces a mandatory
 *    "confirm this field" prompt to the host; returning a confidently wrong
 *    type sails silently into the catalog and renders as the wrong thing. A
 *    wrong guess is strictly worse than no guess, so genuinely ambiguous
 *    names abstain instead of picking.
 */

/** Normalized value kind, so GraphQL types and JSON Schema types classify identically. */
export type SemanticValueKind =
  "string" | "integer" | "number" | "boolean" | "enum" | "object" | "array" | "unknown";

export interface SemanticTypeSignal {
  name: string;
  kind: SemanticValueKind;
  /** JSON Schema `format` (e.g. "date-time", "uri"). */
  format?: string;
  /** Declared type name, e.g. a GraphQL custom scalar such as "DateTime" or "Decimal". */
  typeName?: string;
  /**
   * Host-authored prose. Hosts routinely describe a field far more clearly
   * than they name it ("Total number of reports found" for `total_reports`),
   * so a narrow, high-precision read of the description resolves cases the
   * name alone cannot.
   */
  description?: string;
  title?: string;
}

// Unambiguous money nouns. "total"/"sum" are deliberately excluded — they are
// magnitude modifiers, not money words ("total_reports" is a count).
const MONEY_NOUNS =
  /^(price|amount|cost|revenue|fee|fees|balance|subtotal|charge|salary|payment)$/;
/** Needs a partner noun to mean anything; alone it abstains. */
const MAGNITUDE_MODIFIERS = /^(total|sum|aggregate)$/;
const QUANTITY_NOUNS = /^(count|quantity|qty|stock|units|inventory)$/;
const PERCENT_NOUNS = /^(percent|percentage|ratio)$/;
const IMAGE_NOUNS = /^(image|photo|picture|thumbnail|avatar|poster|logo|icon)$/;
const LINK_NOUNS = /^(url|uri|link|href|website|homepage)$/;
const STATUS_NOUNS = /^(status|state|stage|phase)$/;

const NUMERIC_KINDS = new Set<SemanticValueKind>(["integer", "number"]);

/**
 * Splits camelCase/PascalCase/snake_case into lowercase words so vocabulary
 * matching is whole-word. Raw substring tests misclassify real field names:
 * "isPaid" ends in the letters "id" without being an identifier;
 * "displayGrossPrices" contains "price" without being money.
 */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function hasWord(words: readonly string[], vocabulary: RegExp): boolean {
  return words.some((word) => vocabulary.test(word));
}

/**
 * High-precision only: "number of" / "count of" is an unambiguous statement
 * that a field counts things. Deliberately narrow — this is not an attempt to
 * parse prose, just to catch the one phrasing hosts use constantly.
 */
function describesACount(description: string | undefined): boolean {
  if (!description) return false;
  return /\b(number|count)\s+of\b/i.test(description);
}

export function inferSemanticType(
  signal: SemanticTypeSignal,
): FieldDescriptor["semanticType"] {
  const words = nameWords(signal.name);
  const format = (signal.format ?? "").toLowerCase();
  const typeName = (signal.typeName ?? "").toLowerCase();
  const prose = `${signal.description ?? ""} ${signal.title ?? ""}`.trim();
  const isNumeric =
    NUMERIC_KINDS.has(signal.kind) || /decimal|float|int|long|number/.test(typeName);

  // 1. Declared type wins over every name-based guess below.
  if (signal.kind === "boolean" || typeName === "boolean") return "boolean";

  // 2/3. Temporal, from format or scalar name — both unambiguous.
  if (format === "date-time" || /datetime|timestamp|instant/.test(typeName)) {
    return "date-time";
  }
  if (format === "date" || typeName === "date") return "date";

  // 4. Identifier: the trailing word is exactly "id", or the type says so.
  if (typeName === "id" || typeName === "uuid" || words.at(-1) === "id") {
    return "identifier";
  }

  // 5. A closed value set is a status by construction.
  if (signal.kind === "enum") return "status";

  // 6/7. Links, with images distinguished by name.
  if (hasWord(words, IMAGE_NOUNS)) return "image-url";
  if (
    format === "uri" ||
    format === "url" ||
    /url|uri/.test(typeName) ||
    hasWord(words, LINK_NOUNS)
  ) {
    return "url";
  }

  // 8. Counts before money, so a specific quantity word beats a generic
  //    magnitude modifier ("totalCount" is a count, not a currency).
  if (hasWord(words, QUANTITY_NOUNS) || describesACount(prose)) return "quantity";

  // 9. Money requires an unambiguous money noun, or a money-ish scalar.
  if (hasWord(words, MONEY_NOUNS) || /money|currency/.test(typeName)) return "money";

  // 10. Proportions.
  if (hasWord(words, PERCENT_NOUNS)) return "percentage";

  // 11. ABSTAIN. A bare magnitude modifier with no partner noun is genuinely
  //     ambiguous — "total" could be a price or a row count. Returning
  //     "unknown" asks the host instead of guessing wrong silently.
  if (hasWord(words, MAGNITUDE_MODIFIERS) && isNumeric) return "unknown";

  // 12. Status by name, only once the type hasn't already claimed the field.
  if (hasWord(words, STATUS_NOUNS)) return "status";

  // 13. Plain text.
  if (signal.kind === "string" || typeName === "string") return "text";

  return "unknown";
}
