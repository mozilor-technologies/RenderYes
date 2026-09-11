import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelPlanProvider,
  decodeModeOf,
  schemaFingerprint,
  STRICT_SCHEMA_SUPPORTED,
} from "../dist/providers.js";

/**
 * The provider boundary, proven rather than assumed.
 *
 * A live compose emitted a filter field outside the schema's enum three times
 * running while telemetry said `constrainedDecoding: true`. That read as a model
 * problem for as long as nobody checked what the request actually asked for:
 * the schema goes out with strict mode off, which makes it guidance, not a
 * constraint. These tests pin the request as sent and the mode as reported, so
 * the two cannot drift apart again.
 *
 * The sentinels are impossible on purpose — `filter.field` admits only
 * ONLY_SOURCE_FIELD, `pageFilter.field` only ONLY_PAGE_FIELD — so a response
 * naming neither is unambiguously schema-invalid.
 */

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["dataRequests"],
  properties: {
    dataRequests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requestId"],
        properties: {
          requestId: { type: "string" },
          query: {
            type: "object",
            additionalProperties: false,
            properties: {
              filter: {
                type: "object",
                properties: { field: { enum: ["ONLY_SOURCE_FIELD"] } },
              },
              pageFilter: {
                type: "object",
                properties: { field: { enum: ["ONLY_PAGE_FIELD"] } },
              },
            },
          },
        },
      },
    },
  },
};

const VIOLATING_OUTPUT = {
  dataRequests: [
    { requestId: "r1", query: { filter: { field: "IMPOSSIBLE_FIELD" } } },
  ],
};

function capturingProvider() {
  const requests = [];
  const provider = createModelPlanProvider({
    id: "openai",
    apiKeyEnv: "PROVIDER_DECODE_TEST_KEY",
    model: "test-model",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify(VIOLATING_OUTPUT),
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  return { provider, requests };
}

process.env.PROVIDER_DECODE_TEST_KEY = "sk-test-not-real";

test("the schema is sent with the strict flag the constant declares", async () => {
  const { provider, requests } = capturingProvider();
  await provider.generatePlan({
    systemPrompt: "s",
    userPrompt: "u",
    jsonSchema: SCHEMA,
  });
  const format = requests[0].body.text.format;
  assert.equal(format.type, "json_schema");
  // Derived from one constant, so the request and the reported mode cannot
  // disagree — which is exactly how they disagreed before.
  assert.equal(format.strict, STRICT_SCHEMA_SUPPORTED);
});

test("the schema reaches the provider byte-identical to the one under test", async () => {
  const { provider, requests } = capturingProvider();
  await provider.generatePlan({
    systemPrompt: "s",
    userPrompt: "u",
    jsonSchema: SCHEMA,
  });
  const sent = requests[0].body.text.format.schema;
  // Both sentinels survive the rewrite: whatever lets an invalid value through,
  // it is not the enums being dropped on the way out.
  assert.match(JSON.stringify(sent), /ONLY_SOURCE_FIELD/);
  assert.match(JSON.stringify(sent), /ONLY_PAGE_FIELD/);
  assert.equal(schemaFingerprint(sent), schemaFingerprint(SCHEMA));
});

test("a schema-invalid value survives the adapter, and is not reported as constrained", async () => {
  const { provider } = capturingProvider();
  const result = await provider.generatePlan({
    systemPrompt: "s",
    userPrompt: "u",
    jsonSchema: SCHEMA,
  });
  // The adapter passes it straight through: nothing at this boundary enforces
  // the schema, which is the finding this file exists to pin.
  assert.match(JSON.stringify(result.value), /IMPOSSIBLE_FIELD/);
  assert.equal(result.decodeMode, "schema-advisory");
  assert.equal(
    result.constrainedDecoding,
    false,
    "a decoder that just emitted a forbidden value was not constraining anything",
  );
});

test("decode mode names the fallback, never the format that was requested", () => {
  assert.equal(decodeModeOf(false), "json-object");
  assert.equal(
    decodeModeOf(true),
    STRICT_SCHEMA_SUPPORTED ? "schema-enforced" : "schema-advisory",
  );
});
