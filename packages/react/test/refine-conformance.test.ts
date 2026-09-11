import { describe, expect, it } from "vitest";
import type { FilterGroup } from "@renderyes/core";
import type { RefineFilterGroup, RefineOperation } from "../src/refine-operations.js";

/**
 * The exported refine types must BE the plan's own types, not lookalikes.
 *
 * The bug this pins: `RefineFilterGroup` was hand-copied as
 * `{operator: "and" | "or" | "not"}` while the validator accepts only the
 * plan's `{combine: "all" | "any" | "none"}` — and treats `operator` as a
 * condition marker, so every value of the exported type tripped both branches
 * of the group-vs-condition test and was rejected as ambiguous. One of six
 * refine operations was dead for anyone following the public type, and no
 * test tied the two packages together.
 *
 * The fix is aliasing, which makes drift impossible rather than detected;
 * these assertions are the compile-time proof, kept as a test so removing the
 * alias fails loudly instead of quietly reintroducing a copy.
 */

// A filter written against the exported type, using the validator's actual
// vocabulary — nested group included.
const filter: RefineFilterGroup = {
  combine: "all",
  conditions: [
    { field: "daysLeft", operator: "lt", value: 30 },
    {
      combine: "any",
      conditions: [{ field: "category", operator: "eq", value: "dairy" }],
    },
  ],
};

// The alias, not a structural twin: assignable in both directions.
const asPlanFilter: FilterGroup = filter;
const backAgain: RefineFilterGroup = asPlanFilter;

// The pre-fix shape must no longer compile.
// @ts-expect-error `operator` on a group was the drift; the validator wants `combine`.
const legacy: RefineFilterGroup = { operator: "and", conditions: [] };

const operation: RefineOperation = { kind: "setFilter", requestId: "r1", filter };

describe("refine types are the plan's own", () => {
  it("a setFilter built from the exported type carries the validator's vocabulary", () => {
    expect(operation.kind).toBe("setFilter");
    expect(backAgain.combine).toBe("all");
    // The serialized wire shape is exactly what core's parseFilterNode reads
    // as a group: `combine` present, `operator` absent at group level.
    const wire = JSON.parse(JSON.stringify(filter)) as Record<string, unknown>;
    expect(wire.combine).toBe("all");
    expect("operator" in wire).toBe(false);
    expect(legacy).toBeDefined();
  });
});
