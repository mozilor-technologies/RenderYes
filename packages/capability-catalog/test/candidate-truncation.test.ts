import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/catalog.mjs");

/**
 * What the candidate drops when a capability exceeds the field ceiling.
 *
 * Shallowest-first is a reasonable prior on its own and carries a bias nobody
 * chose: a *composite* value is nested by definition — a price is an amount and
 * a currency, a measure a number and a unit, a point a latitude and a longitude
 * — so sorting by depth discriminates against precisely the values that cannot
 * be one scalar. A cold install found the money missing from the two most
 * obvious views in a commerce admin.
 *
 * Two rules, neither of which decides what matters: nested leaves are kept or
 * dropped together, because half a price is wrong rather than partial; and the
 * drop is named rather than counted, because "1,404 dropped" tells an operator
 * nothing about whether the field their view is about survived.
 */
function candidateFor(scalarCount: number) {
  const dir = mkdtempSync(join(tmpdir(), "iv-cand-"));
  const filler = Array.from({ length: scalarCount }, (_, i) => `  f${i}: String`).join("\n");
  writeFileSync(
    join(dir, "schema.graphql"),
    `type Query { orders(first: Int, after: String): OrderConnection! }
     type OrderConnection { edges: [OrderEdge!]! pageInfo: PageInfo! }
     type OrderEdge { node: Order! cursor: String! }
     type PageInfo { hasNextPage: Boolean! endCursor: String }
     type Money { amount: Float! currency: String! }
     type Order {
       id: ID!
${filler}
       total: Money!
     }`,
  );
  // `spawnSync`, because this CLI reports to stderr and exits 0. `execFileSync`
  // returns stdout alone and throws only on failure, so the report would be
  // read as an empty string and every assertion over it would pass vacuously.
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  };
  run(["inventory", "--schema", join(dir, "schema.graphql"), "--catalog-id", "shop",
       "--out", join(dir, "inv.json")]);
  const report = run(["candidate", "--inventory", join(dir, "inv.json"),
                      "--approve-all-discovered", "--out", join(dir, "dec.json")]);
  const decisions = JSON.parse(readFileSync(join(dir, "dec.json"), "utf8"));
  return { decisions, report, dir };
}

describe("what the field ceiling drops", () => {
  it("keeps a nested object's leaves together, or drops them together", () => {
    const { decisions } = candidateFor(600);
    const approved: string[] = decisions.queries[0].approvedOutputFields;
    const money = approved.filter((path) => path.startsWith("total."));
    expect(approved.length).toBeLessThanOrEqual(500);
    // Never one of the pair: an amount without its currency is not partial
    // information, it is a number that means nothing.
    expect(money.length === 0 || money.length === 2).toBe(true);
  });

  it("drops a whole composite when only part of it would fit", () => {
    // The boundary case, and the only one that exercises the rule: 499 root
    // scalars leave exactly one slot, and `total` needs two. Filling that slot
    // would put an amount on screen with no currency. With enough root fields
    // to blow the budget on their own the composite never gets considered, so a
    // test built that way passes whether the rule exists or not.
    const { decisions } = candidateFor(498);
    const approved: string[] = decisions.queries[0].approvedOutputFields;
    expect(approved.length).toBe(499);
    expect(approved.filter((path) => path.startsWith("total."))).toEqual([]);
  });

  it("leaves a capability under the ceiling untouched", () => {
    const { decisions } = candidateFor(20);
    const approved: string[] = decisions.queries[0].approvedOutputFields;
    expect(approved).toContain("total.amount");
    expect(approved).toContain("total.currency");
  });
});

describe("what the operator is told about a drop", () => {
  it("names dropped fields of consequence, with their semantic type", () => {
    const { report } = candidateFor(600);
    expect(report).toMatch(/graphql\.orders: \d+ discovered, 500 kept/);
    expect(report).toMatch(/dropped: total\.amount \(money\)/);
  });

  it("says where the dropped fields still are", () => {
    const { report, dir } = candidateFor(600);
    expect(report).toContain(join(dir, "inv.json"));
    expect(report).toMatch(/approvedOutputFields/);
  });
});
