import assert from "node:assert/strict";
import test from "node:test";
import { createModelPlanProvider } from "../dist/index.js";

/**
 * Live smoke tests. Skipped unless the relevant API key is present, so CI and
 * offline runs are unaffected; set the key locally to run one real call.
 *
 * These exist because this adapter's endpoint has now been wrong twice — first
 * pointing at `/v1beta/interactions` believed nonexistent, then "fixed" to
 * `/v1beta2/interactions` which actually is nonexistent — and both errors
 * survived a green suite, because every other test asserts a fixture of our
 * own response shape against a URL of our own choosing. A fixture can prove
 * the adapter does what we intended; only a real call can prove the intention
 * matches the service. One gated call per provider is the cheapest possible
 * version of that proof.
 */

test(
  "Gemini: one real call returns parseable JSON from the live endpoint",
  { skip: !process.env.GEMINI_API_KEY ? "GEMINI_API_KEY not set" : false },
  async () => {
    const provider = createModelPlanProvider({
      id: "gemini",
      apiKeyEnv: "GEMINI_API_KEY",
      model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
    });
    const result = await provider.generatePlan({
      systemPrompt: "Reply with JSON only.",
      userPrompt: 'Return exactly {"ok": true}.',
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      },
    });
    // The bar is deliberately low: the endpoint answered and the adapter
    // parsed it. Anything stricter would make this flake on model behaviour,
    // and model behaviour is not what this test is for.
    assert.ok(result.modelId, "expected a model id from a live response");
    assert.ok(result.value !== undefined, "expected a parsed JSON value");
  },
);

test(
  "OpenAI: one real call returns parseable JSON from the live endpoint",
  { skip: !process.env.OPENAI_API_KEY ? "OPENAI_API_KEY not set" : false },
  async () => {
    const provider = createModelPlanProvider({
      id: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      model: process.env.OPENAI_MODEL || "gpt-5.6",
    });
    const result = await provider.generatePlan({
      systemPrompt: "Reply with JSON only.",
      userPrompt: 'Return exactly {"ok": true}.',
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      },
    });
    assert.ok(result.modelId, "expected a model id from a live response");
    assert.ok(result.value !== undefined, "expected a parsed JSON value");
  },
);

/**
 * The two probes the $defs/$ref contract cut turns on — one per provider, for
 * opposite reasons.
 *
 * The plan is to stop inlining recursive input types and reference them
 * instead, measured at 93% of a production-scale contract. Authoring the refs is
 * provider-neutral; whether each decoder *accepts* them is a claim about a live
 * service, and this adapter's endpoint has already been wrong twice from claims
 * settled by reading rather than probing.
 *
 * OpenAI needs a probe because its path rewrites references away before the
 * wire, so nothing has ever shown one to it. Gemini needs one for the opposite
 * reason: it sends `body.jsonSchema` raw, so the `$defs`/`$ref` the plan
 * contract already emits for recursive component slots is *already* going out
 * on every compose — and no test has ever sent it a real schema to find out
 * whether that is accepted or silently falling back to JSON mode, one wasted
 * round trip at a time.
 *
 * Both go through `createModelPlanProvider`, not a hand-built request: a probe
 * that duplicates the adapter's endpoint and body shape can pass while the
 * adapter is broken, which is the exact failure this file exists for.
 */
const RECURSIVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["filter"],
  properties: { filter: { $ref: "#/$defs/group" } },
  $defs: {
    group: {
      type: "object",
      additionalProperties: false,
      required: ["field"],
      properties: {
        field: { type: "string" },
        and: { type: "array", items: { $ref: "#/$defs/group" } },
      },
    },
  },
};

const RECURSIVE_PROMPT =
  'Return a filter nested one level: {"filter": {"field": "any", "and": [{"field": "section"}]}}.';

test(
  "OpenAI: structured mode accepts $defs and a recursive $ref",
  { skip: !process.env.OPENAI_API_KEY ? "OPENAI_API_KEY not set" : false },
  async () => {
    const provider = createModelPlanProvider({
      id: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      model: process.env.OPENAI_MODEL || "gpt-5.6",
    });
    const result = await provider.generatePlan({
      systemPrompt: "Reply with JSON only.",
      userPrompt: RECURSIVE_PROMPT,
      jsonSchema: RECURSIVE_SCHEMA,
    });
    // `constrainedDecoding` is the answer. A rejected schema does not throw —
    // it falls back to validated JSON mode and reports false, which is exactly
    // the silent degradation this probe exists to make loud.
    assert.equal(
      result.constrainedDecoding,
      true,
      "OpenAI fell back to JSON mode, so it rejected the referenced schema",
    );
  },
);

test(
  "Gemini: structured mode accepts the $defs/$ref the contract already sends it",
  { skip: !process.env.GEMINI_API_KEY ? "GEMINI_API_KEY not set" : false },
  async () => {
    const provider = createModelPlanProvider({
      id: "gemini",
      apiKeyEnv: "GEMINI_API_KEY",
      model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
    });
    const result = await provider.generatePlan({
      systemPrompt: "Reply with JSON only.",
      userPrompt: RECURSIVE_PROMPT,
      jsonSchema: RECURSIVE_SCHEMA,
    });
    // Not a new question for this provider: the plan contract emits recursive
    // `$defs.node` for component slots today and Gemini receives it unmodified,
    // so a failure here means constrained decoding has never worked on this
    // path and every compose has been paying for a rejected attempt.
    assert.equal(
      result.constrainedDecoding,
      true,
      "Gemini fell back to JSON mode, so its structured path is not constrained today",
    );
  },
);
