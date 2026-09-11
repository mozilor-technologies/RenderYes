import { createModelPlanProvider } from "@renderyes/server";

/**
 * The narrow seam between this generator and any model.
 *
 * Deliberately not `PlanProvider` itself: the generator needs exactly one
 * call shape and must be trivially mockable in tests, and depending on the
 * wider interface would let generator code start caring about plan-specific
 * result fields it has no business reading.
 */
export interface GenerateModelRequest {
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: unknown;
}

export interface GenerateModelResult {
  /** The parsed JSON the model returned. Validated by the caller, never here. */
  value: unknown;
  modelId?: string;
}

export interface GenerateModelProvider {
  id: string;
  generate(request: GenerateModelRequest): Promise<GenerateModelResult>;
}

/** Same defaults as planner-eval's CLI, the existing precedent for direct model use. */
export const DEFAULT_MODELS: Readonly<Record<"openai" | "gemini", string>> = {
  openai: "gpt-5.6",
  gemini: "gemini-3.6-flash",
};

export const DEFAULT_API_KEY_ENVS: Readonly<Record<"openai" | "gemini", string>> = {
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export interface CreateGenerateModelProviderOptions {
  id: "openai" | "gemini";
  model?: string;
  /** Environment variable NAME holding the key — never the key itself. */
  apiKeyEnv?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Adapts `createModelPlanProvider` from `@renderyes/server` — the HTTP
 * adapters, structured-output fallback, timeout, and key-by-env-name handling
 * already exist there and were already reused once (planner-eval). A third
 * HTTP client for the same two APIs would be pure duplication.
 */
export function createGenerateModelProvider(
  options: CreateGenerateModelProviderOptions,
): GenerateModelProvider {
  const provider = createModelPlanProvider({
    id: options.id,
    model: options.model ?? DEFAULT_MODELS[options.id],
    apiKeyEnv: options.apiKeyEnv ?? DEFAULT_API_KEY_ENVS[options.id],
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return {
    id: options.id,
    async generate(request) {
      const result = await provider.generatePlan(request);
      return { value: result.value, modelId: result.modelId };
    },
  };
}

export type ScriptedResponse =
  unknown | ((request: GenerateModelRequest, callIndex: number) => unknown);

export interface ScriptedGenerateProvider extends GenerateModelProvider {
  /** Every request received, in order — lets tests assert repair prompts verbatim. */
  requests: GenerateModelRequest[];
}

/**
 * The test double. Returns each scripted value in turn; a script shorter than
 * the calls made is an error, because a test that silently reuses its last
 * response is a test that can't tell one repair round from three.
 */
export function createScriptedGenerateProvider(
  script: readonly ScriptedResponse[],
): ScriptedGenerateProvider {
  const requests: GenerateModelRequest[] = [];
  return {
    id: "mock",
    requests,
    async generate(request) {
      const index = requests.length;
      requests.push(request);
      const entry = script[index];
      if (entry === undefined) {
        throw new Error(
          `Scripted provider exhausted: call ${index + 1} of a ${script.length}-entry script`,
        );
      }
      const value = typeof entry === "function" ? entry(request, index) : entry;
      return { value, modelId: "mock" };
    },
  };
}
