import type { EvalReport } from "./run.js";

/**
 * A committed snapshot of per-case rates.
 *
 * The point of committing this is that a prompt or catalog change can then be
 * shown to have regressed something, rather than argued about. Without a
 * baseline, "the suite passes" is compatible with a change that quietly halved
 * first-attempt validity.
 */
export interface EvalBaseline {
  runs: number;
  /**
   * Which model produced this baseline.
   *
   * Recorded because a provider can change the model behind a name without
   * telling anyone, and a diff across two different models attributes their
   * change to ours — the most expensive kind of wrong conclusion this harness
   * can produce, because it looks like evidence. `compareToBaseline` refuses
   * to compare across a mismatch rather than footnoting it.
   */
  model?: { providerId: string; modelId: string };
  /** When the baseline was recorded, for the reader's judgement only. */
  recordedAt?: string;
  cases: Record<string, { passRate: number; firstAttemptValidRate: number }>;
}

export function toBaseline(
  report: EvalReport,
  model?: { providerId: string; modelId: string },
): EvalBaseline {
  return {
    runs: report.runs,
    ...(model ? { model } : {}),
    recordedAt: new Date().toISOString(),
    cases: Object.fromEntries(
      report.cases.map((caseReport) => [
        caseReport.id,
        {
          passRate: caseReport.passRate,
          firstAttemptValidRate: caseReport.firstAttemptValidRate,
        },
      ]),
    ),
  };
}

export interface BaselineDelta {
  id: string;
  metric: "passRate" | "firstAttemptValidRate";
  before: number;
  after: number;
}

/** One case's before/after, in runs rather than rates. */
export interface CaseFlip {
  id: string;
  /** Runs passed, out of `runs`. Whole numbers, because that is what happened. */
  before: number;
  after: number;
  direction: "better" | "worse" | "same";
}

export interface BaselineComparison {
  regressions: BaselineDelta[];
  improvements: BaselineDelta[];
  newCaseIds: string[];
  missingCaseIds: string[];
  /**
   * Every shared case's score out of `runs`, before and after.
   *
   * The aggregate mean hides the case that matters: five cases improving and
   * four regressing nets out to "slightly better" while half the suite moved.
   * Counting cases that went strictly one way is the number that says whether
   * a change helped or merely rearranged the failures.
   */
  flips: CaseFlip[];
  strictlyBetter: number;
  strictlyWorse: number;
  /**
   * Set when the baseline names a different model than this run used. The
   * comparison is still returned so a reader can look, but no conclusion
   * drawn from it is about our own changes.
   */
  modelMismatch?: { baseline: string; current: string };
  /**
   * True when the compared reports used different `runs` counts. The comparison
   * is still produced, but a rate measured over 3 runs and one measured over 20
   * are not the same kind of number, and treating a difference between them as a
   * regression would be wrong.
   */
  runsMismatch: boolean;
}

export function compareToBaseline(
  report: EvalReport,
  baseline: EvalBaseline,
  options: { tolerance?: number; model?: { providerId: string; modelId: string } } = {},
): BaselineComparison {
  // Default 0: report every drop, with its magnitude, and let the reader judge
  // against `report.resolution`. A non-zero default would silently absorb real
  // regressions on suites with a low run count, where one flipped run is a
  // large fraction.
  const tolerance = options.tolerance ?? 0;
  const regressions: BaselineDelta[] = [];
  const improvements: BaselineDelta[] = [];
  const newCaseIds: string[] = [];

  for (const caseReport of report.cases) {
    const previous = baseline.cases[caseReport.id];
    if (!previous) {
      newCaseIds.push(caseReport.id);
      continue;
    }
    const metrics = [
      ["passRate", previous.passRate, caseReport.passRate],
      [
        "firstAttemptValidRate",
        previous.firstAttemptValidRate,
        caseReport.firstAttemptValidRate,
      ],
    ] as const;
    for (const [metric, before, after] of metrics) {
      if (before - after > tolerance) {
        regressions.push({ id: caseReport.id, metric, before, after });
      } else if (after - before > tolerance) {
        improvements.push({ id: caseReport.id, metric, before, after });
      }
    }
  }

  // Per-case scores in whole runs. Rates are the right thing to store and the
  // wrong thing to read: "0.67 -> 0.33" is 2/3 -> 1/3, and one flipped run out
  // of three reads very differently from a two-thirds collapse.
  const flips: CaseFlip[] = [];
  for (const caseReport of report.cases) {
    const previous = baseline.cases[caseReport.id];
    if (!previous) continue;
    const before = Math.round(previous.passRate * baseline.runs);
    const after = Math.round(caseReport.passRate * report.runs);
    flips.push({
      id: caseReport.id,
      before,
      after,
      direction: after > before ? "better" : after < before ? "worse" : "same",
    });
  }

  const baselineModel = baseline.model
    ? `${baseline.model.providerId}:${baseline.model.modelId}`
    : undefined;
  const currentModel = options.model
    ? `${options.model.providerId}:${options.model.modelId}`
    : undefined;

  const reportedIds = new Set(report.cases.map((caseReport) => caseReport.id));
  return {
    regressions,
    improvements,
    newCaseIds,
    missingCaseIds: Object.keys(baseline.cases).filter((id) => !reportedIds.has(id)),
    runsMismatch: baseline.runs !== report.runs,
    flips,
    strictlyBetter: flips.filter((flip) => flip.direction === "better").length,
    strictlyWorse: flips.filter((flip) => flip.direction === "worse").length,
    ...(baselineModel && currentModel && baselineModel !== currentModel
      ? { modelMismatch: { baseline: baselineModel, current: currentModel } }
      : {}),
  };
}

/**
 * Terminal-readable diff, per case, in runs.
 *
 * Leads with the model mismatch when there is one, because every number below
 * it is then measuring someone else's change rather than ours, and a reader
 * who skims past that footnote draws exactly the wrong conclusion.
 */
export function formatBaselineComparison(
  comparison: BaselineComparison,
  runs: number,
): string {
  const lines: string[] = [];

  if (comparison.modelMismatch) {
    lines.push(
      "!! MODEL MISMATCH — this diff does not measure your changes.",
      `   baseline: ${comparison.modelMismatch.baseline}`,
      `   current:  ${comparison.modelMismatch.current}`,
      "   Re-record a baseline on the current model before drawing conclusions.",
      "",
    );
  }
  if (comparison.runsMismatch) {
    lines.push("!! run count differs between baseline and this report.", "");
  }

  lines.push(
    `${comparison.strictlyBetter} better · ${comparison.strictlyWorse} worse · ` +
      `${comparison.flips.length - comparison.strictlyBetter - comparison.strictlyWorse} unchanged`,
    "",
  );

  // Moved cases first: an unchanged case is not what anyone opened this for.
  const moved = comparison.flips.filter((flip) => flip.direction !== "same");
  if (moved.length > 0) {
    const width = Math.max(...moved.map((flip) => flip.id.length), 4);
    lines.push(`${"case".padEnd(width)}  before  after`);
    for (const flip of [...moved].sort((left, right) =>
      left.direction === right.direction
        ? left.id.localeCompare(right.id)
        : left.direction === "worse"
          ? -1
          : 1,
    )) {
      const mark = flip.direction === "worse" ? "-" : "+";
      lines.push(
        `${mark} ${flip.id.padEnd(width - 2)}  ${String(flip.before).padStart(6)}/${runs}  ${String(flip.after).padStart(3)}/${runs}`,
      );
    }
    lines.push("");
  }

  if (comparison.newCaseIds.length > 0) {
    lines.push(`new cases:     ${comparison.newCaseIds.join(", ")}`);
  }
  if (comparison.missingCaseIds.length > 0) {
    lines.push(`missing cases: ${comparison.missingCaseIds.join(", ")}`);
  }
  return lines.join("\n");
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;

/** Terminal-readable report. Ordered worst-first, because the failures are the point. */
export function formatEvalReport(report: EvalReport): string {
  const lines: string[] = [
    `${report.totals.caseCount} cases x ${report.runs} runs  (resolution ${percent(report.resolution)})`,
    `mean pass rate            ${percent(report.totals.meanPassRate)}`,
    `first-attempt valid       ${percent(report.totals.firstAttemptValidRate)}`,
    `false unsupported         ${report.totals.falseUnsupported}`,
    `false ready               ${report.totals.falseReady}`,
    `provider calls            ${report.totals.providerCalls}`,
    `estimated tokens          ${report.totals.estimatedTokens.toLocaleString()}`,
    `wall clock                ${report.totals.wallClockMs} ms`,
    "",
  ];

  const ranked = [...report.cases].sort((a, b) => a.passRate - b.passRate);
  for (const caseReport of ranked) {
    const flag = caseReport.unstable ? " UNSTABLE" : "";
    lines.push(`${percent(caseReport.passRate).padStart(4)}  ${caseReport.id}${flag}`);
    for (const [check, summary] of Object.entries(caseReport.checks)) {
      if (!summary || summary.passRate === 1) continue;
      lines.push(`        ${check} ${percent(summary.passRate)}`);
      for (const failure of summary.failures) {
        lines.push(`          - ${failure}`);
      }
    }
    const buckets = Object.entries(caseReport.failureBuckets);
    if (buckets.length > 0) {
      lines.push(
        `        invalid at: ${buckets.map(([bucket, count]) => `${bucket} x${count}`).join(", ")}`,
      );
    }
  }

  const distribution = Object.entries(report.selectionDistribution).sort(
    (a, b) => b[1] - a[1],
  );
  if (distribution.length > 0) {
    lines.push("", "capability selection distribution (bias check):");
    for (const [capabilityId, count] of distribution) {
      lines.push(`  ${String(count).padStart(4)}  ${capabilityId}`);
    }
  }

  return lines.join("\n");
}
