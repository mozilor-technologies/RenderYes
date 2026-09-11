import { sliceCapability, type CapabilitySlice, type DataContract } from "./inputs.js";
import {
  assembleStyleCorpus,
  detectConvention,
  detectFileExtension,
  listHostFiles,
  type HostConvention,
  type StyleCorpus,
} from "./style-corpus.js";
import { synthesizeSampleRows } from "./sample-rows.js";
import { buildSystemPrompt, buildUserPrompt, type GenerateEnvelope } from "./prompt.js";
import type { GenerateModelProvider } from "./provider.js";
import { generateWithRepair, type GenerateAttempt } from "./repair.js";
import { verifyDraft } from "./verify.js";
import {
  assertNoIdCollision,
  buildArtifacts,
  buildInvalidEnvelopeArtifacts,
  findRegistrationFiles,
  type EmittedArtifact,
} from "./emit.js";
import type { VerificationReport } from "./verify-report.js";

/**
 * The whole pipeline behind `renderyes-generate component`, as a function so
 * the CLI stays an argument parser and the tests drive the real thing.
 *
 * Order matters in two places. The id-collision refusal runs *before* any
 * model call (when the id is caller-chosen) and again at emission (the model
 * picks the id otherwise) — a collision is a refusal, never a repair round,
 * because "regenerate over the reviewed component" must not be a thing this
 * tool can be talked into. And verification runs inside the repair loop, so
 * what gets emitted is always the last verified-or-failing draft plus the
 * report that says which.
 */
export interface GenerateComponentOptions {
  contract: DataContract;
  capabilityId: string;
  provider: GenerateModelProvider;
  /** The host project directory. Style corpus, convention, and extension detection root here. */
  hostDir?: string;
  /** Explicit style-corpus files, replacing automatic assembly. */
  styleFiles?: readonly string[];
  convention?: HostConvention | "auto";
  /** Force the component id. Defaults to a name derived from the data type. */
  componentId?: string;
  maximumRepairRounds?: number;
  log?: (line: string) => void;
}

export interface GenerateComponentResult {
  pass: boolean;
  /**
   * Absent only when every round failed the envelope zod schema — the
   * artifacts then carry draft-invalid.json (raw output + issues) instead of
   * a component file, honouring "always emit, marked failing, for review".
   */
  envelope?: GenerateEnvelope;
  report?: VerificationReport;
  attempts: GenerateAttempt[];
  artifacts: EmittedArtifact[];
  slice: CapabilitySlice;
  corpus: StyleCorpus;
  convention: HostConvention;
  fileExtension: ".tsx" | ".jsx";
  rounds: number;
}

function defaultComponentId(slice: CapabilitySlice): string {
  const base = slice.dataType.id.replace(/[^A-Za-z0-9]/g, "");
  const capitalized = base.charAt(0).toUpperCase() + base.slice(1);
  const suffix = slice.capability.output.shape === "entity" ? "Detail" : "View";
  return `${capitalized}${suffix}`;
}

export async function generateComponent(
  options: GenerateComponentOptions,
): Promise<GenerateComponentResult> {
  const log = options.log ?? (() => {});
  const slice = sliceCapability(options.contract, options.capabilityId);
  const hostDir = options.hostDir ?? process.cwd();
  const hostFiles = listHostFiles(hostDir);

  const convention =
    options.convention && options.convention !== "auto"
      ? options.convention
      : detectConvention(hostDir, hostFiles);
  const fileExtension = detectFileExtension(hostDir);

  const componentId = options.componentId ?? defaultComponentId(slice);
  // Caller-chosen or derived, a colliding id is refused before spending a
  // single model call.
  assertNoIdCollision({ id: componentId, description: "pending", dataSlots: {} }, slice);

  const corpus = assembleStyleCorpus({
    hostDir,
    slice,
    ...(options.contract.uiManifest ? { uiManifest: options.contract.uiManifest } : {}),
    ...(options.styleFiles ? { overrideFiles: options.styleFiles } : {}),
  });
  log(
    `Style corpus: ${corpus.system}, ${corpus.pieces.length} piece(s), ${corpus.totalBytes} bytes` +
      (corpus.pieces.length > 0
        ? ` (${corpus.pieces.map((piece) => `${piece.kind}:${piece.path}`).join(", ")})`
        : ""),
  );
  log(`Convention: ${convention}; emitting ${componentId}.view${fileExtension}`);

  const sampleRows = synthesizeSampleRows({
    dataType: slice.dataType,
    requiredOutputFields: slice.requiredOutputFields,
  });

  const result = await generateWithRepair({
    provider: options.provider,
    systemPrompt: buildSystemPrompt(),
    userPrompt: buildUserPrompt({
      slice,
      corpus,
      convention,
      sampleRows,
      componentId,
      fileExtension,
    }),
    verify: (envelope) =>
      verifyDraft({
        envelope,
        slice,
        plannerManifest: options.contract.plannerManifest,
        ...(options.contract.uiManifest
          ? { uiManifest: options.contract.uiManifest }
          : {}),
        corpus,
        fileExtension,
        sampleRows,
      }),
    ...(options.maximumRepairRounds !== undefined
      ? { maximumRepairRounds: options.maximumRepairRounds }
      : {}),
    log,
  });

  if (!result.envelope || !result.report) {
    // No round ever validated. Emit the evidence anyway — the raw output and
    // the exact zod issues are reviewable; a bare refusal taught the first
    // live acceptance run's reviewer nothing about a draft that was one key
    // from valid.
    return {
      pass: false,
      attempts: result.attempts,
      artifacts: buildInvalidEnvelopeArtifacts({
        componentId,
        slice,
        attempts: result.attempts,
      }),
      slice,
      corpus,
      convention,
      fileExtension,
      rounds: result.attempts.length,
    };
  }

  const artifacts = buildArtifacts({
    envelope: result.envelope,
    slice,
    convention,
    fileExtension,
    report: result.report,
    sampleRows,
    rounds: result.attempts.length,
    hostDir,
    ...(convention === "listed" ? { registrationFiles: findRegistrationFiles(hostDir, hostFiles) } : {}),
    styleSystem: corpus.system,
    stylesheetText: corpus.stylesheetText,
  });

  return {
    pass: result.pass,
    envelope: result.envelope,
    report: result.report,
    attempts: result.attempts,
    artifacts,
    slice,
    corpus,
    convention,
    fileExtension,
    rounds: result.attempts.length,
  };
}
