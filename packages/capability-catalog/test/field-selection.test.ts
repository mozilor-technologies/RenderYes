import { describe, expect, it } from "vitest";
import {
  proposeApprovedFields,
  proposedPaths,
  type FieldSelectionModelProvider,
  type ProposableField,
} from "../src/field-selection.js";
import { createGraphQlCatalogInventory } from "../src/graphql.js";

/**
 * The proposer exists because reviewing a real API is arithmetic: Saleor's
 * `Order` has around sixty fields and its schema ninety root queries, and a
 * host reads every one. It is model-tier only — a name-pattern list is a guess
 * about one API's conventions dressed as a rule — and it may only ever mark
 * rows, never remove them.
 */

const FIELDS: ProposableField[] = [
  { path: "id", label: "Id", type: "ID!", semanticType: "identifier" },
  { path: "number", label: "Number", type: "String!", semanticType: "text" },
  { path: "total.gross.amount", label: "Amount", type: "Float!", semanticType: "money" },
  { path: "searchVector", label: "Search Vector", type: "String", semanticType: "text" },
  { path: "privateMetadata", label: "Private Metadata", type: "String", semanticType: "text" },
];

const CAPABILITY = {
  capabilityId: "graphql.orders",
  purpose: "List a customer's recent orders.",
  resultShape: "collection",
  dataTypeDescription: "One order.",
};

/** A provider that answers with whatever it is told to, and records the call. */
function stubProvider(value: unknown) {
  const calls: { systemPrompt: string; userPrompt: string; jsonSchema: unknown }[] = [];
  const provider: FieldSelectionModelProvider = {
    generateClassification: async (request) => {
      calls.push(request);
      return { value };
    },
  };
  return { provider, calls };
}

describe("proposing which fields a view would use", () => {
  it("returns one proposal per field the model answered for", async () => {
    const { provider, calls } = stubProvider({
      proposals: [
        { path: "id", propose: true, confidence: 0.95, reason: "Identifies the order." },
        {
          path: "searchVector",
          propose: false,
          confidence: 0.9,
          reason: "Index plumbing, not a value a reader asks about.",
        },
      ],
    });

    const proposals = await proposeApprovedFields({
      capability: CAPABILITY,
      fields: FIELDS,
      provider,
    });
    expect(proposals).toHaveLength(2);
    expect(proposedPaths(proposals)).toEqual(["id"]);

    // The capability's purpose is in the prompt: "useful" means nothing without
    // knowing what the view is for.
    expect(calls[0]?.userPrompt).toContain("List a customer's recent orders.");
  });

  /**
   * The invariant this design exists for. The proposer marks; it does not
   * subtract. A model that answers for two of five fields must leave the host
   * looking at five, because the alternative is a model quietly narrowing what
   * a human reviews for visitor access — which would make the review theatre.
   */
  it("proposalsNeverRemoveARow: the reviewable field list is untouched", async () => {
    const { provider } = stubProvider({
      proposals: [
        { path: "id", propose: true, confidence: 1, reason: "Identity." },
        { path: "number", propose: false, confidence: 1, reason: "Redundant." },
      ],
    });

    const proposals = await proposeApprovedFields({
      capability: CAPABILITY,
      fields: FIELDS,
      provider,
    });

    // Nothing this function returns can stand in for the field list: the
    // proposals are keyed by path and cover a subset, and there is no exported
    // function that takes fields and gives back fewer.
    expect(proposals.length).toBeLessThan(FIELDS.length);
    const unanswered = FIELDS.filter(
      (field) => !proposals.some((proposal) => proposal.path === field.path),
    ).map((field) => field.path);
    expect(unanswered).toEqual([
      "total.gross.amount",
      "searchVector",
      "privateMetadata",
    ]);
    // And an unanswered field is not a rejection — `proposedPaths` reports only
    // what was proposed, so the caller cannot read absence as a decision.
    expect(proposedPaths(proposals)).toEqual(["id"]);
  });

  it("drops a proposal for a path that was never offered", async () => {
    // A model naming a field the schema does not declare must not reach a
    // reviewer's screen as though it did. The JSON schema constrains this too;
    // this is the second line.
    const { provider } = stubProvider({
      proposals: [
        { path: "id", propose: true, confidence: 1, reason: "Identity." },
        { path: "ssn", propose: true, confidence: 1, reason: "Invented." },
      ],
    });
    const proposals = await proposeApprovedFields({
      capability: CAPABILITY,
      fields: FIELDS,
      provider,
    });
    expect(proposals.map((proposal) => proposal.path)).toEqual(["id"]);
  });

  it("keeps the first answer when the model repeats a path", async () => {
    const { provider } = stubProvider({
      proposals: [
        { path: "id", propose: true, confidence: 0.9, reason: "First." },
        { path: "id", propose: false, confidence: 0.9, reason: "Second." },
      ],
    });
    const proposals = await proposeApprovedFields({
      capability: CAPABILITY,
      fields: FIELDS,
      provider,
    });
    expect(proposals).toEqual([
      { path: "id", propose: true, confidence: 0.9, reason: "First." },
    ]);
  });

  it("constrains the model to the paths on offer", async () => {
    const { provider, calls } = stubProvider({ proposals: [] });
    await proposeApprovedFields({ capability: CAPABILITY, fields: FIELDS, provider });
    const schema = calls[0]?.jsonSchema as {
      properties: { proposals: { items: { properties: { path: { enum: string[] } } } } };
    };
    expect(schema.properties.proposals.items.properties.path.enum).toEqual(
      FIELDS.map((field) => field.path),
    );
  });

  it("calls no model at all when there is nothing to propose about", async () => {
    const { provider, calls } = stubProvider({ proposals: [] });
    expect(
      await proposeApprovedFields({ capability: CAPABILITY, fields: [], provider }),
    ).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("a confidence floor filters proposals, never the fields", async () => {
    const { provider } = stubProvider({
      proposals: [
        { path: "id", propose: true, confidence: 0.95, reason: "Sure." },
        { path: "number", propose: true, confidence: 0.3, reason: "Unsure." },
      ],
    });
    const proposals = await proposeApprovedFields({
      capability: CAPABILITY,
      fields: FIELDS,
      provider,
    });
    expect(proposedPaths(proposals, { minimumConfidence: 0.8 })).toEqual(["id"]);
    // The low-confidence proposal is still reported, so a reviewer can see the
    // model was unsure rather than that it said nothing.
    expect(proposals).toHaveLength(2);
  });
});

describe("the review draft a proposer runs against", () => {
  it("offers every field regardless of what any model would say", () => {
    // End to end, at the level that matters: the artifact a host reviews is
    // produced by discovery alone. Nothing in this package lets a proposal
    // reach it.
    const draft = createGraphQlCatalogInventory({
      schema: `
        type Query { orders: [Order!] }
        type Order { id: ID!  number: String!  searchVector: String }
      `,
      catalog: { id: "shop", version: "1.0.0", description: "Approved reads." },
      source: { id: "shop-api", label: "Shop", description: "The graph." },
      queries: [
        {
          fieldName: "orders",
          capabilityId: "graphql.orders",
          purpose: "List orders.",
          dataTypeId: "order",
          dataTypeDescription: "One order.",
          resultShape: "collection",
          matchKey: "id",
        },
      ],
    });
    expect(
      draft.queries[0]?.availableOutputFields.map((field) => field.path),
    ).toEqual(["id", "number", "searchVector"]);
  });
});
