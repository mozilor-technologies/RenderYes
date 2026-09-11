import type { PlannerManifest } from "@renderyes/capability-catalog";
import type { PlanProvider } from "@renderyes/core";
import { composeDataPlan } from "@renderyes/planner";
import type { RegisteredSite } from "@renderyes/site-sdk";
import {
  checkPlan,
  readPlanFacts,
  type CheckId,
  type CheckOutcome,
  type EvalCase,
} from "./checks.js";

export interface RunEvalSuiteInput {
  site: RegisteredSite;
  plannerManifest: PlannerManifest;
  surfaceId: string;
  cases: readonly EvalCase[];
  provider: PlanProvider;
  /**
   * How many times each case runs. Defaults to 3.
   *
   * Not 1: a model is stochastic, so a single green run is not a measurement.
   * The smallest change the report can resolve is `1/runs`, which is why the
   * report states its own resolution rather than leaving it implicit.
   */
  runs?: number;
  maxRetries?: number;
}

export interface CheckSummary {
  passRate: number;
  runs: number;
  /** Distinct failure details, so a repeated identical failure is not listed three times. */
  failures: string[];
}

export interface CaseReport {
  id: string;
  prompt: string;
  /** Fraction of runs where every applicable check passed. */
  passRate: number;
  checks: Partial<Record<CheckId, CheckSummary>>;
  firstAttemptValidRate: number;
  meanRepairCount: number;
  meanLatencyMs: number;
  meanEstimatedTokens: number;
  meanProviderCalls: number;
  /**
   * When a run failed validation outright, which part of the plan the issues
   * pointed at — keyed by the leading path segment (`dataRequests`,
   * `dataBindings`, `props`, `dataJoins`, ...). This is the actionable signal:
   * it says which half of the contract the model is misreading.
   */
  failureBuckets: Record<string, number>;
  /** True when this case neither always passes nor always fails — the ones a prompt change can actually move. */
  unstable: boolean;
}

export interface EvalReport {
  runs: number;
  /** The smallest pass-rate change this report can distinguish: `1/runs`. */
  resolution: number;
  cases: CaseReport[];
  totals: {
    caseCount: number;
    meanPassRate: number;
    firstAttemptValidRate: number;
    /** Expected `ready`, got `unsupported`. The highest-value bug class: in production it is indistinguishable from a bad prompt. */
    falseUnsupported: number;
    /** Expected `unsupported`, got `ready`. It invented a view the catalog cannot ground. */
    falseReady: number;
    estimatedTokens: number;
    providerCalls: number;
    wallClockMs: number;
  };
  /**
   * How often each capability was selected across the whole suite. Per-case
   * checks cannot see this, and it is the only way to detect selection bias —
   * from a few-shot example, from prompt ordering, or from a model that simply
   * always reaches for the first option.
   */
  selectionDistribution: Record<string, number>;
  unstableCaseIds: string[];
}

/** Rough token estimate. Labelled *estimated* everywhere because `PlanProvider` reports no usage; a provider that knows its real usage should be measured directly instead. */
const estimateTokens = (text: string): number => Math.round(text.length / 4);

interface ProviderProbe {
  provider: PlanProvider;
  reset(): void;
  calls: () => number;
  estimatedTokens: () => number;
}

/** Wraps a provider to count calls and estimate tokens without changing its behaviour. */
function probe(inner: PlanProvider): ProviderProbe {
  let calls = 0;
  let characters = 0;
  return {
    provider: {
      id: inner.id,
      async generatePlan(request) {
        calls += 1;
        characters += request.systemPrompt.length + request.userPrompt.length;
        const completion = await inner.generatePlan(request);
        characters += JSON.stringify(completion.value).length;
        return completion;
      },
    },
    reset() {
      calls = 0;
      characters = 0;
    },
    calls: () => calls,
    estimatedTokens: () => estimateTokens("x".repeat(characters)),
  };
}

const mean = (values: number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;

export async function runEvalSuite(input: RunEvalSuiteInput): Promise<EvalReport> {
  const runs = input.runs ?? 3;
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("runs must be a positive integer");
  }
  const startedAt = Date.now();
  const instrument = probe(input.provider);
  const selectionDistribution: Record<string, number> = {};
  const cases: CaseReport[] = [];
  let falseUnsupported = 0;
  let falseReady = 0;
  let estimatedTokens = 0;
  let providerCalls = 0;

  for (const evalCase of input.cases) {
    const perRunOutcomes: CheckOutcome[][] = [];
    const latencies: number[] = [];
    const tokens: number[] = [];
    const callCounts: number[] = [];
    const repairCounts: number[] = [];
    const failureBuckets: Record<string, number> = {};

    for (let run = 0; run < runs; run++) {
      instrument.reset();
      const runStartedAt = Date.now();
      const result = await composeDataPlan({
        site: input.site,
        plannerManifest: input.plannerManifest,
        surfaceId: input.surfaceId,
        prompt: evalCase.prompt,
        provider: instrument.provider,
        ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
      });
      latencies.push(Date.now() - runStartedAt);
      tokens.push(instrument.estimatedTokens());
      callCounts.push(instrument.calls());
      estimatedTokens += instrument.estimatedTokens();
      providerCalls += instrument.calls();

      if (result.ok) {
        const facts = readPlanFacts(result.plan, input.plannerManifest);
        for (const capabilityId of facts.capabilityIds) {
          selectionDistribution[capabilityId] =
            (selectionDistribution[capabilityId] ?? 0) + 1;
        }
        repairCounts.push(facts.repairCount);
        if (evalCase.expect.outcome === "unsupported") {
          falseReady += 1;
          perRunOutcomes.push([
            {
              check: "outcome",
              ok: false,
              detail:
                "composed a view for a request the catalog should not be able to answer",
            },
          ]);
          continue;
        }
        perRunOutcomes.push(checkPlan(evalCase.expect, facts, input.plannerManifest));
        continue;
      }

      // Not ok. `unsupported` is a legitimate outcome; anything else is a
      // failure whose issue paths say which part of the contract was misread.
      if (result.kind === "unsupported") {
        const expected = evalCase.expect.outcome === "unsupported";
        if (!expected) falseUnsupported += 1;
        perRunOutcomes.push([
          {
            check: "outcome",
            ok: expected,
            ...(expected
              ? {}
              : {
                  detail: `refused a request the catalog can answer: ${result.reason}`,
                }),
          },
        ]);
        continue;
      }

      for (const issue of result.issues) {
        const bucket = issue.path.replace(/^\//, "").split(/[./]/)[0] || "root";
        failureBuckets[bucket] = (failureBuckets[bucket] ?? 0) + 1;
      }
      perRunOutcomes.push([
        {
          check: "outcome",
          ok: false,
          detail: `${result.kind}: ${result.reason.slice(0, 200)}`,
        },
      ]);
    }

    const checks: Partial<Record<CheckId, CheckSummary>> = {};
    for (const outcomes of perRunOutcomes) {
      for (const outcome of outcomes) {
        const summary =
          checks[outcome.check] ??
          (checks[outcome.check] = { passRate: 0, runs: 0, failures: [] });
        summary.runs += 1;
        if (outcome.ok) summary.passRate += 1;
        else if (outcome.detail && !summary.failures.includes(outcome.detail)) {
          summary.failures.push(outcome.detail);
        }
      }
    }
    for (const summary of Object.values(checks)) {
      if (summary) summary.passRate = summary.passRate / summary.runs;
    }

    const cleanRuns = perRunOutcomes.filter((outcomes) =>
      outcomes.every((outcome) => outcome.ok),
    ).length;
    const passRate = cleanRuns / runs;
    cases.push({
      id: evalCase.id,
      prompt: evalCase.prompt,
      passRate,
      checks,
      firstAttemptValidRate: checks["first-attempt-valid"]?.passRate ?? 0,
      meanRepairCount: mean(repairCounts),
      meanLatencyMs: mean(latencies),
      meanEstimatedTokens: mean(tokens),
      meanProviderCalls: mean(callCounts),
      failureBuckets,
      unstable: passRate > 0 && passRate < 1,
    });
  }

  return {
    runs,
    resolution: 1 / runs,
    cases,
    totals: {
      caseCount: cases.length,
      meanPassRate: mean(cases.map((report) => report.passRate)),
      firstAttemptValidRate: mean(cases.map((report) => report.firstAttemptValidRate)),
      falseUnsupported,
      falseReady,
      estimatedTokens,
      providerCalls,
      wallClockMs: Date.now() - startedAt,
    },
    selectionDistribution,
    unstableCaseIds: cases.filter((report) => report.unstable).map((report) => report.id),
  };
}
