import { describe, expect, it } from "vitest";
import {
  MemoryOperationClassificationCache,
  classifyOperationEffects,
  createLlmOperationEffectClassifier,
  hashOperationClassificationInput,
  type OperationClassificationInput,
} from "../src/operation-effect.js";

const readPost: OperationClassificationInput = {
  operationKey: "openapi:getConversationList",
  protocol: "openapi",
  coordinate: "POST /conversation-list",
  operationName: "getConversationList",
  summary: "Get Conversation List",
  description: "Returns filtered conversations without modifying them.",
  tags: ["Chat"],
  inputShape: { type: "object", properties: { page: { type: "integer" } } },
  outputShape: { type: "array", items: { type: "object" } },
  security: [{ bearerAuth: [] }],
};

describe("semantic operation-effect classification", () => {
  it("uses structured model output and caches it by classifier and schema hash", async () => {
    let calls = 0;
    const classifier = createLlmOperationEffectClassifier({
      cacheKey: "test-model:classifier-v1",
      provider: {
        async generateClassification(request) {
          calls += 1;
          expect(request.systemPrompt).toContain("untrusted data");
          expect(request.userPrompt).toContain("POST /conversation-list");
          expect(request.jsonSchema).toMatchObject({ type: "object" });
          return {
            modelId: "test-model",
            value: {
              classifications: [
                {
                  operationKey: readPost.operationKey,
                  effect: "read-only-query",
                  confidence: 0.96,
                  reason: "The operation retrieves filtered conversations.",
                  riskSignals: ["HTTP POST"],
                },
              ],
            },
          };
        },
      },
    });
    const cache = new MemoryOperationClassificationCache();

    const first = await classifyOperationEffects({
      operations: [readPost],
      classifier,
      cache,
    });
    const second = await classifyOperationEffects({
      operations: [readPost],
      classifier,
      cache,
    });

    expect(first[0]).toMatchObject({
      source: "model",
      effect: "read-only-query",
      suggestedSelection: true,
      requiresHumanReview: true,
    });
    expect(second[0]).toMatchObject({ source: "cache" });
    expect(calls).toBe(1);
  });

  it("invalidates the cache when schema metadata or classifier version changes", () => {
    const original = hashOperationClassificationInput(readPost, "classifier-v1");
    const changedSchema = hashOperationClassificationInput(
      { ...readPost, outputShape: { type: "object" } },
      "classifier-v1",
    );
    const changedClassifier = hashOperationClassificationInput(readPost, "classifier-v2");

    expect(changedSchema).not.toBe(original);
    expect(changedClassifier).not.toBe(original);
  });

  it("gives an explicit publisher annotation precedence and bypasses the model", async () => {
    let calls = 0;
    const result = await classifyOperationEffects({
      operations: [{ ...readPost, explicitEffect: "state-changing-action" }],
      classifier: {
        cacheKey: "unused",
        async classify() {
          calls += 1;
          return [];
        },
      },
    });

    expect(result[0]).toMatchObject({
      source: "publisher",
      effect: "state-changing-action",
      confidence: 1,
      suggestedSelection: false,
      requiresHumanReview: false,
    });
    expect(calls).toBe(0);
  });

  it("fails closed on malformed model output and never auto-selects the fallback", async () => {
    const classifier = createLlmOperationEffectClassifier({
      cacheKey: "broken-model:v1",
      provider: {
        async generateClassification() {
          return { modelId: "broken-model", value: { classifications: [] } };
        },
      },
    });
    const [postFallback, getFallback] = await classifyOperationEffects({
      operations: [
        readPost,
        {
          operationKey: "openapi:getTicket",
          protocol: "openapi",
          coordinate: "GET /tickets/{id}",
          tags: [],
        },
      ],
      classifier,
    });

    expect(postFallback).toMatchObject({
      source: "fallback",
      effect: "ambiguous",
      suggestedSelection: false,
    });
    expect(getFallback).toMatchObject({
      source: "fallback",
      effect: "read-only-query",
      confidence: 0.6,
      suggestedSelection: false,
    });
  });

  it("rejects duplicate operation keys before calling a model", async () => {
    await expect(
      classifyOperationEffects({ operations: [readPost, readPost] }),
    ).rejects.toThrow(/Duplicate operationKey/);
  });
});
