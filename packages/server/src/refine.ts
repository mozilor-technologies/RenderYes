import type { FilterGroup, PlanV3_1, Sort, SurfaceNode } from "@renderyes/core";

/**
 * A direct manipulation a visitor can perform on an already-composed view
 * without going back to the model.
 *
 * Sorting a table, dropping a card, narrowing a filter — these are ordinary
 * interface actions. Routing them through a language model would make them
 * slow (measured compose latency runs 11-57s), expensive, and
 * non-deterministic: the same click could return a differently-arranged view.
 * Applying them as plan edits keeps them instant and repeatable.
 *
 * The set is deliberately closed. Each operation adjusts how approved data is
 * queried or arranged; none can introduce a capability, component, or field
 * the catalog did not already approve, so refinement cannot widen what a
 * visitor is allowed to see.
 */
export type RefineOperation =
  | { kind: "setSort"; requestId: string; sort: Sort[] }
  | { kind: "setFilter"; requestId: string; filter: FilterGroup }
  | { kind: "clearFilter"; requestId: string }
  | { kind: "setLimit"; requestId: string; limit: number }
  | { kind: "removeNode"; nodeId: string }
  | { kind: "reorderNodes"; nodeIds: string[] };

export interface RefineFailure {
  ok: false;
  reason: string;
}

export interface RefineSuccess {
  ok: true;
  plan: PlanV3_1;
}

export type RefineResult = RefineSuccess | RefineFailure;

function findRequest(plan: PlanV3_1, requestId: string) {
  return plan.dataRequests?.find((request) => request.requestId === requestId);
}

/**
 * Applies operations to a copy of `plan`, returning a new plan or the first
 * reason one could not be applied.
 *
 * Pure and total: it never mutates the input and never throws for bad input,
 * because the caller needs to distinguish "this refinement is not valid" from
 * "something broke" — the first is a normal answer to a visitor's click.
 *
 * Note this does not re-check queries against the catalog. That is the
 * caller's job via `validateDataRequestQuery`, so that plan editing and
 * catalog validation stay separable and independently testable.
 */
export function applyRefineOperations(
  plan: PlanV3_1,
  operations: readonly RefineOperation[],
  surfaceId: string,
): RefineResult {
  const next: PlanV3_1 = structuredClone(plan);
  const surface = next.surfaces.find((candidate) => candidate.id === surfaceId);
  if (!surface) return { ok: false, reason: `Unknown surfaceId "${surfaceId}".` };

  for (const operation of operations) {
    switch (operation.kind) {
      case "setSort":
      case "setFilter":
      case "clearFilter":
      case "setLimit": {
        const request = findRequest(next, operation.requestId);
        if (!request) {
          return { ok: false, reason: `Unknown requestId "${operation.requestId}".` };
        }
        const query = { ...(request.query ?? {}) };
        if (operation.kind === "setSort") {
          query.sort = operation.sort;
        } else if (operation.kind === "setFilter") {
          query.filter = operation.filter;
        } else if (operation.kind === "clearFilter") {
          delete query.filter;
        } else {
          if (!Number.isInteger(operation.limit) || operation.limit < 1) {
            return { ok: false, reason: "limit must be a positive integer." };
          }
          query.limit = operation.limit;
        }
        request.query = query;
        break;
      }

      case "removeNode": {
        const before = surface.nodes.length;
        surface.nodes = surface.nodes.filter((node) => node.nodeId !== operation.nodeId);
        if (surface.nodes.length === before) {
          return { ok: false, reason: `Unknown nodeId "${operation.nodeId}".` };
        }
        // Removing the last node would leave a surface with nothing to render,
        // which reads as a broken view rather than a refined one. Resetting is
        // a different action than refining.
        if (surface.nodes.length === 0) {
          return { ok: false, reason: "A view must keep at least one component." };
        }
        break;
      }

      case "reorderNodes": {
        const byId = new Map<string, SurfaceNode>(
          surface.nodes.map((node) => [node.nodeId, node]),
        );
        if (operation.nodeIds.length !== byId.size) {
          return {
            ok: false,
            reason: "reorderNodes must list every current nodeId exactly once.",
          };
        }
        const reordered: SurfaceNode[] = [];
        for (const nodeId of operation.nodeIds) {
          const node = byId.get(nodeId);
          if (!node) return { ok: false, reason: `Unknown nodeId "${nodeId}".` };
          if (reordered.some((existing) => existing.nodeId === nodeId)) {
            return { ok: false, reason: `Duplicate nodeId "${nodeId}".` };
          }
          reordered.push(node);
        }
        surface.nodes = reordered;
        break;
      }

      default: {
        // Exhaustiveness: an unhandled operation kind is a programming error,
        // but it must still fail closed rather than silently doing nothing.
        const unreachable: never = operation;
        return {
          ok: false,
          reason: `Unsupported operation: ${JSON.stringify(unreachable)}`,
        };
      }
    }
  }

  // A refined plan is a new plan. Reusing the id would make a saved view and
  // its refinement indistinguishable, and would collide in the recent-plan map.
  next.planId = `plan-${globalThis.crypto.randomUUID()}`;
  return { ok: true, plan: next };
}
