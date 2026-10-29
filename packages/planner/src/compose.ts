import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import type { PlannerManifest } from "@renderyes/capability-catalog";
import {
  isRecord,
  type ClarificationCandidate,
  type DataComposition,
  type DataJoin,
  type DataRequest,
  type SurfaceNode,
  type PlanV3_1,
  type PlanProvider,
  type PlanProviderRequest,
} from "@renderyes/core";
import { validateDataRequestQuery } from "@renderyes/data-runtime";
import {
  validatePlanDataBindings,
  type DataBindingValidationResult,
  type RegisteredSite,
} from "@renderyes/site-sdk";
import {
  createPlanContract,
  UNSUPPORTED_REASON_PLACEHOLDER,
  type PlanContract,
} from "./contract.js";

export interface ComposeDataPlanInput {
  site: RegisteredSite;
  plannerManifest: PlannerManifest;
  surfaceId: string;
  prompt: string;
  provider: PlanProvider;
  previousPlan?: PlanV3_1;
  maxRetries?: number;
  /**
   * Absolute wall-clock ceiling for the whole planning phase, in milliseconds,
   * shared across every attempt rather than applied per call.
   *
   * Without this the budget multiplied out: each provider call carries its own
   * 60s timeout, a structured-schema rejection retries once inside a single
   * `generatePlan`, and this loop repairs up to twice — so the worst case was
   * six billed model calls and roughly six minutes of server work, against a
   * browser that gave up after 45 seconds. Every second past the point the
   * caller stopped listening is spend with no possible recipient.
   *
   * Checked before starting each attempt, not mid-flight: a call already in
   * progress has already been paid for, so aborting it saves nothing and only
   * discards a result that might have been the good one.
   */
  deadlineMs?: number;
  createId?: () => string;
  now?: () => Date;
  /**
   * Whether the planner may answer with a question. Defaults to true; set
   * false when this prompt is itself the answer to one. See
   * `CreatePlanContractOptions.allowClarification`.
   */
  allowClarification?: boolean;
  /**
   * The approved capability the visitor picked from a clarification's
   * candidates. Carried to the provider as `planning.chosenCapabilityId`, and
   * stated in the user prompt for a provider that reads prose. A deterministic
   * provider plans this capability directly, with no decision call; a
   * language model is told which capability to use. Pair it with
   * `allowClarification: false`, since the pick is itself the answer.
   */
  chosenCapabilityId?: string;
}

export interface DataPlanIssue {
  path: string;
  message: string;
}

/**
 * What this call is planning, stated as data rather than prose.
 *
 * A provider used to receive only the rendered contract — a system prompt and
 * a JSON Schema — and the visitor's words already folded into a user prompt
 * that may also carry a previous plan or a repair transcript. That is the
 * right input for a language model and useless to anything else: a
 * deterministic classifier cannot read the capability list back out of a
 * paragraph, and cannot tell a first attempt from a repair. This block states
 * those facts once, alongside the prompts, so a provider that does not read
 * prose can still decide — and one that does can ignore it.
 *
 * Nothing here widens what a provider may see. The manifest is the same
 * planner-safe projection the system prompt was rendered from (no session
 * keys, no endpoints, no rows), and the site is the component contract the
 * schema was compiled from.
 */
export interface PlanningContext {
  /** The visitor's own words, before any revision or repair framing. */
  prompt: string;
  surfaceId: string;
  /**
   * `initial` — a fresh compose. `revision` — the prompt changes a plan already
   * on screen. `clarification-answer` — the prompt answers a question the
   * planner asked. `repair` — the previous draft failed validation and the user
   * prompt now carries the issues.
   */
  stage: "initial" | "revision" | "clarification-answer" | "repair";
  /** 0 on the first attempt; 1+ on repair attempts. */
  attempt: number;
  /** The planner-safe manifest the contract was built from. */
  plannerManifest: PlannerManifest;
  /**
   * The capability ids the contract actually advertises after surface scoping,
   * sorted. A capability outside this list cannot be bound on this surface.
   */
  capabilityIds: readonly string[];
  /** The registered site whose components the contract offers. */
  site: RegisteredSite;
  /**
   * Set when the visitor picked this capability from a clarification's
   * candidates. Always one of `capabilityIds`. A provider that can plan a
   * capability without reading prose should plan this one and ask nothing.
   */
  chosenCapabilityId?: string;
}

/** The request `composeDataPlan` hands a provider: the core shape plus the planning context. */
export interface DataPlanProviderRequest extends PlanProviderRequest {
  planning: PlanningContext;
}

export type ComposeDataPlanResult =
  | { ok: true; plan: PlanV3_1 }
  /**
   * The planner is asking the visitor something before it commits.
   *
   * `ok: false` because no plan was produced, but this is not a failure and
   * must not be reported as one: the catalog can answer, and the model is
   * saying it would have to guess which answer. `reason` carries the question
   * so a consumer that only knows the older shape still shows the visitor
   * something true.
   */
  | {
      ok: false;
      kind: "needs-clarification";
      question: string;
      /** Two to four suggested answers, when the question has a closed set. */
      options?: readonly string[];
      /**
       * Present when the question is "which approved capability did you
       * mean". Every entry names a capability the contract advertises — the
       * provider's list is checked here and anything else is dropped — so a
       * caller can resubmit the prompt with `chosenCapabilityId` set to one.
       */
      candidates?: readonly ClarificationCandidate[];
      reason: string;
      issues: DataPlanIssue[];
      fallbackPlan: PlanV3_1 | null;
    }
  | {
      ok: false;
      kind: "unsupported" | "invalid" | "provider-error";
      reason: string;
      issues: DataPlanIssue[];
      fallbackPlan: PlanV3_1 | null;
    };

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

interface CompiledContract {
  contract: PlanContract;
  validateDraft: ValidateFunction;
}

/**
/**
 * Building the contract and compiling its schema is pure work over inputs that
 * change only when a catalog is republished or a component is re-registered -
 * yet it ran on every visitor prompt, and `ajv.compile` over a contract with a
 * `oneOf` per component and an `anyOf` per capability is the most expensive
 * deterministic step in the request.
 *
 * Keyed on the **identity** of the manifest and site objects, not on their
 * declared ids and hashes. A string key built from `catalogHash` looked more
 * explicit but is unsound: nothing forces a host - or a test fixture spreading
 * one manifest into another - to give two structurally different manifests
 * different hashes, and the first version of this cache duly served a
 * join-less contract to a join-capable manifest. Identity cannot collide, needs
 * no hashing, and changes exactly when a catalog is republished, which is
 * precisely when the contract must be rebuilt.
 *
 * The trade-off: a host that reconstructs its manifest object on every request
 * gets no hits. `@renderyes/server` holds one stable registered object per
 * published catalog, which is the intended shape. Both outer maps are weak, so
 * an unpublished catalog's compiled schema is collected along with it.
 */
const contractCache = new WeakMap<
  PlannerManifest,
  WeakMap<RegisteredSite, Map<string, CompiledContract>>
>();

function compiledContract(input: ComposeDataPlanInput): CompiledContract {
  let bySite = contractCache.get(input.plannerManifest);
  if (!bySite) {
    bySite = new WeakMap();
    contractCache.set(input.plannerManifest, bySite);
  }
  let bySurface = bySite.get(input.site);
  if (!bySurface) {
    bySurface = new Map();
    bySite.set(input.site, bySurface);
  }
  // The clarification branch is part of the key, not just of the contract: a
  // compose that is answering a question compiles a schema without that branch,
  // and serving it the cached with-branch schema would reopen the loop the flag
  // exists to close.
  const key = `${input.surfaceId}:${input.allowClarification === false ? "no-ask" : "ask"}`;
  const cached = bySurface.get(key);
  if (cached) return cached;

  const contract = createPlanContract(input.site, input.plannerManifest, {
    surfaceId: input.surfaceId,
    ...(input.allowClarification === false ? { allowClarification: false } : {}),
  });
  const compiled: CompiledContract = {
    contract,
    validateDraft: ajv.compile(contract.jsonSchema),
  };
  bySurface.set(key, compiled);
  return compiled;
}

/**
 * Composes and validates a request-bound Plan 3.1 without executing any
 * capability. Provider output is treated as untrusted: it must pass the closed
 * generated JSON Schema, core/site binding validation, and query semantics.
 */
export async function composeDataPlan(
  input: ComposeDataPlanInput,
): Promise<ComposeDataPlanResult> {
  const { contract, validateDraft } = compiledContract(input);
  const maxRetries = input.maxRetries ?? 2;
  const startedAt = Date.now();
  const deadlineMs = input.deadlineMs;
  // The previous plan has always been carried into this function and used only
  // as `fallbackPlan` — the thing to return when planning fails. The model
  // never saw it, so a "revision" was a fresh compose with the old view held in
  // reserve: "now just Europe" was planned with no knowledge of what was on
  // screen, and worked only when the new sentence happened to be self-
  // sufficient. Preserving what the visitor did not ask to change, and adding
  // to a view rather than replacing it, were both impossible for the same
  // reason.
  let userPrompt = withChosenCapability(
    input.previousPlan ? buildRevisionPrompt(input.prompt, input.previousPlan) : input.prompt,
    input.chosenCapabilityId,
  );
  let lastIssues: DataPlanIssue[] = [];
  let lastFailureKind: "invalid" | "provider-error" = "invalid";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // A repair is only worth starting if there is time left to deliver it.
    if (attempt > 0 && deadlineMs !== undefined && Date.now() - startedAt >= deadlineMs) {
      return {
        ok: false,
        kind: lastFailureKind,
        reason: `Planning exceeded its ${deadlineMs}ms budget after ${attempt} attempt(s). ${summarizeIssues(lastIssues)}`,
        issues: lastIssues,
        fallbackPlan: input.previousPlan ?? null,
      };
    }
    let completion: Awaited<ReturnType<PlanProvider["generatePlan"]>>;
    const request: DataPlanProviderRequest = {
      systemPrompt: contract.systemPrompt,
      userPrompt,
      jsonSchema: contract.jsonSchema,
      planning: {
        prompt: input.prompt,
        surfaceId: input.surfaceId,
        stage:
          attempt > 0
            ? "repair"
            : input.previousPlan
              ? "revision"
              : input.allowClarification === false
                ? "clarification-answer"
                : "initial",
        attempt,
        plannerManifest: input.plannerManifest,
        capabilityIds: contract.capabilityIds,
        site: input.site,
        ...(input.chosenCapabilityId &&
        contract.capabilityIds.includes(input.chosenCapabilityId)
          ? { chosenCapabilityId: input.chosenCapabilityId }
          : {}),
      },
    };
    try {
      completion = await input.provider.generatePlan(request);
    } catch {
      lastFailureKind = "provider-error";
      lastIssues = [
        {
          path: "/",
          message: "The plan provider failed to return a result",
        },
      ];
      if (attempt < maxRetries) continue;
      break;
    }

    // A question's `candidates` ride beside the contract rather than inside
    // it: the closed schema is what the language model is decoded against,
    // and a capability-id list is not something a model should be invited to
    // write. They are split off here, checked against the advertised ids
    // below, and the rest of the draft is validated exactly as before.
    const { candidates: offeredCandidates, draft: draftValue } = splitCandidates(
      completion.value,
    );
    if (!validateDraft(draftValue)) {
      lastFailureKind = "invalid";
      lastIssues = issuesFromAjv(validateDraft);
    } else if (isRecord(completion.value) && completion.value.status === "unsupported") {
      const reason = String(completion.value.reason ?? "").trim();
      // A refusal that parrots the contract's own example is not a decision
      // about this request — a model once told a visitor asking about recipes
      // that their site can't render driver locations on a map, verbatim from
      // the example. Template text in the reason means the model copied
      // instead of answering, so it goes through the same repair loop as any
      // other invalid draft rather than reaching the visitor.
      if (reason === UNSUPPORTED_REASON_PLACEHOLDER || /<[^<>]+>/.test(reason)) {
        lastFailureKind = "invalid";
        lastIssues = [
          {
            path: "/reason",
            message:
              "The unsupported reason restated the contract's placeholder. Either compose a plan from the approved capabilities, or refuse with a reason that names what this specific request needs and the catalogs lack.",
          },
        ];
      } else {
        return {
          ok: false,
          kind: "unsupported",
          reason,
          issues: [],
          fallbackPlan: input.previousPlan ?? null,
        };
      }
    } else if (
      isRecord(completion.value) &&
      completion.value.status === "needs-clarification"
    ) {
      // Returned immediately, never repaired. The repair loop exists to fix a
      // plan that failed validation; a question is a valid answer, and resending
      // the whole contract to argue with it would cost a second full model call
      // to arrive back here.
      const options = Array.isArray(completion.value.options)
        ? completion.value.options.filter(
            (option): option is string => typeof option === "string",
          )
        : undefined;
      const candidates = advertisedCandidates(offeredCandidates, contract.capabilityIds);
      return {
        ok: false,
        kind: "needs-clarification",
        question: String(completion.value.question),
        ...(options && options.length > 0 ? { options } : {}),
        ...(candidates.length > 0 ? { candidates } : {}),
        reason: String(completion.value.question),
        issues: [],
        fallbackPlan: input.previousPlan ?? null,
      };
    } else if (isReadyDraft(completion.value)) {
      const candidate = createCandidatePlan(input, completion, attempt);
      // `validateCandidate` already runs `validatePlanDataBindings` and folds
      // its issues in, so it returns the result rather than making the caller
      // run that whole pass a second time to get the validated plan back.
      const { issues, bindings } = validateCandidate(input, candidate);
      if (issues.length === 0 && bindings.ok && bindings.plan.schemaVersion === "3.1") {
        return { ok: true, plan: bindings.plan };
      }
      lastFailureKind = "invalid";
      lastIssues = issues;
    } else {
      lastFailureKind = "invalid";
      lastIssues = [
        {
          path: "/",
          message: "Provider output did not contain a supported plan draft",
        },
      ];
    }

    if (attempt < maxRetries) {
      userPrompt = buildRepairPrompt(
        withChosenCapability(
          input.previousPlan
            ? buildRevisionPrompt(input.prompt, input.previousPlan)
            : input.prompt,
          input.chosenCapabilityId,
        ),
        lastIssues,
      );
    }
  }

  return {
    ok: false,
    kind: lastFailureKind,
    reason: summarizeIssues(lastIssues),
    issues: lastIssues,
    fallbackPlan: input.previousPlan ?? null,
  };
}

/**
 * The visitor's pick, stated for a provider that reads prose. Deterministic
 * text, written once here, so a language model behind a clarification sees
 * the same sentence every time and a test can match it.
 */
function withChosenCapability(prompt: string, capabilityId: string | undefined): string {
  if (!capabilityId) return prompt;
  return `${prompt}\n\nThe visitor chose the capability "${capabilityId}" for this request. Use that capability.`;
}

/** A needs-clarification draft's `candidates`, split from the draft the schema sees. */
function splitCandidates(value: unknown): { candidates: unknown; draft: unknown } {
  if (!isRecord(value) || value.status !== "needs-clarification" || !("candidates" in value)) {
    return { candidates: undefined, draft: value };
  }
  const { candidates, ...draft } = value;
  return { candidates, draft };
}

/** Ceiling on a candidate label: the same as a clarification option. */
const MAX_CANDIDATE_LABEL_LENGTH = 60;

/**
 * The offered candidates that name an advertised capability, de-duplicated,
 * with labels bounded. Anything else is dropped rather than reported: a
 * candidate the surface cannot bind is not a choice the visitor can make.
 */
function advertisedCandidates(
  offered: unknown,
  capabilityIds: readonly string[],
): ClarificationCandidate[] {
  if (!Array.isArray(offered)) return [];
  const seen = new Set<string>();
  const kept: ClarificationCandidate[] = [];
  for (const entry of offered) {
    if (!isRecord(entry)) continue;
    const { capabilityId, label } = entry;
    if (typeof capabilityId !== "string" || !capabilityIds.includes(capabilityId)) continue;
    if (seen.has(capabilityId)) continue;
    const text = typeof label === "string" ? label.replace(/\s+/g, " ").trim() : "";
    if (!text) continue;
    seen.add(capabilityId);
    kept.push({
      capabilityId,
      label:
        text.length > MAX_CANDIDATE_LABEL_LENGTH
          ? `${text.slice(0, MAX_CANDIDATE_LABEL_LENGTH - 1).trimEnd()}…`
          : text,
    });
  }
  return kept;
}

interface ReadyDraft {
  status: "ready";
  dataRequests: DataRequest[];
  dataCompositions?: DataComposition[];
  dataJoins?: DataJoin[];
  nodes: SurfaceNode[];
}

function isReadyDraft(value: unknown): value is ReadyDraft {
  return (
    isRecord(value) &&
    value.status === "ready" &&
    Array.isArray(value.dataRequests) &&
    (value.dataCompositions === undefined || Array.isArray(value.dataCompositions)) &&
    (value.dataJoins === undefined || Array.isArray(value.dataJoins)) &&
    Array.isArray(value.nodes)
  );
}

function createCandidatePlan(
  input: ComposeDataPlanInput,
  completion: Awaited<ReturnType<PlanProvider["generatePlan"]>>,
  repairCount: number,
): PlanV3_1 {
  const draft = completion.value as ReadyDraft;
  return {
    schemaVersion: "3.1",
    planId: (input.createId ?? defaultId)(),
    siteId: input.site.id,
    sourcePrompt: input.prompt,
    catalog: {
      id: input.site.catalog.id,
      version: input.site.catalog.version,
      fingerprint: input.site.catalog.fingerprint,
    },
    dataCatalog: {
      id: input.plannerManifest.catalogId,
      version: input.plannerManifest.catalogVersion,
      hash: input.plannerManifest.catalogHash,
    },
    dataRequests: draft.dataRequests,
    ...(draft.dataCompositions?.length
      ? { dataCompositions: draft.dataCompositions }
      : {}),
    ...(draft.dataJoins?.length ? { dataJoins: draft.dataJoins } : {}),
    surfaces: [{ id: input.surfaceId, nodes: draft.nodes }],
    generation: {
      providerId: input.provider.id,
      modelId: completion.modelId,
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
      repairCount,
      ...(completion.constrainedDecoding !== undefined
        ? { constrainedDecoding: completion.constrainedDecoding }
        : {}),
    },
  };
}

interface CandidateEvaluation {
  issues: DataPlanIssue[];
  bindings: DataBindingValidationResult;
}

/**
 * What plan validation actually reads: the registered site, the planner
 * manifest, and which surface the plan targets. `ComposeDataPlanInput`
 * satisfies it structurally, which is what lets `composeDataPlan` and
 * `validateComposedPlan` share one validation pass instead of two that drift.
 */
export interface PlanValidationInput {
  site: RegisteredSite;
  plannerManifest: PlannerManifest;
  surfaceId: string;
}

/**
 * Runs the exact deterministic validation a model-produced plan passes inside
 * `composeDataPlan` — surface membership, slot bindings at every depth,
 * composition and join semantics, and query legality — against a plan built
 * some other way.
 *
 * Exists for plans the server *derives* from an already-validated one (e.g.
 * slicing a saved pin down to one node): such a plan never goes back through
 * the model loop, but storing it unvalidated would mean the first check it
 * ever meets is execution on reopen. An empty array means the plan passes.
 */
export function validateComposedPlan(
  input: PlanValidationInput,
  plan: PlanV3_1,
): DataPlanIssue[] {
  return validateCandidate(input, plan).issues;
}

function validateCandidate(
  input: PlanValidationInput,
  candidate: PlanV3_1,
): CandidateEvaluation {
  const issues: DataPlanIssue[] = [];
  const surface = input.site.getSurface(input.surfaceId);
  if (!surface) {
    return {
      issues: [
        {
          path: "surfaces.0.id",
          message: `Unknown site surface ${input.surfaceId}`,
        },
      ],
      // An unknown surface means there is nothing to bind against, so this
      // never reaches the compatibility pass; `invalid-plan` is the existing
      // code for "the plan could not be interpreted at all".
      bindings: {
        ok: false,
        issues: [
          {
            code: "invalid-plan",
            path: "surfaces.0.id",
            message: `Unknown site surface ${input.surfaceId}`,
          },
        ],
      },
    };
  }
  if (
    surface.maxComponents !== undefined &&
    candidate.surfaces[0].nodes.length > surface.maxComponents
  ) {
    issues.push({
      path: "surfaces.0.nodes",
      message: `Surface ${surface.id} allows at most ${surface.maxComponents} components`,
    });
  }

  const referencedRequestIds = new Set<string>();
  const referencedCompositionIds = new Set<string>();
  const referencedJoinIds = new Set<string>();
  // Two node instances whose data slots resolve to the same registered
  // renderer path used to be rejected here, because both would project to
  // one immutable data-model location and the executor would throw. That is
  // no longer possible: `projectPlanDataModel` and `compileSurfaceMessages`
  // now scope every executor-written path by the owning node's id (see
  // `scopedDataPath` in `@renderyes/site-sdk`), and `defineComponent`
  // statically rejects a single component binding two renderer props to the
  // same path — the one collision scoping cannot prevent.
  //
  // Keeping the guard would now reject valid plans: two instances of one
  // component bound to different requests is exactly how a "compare A vs B"
  // view is expressed, and it renders correctly.
  //
  // Walk the whole node tree, not just top-level nodes: a component's declared
  // slot may contain further approved components as children (core/site-sdk
  // already validate slot cardinality, `accepts`, depth, and node-count limits
  // structurally once `validatePlanDataBindings` runs below). This planner-level
  // pass only checks what core cannot: surface membership, and that every data
  // slot at every depth is bound.
  function visitNode(node: SurfaceNode, path: string): void {
    if (!surface!.componentIds.includes(node.componentId)) {
      issues.push({
        path: `${path}.componentId`,
        message: `Component ${node.componentId} is not allowed on surface ${surface!.id}`,
      });
    }
    const component = input.site.getComponent(node.componentId);
    const dataSlotNames = Object.keys(component?.dataSlots ?? {});
    for (const slotName of dataSlotNames) {
      const binding = node.dataBindings?.[slotName];
      if (
        !binding ||
        (!("requestId" in binding) &&
          !("compositionId" in binding) &&
          !("joinId" in binding))
      ) {
        issues.push({
          path: `${path}.dataBindings.${slotName}`,
          message: `Component ${node.componentId}.${slotName} requires a request, composition, or join binding`,
        });
      }
    }
    for (const binding of Object.values(node.dataBindings ?? {})) {
      if ("requestId" in binding) referencedRequestIds.add(binding.requestId);
      if ("compositionId" in binding) {
        referencedCompositionIds.add(binding.compositionId);
      }
      if ("joinId" in binding) referencedJoinIds.add(binding.joinId);
    }
    for (const [slotName, children] of Object.entries(node.slots ?? {})) {
      for (const [childIndex, child] of children.entries()) {
        visitNode(child, `${path}.slots.${slotName}.${childIndex}`);
      }
    }
  }
  for (const [nodeIndex, node] of candidate.surfaces[0].nodes.entries()) {
    visitNode(node, `surfaces.0.nodes.${nodeIndex}`);
  }
  const requestsById = new Map(
    candidate.dataRequests.map((request) => [request.requestId, request]),
  );
  for (const [compositionIndex, composition] of (
    candidate.dataCompositions ?? []
  ).entries()) {
    const compositionPath = `dataCompositions.${compositionIndex}`;
    if (!referencedCompositionIds.has(composition.compositionId)) {
      issues.push({
        path: `${compositionPath}.compositionId`,
        message: `Data composition ${composition.compositionId} is not bound to a component`,
      });
    }
    issues.push(
      ...validateComposition(input.plannerManifest, composition, requestsById).map(
        (issue) => ({
          path: `${compositionPath}.${issue.path}`,
          message: issue.message,
        }),
      ),
    );
    for (const requestId of composition.inputs) {
      referencedRequestIds.add(requestId);
    }
  }

  for (const [joinIndex, join] of (candidate.dataJoins ?? []).entries()) {
    const joinPath = `dataJoins.${joinIndex}`;
    if (!referencedJoinIds.has(join.joinId)) {
      issues.push({
        path: `${joinPath}.joinId`,
        message: `Data join ${join.joinId} is not bound to a component`,
      });
    }
    issues.push(
      ...validateJoin(input.plannerManifest, join, requestsById).map((issue) => ({
        path: `${joinPath}.${issue.path}`,
        message: issue.message,
      })),
    );
    // A join's inputs are consumed by the join, not bound directly to UI.
    referencedRequestIds.add(join.left);
    referencedRequestIds.add(join.right);
  }

  const bindings = validatePlanDataBindings(input.site, candidate, input.plannerManifest);
  if (!bindings.ok) {
    issues.push(
      ...bindings.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    );
  }

  for (const [requestIndex, request] of candidate.dataRequests.entries()) {
    const requestPath = `dataRequests.${requestIndex}`;
    if (!referencedRequestIds.has(request.requestId)) {
      issues.push({
        path: `${requestPath}.requestId`,
        message: `Data request ${request.requestId} is not bound to a component`,
      });
    }
    const query = validateDataRequestQuery(input.plannerManifest, request);
    if (!query.ok) {
      issues.push(
        ...query.issues.map((issue) => ({
          path: `${requestPath}.${issue.path}`,
          message: issue.message,
        })),
      );
    }
  }

  return { issues: deduplicateIssues(issues), bindings };
}

function validateComposition(
  manifest: PlannerManifest,
  composition: DataComposition,
  requestsById: Map<string, DataRequest>,
): DataPlanIssue[] {
  const issues: DataPlanIssue[] = [];
  const capabilities = new Map(
    manifest.capabilities.map((capability) => [capability.id, capability]),
  );
  let dataTypeId: string | undefined;

  for (const [index, requestId] of composition.inputs.entries()) {
    const request = requestsById.get(requestId);
    if (!request) {
      issues.push({
        path: `inputs.${index}`,
        message: `Composition input ${requestId} is not a declared data request`,
      });
      continue;
    }
    const capability = capabilities.get(request.capabilityId);
    if (!capability) {
      issues.push({
        path: `inputs.${index}`,
        message: `Capability ${request.capabilityId} is not approved by the planner manifest`,
      });
      continue;
    }
    if (!capability.supports?.setOperations?.includes(composition.operation)) {
      issues.push({
        path: `operation`,
        message: `Capability ${capability.id} does not advertise ${composition.operation} composition`,
      });
    }
    if (dataTypeId === undefined) {
      dataTypeId = capability.output.dataTypeId;
    } else if (dataTypeId !== capability.output.dataTypeId) {
      issues.push({
        path: `inputs.${index}`,
        message: `Composition inputs must share one output data type; found ${dataTypeId} and ${capability.output.dataTypeId}`,
      });
    }
  }

  if (!dataTypeId || !composition.query) return issues;
  const fields = new Set(
    Object.keys(
      manifest.dataTypes.find((dataType) => dataType.id === dataTypeId)?.fields ?? {},
    ),
  );
  for (const [index, sort] of (composition.query.sort ?? []).entries()) {
    if (!fields.has(sort.field)) {
      issues.push({
        path: `query.sort.${index}.field`,
        message: `Composition sort field ${sort.field} is not exposed by ${dataTypeId}`,
      });
    }
  }
  for (const [index, field] of (composition.query.project ?? []).entries()) {
    if (!fields.has(field)) {
      issues.push({
        path: `query.project.${index}`,
        message: `Composition projection field ${field} is not exposed by ${dataTypeId}`,
      });
    }
  }
  return issues;
}

const JOIN_TO_ONE_CARDINALITIES = new Set(["one-to-one", "many-to-one"]);

/**
 * Mirrors the deterministic runtime join checks (`joinOne` in
 * `@renderyes/data-runtime`) so a planner-accepted join is guaranteed to be
 * runtime-executable: the relationship must exist and be to-one, both request
 * inputs must be declared, and their capability output data types must match the
 * relationship's `from`/`to` sides. Without this, an invalid relationship would
 * pass planner validation and only fail (as an error state) at execution.
 */
function validateJoin(
  manifest: PlannerManifest,
  join: DataJoin,
  requestsById: Map<string, DataRequest>,
): DataPlanIssue[] {
  const issues: DataPlanIssue[] = [];
  const relationship = manifest.relationships.find(
    (candidate) => candidate.id === join.relationshipId,
  );
  if (!relationship) {
    issues.push({
      path: "relationshipId",
      message: `Relationship ${join.relationshipId} is not approved by the planner manifest`,
    });
    return issues;
  }
  if (!JOIN_TO_ONE_CARDINALITIES.has(relationship.cardinality)) {
    issues.push({
      path: "relationshipId",
      message: `Relationship ${relationship.id} is ${relationship.cardinality}; only to-one joins are supported`,
    });
  }

  const capabilities = new Map(
    manifest.capabilities.map((capability) => [capability.id, capability]),
  );
  const sides: Array<["left" | "right", string, string]> = [
    ["left", join.left, relationship.fromDataTypeId],
    ["right", join.right, relationship.toDataTypeId],
  ];
  for (const [side, requestId, expectedDataTypeId] of sides) {
    const request = requestsById.get(requestId);
    if (!request) {
      issues.push({
        path: side,
        message: `Join ${side} ${requestId} is not a declared data request`,
      });
      continue;
    }
    const capability = capabilities.get(request.capabilityId);
    if (!capability) {
      issues.push({
        path: side,
        message: `Capability ${request.capabilityId} is not approved by the planner manifest`,
      });
      continue;
    }
    if (capability.output.dataTypeId !== expectedDataTypeId) {
      issues.push({
        path: side,
        message: `Join ${side} produces ${capability.output.dataTypeId}, but relationship ${relationship.id} requires ${expectedDataTypeId}`,
      });
    }
  }
  return issues;
}

function issuesFromAjv(validate: ValidateFunction): DataPlanIssue[] {
  // These become the repair prompt. Two properties matter there: an enum
  // violation must NAME the allowed values ("must be equal to one of the
  // allowed values" invites another guess; the list ends the guessing), and
  // a oneOf failure must not flood the prompt — ajv reports every branch of
  // every alternative, which for one bad filter condition is a dozen lines of
  // contradictory advice. Deduplicated per path+message.
  return deduplicateIssues(
    (validate.errors ?? []).map((error: ErrorObject) => {
      const allowed = (error.params as { allowedValues?: unknown[] } | undefined)
        ?.allowedValues;
      const suffix = Array.isArray(allowed)
        ? `: ${allowed.map((value) => JSON.stringify(value)).join(", ")}`
        : "";
      return {
        path: error.instancePath || "/",
        message: `${error.message ?? "Invalid provider output"}${suffix}`,
      };
    }),
  );
}

function deduplicateIssues(issues: DataPlanIssue[]): DataPlanIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.path}\0${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The visitor's words plus the view they are looking at.
 *
 * Carries the plan's *structure* — data requests and nodes — and never the rows
 * behind it: the model decides what to render, not what the data says, and the
 * fetched result can be large, stale by the time it is read, and is exactly the
 * content that must not re-enter the model.
 *
 * The instruction matters as much as the plan. Without "keep what was not
 * mentioned" the model rewrites the view from the new sentence alone, which is
 * the behaviour this replaces; without "you may add" it treats every revision
 * as a replacement, so "add a chart beside it" loses the table.
 */
function buildRevisionPrompt(prompt: string, previousPlan: PlanV3_1): string {
  return [
    "The visitor is changing a view that is already on screen. Its plan is:",
    JSON.stringify(
      {
        dataRequests: previousPlan.dataRequests,
        ...(previousPlan.dataCompositions ? { dataCompositions: previousPlan.dataCompositions } : {}),
        ...(previousPlan.dataJoins ? { dataJoins: previousPlan.dataJoins } : {}),
        surfaces: previousPlan.surfaces,
      },
      null,
      2,
    ),
    "",
    "Return a complete new plan for the view after this change:",
    prompt,
    "",
    "Keep anything the visitor did not ask to change — the same data requests,",
    "the same components, the same bindings. You may add to the view as well as",
    "alter it: a request to show something *as well* should return the previous",
    "nodes plus the new one.",
    "The order of the nodes in each surface is the arrangement the visitor has",
    "chosen on screen. Keep the nodes you retain in that order unless the change",
    "asks for a different one; place added nodes where the change implies.",
  ].join("\n");
}

function buildRepairPrompt(originalPrompt: string, issues: DataPlanIssue[]): string {
  return [
    originalPrompt,
    "",
    "The previous plan was rejected by deterministic validation.",
    "Return a corrected plan using only the supplied schema and catalog.",
    ...issues.map((issue) => `- ${issue.path}: ${issue.message}`),
  ].join("\n");
}

function summarizeIssues(issues: DataPlanIssue[]): string {
  if (issues.length === 0) return "Plan generation failed";
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

function defaultId(): string {
  return `plan-${globalThis.crypto.randomUUID()}`;
}
