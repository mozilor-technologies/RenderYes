import type { PlannerManifest } from "@renderyes/capability-catalog";
import { isRecord } from "@renderyes/core";
import { createDataPlanningContract, DEFAULT_MAX_ROWS } from "@renderyes/data-runtime";
import {
  scopeManifestToSurface,
  type ComponentDataAcceptance,
  type RegisteredSite,
  type SiteComponentDefinition,
} from "@renderyes/site-sdk";

export interface CreatePlanContractOptions {
  surfaceId: string;
  /**
   * Narrow the advertised capabilities to those this surface's components can
   * actually bind (see `scopeManifestToSurface`). On by default: a capability
   * no slot accepts cannot be bound, so advertising it only costs tokens and
   * invites a draft that deterministic validation will reject.
   *
   * Set false to advertise the whole manifest — only useful for diagnosing
   * whether a "no plan found" result is a scoping problem or a prompt problem.
   */
  scopeCapabilitiesToSurface?: boolean;
  /**
   * Include worked examples of the required output shape in the system prompt.
   * On by default; exposed as a flag so an eval harness can A/B it, because
   * whether examples improve first-attempt validity is an empirical question
   * and not one this code can answer by asserting it.
   */
  includeShapeExamples?: boolean;
  /**
   * Whether the planner may answer with a question instead of a plan.
   * Defaults to true.
   *
   * Set false when the prompt *is* an answer to a question this planner already
   * asked. That makes a second question impossible rather than merely
   * discouraged: without it, a model that keeps finding the answer ambiguous
   * can ask forever, and the visitor is in a loop with no way out but reloading
   * the page. Removing the branch from the schema costs one contract-cache
   * entry and closes the loop structurally.
   */
  allowClarification?: boolean;
}

/**
 * The complete planner-facing contract for the first Plan 3.1 slice.
 * It intentionally exposes only planner-safe capability metadata and semantic
 * component contracts. Resolver functions, sessions, permissions, endpoints,
 * raw data, and registered renderer paths never enter this object.
 */
export interface PlanContract {
  surfaceId: string;
  systemPrompt: string;
  jsonSchema: Record<string, unknown>;
  /**
   * The capability ids actually advertised to the model, sorted. Exposed so a
   * host can see the effect of surface scoping without re-deriving it, and so a
   * "no plan found" result can be diagnosed as an empty scope rather than a bad
   * prompt.
   */
  capabilityIds: readonly string[];
}

export function createPlanContract(
  site: RegisteredSite,
  plannerManifest: PlannerManifest,
  options: CreatePlanContractOptions,
): PlanContract {
  const surface = site.getSurface(options.surfaceId);
  if (!surface) {
    throw new Error(`Unknown site surface: ${options.surfaceId}`);
  }

  const components = surface.componentIds.map((componentId) => {
    const component = site.getComponent(componentId);
    if (!component) {
      throw new Error(
        `Surface ${surface.id} references unknown component ${componentId}`,
      );
    }
    return component;
  });
  // Components are already scoped by `surface.componentIds`; capabilities were
  // not, so every approved operation entered every surface's contract. Narrow
  // the manifest first, then derive every capability-facing part of the
  // contract from the narrowed copy so the prompt, the request schema, the
  // composition schema, and the join schema all agree on one scope.
  const scope =
    options.scopeCapabilitiesToSurface === false
      ? undefined
      : scopeManifestToSurface(plannerManifest, site, surface.id);
  const scopedManifest = scope
    ? narrowManifest(plannerManifest, scope.capabilityIds)
    : plannerManifest;
  // What the scope dropped, so a refusal can name the real blocker. Kept out
  // of `scopedManifest` on purpose: the narrowed manifest is what every
  // bindable part of the contract is derived from, and an unrenderable
  // capability must remain absent from the request schema, the composition
  // schema, and the join schema alike.
  const unrenderableOutputs = scope?.unrenderableOutputs ?? [];

  const dataContract = createDataPlanningContract(scopedManifest);
  const dataRequestsSchema = readDataRequestsSchema(dataContract.jsonSchema);
  const compositionSchema = compositionDraftSchema(scopedManifest);
  const joinSchema = joinDraftSchema(scopedManifest);
  const bindingOptions: NodeBindingOptions = {
    allowCompositions: Boolean(compositionSchema),
    allowJoins: Boolean(joinSchema),
  };
  const nodeVariants = components.map((component) =>
    componentNodeSchema(component, bindingOptions),
  );
  // A component may declare child slots (site-sdk/core `SlotDefinition`). Only
  // wire the recursive $defs.node mechanism when at least one approved
  // component actually declares one — otherwise the contract stays exactly the
  // flat schema, unchanged, matching how compositions/joins are only
  // advertised when they qualify.
  const hasNestedSlots = components.some(
    (component) => Object.keys(component.slots ?? {}).length > 0,
  );
  const componentSummary = components.map(describeComponent).join("\n");

  const readySchema = {
    type: "object",
    additionalProperties: false,
    required: ["status", "dataRequests", "nodes"],
    properties: {
      status: { const: "ready" },
      dataRequests: dataRequestsSchema,
      ...(compositionSchema ? { dataCompositions: compositionSchema } : {}),
      ...(joinSchema ? { dataJoins: joinSchema } : {}),
      nodes: {
        type: "array",
        minItems: 1,
        ...(surface.maxComponents !== undefined
          ? { maxItems: surface.maxComponents }
          : {}),
        items: nodeVariants.length ? { oneOf: nodeVariants } : false,
      },
    },
  };

  return {
    surfaceId: surface.id,
    systemPrompt: [
      "You compose one RenderYes surface from owner-approved data capabilities and components.",
      "Return only JSON matching the supplied schema.",
      "Choose capability parameters and declarative query operations from the capability contract.",
      "Bind component data slots by requestId, compositionId, or joinId; never provide renderer paths.",
      "A composition combines two or more already-declared requestIds using only an advertised set operation and compatible output type.",
      "A join enriches one already-declared requestId (left) with a related requestId (right) through an approved relationshipId; the relationship and its keys are owner-controlled, so never invent join keys, only name an advertised relationship.",
      ...(hasNestedSlots
        ? [
            "A component that declares a slot may contain other approved components as children in that slot; nest a child only inside a slot its parent declares, and never exceed a slot's cardinality.",
          ]
        : []),
      'Use status "unsupported" when the request cannot be represented by the approved capabilities and components.',
      // Two different blockers reached the visitor as one sentence. A
      // capability the surface cannot render is absent from everything below,
      // so the model correctly reported having no capability for the request
      // and wrongly named the *catalog* as the reason: measured on a
      // `hierarchy` type refused as data the catalog "does not provide", which
      // rendered 17 rows the moment a component accepting that shape was
      // registered — nothing about the catalog, the fields, or the data
      // changed. The two blockers have opposite fixes, and only one of them is
      // "approve more fields".
      //
      // Emitted only when the scope actually dropped something, and carrying
      // (dataTypeId, shape) alone: enough to name what cannot be shown, and
      // deliberately not enough to call it.
      ...(unrenderableOutputs.length > 0
        ? [
            `Approved data this surface cannot display: ${describeUnrenderableOutputs(unrenderableOutputs)}. These are NOT bindable — no requestId, composition, or join may name a capability producing them, and none appears in the approved capability list below. They are stated only so a refusal can be accurate.`,
            'When the request needs one of those, refuse with "unsupported" and say that the data is approved and available but this surface has no component that can present it, naming the data type and shape. Do not say the catalog lacks the data: that sends the owner looking for fields to approve, and no approval fixes a missing component.',
          ]
        : []),
      // The affordance and the brake, in one breath. A model handed a "you may
      // ask a question" branch will use it — asking is always locally safer
      // than committing — and a system that answers a prompt with a question is
      // worse than one that guesses and lets the visitor refine. So the rule
      // names the only case that qualifies, and rules out the three that read
      // like it: confirmation, missing data, and detail the visitor can adjust
      // afterwards.
      ...(options.allowClarification === false
        ? [
            // The prompt already carries a question and its answer. Saying so
            // is worth a line: without it the model sees a conversation it is
            // not allowed to continue and no explanation of why.
            "This request already includes the answer to a question you asked. Compose the view; you may not ask another.",
          ]
        : [
            // The trigger used to be stated only as "two or more materially
            // different ways", which the model read as a property of the
            // *catalog* rather than of the visitor's wording — so it fired for
            // requests the catalog could not answer and never for the ones it
            // could answer several ways. "Show me our best products" was
            // guessed as relevance ranking and rejected upstream; naming the
            // vague-superlative case is what makes the rule reachable.
            'Use status "needs-clarification" only when the visitor\'s wording maps to two or more materially different answers the approved capabilities can each actually produce — a different sort field, a different capability, a different metric — and answering the wrong one would show them something they did not ask for. A vague superlative or comparative ("best", "top", "biggest", "most popular") is that case whenever more than one approved field or capability could be the one they mean: ask which, and name the concrete alternatives.',
            // The brake on the affordance, from the failure of asking badly: a
            // question about calendar months against a catalog that could not
            // aggregate by month either way ended in the same refusal one
            // round trip later. A question no answer can change is worse than
            // no question.
            "Check what is producible before asking. If only one candidate reading can be produced, compose that one and do not ask. If none can, refuse as \"unsupported\" — a question whose every answer leads to the same refusal costs the visitor a round trip and changes nothing.",
            // The third clause used to rule out "sorting" outright, which is
            // exactly the case above: "best" *is* an ordering choice, so the
            // rule instructed the guess. The line the visitor can act on
            // afterwards is one the request already stated; an unstated choice
            // of which metric answers the question decides what gets fetched.
            'Do not ask to confirm something the request already implies, and do not ask about data this catalog does not have — that is "unsupported". Do not ask about an ordering, a row limit, or a date range the request already states and the visitor can adjust on the view afterwards; an unstated choice of which metric or capability answers the question is not that.',
            "Prefer answering. A view someone can refine is better than a question they must answer before seeing anything.",
          ]),
      "Never invent capabilities, components, props, data slots, identity, permissions, credentials, endpoints, executable code, or data rows.",
      // Measured: a metric capability and a metric-accepting component both
      // reach the contract and both stay unchosen, because a question like
      // "what is our total revenue" also looks answerable by aggregating a
      // collection — and a model with no stated preference reaches for the
      // list it understands better. The preference is not stylistic: an
      // aggregate over a collection is bounded by that capability's row limit,
      // and the runtime refuses one computed over a truncated result rather
      // than return a confident wrong number. A capability whose output shape
      // is `metric` has already done the arithmetic upstream, over everything.
      'A capability whose output shape is "metric" already returns the figure. When the request asks for one number — a total, a count, an average, a rate — use that capability rather than aggregating a collection to derive the same number, and bind it to a component that accepts the metric shape. Aggregate a collection only when no metric capability reports what was asked for.',
      // This rule used to end at "use the id-taking capability with exactly
      // that value", and offered `order #482` as an example of a value to pass
      // through — so "open order 2486" did exactly that, and the upstream
      // answered `Invalid ID: 2486`. An order number is a human-facing key; the
      // argument wanted an opaque identifier, and the two are not the same
      // string even when both are "the id" in conversation. The rule was
      // instructing the failure, not merely permitting it.
      //
      // So the split is now by what the *argument* is, which the contract
      // states per argument (see `isOpaqueIdentifierArgument` in
      // capability-catalog), rather than by what the visitor's words look like.
      // Pass-through survives for the case it was written for: an identifier
      // this session already returned.
      'Identifier arguments are pass-through, never invented. An argument the contract marks as an opaque identifier accepts only a value that came back in this session\'s own data — a visitor\'s wording never contains one, however much a number in it looks like an id ("order 2486" is an order number, not the id that argument wants).',
      // "Filtered on the field they actually named" used to leave the *where*
      // open, and the model reached for query.filter — which runs over one
      // fetched page, so a named record outside that page was reported as
      // nonexistent (measured: a customer's email matched 3 of her 117
      // orders). The narrowing must go to the source when the source takes
      // it; the capability facts state which params do (see
      // sourceNarrowingArguments in the data contract below).
      'So when the visitor names a thing — by number, title, email, or code — reach it through a list or search capability narrowed on the field they actually named: through a source-narrowing param when one can carry it, and only otherwise through a query filter. Limit it to what they asked for. When nothing approved can narrow on that field, refuse with "unsupported" and name the field: a lookup handed a value it was never going to accept fails as an error the visitor cannot act on.',
      'A question about one named thing IS answerable this way: a list or search capability narrowed to that name answers "tell me about X" even though it returns a collection. Missing an id is never by itself a reason to refuse while such a capability exists.',
      `Site: ${site.id}@${site.version}.`,
      `Surface: ${surface.id}. ${surface.description}`,
      // Nothing else in the prompt says plural is possible: every default
      // example shows one node, and the schema only bounds `nodes` from above.
      // Without this sentence the model infers a one-component surface and
      // "cannot show both" becomes a fabricated refusal reason. Stated only
      // when the schema agrees — telling a maxComponents: 1 surface it holds
      // several would teach a shape the enforced schema rejects.
      ...(surface.maxComponents === undefined
        ? ["This surface holds one or several components side by side."]
        : surface.maxComponents >= 2
          ? [
              `This surface holds one or several components side by side, at most ${surface.maxComponents}.`,
            ]
          : []),
      ...(options.includeShapeExamples === false
        ? []
        : shapeExampleLines({
            allowJoins: Boolean(joinSchema),
            allowSiblings:
              surface.maxComponents === undefined || surface.maxComponents >= 2,
          })),
      "Approved components:",
      componentSummary,
      dataContract.systemPrompt,
    ].join("\n"),
    jsonSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      oneOf: [
        readySchema,
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "reason"],
          properties: {
            status: { const: "unsupported" },
            reason: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
        ...(options.allowClarification === false ? [] : [{
          type: "object",
          additionalProperties: false,
          required: ["status", "question"],
          properties: {
            status: { const: "needs-clarification" },
            // Short because it is going straight to a visitor who typed one
            // sentence and expected a view. A paragraph-long question is a
            // form, and the answer to a form is abandonment.
            question: { type: "string", minLength: 1, maxLength: 200 },
            // Two to four. One option is not a choice, and five is the form
            // again. Optional: some questions have no closed answer set, and
            // inventing one would narrow what the visitor can say.
            options: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              items: { type: "string", minLength: 1, maxLength: 60 },
            },
          },
        }]),
      ],
      // Recursive node reference for slot children. Uses anyOf (not oneOf) so
      // deep recursive matching does not emit ambiguous-branch AJV errors that
      // would degrade the repair prompt. Only present when a component actually
      // declares a slot; unreferenced otherwise.
      ...(hasNestedSlots ? { $defs: { node: { anyOf: nodeVariants } } } : {}),
    },
    capabilityIds: scopedManifest.capabilities.map((capability) => capability.id).sort(),
  };
}

/**
 * Worked examples of the required output shape.
 *
 * Every id in these examples is a **bracketed description, never a literal**.
 * That is the whole design: few-shot examples that name real capabilities or
 * components would teach the model to prefer whichever ones happened to be
 * chosen for the example, and that selection bias is invisible in a pass rate —
 * it shows up only as a skewed distribution across a whole eval suite. A
 * description cannot bias selection because it carries no catalog information,
 * and it cannot be copied as an invalid literal either.
 *
 * The examples are also deliberately *unlike* each other in structure, so
 * neither one anchors the model on a single plan shape, and one of the three is
 * a refusal: models under-refuse, and a wrong view is worse than no view, but
 * `unsupported` is the branch a model is least likely to reach for unaided.
 *
 * The join example is conditional for correctness, not economy. `readySchema` is
 * `additionalProperties: false` and omits `dataJoins` entirely when no approved
 * relationship qualifies, so showing a join to a catalog without one would teach
 * a key the schema then rejects.
 */
/**
 * The refusal example's reason, exported so `composeDataPlan` can recognise a
 * model that returned the template instead of writing its own sentence.
 */
export const UNSUPPORTED_REASON_PLACEHOLDER =
  "<one sentence naming what this request needs that the catalogs lack, in the visitor's terms>";

function shapeExampleLines(options: {
  allowJoins: boolean;
  /**
   * Whether the surface can hold two components at once. Conditional for the
   * same correctness reason the join example is: `readySchema` sets
   * `maxItems: 1` when `surface.maxComponents` is 1, so showing sibling nodes
   * to that surface would teach a shape the enforced schema rejects.
   */
  allowSiblings: boolean;
}): string[] {
  return [
    "Example of the required shape. The bracketed names below describe what to pick, not literal values — every capabilityId, componentId, relationshipId, and slot name you emit must come from the approved lists that follow.",
    // (The unsupported example's reason is a bracketed placeholder for the same
    // reason the ids are: an earlier version used a realistic sample sentence
    // ("driver locations…a map") and a model under pressure returned it
    // verbatim as its answer — a visitor asking about recipes was told their
    // site can't render maps. Nothing realistic may appear where the model
    // could mistake copying for answering; composeDataPlan additionally
    // rejects any refusal that still carries bracketed template text.)
    "One request bound to one component:",
    JSON.stringify({
      status: "ready",
      dataRequests: [
        {
          requestId: "r1",
          capabilityId: "<a capability producing a collection>",
          params: {},
          query: { limit: 10 },
        },
      ],
      nodes: [
        {
          nodeId: "n1",
          componentId: "<a component whose data slot accepts that collection>",
          props: {},
          dataBindings: { "<that slot's name>": { requestId: "r1" } },
        },
      ],
    }),
    // Without this example every ready example shows exactly one node, and the
    // model reads that as a rule: compound prompts get refused with a
    // fabricated "not supported" reason because nothing ever showed plural.
    ...(options.allowSiblings
      ? [
          "Two things asked for together, each answered by its own component — sibling nodes side by side:",
          JSON.stringify({
            status: "ready",
            dataRequests: [
              {
                requestId: "r1",
                capabilityId: "<a capability answering the first part of the request>",
                params: {},
              },
              {
                requestId: "r2",
                capabilityId: "<a capability answering the second part>",
                params: {},
              },
            ],
            nodes: [
              {
                nodeId: "n1",
                componentId: "<a component whose data slot accepts the first output>",
                props: {},
                dataBindings: { "<that slot's name>": { requestId: "r1" } },
              },
              {
                nodeId: "n2",
                componentId: "<a component whose data slot accepts the second output>",
                props: {},
                dataBindings: { "<that slot's name>": { requestId: "r2" } },
              },
            ],
          }),
        ]
      : []),
    ...(options.allowJoins
      ? [
          "A join, which needs both sides declared as requests first:",
          JSON.stringify({
            status: "ready",
            dataRequests: [
              {
                requestId: "left",
                capabilityId: "<capability producing the relationship's from-type>",
                params: {},
              },
              {
                requestId: "right",
                capabilityId: "<capability producing the relationship's to-type>",
                params: {},
              },
            ],
            dataJoins: [
              {
                joinId: "j1",
                relationshipId: "<an advertised relationshipId>",
                left: "left",
                right: "right",
                as: "related",
              },
            ],
            nodes: [
              {
                nodeId: "n1",
                componentId: "<component accepting the left type as a collection>",
                props: {},
                dataBindings: { "<that slot's name>": { joinId: "j1" } },
              },
            ],
          }),
        ]
      : []),
    "When the approved capabilities and components cannot answer the request:",
    JSON.stringify({
      status: "unsupported",
      reason: UNSUPPORTED_REASON_PLACEHOLDER,
    }),
    "Write the reason yourself, in the visitor's terms, naming what this specific request needs that the catalogs lack. Never return the bracketed placeholder text.",
    // The second NOT clause exists because the first taught its lesson too
    // well in one direction only: "prefer unsupported over partial" read a
    // multi-part request as partial-by-construction, and the perceived limit
    // became a refusal. The brake stays at the end of the same sentence.
    // Both multi-part clauses are gated on allowSiblings for the same reason
    // the sibling example is: on a one-component surface the schema rejects a
    // second node, and "one component per part" would instruct exactly the
    // draft the contract then refuses — an invited repair loop.
    `Prefer "unsupported" over a partial or approximated view: a view that answers a different question than the visitor asked is worse than no view. A list or search capability narrowed to one named thing is NOT partial — it is the faithful answer to a question about that thing, and refusing it for want of an id is wrong.${
      options.allowSiblings
        ? " A view that answers every part of the request, each part with its own component, is NOT partial either — refuse only when some part of the request has no approved capability or component at all."
        : ""
    }`,
    // The affordance and the brake in one sentence, like the identifier rule:
    // unqualified, "do not add nodes" reads as one-node-per-view and compound
    // prompts get refused or half-answered; the counterweight names what the
    // request itself called for without licensing anything beyond it.
    options.allowSiblings
      ? "Do not add nodes the request did not call for — but a request that asks for two things has called for two: answer every part the catalog can answer, one component per part, and do not ask which part to show."
      : "Do not add nodes the request did not call for.",
    // Measured live: "revenue for the last six months as a trend" against a
    // catalog with no groupBy produced a chart titled "Revenue trend — last 6
    // months" plotting a hundred raw orders, one point each. Every layer was
    // green — the most dangerous class of wrong answer, because the heading is
    // the one thing on screen claiming the computation happened. The refusal
    // rule above covers "cannot aggregate"; this covers the label.
    'Headings and prop text must describe what the query actually computes. Never title a view with an aggregation, grouping, or period ("monthly", "trend", "total per …") unless the plan itself requests it via groupBy or aggregates; a raw list gets a raw list\'s name. If the visitor asked for an aggregation the capabilities cannot compute, that is "unsupported" — not a relabelled list.',
  ];
}

/**
 * Renders the unrenderable outputs as `type (shape, shape)`, grouped by data
 * type.
 *
 * Grouped and un-JSONed because this is pure contract cost on every attempt: a
 * one-component surface over a two-dozen-capability catalog excludes most of
 * it, and the JSON encoding of the same facts measured 383 tokens against 187
 * for this form — the repeated key names were most of it. What a refusal needs
 * is the vocabulary to name what cannot be shown, which survives the encoding.
 */
function describeUnrenderableOutputs(
  outputs: readonly { dataTypeId: string; shape: string }[],
): string {
  const byDataType = new Map<string, string[]>();
  for (const output of outputs) {
    const shapes = byDataType.get(output.dataTypeId) ?? [];
    if (!shapes.includes(output.shape)) shapes.push(output.shape);
    byDataType.set(output.dataTypeId, shapes);
  }
  return [...byDataType.entries()]
    .map(([dataTypeId, shapes]) => `${dataTypeId} (${shapes.join(", ")})`)
    .join("; ");
}

function narrowManifest(
  manifest: PlannerManifest,
  capabilityIds: readonly string[],
): PlannerManifest {
  const keep = new Set(capabilityIds);
  // Only `capabilities` is filtered. `dataTypes` must stay whole because
  // structural acceptance matching resolves field semantics through it, and an
  // unreferenced data type never reaches the prompt anyway. `relationships`
  // needs no filter either: `joinDraftSchema` already drops any relationship
  // whose sides are no longer produced.
  return {
    ...manifest,
    capabilities: manifest.capabilities.filter((capability) => keep.has(capability.id)),
  };
}

/**
 * Renders one component as prose for the system prompt.
 *
 * The rule this follows: **state only what the enforced JSON Schema cannot
 * express.** The prompt used to carry `JSON.stringify` of the whole component
 * summary, including `props.jsonSchema` verbatim — but `componentNodeSchema`
 * below already puts that exact schema into the structured-output constraint,
 * so the model paid for it twice. Slot cardinality is likewise already a
 * `maxItems`.
 *
 * What genuinely cannot live in JSON Schema is the cross-reference: which
 * capability outputs a data slot accepts, and which components a child slot
 * accepts. The schema can only say a binding is `{ requestId }`; it cannot say
 * that `requestId` must name a capability producing a particular data type.
 * That gap is exactly what `validatePlanDataBindings` closes after the fact, so
 * the model has to be told it here to get the first attempt right.
 */
function describeComponent(component: SiteComponentDefinition): string {
  const lines = [`- ${component.id}: ${component.description}`];

  const schemaProperties = component.props.jsonSchema.properties;
  const propNames = isRecord(schemaProperties) ? Object.keys(schemaProperties) : [];
  if (propNames.length > 0) {
    // Names only — every constraint on them is in the schema.
    lines.push(`  props: ${propNames.join(", ")}`);
  }

  for (const [slotName, slot] of Object.entries(component.dataSlots)) {
    const accepts = slot.accepts.map(describeAcceptance).join(" or ");
    lines.push(`  data slot "${slotName}" accepts ${accepts}`);
  }

  for (const [slotName, slot] of Object.entries(component.slots ?? {})) {
    const accepts = slot.accepts?.length
      ? slot.accepts.join(", ")
      : "any approved component";
    lines.push(
      `  child slot "${slotName}" (${slot.cardinality}) accepts ${accepts} — ${slot.description}`,
    );
  }

  return lines.join("\n");
}

function describeAcceptance(acceptance: ComponentDataAcceptance): string {
  // The grouping requirement is stated where the acceptance is, because the
  // schema cannot express it and validation enforces it: a chart slot that
  // silently rejected ungrouped rows would send every aggregation prompt into
  // the repair loop instead of producing a grouped request first try.
  const grouping =
    acceptance.requiresGrouping === true
      ? " — grouped data only: the bound request must set query.groupBy/aggregates (a time-series output qualifies as already aggregated)"
      : "";
  if ("dataTypeId" in acceptance) {
    return `${acceptance.dataTypeId} as ${acceptance.shapes.join("/")}${grouping}`;
  }
  const requirements = [
    ...(acceptance.requires ?? []).map(
      (requirement) => `a ${requirement.semanticType} field`,
    ),
    ...(acceptance.minFields !== undefined
      ? [`at least ${acceptance.minFields} fields`]
      : []),
  ];
  const suffix = requirements.length ? ` with ${requirements.join(" and ")}` : "";
  return `any ${acceptance.shape}${suffix}${grouping}`;
}

interface NodeBindingOptions {
  allowCompositions: boolean;
  allowJoins: boolean;
}

function componentNodeSchema(
  component: SiteComponentDefinition,
  bindings: NodeBindingOptions,
): Record<string, unknown> {
  const dataSlotNames = Object.keys(component.dataSlots);
  const properties: Record<string, unknown> = {
    nodeId: { type: "string", minLength: 1 },
    componentId: { const: component.id },
    props: component.props.jsonSchema,
  };
  const required = ["nodeId", "componentId", "props"];

  if (dataSlotNames.length > 0) {
    properties.dataBindings = {
      type: "object",
      additionalProperties: false,
      required: dataSlotNames,
      properties: Object.fromEntries(
        dataSlotNames.map((slotName) => [
          slotName,
          {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["requestId"],
                properties: {
                  requestId: { type: "string", minLength: 1 },
                },
              },
              ...(bindings.allowCompositions
                ? [
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["compositionId"],
                      properties: {
                        compositionId: { type: "string", minLength: 1 },
                      },
                    },
                  ]
                : []),
              ...(bindings.allowJoins
                ? [
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["joinId"],
                      properties: {
                        joinId: { type: "string", minLength: 1 },
                      },
                    },
                  ]
                : []),
            ],
          },
        ]),
      ),
    };
    required.push("dataBindings");
  }

  // Child slots (site-sdk/core SlotDefinition, distinct from data slots). Each
  // slot's children reference the shared recursive node definition; slots stay
  // optional at the schema level (core structurally enforces cardinality,
  // `accepts`, depth, and node-count limits once the plan is validated).
  const slotNames = Object.keys(component.slots ?? {});
  if (slotNames.length > 0) {
    properties.slots = {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        slotNames.map((slotName) => {
          const slot = component.slots![slotName];
          return [
            slotName,
            {
              type: "array",
              items: { $ref: "#/$defs/node" },
              ...(slot.cardinality === "one" ? { maxItems: 1 } : {}),
            },
          ];
        }),
      ),
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

function compositionDraftSchema(
  plannerManifest: PlannerManifest,
): Record<string, unknown> | undefined {
  const operations = new Map<string, Set<string>>();
  for (const capability of plannerManifest.capabilities) {
    const dataTypeId = capability.output.dataTypeId;
    for (const operation of capability.supports?.setOperations ?? []) {
      const key = `${operation}\u0000${dataTypeId}`;
      const capabilityIds = operations.get(key) ?? new Set<string>();
      capabilityIds.add(capability.id);
      operations.set(key, capabilityIds);
    }
  }

  const compatible = Array.from(operations.entries())
    .filter(([, capabilityIds]) => capabilityIds.size >= 2)
    .map(([key, capabilityIds]) => {
      const [operation, dataTypeId] = key.split("\u0000");
      return {
        operation,
        dataTypeId,
        capabilityIds: Array.from(capabilityIds).sort(),
      };
    });
  if (compatible.length === 0) return undefined;

  const operationsByName = Array.from(
    new Set(compatible.map((item) => item.operation)),
  ).sort();
  return {
    type: "array",
    minItems: 1,
    maxItems: 8,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["compositionId", "operation", "inputs"],
      properties: {
        compositionId: { type: "string", minLength: 1 },
        operation: { enum: operationsByName },
        inputs: {
          type: "array",
          minItems: 2,
          maxItems: 8,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
        query: compositionQuerySchema(),
      },
    },
  };
}

function compositionQuerySchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      sort: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["field", "direction"],
          properties: {
            field: { type: "string", minLength: 1 },
            direction: { enum: ["asc", "desc"] },
          },
        },
      },
      project: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
      },
      offset: { type: "integer", minimum: 0 },
      // Capped for the same reason the per-capability limit is: a `minimum`
      // with no `maximum` made `limit: 1000000` a schema-legal plan, and a
      // composition unions several requests, so it is the larger of the two
      // ways to ask for everything.
      limit: { type: "integer", minimum: 1, maximum: DEFAULT_MAX_ROWS },
    },
  };
}

const TO_ONE_CARDINALITIES = new Set(["one-to-one", "many-to-one"]);

/**
 * Advertises the approved catalog relationships the planner may request as
 * joins. A relationship qualifies only when it is to-one (the runtime executes
 * to-one joins only) and the manifest exposes at least one capability producing
 * each side's data type, so the model can always form a valid left/right pair.
 * The relationship's join keys are never exposed — only its id, mirroring the
 * planner-safe manifest. Returns undefined when no relationship qualifies, so
 * the `dataJoins` key and the `joinId` binding variant are both omitted.
 */
function joinDraftSchema(
  plannerManifest: PlannerManifest,
): Record<string, unknown> | undefined {
  const producedDataTypes = new Set(
    plannerManifest.capabilities.map((capability) => capability.output.dataTypeId),
  );
  const relationshipIds = plannerManifest.relationships
    .filter(
      (relationship) =>
        TO_ONE_CARDINALITIES.has(relationship.cardinality) &&
        producedDataTypes.has(relationship.fromDataTypeId) &&
        producedDataTypes.has(relationship.toDataTypeId),
    )
    .map((relationship) => relationship.id)
    .sort();
  if (relationshipIds.length === 0) return undefined;

  return {
    type: "array",
    minItems: 1,
    maxItems: 8,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["joinId", "relationshipId", "left", "right", "as"],
      properties: {
        joinId: { type: "string", minLength: 1 },
        relationshipId: { enum: relationshipIds },
        left: { type: "string", minLength: 1 },
        right: { type: "string", minLength: 1 },
        // `as` namespaces the joined right fields as `${as}_${field}`, which
        // becomes a renderer column id. Constrain it to the safe column-id
        // alphabet so a joined field can never break the trusted table.
        as: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]*$", maxLength: 40 },
      },
    },
  };
}

function readDataRequestsSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema.properties;
  if (!isRecord(properties) || !isRecord(properties.dataRequests)) {
    throw new Error("Data planning contract does not expose dataRequests");
  }
  return properties.dataRequests;
}
