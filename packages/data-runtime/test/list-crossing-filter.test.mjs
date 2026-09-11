import assert from "node:assert/strict";
import test from "node:test";
import { applyValidatedQuery } from "../dist/query.js";

/**
 * Filtering on a path that crosses a list.
 *
 * `readField` deliberately maps a dotted path over list elements —
 * `categories.title` on an article reads to the LIST of its section titles —
 * so any row whose categories include the wanted one should match. Before
 * this, `eq` compared that list to the scalar with strict JSON equality:
 * `["Politics"] eq "Politics"` was false for every row, including the
 * matching ones, while `filterFields` advertised the path to the planner as
 * filterable. A visitor asking for one section got "No matching records"
 * over a dataset full of them. Found live on a Payload CMS host.
 */

const ARTICLES = [
  { id: 1, title: "Budget passes", categories: [{ title: "Politics" }] },
  { id: 2, title: "Cup final", categories: [{ title: "Sport" }] },
  {
    id: 3,
    title: "Stadium funding row",
    categories: [{ title: "Politics" }, { title: "Sport" }],
  },
];

function ids(result) {
  return result.map((row) => row.id);
}

test("eq on a list-crossing path means any element equals", () => {
  const result = applyValidatedQuery(ARTICLES, {
    filter: {
      combine: "all",
      conditions: [{ field: "categories.title", operator: "eq", value: "Politics" }],
    },
  });
  assert.deepEqual(ids(result), [1, 3]);
});

test("not-eq on a list-crossing path means no element equals", () => {
  const result = applyValidatedQuery(ARTICLES, {
    filter: {
      combine: "all",
      conditions: [{ field: "categories.title", operator: "not-eq", value: "Politics" }],
    },
  });
  assert.deepEqual(ids(result), [2]);
});

test("in on a list-crossing path matches on any shared element", () => {
  const result = applyValidatedQuery(ARTICLES, {
    filter: {
      combine: "all",
      conditions: [
        { field: "categories.title", operator: "in", value: ["Sport", "Culture"] },
      ],
    },
  });
  assert.deepEqual(ids(result), [2, 3]);
});

test("not-in on a list-crossing path requires no shared element", () => {
  const result = applyValidatedQuery(ARTICLES, {
    filter: {
      combine: "all",
      conditions: [
        { field: "categories.title", operator: "not-in", value: ["Sport"] },
      ],
    },
  });
  assert.deepEqual(ids(result), [1]);
});

test("scalar eq is unchanged, including its text normalization", () => {
  const result = applyValidatedQuery(ARTICLES, {
    filter: {
      combine: "all",
      conditions: [{ field: "title", operator: "eq", value: "  BUDGET PASSES " }],
    },
  });
  assert.deepEqual(ids(result), [1]);
});

test("array-to-array eq stays exact equality, not overlap", () => {
  const rows = [{ id: 1, tags: ["a", "b"] }];
  const overlap = applyValidatedQuery(rows, {
    filter: {
      combine: "all",
      conditions: [{ field: "tags", operator: "eq", value: ["a"] }],
    },
  });
  assert.deepEqual(ids(overlap), []);
  const exact = applyValidatedQuery(rows, {
    filter: {
      combine: "all",
      conditions: [{ field: "tags", operator: "eq", value: ["a", "b"] }],
    },
  });
  assert.deepEqual(ids(exact), [1]);
});
