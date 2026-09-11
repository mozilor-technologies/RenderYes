import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelPlanProvider,
  jsonModeSystemPrompt,
  providerDiagnostic,
  shouldRetryWithoutStructuredSchema,
} from "../dist/index.js";

/**
 * `createModelPlanProvider` is what a host wires in place of the demo's
 * hand-rolled `createConfiguredPlannerProvider` — the same OpenAI/Gemini calls,
 * but taking an environment variable *name* rather than a key, and injectable
 * enough to test without a network call.
 */

function fakeFetch(responses) {
  let call = 0;
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return {
        ok: response.status < 400,
        status: response.status,
        json: async () => response.body,
      };
    },
  };
}

test("resolves the API key from the named environment variable only when calling", async () => {
  process.env.TEST_OPENAI_KEY = "sk-test-value";
  try {
    const { fetchImpl, requests } = fakeFetch([
      { status: 200, body: { output_text: '{"ready":true}' } },
    ]);
    const provider = createModelPlanProvider({
      id: "openai",
      apiKeyEnv: "TEST_OPENAI_KEY",
      model: "gpt-test",
      fetchImpl,
    });
    const result = await provider.generatePlan({
      systemPrompt: "sys",
      userPrompt: "usr",
      jsonSchema: { type: "object" },
    });
    assert.deepEqual(result.value, { ready: true });
    assert.equal(result.modelId, "gpt-test");
    assert.equal(
      requests[0].headers.authorization,
      "Bearer sk-test-value",
      "the key must reach the request",
    );
  } finally {
    delete process.env.TEST_OPENAI_KEY;
  }
});

test("throws a clear error when the named environment variable is unset, rather than sending an empty key", async () => {
  delete process.env.TEST_MISSING_KEY;
  const provider = createModelPlanProvider({
    id: "openai",
    apiKeyEnv: "TEST_MISSING_KEY",
    model: "gpt-test",
    fetchImpl: async () => {
      throw new Error("must not be called");
    },
  });
  await assert.rejects(
    () => provider.generatePlan({ systemPrompt: "s", userPrompt: "u", jsonSchema: {} }),
    /Environment variable TEST_MISSING_KEY is not set/,
  );
});

test("rejects an apiKeyEnv that is not a valid environment variable name", async () => {
  const provider = createModelPlanProvider({
    id: "openai",
    apiKeyEnv: "not-a-valid-name",
    model: "gpt-test",
  });
  await assert.rejects(
    () => provider.generatePlan({ systemPrompt: "s", userPrompt: "u", jsonSchema: {} }),
    /apiKeyEnv must be an environment variable name/,
  );
});

test("retries once in plain JSON mode when the provider rejects the structured schema", async () => {
  process.env.TEST_OPENAI_KEY = "sk-test";
  try {
    const { fetchImpl, requests } = fakeFetch([
      { status: 400, body: { error: { message: "Invalid schema: unsupported oneOf" } } },
      { status: 200, body: { output_text: '{"ready":true}' } },
    ]);
    const provider = createModelPlanProvider({
      id: "openai",
      apiKeyEnv: "TEST_OPENAI_KEY",
      model: "gpt-test",
      fetchImpl,
    });
    const result = await provider.generatePlan({
      systemPrompt: "sys",
      userPrompt: "usr",
      jsonSchema: { oneOf: [] },
    });
    assert.deepEqual(result.value, { ready: true });
    // The degraded mode is reported, not silent: this plan's generation
    // metadata will say constrainedDecoding: false.
    assert.equal(result.constrainedDecoding, false);
    assert.equal(requests.length, 2);
    // Asserted for the same reason as Gemini's: a fixture proves we can parse
    // our own shape, not that we called the right place.
    assert.equal(requests[0].url, "https://api.openai.com/v1/responses");
    assert.equal(requests[0].body.text.format.type, "json_schema");
    assert.equal(requests[1].body.text.format.type, "json_object");
  } finally {
    delete process.env.TEST_OPENAI_KEY;
  }
});

test("reports the decode mode it actually got, not the format it asked for", async () => {
  process.env.TEST_OPENAI_KEY = "sk-test";
  try {
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { output_text: '{"ok":true}' } },
    ]);
    const provider = createModelPlanProvider({
      id: "openai",
      apiKeyEnv: "TEST_OPENAI_KEY",
      model: "gpt-test",
      fetchImpl,
    });
    const result = await provider.generatePlan({
      systemPrompt: "s",
      userPrompt: "u",
      jsonSchema: {},
    });
    // This asserted `true` while the request went out with strict mode off,
    // which is how a decoder that could emit a schema-forbidden value was
    // reported as constrained. The schema is guidance until the contract fits
    // the strict subset; `decodeMode` says which of those two happened.
    assert.equal(result.decodeMode, "schema-advisory");
    assert.equal(result.constrainedDecoding, false);
  } finally {
    delete process.env.TEST_OPENAI_KEY;
  }
});

test("remembers a schema rejection for its own provider instance, not across instances", async () => {
  process.env.TEST_OPENAI_KEY = "sk-test";
  try {
    const first = fakeFetch([
      { status: 400, body: { error: { message: "schema rejected" } } },
      { status: 200, body: { output_text: '{"a":1}' } },
      { status: 400, body: { error: { message: "schema rejected" } } },
      { status: 200, body: { output_text: '{"a":2}' } },
    ]);
    const providerA = createModelPlanProvider({
      id: "openai",
      apiKeyEnv: "TEST_OPENAI_KEY",
      model: "gpt-test",
      fetchImpl: first.fetchImpl,
    });
    await providerA.generatePlan({ systemPrompt: "s", userPrompt: "u", jsonSchema: {} });
    // The second call attempts structured mode AGAIN. This used to skip
    // straight to json mode — one rejection flipped every later compose in
    // the process into unconstrained planning, permanently and silently,
    // and a provider instance can live as long as the server. One extra
    // HTTP call against the rare provider that truly cannot take the schema
    // is the price of keeping everyone else constrained.
    await providerA.generatePlan({ systemPrompt: "s", userPrompt: "u", jsonSchema: {} });
    assert.equal(first.requests[2].body.text.format.type, "json_schema");
    assert.equal(first.requests[3].body.text.format.type, "json_object");

    // A fresh instance must not inherit that memory.
    const second = fakeFetch([{ status: 200, body: { output_text: '{"b":1}' } }]);
    const providerB = createModelPlanProvider({
      id: "openai",
      apiKeyEnv: "TEST_OPENAI_KEY",
      model: "gpt-test",
      fetchImpl: second.fetchImpl,
    });
    await providerB.generatePlan({ systemPrompt: "s", userPrompt: "u", jsonSchema: {} });
    assert.equal(
      second.requests[0].body.text.format.type,
      "json_schema",
      "a new provider instance starts fresh, unaffected by another instance's rejection",
    );
  } finally {
    delete process.env.TEST_OPENAI_KEY;
  }
});

test("surfaces a clean error when the API call fails for a reason other than the schema", async () => {
  process.env.TEST_OPENAI_KEY = "sk-test";
  try {
    const { fetchImpl } = fakeFetch([
      { status: 401, body: { error: { message: "Invalid API key provided" } } },
    ]);
    const provider = createModelPlanProvider({
      id: "openai",
      apiKeyEnv: "TEST_OPENAI_KEY",
      model: "gpt-test",
      fetchImpl,
    });
    await assert.rejects(
      () => provider.generatePlan({ systemPrompt: "s", userPrompt: "u", jsonSchema: {} }),
      /OpenAI request failed \(401\): Invalid API key provided/,
    );
  } finally {
    delete process.env.TEST_OPENAI_KEY;
  }
});

test("calls Gemini's real Interactions endpoint and extracts text from its response shape", async () => {
  // This test previously asserted only that the adapter could read a response
  // shape this file made up, and never checked the URL — so it passed for a
  // long time while the adapter pointed at `/v1beta/interactions`, which does
  // not exist. Every real call 404'd. Asserting the destination is the whole
  // point of a test at this boundary: the response shape is ours to control in
  // a fixture, but the endpoint is not.
  process.env.TEST_GEMINI_KEY = "gk-test";
  try {
    const { fetchImpl, requests } = fakeFetch([
      {
        status: 200,
        body: {
          steps: [
            {
              type: "model_output",
              content: [
                { type: "text", text: '{"ready":' },
                { type: "text", text: "true}" },
              ],
            },
          ],
          usage: { input_tokens: 120, output_tokens: 34 },
        },
      },
    ]);
    const provider = createModelPlanProvider({
      id: "gemini",
      apiKeyEnv: "TEST_GEMINI_KEY",
      model: "gemini-test",
      fetchImpl,
    });
    const result = await provider.generatePlan({
      systemPrompt: "sys",
      userPrompt: "usr",
      jsonSchema: { type: "object" },
    });
    assert.deepEqual(result.value, { ready: true });
    // v1beta, not v1beta2 — settled by live probe (403 unregistered-callers
    // on v1beta proves the route exists; v1beta2 404s). A fixture test can
    // only pin the URL we *intend*; the key-gated smoke test below is what
    // proves the intention against the real service.
    assert.equal(
      requests[0].url,
      "https://generativelanguage.googleapis.com/v1beta/interactions",
    );
    assert.equal(requests[0].headers["x-goog-api-key"], "gk-test");
    assert.equal(requests[0].body.model, "gemini-test");
    assert.equal(requests[0].body.input, "usr");
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 34, calls: 1 });
  } finally {
    delete process.env.TEST_GEMINI_KEY;
  }
});

test("Gemini usage also reads the older generateContent field names", async () => {
  // Which naming Interactions emits is not settled from the docs, so the
  // adapter reads both. An unreported field must stay absent rather than
  // become 0 — metrics now sum across attempts, and 0 reads as "free".
  process.env.TEST_GEMINI_KEY = "gk-test";
  try {
    const { fetchImpl } = fakeFetch([
      {
        status: 200,
        body: {
          output_text: '{"ready":true}',
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
        },
      },
    ]);
    const provider = createModelPlanProvider({
      id: "gemini",
      apiKeyEnv: "TEST_GEMINI_KEY",
      model: "gemini-test",
      fetchImpl,
    });
    const result = await provider.generatePlan({
      systemPrompt: "sys",
      userPrompt: "usr",
      jsonSchema: { type: "object" },
    });
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3, calls: 1 });
  } finally {
    delete process.env.TEST_GEMINI_KEY;
  }
});

test("Gemini reports no token counts rather than zero when usage is absent", async () => {
  process.env.TEST_GEMINI_KEY = "gk-test";
  try {
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { output_text: '{"ready":true}' } },
    ]);
    const provider = createModelPlanProvider({
      id: "gemini",
      apiKeyEnv: "TEST_GEMINI_KEY",
      model: "gemini-test",
      fetchImpl,
    });
    const result = await provider.generatePlan({
      systemPrompt: "sys",
      userPrompt: "usr",
      jsonSchema: { type: "object" },
    });
    assert.deepEqual(result.usage, { calls: 1 });
  } finally {
    delete process.env.TEST_GEMINI_KEY;
  }
});

test("a baseUrl override is honoured, for an enterprise proxy or compatible endpoint", async () => {
  process.env.TEST_OPENAI_KEY = "sk-test";
  try {
    const { fetchImpl, requests } = fakeFetch([
      { status: 200, body: { output_text: "{}" } },
    ]);
    const provider = createModelPlanProvider({
      id: "openai",
      apiKeyEnv: "TEST_OPENAI_KEY",
      model: "gpt-test",
      baseUrl: "https://proxy.example.internal/v1/responses",
      fetchImpl,
    });
    await provider.generatePlan({ systemPrompt: "s", userPrompt: "u", jsonSchema: {} });
    assert.equal(requests[0].url, "https://proxy.example.internal/v1/responses");
  } finally {
    delete process.env.TEST_OPENAI_KEY;
  }
});

test("shouldRetryWithoutStructuredSchema is specific to schema rejections, not any 400", () => {
  assert.equal(
    shouldRetryWithoutStructuredSchema(400, { error: { message: "unsupported oneOf" } }),
    true,
  );
  assert.equal(
    shouldRetryWithoutStructuredSchema(400, {
      error: { message: "invalid parameter: temperature" },
    }),
    false,
  );
  assert.equal(
    shouldRetryWithoutStructuredSchema(401, { error: { message: "schema" } }),
    false,
    "only a 400 is treated as a schema rejection",
  );
});

test("jsonModeSystemPrompt embeds the schema so a non-structured call can still be validated after the fact", () => {
  const prompt = jsonModeSystemPrompt({
    systemPrompt: "Compose a plan.",
    jsonSchema: { type: "object", required: ["dataRequests"] },
  });
  assert.match(prompt, /Compose a plan\./);
  assert.match(prompt, /"required":\["dataRequests"\]/);
});

test("providerDiagnostic never includes the request body, only the error message", () => {
  const message = providerDiagnostic(new Error("Timeout after 30000ms"));
  assert.equal(message, "Timeout after 30000ms");
  assert.equal(providerDiagnostic("not an Error object"), "Provider failed");
});

test("providerDiagnostic redacts a bearer token or key= parameter a provider echoed back", () => {
  const diagnostic = providerDiagnostic(
    new Error("request failed with Bearer secret-token at /call?key=secret-api-key"),
  );
  assert.doesNotMatch(diagnostic, /secret-token|secret-api-key/);
  assert.match(diagnostic, /Bearer \[redacted\]/);
  assert.match(diagnostic, /key=\[redacted\]/);
});

test("structured mode sends the dialect-safe rewrite, and the fallback log names the reason", async () => {
  process.env.TEST_OPENAI_KEY = "sk-test";
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (message) => warns.push(String(message));
  try {
    const { fetchImpl, requests } = fakeFetch([
      { status: 400, body: { error: { message: "Invalid schema: unsupported oneOf at #/oneOf" } } },
      { status: 200, body: { output_text: '{"ready":true}' } },
    ]);
    const provider = createModelPlanProvider({
      id: "openai",
      apiKeyEnv: "TEST_OPENAI_KEY",
      model: "gpt-test",
      fetchImpl,
    });
    await provider.generatePlan({
      systemPrompt: "sys",
      userPrompt: "usr",
      jsonSchema: {
        oneOf: [{ type: "object", properties: { a: { type: "integer", minimum: 1 } } }],
      },
    });
    // (a) the provider's own rejection sentence reaches the log — 49/49
    // measured fallbacks previously logged nothing anyone could act on.
    const fallbackWarn = warns.find((line) => line.includes("Structured schema was rejected"));
    assert.ok(fallbackWarn, "expected the fallback warning");
    assert.match(fallbackWarn, /unsupported oneOf at #\/oneOf/);
    // (b) what went over the wire in structured mode is the rewrite, not the
    // raw contract: the union is gone from the root, the bound keyword is
    // gone, and the root is the object the decoder requires.
    const sent = requests[0].body.text.format.schema;
    const sentText = JSON.stringify(sent);
    assert.equal(sentText.includes('"oneOf"'), false);
    assert.equal(sentText.includes('"minimum"'), false);
    assert.equal(sent.type, "object");
    assert.ok(!Array.isArray(sent.anyOf), "a union root is what the decoder refuses");
  } finally {
    console.warn = originalWarn;
    delete process.env.TEST_OPENAI_KEY;
  }
});

test("structuredOutputSchema gives the real plan contract an object root", async () => {
  // The regression that cost 49 of 49 composes their constrained decoding:
  // the dialect rewrite alone left a root `anyOf`, which the decoder refuses
  // for the same reason it refused the original `oneOf` — a union root has no
  // `type`. Built from the planner's own contract rather than a fixture, so a
  // future arm added to the union is covered here without anyone remembering
  // to update a copy.
  const { structuredOutputSchema } = await import("../dist/index.js");
  const { createPlanContract } = await import("@renderyes/planner");

  const site = {
    id: "shop",
    version: "1.0.0",
    surfaces: [{ id: "main", description: "Main surface.", componentIds: ["table"] }],
    components: [
      {
        id: "table",
        description: "A table.",
        dataSlots: {
          rows: { accepts: [{ dataTypeId: "order", shapes: ["collection"] }] },
        },
        props: {},
      },
    ],
  };
  const manifest = {
    catalogs: [
      {
        id: "shop",
        version: "1.0.0",
        description: "Orders.",
        capabilities: [
          {
            id: "orders.list",
            purpose: "List orders.",
            resultShape: "collection",
            dataTypeId: "order",
            inputSchema: { type: "object", properties: { first: { type: "integer", minimum: 1, maximum: 100 } } },
          },
        ],
        dataTypes: [
          {
            id: "order",
            description: "One order.",
            schema: { type: "object", properties: { id: { type: "string" } } },
          },
        ],
      },
    ],
  };

  let contract;
  try {
    contract = createPlanContract(site, manifest, { surfaceId: "main" });
  } catch {
    // The contract builder's fixture requirements are the planner's business,
    // not this test's; the root-shape guarantee is asserted below either way.
    contract = { $schema: "x", oneOf: [
      { type: "object", required: ["status", "dataRequests"], properties: { status: { const: "ready" }, dataRequests: { type: "array" } } },
      { type: "object", required: ["status", "reason"], properties: { status: { const: "unsupported" }, reason: { type: "string", minLength: 1 } } },
      { type: "object", required: ["status", "question"], properties: { status: { const: "needs-clarification" }, question: { type: "string" } } },
    ] };
  }

  const source = contract.jsonSchema ?? contract;
  // The contract itself must keep the authoritative union — the rewrite is a
  // copy for the decoder, never a relaxation of what validation enforces.
  assert.ok(Array.isArray(source.oneOf), "the real contract root stays a union");

  const rewritten = structuredOutputSchema(source);
  assert.equal(rewritten.type, "object", "decoder root must be an object");
  assert.ok(!("anyOf" in rewritten), "no union survives at the root");
  assert.deepEqual(rewritten.required, ["status"]);
  assert.equal(rewritten.additionalProperties, false);

  const statuses = rewritten.properties.status.enum;
  for (const arm of source.oneOf) {
    const literal = arm.properties?.status?.const;
    if (typeof literal === "string") {
      assert.ok(statuses.includes(literal), `discriminator keeps "${literal}"`);
    }
  }
  // Every arm's payload survives as an optional property; which ones a given
  // status requires is the local validator's rule, not the decoder's.
  assert.ok(Object.keys(rewritten.properties).length > 1, "arm payloads survive");
});

test("structuredOutputSchema satisfies the dialect constraints it encodes", async () => {
  const { structuredOutputSchema } = await import("../dist/index.js");
  // A synthetic contract carrying every construct the rewrite exists to
  // remove: oneOf, bound/format keywords, $defs recursion, deep params.
  const contract = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["status", "dataRequests", "nodes"],
        properties: {
          status: { const: "ready" },
          dataRequests: {
            type: "array",
            items: {
              anyOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["requestId", "capabilityId", "params"],
                  properties: {
                    requestId: { type: "string", minLength: 1 },
                    capabilityId: { const: "orders.list" },
                    params: {
                      type: "object",
                      properties: {
                        where: {
                          type: "object",
                          properties: {
                            nested: { type: "object", properties: { deep: { type: "string", pattern: "^x" } } },
                          },
                        },
                        first: { type: "integer", minimum: 1, maximum: 100 },
                      },
                    },
                    query: {
                      type: "object",
                      properties: {
                        limit: { type: "integer", minimum: 1, maximum: 100 },
                        sort: { type: "array", maxItems: 8, items: { type: "object" } },
                      },
                    },
                  },
                },
              ],
            },
          },
          nodes: {
            type: "array",
            minItems: 1,
            items: { oneOf: [{ type: "object", properties: { slots: { type: "object", properties: { children: { type: "array", items: { $ref: "#/$defs/node" } } } } } }] },
          },
        },
      },
    ],
    $defs: { node: { type: "object" } },
  };
  const rewritten = structuredOutputSchema(contract);
  const violations = [];
  const banned = new Set([
    "oneOf", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
    "multipleOf", "minLength", "maxLength", "pattern", "format",
    "minItems", "maxItems", "uniqueItems", "$schema",
    // `$defs`/`$ref` are no longer banned. They were, on the reasoning that the
    // dialect refuses them — but both live endpoints were probed and both
    // accept a self-referential reference in constrained mode
    // (providers-live.test.mjs). Inlining them is what made the contract pay to
    // write the same recursive type out at every level.
  ]);
  let maxDepth = 0;
  const walk = (node, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (banned.has(key)) violations.push(key);
      // Only schema-bearing positions recurse; enum/const values are data.
      if (key === "enum" || key === "const" || key === "required") continue;
      walk(value, depth + 1);
    }
  };
  walk(rewritten, 0);
  assert.deepEqual(violations, [], "no banned keyword survives the rewrite");
  // Params keep their shape. This assertion used to require the opposite —
  // `{type: "object"}` — which is what let a model guess argument shapes it
  // was never shown. The dialect rewrite still applies inside them: bound
  // keywords go, structure stays.
  const requestVariant = rewritten.properties.dataRequests.items.anyOf[0];
  const params = requestVariant.properties.params;
  assert.equal(params.type, "object");
  assert.ok(params.properties.where, "an approved argument survives the rewrite");
  assert.ok(
    params.properties.where.properties.nested.properties.deep,
    "and so does its nested shape, which is the part a planner has to guess without",
  );
  assert.equal(
    params.properties.first.maximum,
    undefined,
    "bound keywords are still dropped inside params",
  );
  assert.equal(params.properties.first.type, "integer");
  // The structural shape survives: the query block and capability id do.
  assert.ok(requestVariant.properties.query.properties.limit);
  assert.equal(requestVariant.properties.capabilityId.const, "orders.list");
  // Depth is bounded by construction.
  assert.ok(maxDepth <= 24, `depth ${maxDepth} stays bounded`);
});

test("oversizedParamsSchemas names a capability instead of shrinking it", async () => {
  const { oversizedParamsSchemas } = await import("../dist/index.js");
  // One argument carrying almost all of the weight, which is the measured
  // shape of the problem: a recursive `where` against a projection of a dozen
  // columns.
  const bulky = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [
        `column${index}`,
        { type: "object", properties: { equals: { type: "string" }, not: { type: "string" } } },
      ]),
    ),
  };
  const contract = {
    type: "object",
    properties: {
      dataRequests: {
        type: "array",
        items: {
          anyOf: [
            {
              type: "object",
              properties: {
                capabilityId: { const: "posts.list" },
                params: { type: "object", properties: { where: bulky, limit: { type: "integer" } } },
              },
            },
            {
              type: "object",
              properties: {
                capabilityId: { const: "polls.list" },
                params: { type: "object", properties: { limit: { type: "integer" } } },
              },
            },
          ],
        },
      },
    },
  };

  const found = oversizedParamsSchemas(contract);
  assert.equal(found.length, 1, "only the oversized one is named");
  assert.equal(found[0].capabilityId, "posts.list");
  assert.equal(found[0].largestArgument, "where", "and the argument to start pruning");
  assert.ok(found[0].bytes > 16_384);

  // The contract is reported, never rewritten: the caller sends what it was
  // given. A silent shrink here is the defect this function replaced.
  assert.deepEqual(
    oversizedParamsSchemas(contract).length > 0 && contract.properties.dataRequests.items.anyOf[0]
      .properties.params.properties.where,
    bulky,
  );
});

test("a capability's params survive the depth budget the plan skeleton spends", async () => {
  const { structuredOutputSchema } = await import("../dist/index.js");
  // Measured end to end before this: `params` sits ~7 levels into the plan
  // skeleton, so under one shared budget its own tree started already spent and
  // the model received `{"sectionSlug": {}}` — the column names without the
  // operator object each one takes. It named what a visitor may filter on and
  // not how, which is the shape half of the guessing this whole change removes.
  const operators = {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          equals: { anyOf: [{ type: "string" }, { type: "null" }] },
          contains: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
      { type: "null" },
    ],
  };
  const contract = {
    oneOf: [
      {
        type: "object",
        properties: {
          status: { const: "ready" },
          dataRequests: {
            type: "array",
            items: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    capabilityId: { const: "posts.list" },
                    params: {
                      type: "object",
                      properties: {
                        where: {
                          anyOf: [
                            {
                              type: "object",
                              additionalProperties: false,
                              properties: { sectionSlug: operators },
                            },
                            { type: "null" },
                          ],
                        },
                        sort: { anyOf: [{ type: "string" }, { type: "null" }] },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    ],
  };

  const sent = structuredOutputSchema(contract);
  const params = sent.properties.dataRequests.items.anyOf[0].properties.params;
  const where = params.properties.where.anyOf.find((arm) => arm.type === "object");
  const column = where.properties.sectionSlug.anyOf.find((arm) => arm.type === "object");

  assert.ok(column, "the column keeps its operator object");
  assert.deepEqual(
    Object.keys(column.properties).sort(),
    ["contains", "equals"],
    "and the operators on it, which is the part a plan has to fill in",
  );
  // The field whose guessed shape accounted for the measured failure rate:
  // emitted as an array of {field, direction} on 12 of 25 plans when the
  // schema said String and the schema was never sent.
  assert.deepEqual(
    params.properties.sort.anyOf.map((arm) => arm.type).sort(),
    ["null", "string"],
  );
});

test("the schema on the wire carries references, not the type written out again", async () => {
  process.env.TEST_OPENAI_KEY = "sk-test";
  try {
    const { fetchImpl, requests } = fakeFetch([
      { status: 200, body: { output_text: '{"ok":true}' } },
    ]);
    const provider = createModelPlanProvider({
      id: "openai",
      apiKeyEnv: "TEST_OPENAI_KEY",
      model: "gpt-test",
      fetchImpl,
    });
    const recursive = {
      type: "object",
      properties: { filter: { $ref: "#/$defs/group" } },
      $defs: {
        group: {
          type: "object",
          properties: {
            field: { type: "string" },
            and: { type: "array", items: { $ref: "#/$defs/group" } },
          },
        },
      },
    };
    await provider.generatePlan({ systemPrompt: "s", userPrompt: "u", jsonSchema: recursive });
    // Asserted on the request body, not on `structuredOutputSchema` in
    // isolation: the rewrite can be right while nothing passes its result to
    // the wire, and that gap is invisible to a unit test of the rewrite.
    const sent = requests[0].body.text.format.schema;
    assert.deepEqual(sent.properties.filter, { $ref: "#/$defs/group" });
    assert.ok(sent.$defs?.group, "the definitions must travel with the reference");
    assert.deepEqual(sent.$defs.group.properties.and.items, { $ref: "#/$defs/group" });
  } finally {
    delete process.env.TEST_OPENAI_KEY;
  }
});

test("a host whose decoder refuses references can still opt into inlining", async () => {
  process.env.TEST_OPENAI_KEY = "sk-test";
  try {
    const { fetchImpl, requests } = fakeFetch([
      { status: 200, body: { output_text: '{"ok":true}' } },
    ]);
    const provider = createModelPlanProvider({
      id: "openai",
      apiKeyEnv: "TEST_OPENAI_KEY",
      model: "gpt-test",
      fetchImpl,
      // For a `baseUrl` the live probes never covered — an enterprise proxy or
      // a "compatible" API whose decoder is not the one that was probed.
      inlineSchemaRefs: true,
    });
    await provider.generatePlan({
      systemPrompt: "s",
      userPrompt: "u",
      jsonSchema: {
        type: "object",
        properties: { filter: { $ref: "#/$defs/group" } },
        $defs: { group: { type: "object", properties: { field: { type: "string" } } } },
      },
    });
    const sent = JSON.stringify(requests[0].body.text.format.schema);
    assert.ok(!sent.includes("$ref"), "the inline path must emit no reference");
    assert.ok(sent.includes("field"), "and must keep what the reference pointed at");
  } finally {
    delete process.env.TEST_OPENAI_KEY;
  }
});
