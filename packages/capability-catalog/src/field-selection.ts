import { z } from "zod";

/**
 * A starting point for "which of these fields should a visitor see?", proposed
 * by a model and decided by a host.
 *
 * The problem is arithmetic. A commerce API's `Order` type offers around sixty
 * fields and its schema ninety root queries; a reviewer approving a catalog reads
 * every one of them, and the ones that matter for "recent orders" are a handful.
 * That is the cost that makes onboarding a real API a day rather than an hour.
 *
 * Two rules shape everything here, and both were arrived at by rejecting the
 * alternative:
 *
 *  1. **Model tier only.** No name patterns, no `/_id$/`, no "fields called
 *     `internalNotes` are probably internal". A pattern list is a guess about
 *     one schema's naming conventions dressed as a rule, and it is wrong in a
 *     way nobody can see: it looks like it works on the API it was written
 *     against. With no provider configured this proposes nothing at all, and
 *     the review stays fully manual — which is the honest degradation.
 *
 *  2. **Propose, never filter.** This returns proposals keyed by path. It does
 *     not return a field list, cannot return a field list, and nothing it
 *     produces is subtractive. A field the model ignored is still on the
 *     reviewer's screen with its checkbox unticked, because a model quietly
 *     removing a row from a security review is the failure mode that would make
 *     the whole review theatre. `proposalsNeverRemoveARow` in the test suite
 *     holds this.
 */

/** One field offered for review, as the proposer sees it. */
export interface ProposableField {
  /** Row-relative path, e.g. `total.gross.amount`. */
  path: string;
  label: string;
  /** The upstream type as written, e.g. `Float!`. */
  type: string;
  /** What the catalog inferred the value means, `unknown` when it could not. */
  semanticType: string;
  description?: string;
  deprecated?: boolean;
}

/** What the model proposes for one field. Advisory in every case. */
export interface FieldSelectionProposal {
  path: string;
  /** True when a visitor-facing view of this capability would use the field. */
  propose: boolean;
  /** The model's honest probability it is right, 0 to 1. */
  confidence: number;
  /** One sentence a reviewer can check at a glance. */
  reason: string;
}

/** Same generic structured-output contract the other classifiers use. */
export interface FieldSelectionModelProvider {
  generateClassification(request: {
    systemPrompt: string;
    userPrompt: string;
    jsonSchema: Record<string, unknown>;
  }): Promise<{ value: unknown }>;
}

const SELECTION_SYSTEM_PROMPT = `You are helping a site owner review which fields of their own API a visitor-facing view should be allowed to read.

You receive one capability — what it returns and what it is for — and every field the schema offers on it. For each field, say whether a view answering that purpose would use it.

Propose a field when:
- it identifies the record, or a person would recognise the record by it
- the capability's stated purpose implies someone wants to see it
- it carries a quantity, status, date or label a reader would ask about

Do not propose a field when:
- it is internal plumbing: cursors, revision counters, foreign keys to things not in this catalog
- it exists for the API's own bookkeeping rather than for a reader
- you cannot state in one sentence what a reader would do with it
- it is deprecated and something else supersedes it

Rules:
- Answer for every field you are given, including the ones you would not propose. A field you skip is not a rejection, and the reviewer sees it either way.
- confidence is your honest probability, 0 to 1. Lower it rather than guessing; an unsure proposal a reviewer checks is more use than a confident wrong one.
- reason is one short sentence, about this field and this capability.
- You are proposing a starting point. A human reviews every field regardless, and only they approve anything.`;

const ProposableFieldSchema = z.strictObject({
  path: z.string().min(1),
  label: z.string().min(1),
  type: z.string().min(1),
  semanticType: z.string().min(1),
  description: z.string().min(1).optional(),
  deprecated: z.boolean().optional(),
});

const FieldSelectionProposalSchema = z.strictObject({
  path: z.string().min(1),
  propose: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

function selectionJsonSchema(paths: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["proposals"],
    properties: {
      proposals: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "propose", "confidence", "reason"],
          properties: {
            // Constrained to the paths actually offered, so the model cannot
            // name a field that does not exist and have it reach a reviewer's
            // screen as though the schema declared it.
            path: { enum: [...paths] },
            propose: { type: "boolean" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string", minLength: 1 },
          },
        },
      },
    },
  };
}

/** The capability the fields belong to — the context that makes "useful" mean anything. */
export interface ProposalCapabilityContext {
  capabilityId: string;
  /** The host's planner-facing statement of what this capability is for. */
  purpose: string;
  /** `collection`, `entity`, `time-series`, and so on. */
  resultShape: string;
  /** What one row is, e.g. "One order." */
  dataTypeDescription?: string;
}

/**
 * Asks the provider which fields a view of this capability would use.
 *
 * Returns at most one proposal per path, for paths that were actually offered;
 * anything else the model returns is dropped rather than trusted. A path with
 * no proposal is not a rejection — it is a field the model did not answer for,
 * and the caller must keep showing it either way.
 */
export async function proposeApprovedFields(options: {
  capability: ProposalCapabilityContext;
  fields: readonly ProposableField[];
  provider: FieldSelectionModelProvider;
}): Promise<FieldSelectionProposal[]> {
  const fields = options.fields.map((field) => ProposableFieldSchema.parse(field));
  if (fields.length === 0) return [];

  const paths = fields.map((field) => field.path);
  const completion = await options.provider.generateClassification({
    systemPrompt: SELECTION_SYSTEM_PROMPT,
    userPrompt: JSON.stringify({ capability: options.capability, fields }),
    jsonSchema: selectionJsonSchema(paths),
  });
  const envelope = z
    .strictObject({ proposals: z.array(FieldSelectionProposalSchema) })
    .parse(completion.value);

  const offered = new Set(paths);
  const byPath = new Map<string, FieldSelectionProposal>();
  for (const proposal of envelope.proposals) {
    if (!offered.has(proposal.path) || byPath.has(proposal.path)) continue;
    byPath.set(proposal.path, proposal);
  }
  return [...byPath.values()];
}

/**
 * The proposed paths, for a caller that wants to pre-tick checkboxes.
 *
 * Deliberately a separate, obviously-named function rather than an option on
 * the one above: a caller has to ask for the subset, and the thing they are
 * holding while they ask is the full proposal list. `applyProposals` — a
 * function that took fields and gave back fewer — is the shape this design
 * exists to avoid, and having no such function is how that is enforced.
 */
export function proposedPaths(
  proposals: readonly FieldSelectionProposal[],
  options: { minimumConfidence?: number } = {},
): string[] {
  const floor = options.minimumConfidence ?? 0;
  return proposals
    .filter((proposal) => proposal.propose && proposal.confidence >= floor)
    .map((proposal) => proposal.path);
}
