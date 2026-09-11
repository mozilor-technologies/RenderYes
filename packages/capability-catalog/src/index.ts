export {
  CATALOG_ID_PATTERN,
  CapabilityCatalogSchema,
  CapabilityDescriptorSchema,
  CapabilityExecutionErrorSchema,
  CapabilityFailureResultSchema,
  CapabilitySuccessResultSchema,
  DataTypeDescriptorSchema,
  FreshnessSchema,
  ProvenanceSchema,
  RelationshipDescriptorSchema,
  ResultShapeSchema,
  SemanticTypeSchema,
  SourceDescriptorSchema,
  SourceReferenceSchema,
} from "./schema.js";
export type {
  CapabilityCatalog,
  CapabilityDescriptor,
  CapabilityExecutionError,
  CapabilityExecutionResult,
  CapabilityFailureResult,
  CapabilityPolicy,
  CapabilityResult,
  CapabilitySuccessResult,
  CapabilitySupport,
  DataProvenance,
  DataTypeDescriptor,
  FieldDescriptor,
  Freshness,
  JsonSchema,
  RelationshipDescriptor,
  ResultShape,
  SemanticType,
  SourceDescriptor,
  SourceReference,
} from "./schema.js";
export {
  assertCapabilityCatalog,
  createPlannerManifest,
  findCapability,
  hashCapabilityCatalog,
  isListResultShape,
  validateCapabilityCatalogDefinition,
  CatalogDefinitionError,
} from "./compile.js";
export {
  MemoryOperationClassificationCache,
  OperationClassificationInputSchema,
  OperationClassificationResultSchema,
  OperationEffectSchema,
  classifyOperationEffects,
  createLlmOperationEffectClassifier,
  hashOperationClassificationInput,
} from "./operation-effect.js";
export type {
  OperationClassificationCache,
  OperationClassificationInput,
  OperationClassificationModelProvider,
  OperationClassificationResult,
  OperationEffect,
  OperationEffectClassifier,
  ResolvedOperationClassification,
} from "./operation-effect.js";
export type { CatalogIssue, PlannerCapability, PlannerManifest } from "./compile.js";
export {
  DEFAULT_MAX_ROWS,
  NUMERIC_SEMANTIC_TYPES,
  createDataPlanningContract,
  declaredFieldEnumValues,
  effectiveLimitCeiling,
  pagingArgumentCap,
} from "./planning-contract.js";
export type { DataPlanningContract } from "./planning-contract.js";
export {
  DEFAULT_CONTRACT_TOKEN_BUDGET,
  describeContractCost,
  judgeContractCost,
} from "./contract-cost.js";
export type {
  CapabilityContractCost,
  ContractBudgetVerdict,
  ContractCost,
  ContractCostFacet,
  ContractFacetCost,
} from "./contract-cost.js";
export {
  ORDERING_FIELD_TOKEN,
  canPushOrdering,
  renderOrderingValue,
} from "./ordering.js";
export type { OrderingPushdown, OrderingRequest } from "./ordering.js";
export {
  canPushFilter,
  describeFilterRefusal,
  isFilterGroup,
  renderFilterValue,
} from "./filter-pushdown.js";
export type {
  FilterCondition,
  FilterFieldPushdown,
  FilterGroup,
  FilterOperator,
  FilterPushdown,
  FilterPushdownRefusal,
  FilterPushdownResult,
} from "./filter-pushdown.js";
export { suggestFieldSemanticTypes } from "./semantic-suggestion.js";
export { proposeApprovedFields, proposedPaths } from "./field-selection.js";
export type {
  FieldSelectionModelProvider,
  FieldSelectionProposal,
  ProposableField,
  ProposalCapabilityContext,
} from "./field-selection.js";
export {
  buildGraphQlReviewExport,
  REVIEW_EXPORT_FORMAT,
  REVIEW_EXPORT_VERSION,
  ReviewExportEnvelopeSchema,
} from "./review-export.js";
export type { ReviewExport } from "./review-export.js";
export type {
  DecidableSemanticType,
  SemanticSuggestionField,
  SemanticSuggestionModelProvider,
  SemanticTypeSuggestion,
} from "./semantic-suggestion.js";

/**
 * The contracts a host implements, re-exported from the package root.
 *
 * Their implementations stay on the subpaths that own them — `/server` for the
 * manual catalog, `/graphql` for the transport — because those carry runtime
 * code a consumer should opt into. Types are erased at build, so naming them
 * here costs nothing at runtime and is the difference between a host finding
 * the interface and concluding the package cannot do custom backends.
 */
export type {
  CapabilityExecutionContext,
  CapabilityRuntime,
  ManualCapabilityRegistration,
  ManualDataTypeRegistration,
} from "./manual.js";
export type { GraphQlTransport } from "./graphql.js";
