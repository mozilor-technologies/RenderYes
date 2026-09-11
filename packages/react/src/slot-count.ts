/**
 * How many records a slot's result stands for — which is not `rows.length`.
 *
 * A slot's rows are one page of the set, cut by the row budget, so
 * `rows.length` is the page size whenever the result was truncated: "How many
 * orders in total?" over a 2,500-order shop headlines 100. The runtime already
 * reports what it knows in `completeness`; this helper is the one place that
 * turns rows + completeness into an honest count, so no caller re-derives it
 * from the page.
 */
export interface BeyondPageCount {
  /** `completeness.totalRows` when the runtime reported one, else the page size. */
  count: number;
  /**
   * False when the set is known to continue past `count` — the result is
   * known-incomplete and no total was reported. Render "at least `count`",
   * never `count` alone.
   */
  exact: boolean;
}

/**
 * Counts a slot's records honestly: prefers `completeness.totalRows`, falls
 * back to the page, and says when the page is provably not the set.
 *
 * `rows` may be the slot's array, an already-computed length, or null while
 * the request is pending; `completeness` is the companion prop of the same
 * name. Named for what it does: the count looks beyond the page the slot
 * delivered.
 */
export function countBeyondPage(
  rows: readonly unknown[] | number | null | undefined,
  completeness?: {
    complete?: boolean;
    truncated?: boolean;
    rowCount?: number;
    totalRows?: number;
  } | null,
): BeyondPageCount {
  const page =
    typeof rows === "number"
      ? rows
      : Array.isArray(rows)
        ? rows.length
        : typeof completeness?.rowCount === "number"
          ? completeness.rowCount
          : 0;
  if (typeof completeness?.totalRows === "number") {
    return { count: completeness.totalRows, exact: true };
  }
  const knownIncomplete =
    completeness?.complete === false || completeness?.truncated === true;
  return { count: page, exact: !knownIncomplete };
}
