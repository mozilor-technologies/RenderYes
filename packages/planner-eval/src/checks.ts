import type { PlannerManifest } from "@renderyes/capability-catalog";
import type { SurfaceNode, PlanV3_1 } from "@renderyes/core";

/**
 * Every check the harness performs, as a closed set.
 *
 * These are named individually rather than folded into one pass/fail because a
 * bare pass rate does not tell you what to change. "The plan was invalid" is not
 * actionable; "it picked the right data type but the wrong verb, 40% of the
 * time" is.
 */
export type CheckId =
  /** Did it return the expected `ready` / `unsupported` outcome at all. */
  | "outcome"
  /**
   * Did the *first* draft pass validation, with no repair round. The headline
   * metric: the repair loop hides draft quality, so a suite can show a high
   * success rate while every single case needed two model calls to get there.
   */
  | "first-attempt-valid"
  /** Did it select the capabilities the case expects (subset, not equality). */
  | "capability-selection"
  /**
   * Did it select a capability producing the *right data type* but the wrong
   * operation (list vs search vs get). Bucketed separately from a plain
   * capability miss because the fix is different: this is a purpose/description
   * problem, not a scoping problem.
   */
  | "capability-verb"
  /** Did it select the components the case expects (subset, not equality). */
  | "component-selection"
  /** Did it stay within the expected node count. Over-building is a real failure (asked for one number, got a dashboard) and so is under-building (asked for two things, got one component). */
  | "node-count"
  /** Did it filter on the fields the prompt implies. */
  | "filter-fields"
  /** Did it honour an explicit count ("top 2"). */
  | "limit"
  /** Did it sort the way the prompt implies ("most recent", "largest"). */
  | "sort"
  /** Did it use a composition when one was required, and not when it wasn't. */
  | "composition-used"
  /** Did it use a join when one was required, and not when it wasn't. */
  | "join-used";

export interface CheckOutcome {
  check: CheckId;
  ok: boolean;
  /** Why it failed, in terms a prompt or catalog change can act on. */
  detail?: string;
}

export interface EvalExpectation {
  outcome: "ready" | "unsupported";
  /** Capability ids that must appear. A subset check — an extra harmless request does not fail the case. */
  usesCapabilities?: readonly string[];
  /** Component ids that must appear anywhere in the node tree. Subset. */
  usesComponents?: readonly string[];
  /** Fields that must appear in some request's filter, at any nesting depth. */
  filtersOn?: readonly string[];
  limit?: number;
  sortsBy?: readonly { field: string; direction: "asc" | "desc" }[];
  usesComposition?: boolean;
  usesJoin?: boolean;
  maxNodes?: number;
  /** Under-building is the same failure mirrored: asked for two things, got one component (or a refusal dressed as one). */
  minNodes?: number;
}

export interface EvalCase {
  id: string;
  prompt: string;
  expect: EvalExpectation;
}

/** Flattens the node tree — a component can nest approved children in a declared slot. */
export function walkNodes(nodes: readonly SurfaceNode[]): SurfaceNode[] {
  return nodes.flatMap((node) => [
    node,
    ...walkNodes(Object.values(node.slots ?? {}).flat()),
  ]);
}

/**
 * Collects filter field names at any depth. Filter groups nest up to 3 levels
 * (`filterGroupSchema` in data-runtime), so a flat read of `conditions` would
 * miss a field the model nested one group down and report a false failure.
 */
function filterFields(group: unknown, into: Set<string>): void {
  if (!group || typeof group !== "object") return;
  const conditions = (group as { conditions?: unknown }).conditions;
  if (!Array.isArray(conditions)) return;
  for (const condition of conditions) {
    if (!condition || typeof condition !== "object") continue;
    const field = (condition as { field?: unknown }).field;
    if (typeof field === "string") into.add(field);
    else filterFields(condition, into);
  }
}

/** Everything one produced plan actually says, reduced to what the checks compare. */
export interface PlanFacts {
  capabilityIds: string[];
  dataTypeIds: string[];
  componentIds: string[];
  nodeCount: number;
  filterFields: string[];
  limits: number[];
  sorts: { field: string; direction: string }[];
  usedComposition: boolean;
  usedJoin: boolean;
  repairCount: number;
}

export function readPlanFacts(plan: PlanV3_1, manifest: PlannerManifest): PlanFacts {
  const outputByCapabilityId = new Map(
    manifest.capabilities.map((capability) => [
      capability.id,
      capability.output.dataTypeId,
    ]),
  );
  const fields = new Set<string>();
  const limits: number[] = [];
  const sorts: { field: string; direction: string }[] = [];
  for (const request of plan.dataRequests) {
    filterFields(request.query?.filter, fields);
    if (typeof request.query?.limit === "number") limits.push(request.query.limit);
    for (const sort of request.query?.sort ?? []) {
      sorts.push({ field: sort.field, direction: sort.direction });
    }
  }
  const nodes = walkNodes(plan.surfaces[0]?.nodes ?? []);
  const capabilityIds = [
    ...new Set(plan.dataRequests.map((request) => request.capabilityId)),
  ];
  return {
    capabilityIds,
    dataTypeIds: [
      ...new Set(
        capabilityIds
          .map((id) => outputByCapabilityId.get(id))
          .filter((id): id is string => typeof id === "string"),
      ),
    ],
    componentIds: [...new Set(nodes.map((node) => node.componentId))],
    nodeCount: nodes.length,
    filterFields: [...fields],
    limits,
    sorts,
    usedComposition: Boolean(plan.dataCompositions?.length),
    usedJoin: Boolean(plan.dataJoins?.length),
    repairCount: plan.generation.repairCount,
  };
}

/**
 * Runs every applicable check against one produced plan. A check whose
 * expectation the case does not state is skipped entirely rather than reported
 * as a pass, so a case's pass rate reflects only what it actually asserts.
 */
export function checkPlan(
  expectation: EvalExpectation,
  facts: PlanFacts,
  manifest: PlannerManifest,
): CheckOutcome[] {
  const outcomes: CheckOutcome[] = [
    { check: "outcome", ok: true },
    {
      check: "first-attempt-valid",
      ok: facts.repairCount === 0,
      ...(facts.repairCount === 0
        ? {}
        : { detail: `needed ${facts.repairCount} repair round(s)` }),
    },
  ];

  if (expectation.usesCapabilities) {
    const missing = expectation.usesCapabilities.filter(
      (id) => !facts.capabilityIds.includes(id),
    );
    outcomes.push({
      check: "capability-selection",
      ok: missing.length === 0,
      ...(missing.length
        ? {
            detail: `expected ${missing.join(", ")}; selected ${facts.capabilityIds.join(", ") || "nothing"}`,
          }
        : {}),
    });

    // Same data type, different operation: a distinct diagnosis from "picked
    // something unrelated", so it gets its own check rather than hiding inside
    // the selection failure above.
    if (missing.length > 0) {
      const expectedDataTypes = new Set(
        missing
          .map(
            (id) =>
              manifest.capabilities.find((capability) => capability.id === id)?.output
                .dataTypeId,
          )
          .filter((id): id is string => typeof id === "string"),
      );
      const wrongVerb = facts.capabilityIds.filter((id) => {
        const dataTypeId = manifest.capabilities.find(
          (capability) => capability.id === id,
        )?.output.dataTypeId;
        return dataTypeId !== undefined && expectedDataTypes.has(dataTypeId);
      });
      outcomes.push({
        check: "capability-verb",
        ok: wrongVerb.length === 0,
        ...(wrongVerb.length
          ? {
              detail: `right data type, wrong operation: chose ${wrongVerb.join(", ")} instead of ${missing.join(", ")}`,
            }
          : {}),
      });
    }
  }

  if (expectation.usesComponents) {
    const missing = expectation.usesComponents.filter(
      (id) => !facts.componentIds.includes(id),
    );
    outcomes.push({
      check: "component-selection",
      ok: missing.length === 0,
      ...(missing.length
        ? {
            detail: `expected ${missing.join(", ")}; rendered ${facts.componentIds.join(", ") || "nothing"}`,
          }
        : {}),
    });
  }

  if (expectation.maxNodes !== undefined) {
    outcomes.push({
      check: "node-count",
      ok: facts.nodeCount <= expectation.maxNodes,
      ...(facts.nodeCount > expectation.maxNodes
        ? {
            detail: `built ${facts.nodeCount} nodes, expected at most ${expectation.maxNodes}`,
          }
        : {}),
    });
  }

  if (expectation.minNodes !== undefined) {
    outcomes.push({
      check: "node-count",
      ok: facts.nodeCount >= expectation.minNodes,
      ...(facts.nodeCount < expectation.minNodes
        ? {
            detail: `expected at least ${expectation.minNodes} top-level nodes, got ${facts.nodeCount}`,
          }
        : {}),
    });
  }

  if (expectation.filtersOn) {
    const missing = expectation.filtersOn.filter(
      (field) => !facts.filterFields.includes(field),
    );
    outcomes.push({
      check: "filter-fields",
      ok: missing.length === 0,
      ...(missing.length
        ? {
            detail: `did not filter on ${missing.join(", ")}; filtered on ${facts.filterFields.join(", ") || "nothing"}`,
          }
        : {}),
    });
  }

  if (expectation.limit !== undefined) {
    const ok = facts.limits.includes(expectation.limit);
    outcomes.push({
      check: "limit",
      ok,
      ...(ok
        ? {}
        : {
            detail: `expected limit ${expectation.limit}; used ${facts.limits.join(", ") || "none"}`,
          }),
    });
  }

  if (expectation.sortsBy) {
    const missing = expectation.sortsBy.filter(
      (expected) =>
        !facts.sorts.some(
          (actual) =>
            actual.field === expected.field && actual.direction === expected.direction,
        ),
    );
    outcomes.push({
      check: "sort",
      ok: missing.length === 0,
      ...(missing.length
        ? {
            detail: `expected sort ${missing.map((s) => `${s.field} ${s.direction}`).join(", ")}; used ${facts.sorts.map((s) => `${s.field} ${s.direction}`).join(", ") || "none"}`,
          }
        : {}),
    });
  }

  if (expectation.usesComposition !== undefined) {
    outcomes.push({
      check: "composition-used",
      ok: facts.usedComposition === expectation.usesComposition,
      ...(facts.usedComposition === expectation.usesComposition
        ? {}
        : {
            detail: expectation.usesComposition
              ? "no composition, but the request needs two sources merged"
              : "used a composition the request did not need",
          }),
    });
  }

  if (expectation.usesJoin !== undefined) {
    outcomes.push({
      check: "join-used",
      ok: facts.usedJoin === expectation.usesJoin,
      ...(facts.usedJoin === expectation.usesJoin
        ? {}
        : {
            detail: expectation.usesJoin
              ? "no join, but the request needs related data"
              : "used a join the request did not need",
          }),
    });
  }

  return outcomes;
}
