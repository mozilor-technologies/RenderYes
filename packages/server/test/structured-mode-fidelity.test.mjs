import assert from "node:assert/strict";
import test from "node:test";
import { structuredOutputSchema } from "../dist/index.js";
import { createDataPlanningContract } from "@renderyes/capability-catalog";

/**
 * Nothing the plan contract states may be lost on the way to the model.
 *
 * `structuredOutputSchema` rewrites the contract into the dialect structured
 * decoding accepts, and bounds depth by replacing deep subtrees with `{}`. That
 * trim is silent by construction — `{}` is a valid schema meaning "anything" —
 * so a constraint dropped this way produces no error anywhere. It produces a
 * model that guesses.
 *
 * The budget was 8 and the contract is 18 deep at its operator enum, so six
 * constraints never arrived: the filter-operator vocabulary, the null-check
 * operators, each capability's filterable-field list (the host's own
 * `supports.filterFields`), and the `required` keys of a filter condition. The
 * model wrote `"equals"` and `"="` — reasonable guesses at a list it was never
 * shown — and the local validator, which had the list, rejected all of them.
 * Measured on one production install: it caused every constrained-question failure in their
 * eval, and three repair attempts per compose.
 *
 * Which is why this test compares *by content, not by position*: the simplifier
 * renames `oneOf` to `anyOf` and reorders branches, and a structural diff
 * silently matched nothing and reported a clean bill of health. Collecting the
 * constraints each side states and diffing the sets is the version that fails
 * when it should.
 */

/** Constraints that change what a decoder *emits*, not merely what we check. */
function generativeConstraints(node, out = new Map()) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) generativeConstraints(item, out);
    return out;
  }
  const add = (key) => out.set(key, (out.get(key) ?? 0) + 1);
  if (Array.isArray(node.enum)) add(`enum:${JSON.stringify([...node.enum].sort())}`);
  if (typeof node.const === "string") add(`const:${node.const}`);
  if (Array.isArray(node.required) && node.required.length > 0) {
    add(`required:${JSON.stringify([...node.required].sort())}`);
  }
  for (const value of Object.values(node)) generativeConstraints(value, out);
  return out;
}

function manifest() {
  const post = {
    id: "Post", version: "1.0.0", description: "A published article.",
    schema: {
      type: "object", additionalProperties: false, required: ["id"],
      properties: {
        id: { type: "string" }, title: { type: "string" },
        wordCount: { type: "number" }, section: { type: "string" },
      },
    },
    fields: {
      id: { label: "Id", semanticType: "identifier" },
      title: { label: "Title", semanticType: "text" },
      wordCount: { label: "Words", semanticType: "quantity" },
      section: { label: "Section", semanticType: "category" },
    },
  };
  return {
    schemaVersion: "1.0", catalogId: "news", catalogVersion: "1.0.0", catalogHash: "h",
    description: "Approved reads.",
    dataTypes: [post],
    capabilities: [
      {
        id: "posts.list", version: "1.0.0", purpose: "List published posts.", kind: "query",
        // A recursive-ish approved argument, the shape a CMS filter takes: the
        // column wraps an operator object, which is where `params` depth bites.
        inputSchema: {
          type: "object", additionalProperties: false,
          properties: {
            limit: { type: "integer" },
            where: {
              anyOf: [
                {
                  type: "object", additionalProperties: false,
                  properties: {
                    section: {
                      anyOf: [
                        {
                          type: "object", additionalProperties: false,
                          properties: { equals: { anyOf: [{ type: "string" }, { type: "null" }] } },
                        },
                        { type: "null" },
                      ],
                    },
                  },
                },
                { type: "null" },
              ],
            },
          },
        },
        outputSchema: {
          type: "array",
          items: {
            type: "object", additionalProperties: false, required: ["id"],
            properties: {
              id: { type: "string" }, title: { type: "string" },
              wordCount: { type: "number" }, section: { type: "string" },
            },
          },
        },
        output: { dataTypeId: "Post", shape: "collection" },
        requiredSessionKeys: [], sourceIds: ["pg"],
        policy: { authentication: "public" },
        constraints: { maximumRows: 100, timeoutMs: 5000 },
        supports: {
          filterFields: ["title", "wordCount", "section"],
          sortFields: ["wordCount"],
          sourceNarrowingArguments: ["limit", "where"],
        },
      },
    ],
    relationships: [], sources: [{ id: "pg", label: "PG" }],
  };
}

test("every constraint the contract states reaches the model", () => {
  const contract = createDataPlanningContract(manifest());
  const truth = generativeConstraints(contract.jsonSchema);
  const sent = generativeConstraints(structuredOutputSchema(contract.jsonSchema));

  const missing = [...truth.keys()].filter((key) => !sent.has(key));
  assert.deepEqual(
    missing,
    [],
    `These constraints are in the compiled contract and not in what the model is ` +
      `sent, so the model has to guess them: ${missing.join(" | ")}`,
  );

  const thinned = [...truth.entries()]
    .filter(([key, count]) => (sent.get(key) ?? 0) < count)
    .map(([key, count]) => `${key} (${count} -> ${sent.get(key) ?? 0})`);
  assert.deepEqual(
    thinned,
    [],
    `Present but fewer times than stated, so some branches lost them: ${thinned.join(" | ")}`,
  );
});

test("the operator vocabulary specifically survives, by name", () => {
  // Named separately because it is the one that was measured causing failures,
  // and because a generic invariant is easy to weaken by accident.
  const contract = createDataPlanningContract(manifest());
  const sent = JSON.stringify(structuredOutputSchema(contract.jsonSchema));
  for (const operator of ["eq", "not-eq", "starts-with", "is-null", "between"]) {
    assert.ok(sent.includes(`"${operator}"`), `the model is never shown "${operator}"`);
  }
  // And the host's own approval work: which fields may be filtered on.
  assert.ok(sent.includes('"wordCount"'), "filterFields never reach the model");
});

test("recursion is still cut, so the budget is not the thing holding it", () => {
  // The depth budget was set low to bound the recursive component `node` tree.
  // It never had to be: `$ref` is replaced independently of depth. If that ever
  // stops being true, raising the budget becomes unsafe — so it is pinned here.
  const recursive = { type: "object", properties: { child: { $ref: "#/$defs/node" } } };
  const sent = structuredOutputSchema(recursive, 28);
  assert.deepEqual(
    sent.properties.child,
    { type: "object" },
    "a $ref must become a permissive object regardless of remaining depth",
  );
});

test("a resolvable $ref keeps the shape it points at, instead of losing it", async () => {
  const { structuredOutputSchema } = await import("../dist/index.js");
  // The plan contract emits `$defs`/`$ref` for recursive component slots, and
  // every reference was being flattened to `{type: "object"}` — so a nested
  // slot reached the model with no shape at all, and only local validation
  // caught a wrong draft, as repair attempts nobody could see the cause of.
  const withDefs = {
    type: "object",
    properties: { child: { $ref: "#/$defs/node" } },
    $defs: {
      node: {
        type: "object",
        properties: {
          componentId: { enum: ["card", "table"] },
          children: { type: "array", items: { $ref: "#/$defs/node" } },
        },
      },
    },
  };
  // Forwarded, since both live endpoints accept a self-referential reference in
  // constrained mode. The definitions travel with it or every reference dangles.
  const sent = structuredOutputSchema(withDefs, 6);
  assert.deepEqual(sent.properties.child, { $ref: "#/$defs/node" });
  assert.deepEqual(
    sent.$defs.node.properties.componentId,
    { enum: ["card", "table"] },
    "the referenced shape travels with the reference, enum included",
  );
  assert.deepEqual(
    sent.$defs.node.properties.children.items,
    { $ref: "#/$defs/node" },
    "and the self-reference stays a reference rather than expanding",
  );

  // Inlining is still reachable, for a baseUrl whose decoder refuses one.
  const inlined = structuredOutputSchema(withDefs, 6, { forwardRefs: false });
  assert.deepEqual(
    inlined.properties.child.properties.componentId,
    { enum: ["card", "table"] },
    "the inline path still preserves what the reference pointed at",
  );
  assert.ok(!JSON.stringify(inlined).includes("$ref"), "and emits no reference");
});

test("an unresolvable $ref still becomes a permissive object", async () => {
  const { structuredOutputSchema } = await import("../dist/index.js");
  // Preserving or resolving a dangling reference would produce a schema the
  // API rejects outright, which is worse than a permissive object.
  const dangling = { type: "object", properties: { child: { $ref: "#/$defs/missing" } } };
  assert.deepEqual(
    structuredOutputSchema(dangling, 28).properties.child,
    { type: "object" },
  );
});
