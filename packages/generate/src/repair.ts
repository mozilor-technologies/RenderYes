import {
  buildRepairPrompt,
  GenerateEnvelopeSchema,
  GENERATE_ENVELOPE_JSON_SCHEMA,
  type GenerateEnvelope,
} from "./prompt.js";
import type { GenerateModelProvider } from "./provider.js";
import { failingDetails, type VerificationReport } from "./verify-report.js";

/**
 * The bounded repair loop: at most `1 + maximumRepairRounds` model calls,
 * feeding back the exact thrown/check messages — nothing paraphrased, because
 * a paraphrase is a second place for the checks' meaning to drift.
 *
 * Always finishes with whatever the last round produced. An emitted-but-
 * failing draft with a report saying exactly what failed is reviewable; a
 * tool that throws everything away after round 2 taught the reviewer nothing.
 */
export interface GenerateAttempt {
  round: number;
  /** Envelope-shape errors — set when the model's JSON failed the zod schema. */
  envelopeIssues?: string[];
  /**
   * The raw model output for an envelope-invalid round, kept so the caller can
   * still emit it for review when no round ever validates ("always emit,
   * marked failing").
   */
  rawValue?: unknown;
  envelope?: GenerateEnvelope;
  report?: VerificationReport;
}

export interface GenerateWithRepairOptions {
  provider: GenerateModelProvider;
  systemPrompt: string;
  userPrompt: string;
  verify: (envelope: GenerateEnvelope) => Promise<VerificationReport>;
  /** Repair rounds after the initial draft. Default 2, the plan's bound. */
  maximumRepairRounds?: number;
  log?: (line: string) => void;
}

export interface GenerateWithRepairResult {
  pass: boolean;
  /** The last envelope produced, failing or not. Absent only if every round returned malformed JSON. */
  envelope?: GenerateEnvelope;
  report?: VerificationReport;
  attempts: GenerateAttempt[];
}

export async function generateWithRepair(
  options: GenerateWithRepairOptions,
): Promise<GenerateWithRepairResult> {
  const maximumRepairRounds = options.maximumRepairRounds ?? 2;
  const log = options.log ?? (() => {});
  const attempts: GenerateAttempt[] = [];

  // Repair prompts are rebuilt from the ORIGINAL prompt every round: the data
  // contract, style corpus, and envelope example must stay in front of the
  // model, and only the latest envelope rides along (never a cumulative
  // history of componentFiles).
  const originalUserPrompt = options.userPrompt;
  let userPrompt = originalUserPrompt;
  let lastEnvelope: GenerateEnvelope | undefined;
  let lastReport: VerificationReport | undefined;

  for (let round = 0; round <= maximumRepairRounds; round += 1) {
    log(round === 0 ? "Drafting component…" : `Repair round ${round}…`);
    const { value } = await options.provider.generate({
      systemPrompt: options.systemPrompt,
      userPrompt,
      jsonSchema: GENERATE_ENVELOPE_JSON_SCHEMA,
    });

    const parsed = GenerateEnvelopeSchema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (issue) => `envelope.${issue.path.join(".")}: ${issue.message}`,
      );
      attempts.push({ round, envelopeIssues: issues, rawValue: value });
      log(`  envelope invalid (${issues.length} issue(s))`);
      if (round === maximumRepairRounds) break;
      userPrompt = buildRepairPrompt({
        originalUserPrompt,
        previousEnvelopeJson: JSON.stringify(value).slice(0, 20_000),
        failures: issues,
      });
      continue;
    }

    const envelope = parsed.data;
    lastEnvelope = envelope;
    const report = await options.verify(envelope);
    lastReport = report;
    attempts.push({ round, envelope, report });
    for (const check of report.checks) {
      log(`  ${check.pass ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
    }
    if (report.pass) {
      return { pass: true, envelope, report, attempts };
    }
    if (round === maximumRepairRounds) break;
    userPrompt = buildRepairPrompt({
      originalUserPrompt,
      previousEnvelopeJson: JSON.stringify(envelope),
      failures: failingDetails(report),
    });
  }

  return {
    pass: false,
    ...(lastEnvelope ? { envelope: lastEnvelope } : {}),
    ...(lastReport ? { report: lastReport } : {}),
    attempts,
  };
}
