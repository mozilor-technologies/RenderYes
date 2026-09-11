import { describe, expect, it } from "vitest";
import {
  canPushFilter,
  describeFilterRefusal,
  renderFilterValue,
  type FilterPushdown,
} from "../src/filter-pushdown.js";

/**
 * Compiling the planner's filter into four real dialects.
 *
 * These are the shapes the schemas actually declare: Payload's
 * `{title: {equals: "x"}}` with `AND`/`OR` lists, Hasura's `{title: {_eq: "x"}}`
 * with `_and`/`_or`, Prisma-style `equals`/`gt`, Strapi's `eq`/`ne`. Nothing
 * here is declared by a host — every operator name was read off the schema, so
 * a test that hardcoded one dialect's spelling would be testing the wrong
 * thing.
 */

const payload: FilterPushdown = {
  argument: "where",
  fields: {
    title: { operators: { eq: "equals", "not-eq": "not_equals", contains: "contains" } },
    publishedAt: {
      operators: { gte: "greater_than_equal", lte: "less_than_equal", gt: "greater_than" },
      nullTest: { name: "exists", nullValue: false },
    },
    section: { operators: { eq: "equals", in: "in" } },
  },
  combinators: { all: { name: "AND", list: true }, any: { name: "OR", list: true } },
};

const hasura: FilterPushdown = {
  argument: "where",
  fields: {
    title: { operators: { eq: "_eq", "not-eq": "_neq", contains: "_ilike" } },
    publishedAt: {
      operators: { gte: "_gte", lte: "_lte" },
      nullTest: { name: "_is_null", nullValue: true },
    },
  },
  // _not is a single bool_exp on a real Hasura, beside list-typed _and/_or.
  combinators: {
    all: { name: "_and", list: true },
    any: { name: "_or", list: true },
    none: { name: "_not", list: false },
  },
};

describe("a planned filter, compiled into the upstream's own argument", () => {
  it("renders one condition without needing a combinator at all", () => {
    const filter = { combine: "all" as const, conditions: [{ field: "title", operator: "eq" as const, value: "Budget" }] };
    expect(renderFilterValue(payload, filter)).toEqual({
      ok: true,
      value: { title: { equals: "Budget" } },
    });
    expect(renderFilterValue(hasura, filter)).toEqual({
      ok: true,
      value: { title: { _eq: "Budget" } },
    });
  });

  it("renders each dialect's own spelling from the same plan", () => {
    const filter = {
      combine: "any" as const,
      conditions: [
        { field: "title", operator: "contains" as const, value: "water" },
        { field: "publishedAt", operator: "gte" as const, value: "2026-01-01" },
      ],
    };
    expect(renderFilterValue(payload, filter)).toEqual({
      ok: true,
      value: {
        OR: [{ title: { contains: "water" } }, { publishedAt: { greater_than_equal: "2026-01-01" } }],
      },
    });
    expect(renderFilterValue(hasura, filter)).toEqual({
      ok: true,
      // Wrapped in wildcards, unlike Payload's `contains` above: SQL LIKE
      // matches the whole value, so the raw string would have compiled
      // "contains water" into "is exactly water" — zero rows, looking like an
      // answer. The visitor's own %/_ are escaped, so they search literally.
      value: { _or: [{ title: { _ilike: "%water%" } }, { publishedAt: { _gte: "2026-01-01" } }] },
    });
  });

  it("nests groups the way the plan nested them", () => {
    const filter = {
      combine: "all" as const,
      conditions: [
        { field: "section", operator: "eq" as const, value: "sport" },
        {
          combine: "any" as const,
          conditions: [
            { field: "title", operator: "contains" as const, value: "cricket" },
            { field: "title", operator: "contains" as const, value: "football" },
          ],
        },
      ],
    };
    expect(renderFilterValue(payload, filter)).toEqual({
      ok: true,
      value: {
        AND: [
          { section: { equals: "sport" } },
          { OR: [{ title: { contains: "cricket" } }, { title: { contains: "football" } }] },
        ],
      },
    });
  });

  it("compiles a range as the pair, since no dialect spells it as one operator", () => {
    const filter = {
      combine: "all" as const,
      conditions: [
        { field: "publishedAt", operator: "between" as const, value: ["2026-01-01", "2026-02-01"] },
      ],
    };
    expect(renderFilterValue(payload, filter)).toEqual({
      ok: true,
      value: { publishedAt: { greater_than_equal: "2026-01-01", less_than_equal: "2026-02-01" } },
    });
  });

  it("escapes the visitor's own wildcards in a like pattern", () => {
    // A search for "50%" is a search for the string "50%". Unescaped, the
    // visitor's % becomes a wildcard and matches "50 anything" — rows nobody
    // asked for, in a shape that looks right.
    const result = renderFilterValue(hasura, {
      combine: "all",
      conditions: [{ field: "title", operator: "contains", value: "50%_off" }],
    });
    expect(result).toEqual({ ok: true, value: { title: { _ilike: "%50\\%\\_off%" } } });
  });

  it("gets the null test the right way round in both conventions", () => {
    // `exists: false` and `_is_null: true` both mean "is null". A name table
    // alone would compile one of them backwards and return exactly the rows the
    // visitor did not ask for.
    const isNull = { combine: "all" as const, conditions: [{ field: "publishedAt", operator: "is-null" as const }] };
    const notNull = { combine: "all" as const, conditions: [{ field: "publishedAt", operator: "is-not-null" as const }] };
    expect(renderFilterValue(payload, isNull)).toEqual({ ok: true, value: { publishedAt: { exists: false } } });
    expect(renderFilterValue(payload, notNull)).toEqual({ ok: true, value: { publishedAt: { exists: true } } });
    expect(renderFilterValue(hasura, isNull)).toEqual({ ok: true, value: { publishedAt: { _is_null: true } } });
    expect(renderFilterValue(hasura, notNull)).toEqual({ ok: true, value: { publishedAt: { _is_null: false } } });
  });
});

describe("what it will not compile", () => {
  it("refuses an operator the schema does not declare, naming it", () => {
    const filter = {
      combine: "all" as const,
      conditions: [{ field: "title", operator: "starts-with" as const, value: "The" }],
    };
    const result = renderFilterValue(payload, filter);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(describeFilterRefusal(result.refusal)).toMatch(/cannot express "starts-with" on "title"/);
  });

  it("refuses a field outside the approved filter vocabulary", () => {
    const result = renderFilterValue(payload, {
      combine: "all",
      conditions: [{ field: "authorEmail", operator: "eq", value: "x@example.com" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.refusal).toEqual({ kind: "unknown-field", field: "authorEmail" });
  });

  it("refuses a combinator the schema has no field for", () => {
    // Payload declares AND and OR and no NOT, so a `none` group has nowhere to go.
    const result = renderFilterValue(payload, {
      combine: "none",
      conditions: [{ field: "title", operator: "eq", value: "x" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.refusal).toEqual({ kind: "unsupported-combinator", combine: "none" });
    expect(canPushFilter(hasura, { combine: "none", conditions: [{ field: "title", operator: "eq", value: "x" }] })).toBe(true);
  });

  it("refuses a range the schema has only one half of", () => {
    const half: FilterPushdown = {
      ...payload,
      fields: { publishedAt: { operators: { gte: "greater_than_equal" } } },
    };
    expect(
      canPushFilter(half, {
        combine: "all",
        conditions: [{ field: "publishedAt", operator: "between", value: ["a", "b"] }],
      }),
    ).toBe(false);
  });

  it("refuses when there is no pushdown at all, rather than inventing one", () => {
    const result = renderFilterValue(undefined, {
      combine: "all",
      conditions: [{ field: "title", operator: "eq", value: "x" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.refusal.kind).toBe("no-pushdown");
  });

  it("refuses the whole filter when any part of it does not compile", () => {
    // Partial push-down would be the worst outcome available: the upstream
    // narrows on half the conditions, the rows look filtered, and the half that
    // silently did not apply is invisible in the result.
    const result = renderFilterValue(payload, {
      combine: "all",
      conditions: [
        { field: "title", operator: "eq", value: "x" },
        { field: "title", operator: "ends-with", value: "y" },
      ],
    });
    expect(result.ok).toBe(false);
  });
});
