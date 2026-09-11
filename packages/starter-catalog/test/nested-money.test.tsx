import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createMetricCardView } from "../src/metric-card.js";
import { resolveAxes } from "../src/charts.js";
import { deriveScalarFields, scalarLeafEntries } from "../src/shared.js";

/**
 * Nested money, from a live Saleor compose. Every monetary value in a
 * Relay-shaped API sits inside nested objects — `gross.amount`,
 * `total.gross.amount` — and every field enumerator in this package worked one
 * level deep. So the metric card showed the currency code where the figure
 * belonged, and the charts rendered their empty state over non-empty rows:
 * silent both times, with the catalog, planner and payload all correct.
 *
 * The payloads here are verbatim from the report. The precedent is the entity
 * fix ("render the nested half instead of dropping it") — these components
 * did not receive it; this file is what makes that class of miss loud.
 */

// The metric as delivered: the figure is two levels down.
const revenue = {
  currency: "USD",
  gross: { amount: 10137.88 },
  net: { amount: 8341.12 },
};

// A collection row as delivered: no top-level numeric anywhere.
const orders = [
  { status: "FULFILLED", total: { gross: { amount: 9325.71, currency: "USD" } } },
  { status: "UNFULFILLED", total: { gross: { amount: 812.17, currency: "USD" } } },
];

afterEach(cleanup);

describe("nested money reaches the screen", () => {
  it("the metric card renders each amount as one money value, never the code alone", () => {
    const Card = createMetricCardView();
    render(<Card heading="This month's revenue" metric={revenue} state="ready" />);
    // The bug on record, twice: first this read "CURRENCY / USD" and nothing
    // else; then leaf enumeration rendered three co-equal stats with the
    // currency code as the most prominent value. Amount and currency are one
    // value, and the ancestor-level `currency` covers both amounts.
    expect(screen.getByText("10,137.88 USD")).toBeDefined();
    expect(screen.getByText("8,341.12 USD")).toBeDefined();
    expect(screen.getByText("Gross")).toBeDefined();
    expect(screen.getByText("Net")).toBeDefined();
    // The consumed currency leaf is no longer a stat of its own.
    expect(screen.queryByText("USD")).toBeNull();
    expect(screen.queryByText("Currency")).toBeNull();
  });

  it("a currency with no amount anywhere near it still renders as before", () => {
    const Card = createMetricCardView();
    render(<Card metric={{ currency: "USD", note: "settlement" }} state="ready" />);
    expect(screen.getByText("Currency")).toBeDefined();
    expect(screen.getByText("USD")).toBeDefined();
  });

  it("charts find their series inside nested objects", () => {
    const { xKey, yKeys } = resolveAxes(orders, {});
    expect(xKey).toBe("status");
    // Was []: no top-level number, so plottable was false and the chart showed
    // its empty state despite two rows of data.
    expect(yKeys).toEqual(["total.gross.amount"]);
  });

  it("a leading row with a null object does not hide the series behind it", () => {
    const { yKeys } = resolveAxes(
      [{ status: "DRAFT", total: null }, ...orders],
      {},
    );
    expect(yKeys).toEqual(["total.gross.amount"]);
  });

  it("explicit options still win over derivation", () => {
    const { xKey, yKeys } = resolveAxes(orders, {
      xKey: "status",
      yKeys: ["total.gross.amount"],
    });
    expect(xKey).toBe("status");
    expect(yKeys).toEqual(["total.gross.amount"]);
  });

  it("derived supporting fields reach nested leaves too, and never the prototype", () => {
    const specs = deriveScalarFields(orders, "status", 3);
    expect(specs.map((spec) => spec.key)).toEqual([
      "total.gross.amount",
      "total.gross.currency",
    ]);
    // A key is data; __proto__ in it must not walk the prototype chain.
    const hostile = JSON.parse('{"__proto__": {"amount": 1}, "safe": 2}');
    expect(scalarLeafEntries(hostile).map((spec) => spec.key)).toEqual(["safe"]);
  });

  it("arrays are skipped, not descended — an embedded list is not a field", () => {
    const specs = scalarLeafEntries({
      currency: "USD",
      lines: [{ amount: 3 }],
      gross: { amount: 1 },
    });
    expect(specs.map((spec) => spec.key)).toEqual(["currency", "gross.amount"]);
  });
});
