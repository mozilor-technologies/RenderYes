import type {
  OperationClassificationInput,
  ResolvedOperationClassification,
} from "@renderyes/capability-catalog";

export type ClassificationState =
  | { status: "idle" }
  | { status: "classifying"; completed: number; total: number }
  | {
      status: "ready";
      byOperationKey: Record<string, ResolvedOperationClassification>;
      usedLiveModel: boolean;
    }
  | { status: "error"; message: string };

const BATCH_INPUT_TOKEN_BUDGET = 6_200;
const RESERVED_OUTPUT_TOKENS_PER_OPERATION = 100;
const MAX_OPERATIONS_PER_BATCH = 12;
const MAX_CONCURRENT_BATCHES = 2;

function estimatedTokens(operation: OperationClassificationInput): number {
  // Deliberately conservative and provider-neutral. It includes the compact
  // input metadata plus enough structured output for effect/confidence/reason.
  return (
    Math.ceil(JSON.stringify(operation).length / 4) + RESERVED_OUTPUT_TOKENS_PER_OPERATION
  );
}

function batchOperations(
  operations: readonly OperationClassificationInput[],
): OperationClassificationInput[][] {
  const batches: OperationClassificationInput[][] = [];
  let current: OperationClassificationInput[] = [];
  let currentTokens = 800; // system instructions and response schema
  for (const operation of operations) {
    const cost = estimatedTokens(operation);
    if (
      current.length > 0 &&
      (current.length >= MAX_OPERATIONS_PER_BATCH ||
        currentTokens + cost > BATCH_INPUT_TOKEN_BUDGET)
    ) {
      batches.push(current);
      current = [];
      currentTokens = 800;
    }
    current.push(operation);
    currentTokens += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function requestBatch(
  operations: readonly OperationClassificationInput[],
): Promise<ResolvedOperationClassification[]> {
  const response = await fetch("/api/classify-operations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operations }),
  });
  const payload = (await response.json()) as {
    error?: unknown;
    classifications?: ResolvedOperationClassification[];
  };
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `Classification failed (${response.status})`,
    );
  }
  if (!Array.isArray(payload.classifications)) {
    throw new Error("Classification service returned no classifications");
  }
  return payload.classifications;
}

export async function requestOperationClassifications(
  operations: readonly OperationClassificationInput[],
  onProgress?: (progress: { completed: number; total: number }) => void,
): Promise<Extract<ClassificationState, { status: "ready" }>> {
  const batches = batchOperations(operations);
  const classifications: ResolvedOperationClassification[] = [];
  let nextBatch = 0;
  let completed = 0;
  async function worker(): Promise<void> {
    while (nextBatch < batches.length) {
      const batch = batches[nextBatch++];
      if (!batch) return;
      const result = await requestBatch(batch);
      classifications.push(...result);
      completed += batch.length;
      onProgress?.({ completed, total: operations.length });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_BATCHES, batches.length) }, worker),
  );
  return {
    status: "ready",
    byOperationKey: Object.fromEntries(
      classifications.map((classification) => [
        classification.operationKey,
        classification,
      ]),
    ),
    usedLiveModel: classifications.some(
      (classification) =>
        classification.source === "model" || classification.source === "cache",
    ),
  };
}

export function effectLabel(effect: ResolvedOperationClassification["effect"]): string {
  if (effect === "read-only-query") return "Likely read-only";
  if (effect === "state-changing-action") return "Likely action";
  return "Needs host decision";
}
