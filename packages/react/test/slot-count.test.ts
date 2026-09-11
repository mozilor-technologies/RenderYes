import { describe, expect, it } from "vitest";
import { countBeyondPage } from "../src/slot-count.js";

/**
 * `rows.length` is the page, not the set: "How many orders in total?" over a
 * 2,500-order shop headlined 100 — the page size — while the caveat one line
 * above correctly said "100 of 2500". This helper is the one honest counter.
 */
describe("countBeyondPage", () => {
  const page = Array.from({ length: 100 }, (_, i) => ({ id: i }));

  it("prefers totalRows over the page size", () => {
    expect(
      countBeyondPage(page, { complete: false, truncated: true, rowCount: 100, totalRows: 2500 }),
    ).toEqual({ count: 2500, exact: true });
  });

  it("signals incompleteness when the set continues and no total is known", () => {
    expect(countBeyondPage(page, { complete: false, truncated: true, rowCount: 100 })).toEqual({
      count: 100,
      exact: false,
    });
  });

  it("treats a complete result's page as the set", () => {
    expect(countBeyondPage(page, { complete: true, truncated: false, rowCount: 100 })).toEqual({
      count: 100,
      exact: true,
    });
  });

  it("works without completeness at all", () => {
    expect(countBeyondPage([{ id: 1 }, { id: 2 }])).toEqual({ count: 2, exact: true });
  });

  it("accepts a precomputed length, and falls back to rowCount without rows", () => {
    expect(countBeyondPage(42)).toEqual({ count: 42, exact: true });
    expect(countBeyondPage(null, { complete: false, rowCount: 7 })).toEqual({
      count: 7,
      exact: false,
    });
  });
});
