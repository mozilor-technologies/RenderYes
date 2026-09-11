import type {
  DataBinding,
  DataComposition,
  DataJoin,
  PlanV3_1,
  SurfaceNode,
} from "@renderyes/core";

/**
 * Server-side plan slicing, for pinning one panel of a composed view.
 *
 * A pin is a saved view containing only the top-level nodes the visitor chose
 * and the data those nodes actually consume. The slice happens here — never on
 * the client — for the same reason `saveComposedView` takes a `planId` and not
 * a plan body: the only plans this server stores are ones it composed and
 * validated itself, and a client-assembled subset would be an arbitrary plan
 * wearing a familiar planId.
 *
 * What "the data those nodes consume" means, precisely:
 * - every `requestId` bound by a kept node or by any of its slot children, at
 *   any depth;
 * - for a bound join, the join itself plus both of its side requests — a join
 *   with one side missing cannot execute;
 * - for a bound composition, the composition plus every request in its
 *   `inputs` — a set operation over absent members is a different answer, not
 *   a smaller one.
 *
 * Everything else — other nodes, requests only they consumed, joins and
 * compositions nothing kept references — is dropped, so reopening the pin
 * executes exactly the requests its one panel needs and nothing more.
 */
export function slicePlanToNodes(
  plan: PlanV3_1,
  surfaceId: string,
  nodeIds: readonly string[],
  planId: string,
): PlanV3_1 {
  if (nodeIds.length === 0) {
    throw new Error("Pinning needs at least one nodeId to keep.");
  }
  const surface = plan.surfaces.find((candidate) => candidate.id === surfaceId);
  if (!surface) {
    throw new Error(`Plan does not contain surface "${surfaceId}".`);
  }

  // Only top-level nodes are pinnable: a nested slot child is part of its
  // parent's layout, and "pin the headline out of the panel" would save a node
  // whose surface placement the plan never approved on its own.
  const topLevelIds = new Set(surface.nodes.map((node) => node.nodeId));
  const wanted = new Set(nodeIds);
  for (const nodeId of wanted) {
    if (!topLevelIds.has(nodeId)) {
      throw new Error(
        `This view has no top-level node "${nodeId}" to pin. ` +
          `Top-level nodes: ${surface.nodes.map((node) => `"${node.nodeId}"`).join(", ")}.`,
      );
    }
  }

  // Kept in the surface's own order, so pinning ["b", "a"] does not reorder a
  // view relative to how it rendered.
  const keptNodes = surface.nodes.filter((node) => wanted.has(node.nodeId));

  const boundRequestIds = new Set<string>();
  const boundCompositionIds = new Set<string>();
  const boundJoinIds = new Set<string>();
  const collect = (node: SurfaceNode): void => {
    for (const binding of Object.values(node.dataBindings ?? {})) {
      recordBinding(binding, boundRequestIds, boundCompositionIds, boundJoinIds);
    }
    for (const children of Object.values(node.slots ?? {})) {
      for (const child of children) collect(child);
    }
  };
  for (const node of keptNodes) collect(node);

  // Expand indirect references: a kept join needs both side requests, a kept
  // composition needs every input. Neither can nest further (core forbids
  // joins-of-joins and compositions-of-compositions), so one pass suffices.
  const keptJoins = (plan.dataJoins ?? []).filter((join) =>
    boundJoinIds.has(join.joinId),
  );
  for (const join of keptJoins) {
    boundRequestIds.add(join.left);
    boundRequestIds.add(join.right);
  }
  const keptCompositions = (plan.dataCompositions ?? []).filter((composition) =>
    boundCompositionIds.has(composition.compositionId),
  );
  for (const composition of keptCompositions) {
    for (const requestId of composition.inputs) boundRequestIds.add(requestId);
  }

  const keptRequests = plan.dataRequests.filter((request) =>
    boundRequestIds.has(request.requestId),
  );

  // Destructured out rather than spread through: a plan whose join or
  // composition list survives the spread when the slice kept none of them
  // would carry sections that reference dropped requests.
  const {
    dataCompositions: _droppedCompositions,
    dataJoins: _droppedJoins,
    ...base
  } = plan;

  return {
    ...base,
    // A new identity, not the source plan's: `planId` is what saved views and
    // follow-up actions are keyed by, and the pin is a different plan — the
    // same id naming two different node sets would conflate them everywhere
    // an id is compared.
    planId,
    surfaces: plan.surfaces.map((candidate) =>
      candidate.id === surfaceId ? { ...candidate, nodes: keptNodes } : candidate,
    ),
    dataRequests: keptRequests,
    // Omitted rather than empty when nothing survives, matching how a composed
    // plan is built (`createCandidatePlan` omits absent sections too).
    ...(keptCompositions.length > 0
      ? { dataCompositions: keptCompositions as DataComposition[] }
      : {}),
    ...(keptJoins.length > 0 ? { dataJoins: keptJoins as DataJoin[] } : {}),
  };
}

function recordBinding(
  binding: DataBinding,
  requestIds: Set<string>,
  compositionIds: Set<string>,
  joinIds: Set<string>,
): void {
  if ("requestId" in binding) requestIds.add(binding.requestId);
  else if ("compositionId" in binding) compositionIds.add(binding.compositionId);
  else if ("joinId" in binding) joinIds.add(binding.joinId);
}
