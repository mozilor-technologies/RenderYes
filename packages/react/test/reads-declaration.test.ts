import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineHostComponent,
  findUnprojectedReads,
  warnUnprojectedReads,
} from "../src/define-host-component.js";
import { defineView, ingestViews } from "../src/define-view.js";

/**
 * The field-level agreement a slot never had: a view declares a column
 * reading `user.email`, the plan projects `user.firstName`/`lastName`
 * instead, and every cell renders the missing-value dash — including rows
 * where `user` is genuinely null, so one column holds two dashes meaning
 * opposite things. `reads` turns the mismatch into a console warning at
 * data-bind time. The line it walks: an absent key is evidence the plan did
 * not project the field; a null value is not — null is data.
 */

function NullView() {
  return null;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reads declaration", () => {
  it("registration accepts reads, and the published contract carries only accepts", () => {
    // defineComponent rejects any slot key besides `accepts`, so `reads`
    // must be a renderer-side declaration that never reaches the contract.
    const registered = defineHostComponent({
      id: "ReadsTable",
      description: "A table that declares the field paths it reads.",
      dataSlots: {
        rows: { accepts: [{ shape: "collection" }], reads: ["user.email", "status"] },
      },
      component: NullView,
    });
    expect(registered.definition.dataSlots.rows).toEqual({
      accepts: [{ shape: "collection" }],
    });
  });

  it("flows through defineView and ingestViews", () => {
    const spec = defineView({
      id: "ReadsView",
      description: "A view file that declares reads on its slot.",
      dataSlots: { rows: { accepts: [{ shape: "collection" }], reads: ["user.email"] } },
    });
    const [registered] = ingestViews({
      "./views/reads.view.tsx": { spec, default: NullView },
    });
    expect(registered!.definition.dataSlots.rows).toEqual({
      accepts: [{ shape: "collection" }],
    });
  });

  it("flags a path absent from every record's projection", () => {
    expect(
      findUnprojectedReads(
        ["user.email"],
        [{ user: { firstName: "Ada" } }, { user: { firstName: "Grace" } }],
      ),
    ).toEqual(["user.email"]);
  });

  it("does not flag a path that is merely null — null is data, not absence", () => {
    expect(
      findUnprojectedReads(
        ["user.email"],
        [{ user: { email: null } }, { user: { firstName: "Ada" } }],
      ),
    ).toEqual([]);
  });

  it("does not flag when only null ancestors hide the path — that is undecidable", () => {
    expect(findUnprojectedReads(["user.email"], [{ user: null }])).toEqual([]);
    // But a single decidable record settles it despite the null ones.
    expect(
      findUnprojectedReads(["user.email"], [{ user: null }, { user: { firstName: "Ada" } }]),
    ).toEqual(["user.email"]);
  });

  it("checks a single entity record the same way", () => {
    expect(findUnprojectedReads(["total.net"], { total: { gross: 1 } })).toEqual([
      "total.net",
    ]);
    expect(findUnprojectedReads(["total.net"], { total: { net: null } })).toEqual([]);
  });

  it("stays silent with no data yet", () => {
    expect(findUnprojectedReads(["user.email"], null)).toEqual([]);
    expect(findUnprojectedReads(["user.email"], [])).toEqual([]);
  });

  it("warns loudly, naming the component, slot and path — once, not per render", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const data = [{ user: { firstName: "Ada" } }];
    warnUnprojectedReads("WarnOnceTable", "rows", ["user.email"], data);
    warnUnprojectedReads("WarnOnceTable", "rows", ["user.email"], data);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain("WarnOnceTable");
    expect(message).toContain('"rows"');
    expect(message).toContain('"user.email"');
    expect(message).toContain("did not project");
  });

  it("never warns for a projected-but-null value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnUnprojectedReads("NullIsData", "rows", ["user.email"], [{ user: { email: null } }]);
    expect(warn).not.toHaveBeenCalled();
  });
});
