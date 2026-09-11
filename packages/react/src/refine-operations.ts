import type { FilterCondition, FilterGroup, Sort } from "@renderyes/core";

/**
 * The refinement vocabulary, mirrored for the browser.
 *
 * The operation *union* is duplicated from `@renderyes/server` — react must
 * not pull the server package into a browser bundle to describe a request
 * body — but the payloads inside it are the plan's own types, imported
 * type-only from `@renderyes/core`, a dependency this package already has,
 * at zero bundle cost.
 *
 * The first version hand-copied the payload types too, on the theory that a
 * mismatch would "surface immediately" because the server re-validates every
 * operation. It surfaced as a dead feature instead: the copied filter group
 * said `{operator: "and" | "or" | "not"}` while the validator accepts only
 * the plan's `{combine: "all" | "any" | "none"}` — and reads `operator` as a
 * *condition* marker, so every value of the exported type was rejected as
 * ambiguous. `setFilter` was unusable through its own public contract, for
 * anyone who followed it. A copy can drift; an alias cannot.
 *
 * Every operation edits an existing plan. None can introduce a capability,
 * component, or field the catalog did not already approve, which is what
 * makes direct manipulation safe to hand to a visitor: refinement cannot
 * widen what they are allowed to see, only rearrange what they already have.
 */

export type RefineSort = Sort;

/** A filter condition, matching the catalog's approved operator vocabulary. */
export type RefineCondition = FilterCondition;

/** A filter tree: `all` = AND, `any` = OR, `none` = NOR. */
export type RefineFilterGroup = FilterGroup;

export type RefineOperation =
  | { kind: "setSort"; requestId: string; sort: readonly RefineSort[] }
  | { kind: "setFilter"; requestId: string; filter: RefineFilterGroup }
  | { kind: "clearFilter"; requestId: string }
  | { kind: "setLimit"; requestId: string; limit: number }
  | { kind: "removeNode"; nodeId: string }
  | { kind: "reorderNodes"; nodeIds: readonly string[] };
