export {
  loadDataContractFromDecisions,
  loadDataContractFromExport,
  sliceCapability,
} from "./inputs.js";
export type { ApprovalContractOptions, CapabilitySlice, DataContract } from "./inputs.js";

export {
  assembleStyleCorpus,
  detectConvention,
  detectFileExtension,
  detectStyleSystem,
  discoverPilotBespokeViews,
  listHostFiles,
  STYLE_CORPUS_BUDGET_BYTES,
} from "./style-corpus.js";
export type {
  HostConvention,
  HostFile,
  StyleCorpus,
  StyleCorpusPiece,
  StyleSystem,
} from "./style-corpus.js";

export {
  buildStateFixtures,
  synthesizeSampleRows,
  synthesizeSampleValue,
} from "./sample-rows.js";
export type { StateFixture, SynthesizeSampleRowsOptions } from "./sample-rows.js";

export {
  buildRepairPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  EnvelopeAcceptanceSchema,
  EnvelopeDataSlotSchema,
  EnvelopeSpecSchema,
  GENERATE_ENVELOPE_JSON_SCHEMA,
  GenerateEnvelopeSchema,
  SEMANTIC_TREATMENTS,
} from "./prompt.js";
export type { GenerateEnvelope, GenerateSpec } from "./prompt.js";

export {
  createGenerateModelProvider,
  createScriptedGenerateProvider,
  DEFAULT_API_KEY_ENVS,
  DEFAULT_MODELS,
} from "./provider.js";
export type {
  GenerateModelProvider,
  GenerateModelRequest,
  GenerateModelResult,
  ScriptedGenerateProvider,
} from "./provider.js";

export { verifyDraft } from "./verify.js";
export type { VerifyDraftOptions } from "./verify.js";
export { failingDetails } from "./verify-report.js";
export type {
  RenderedStateName,
  VerificationCheck,
  VerificationReport,
} from "./verify-report.js";

export { PREVIEW_STATE_ORDER, renderPreviewHtml } from "./preview.js";
export type { RenderPreviewHtmlOptions } from "./preview.js";

export { generateWithRepair } from "./repair.js";
export type {
  GenerateAttempt,
  GenerateWithRepairOptions,
  GenerateWithRepairResult,
} from "./repair.js";

export {
  assertNoIdCollision,
  buildArtifacts,
  buildInvalidEnvelopeArtifacts,
  buildRegistrationPatch,
  deriveTwinDefinition,
  findRegistrationFiles,
  GenerateRefusalError,
  renderTwinModule,
  renderVerificationReport,
  unifiedDiffForFile,
  writeArtifacts,
} from "./emit.js";
export type {
  BuildArtifactsOptions,
  BuildInvalidEnvelopeArtifactsOptions,
  EmittedArtifact,
  Insertion,
  RegistrationFiles,
  RegistrationPatchResult,
} from "./emit.js";

export { generateComponent } from "./generate.js";
export type { GenerateComponentOptions, GenerateComponentResult } from "./generate.js";

export { DEFAULT_GENERATE_TIMEOUT_SECONDS, runCli } from "./cli.js";
