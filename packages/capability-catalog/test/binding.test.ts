import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createGraphQlCatalogInventory, rebindGraphQlDecisions } from "../src/graphql.js";

/**
 * A decisions file, its inventory, and the hash that binds them.
 *
 * This file exists because two diagnostics sent each other in a circle. Adding
 * one custom scalar mapping re-hashes an inventory whose *schema is
 * byte-identical* — `reviewSourceHash` covers the inventory's options, and
 * `scalarMappings` is one of them. The compile then refused the pair with a
 * message naming the schema, and told the host to run `diff`; `diff` compared
 * fields, found nothing wrong, printed "nothing to decide" and exited 0. A host
 * following the instruction had no exit, and CI gating on `diff` went green on
 * decisions that could not compile.
 *
 * The only escape was hand-editing `reviewSourceHash` to the value the error
 * printed — forging the hash the review depends on. So the design's own
 * pressure pushed a host toward defeating its single audit control, and one
 * scalar mapping was enough to get there.
 *
 * Everything here runs the real binary, because the bug was not in either
 * function: each behaved as written. It was in what they said to each other.
 */

const CLI = fileURLToPath(new URL("../bin/catalog.mjs", import.meta.url));

const SDL = /* GraphQL */ `
  scalar Decimal
  type Query {
    "List orders."
    orders(first: Int): OrderConnection
  }
  type OrderConnection { edges: [OrderEdge!]!  pageInfo: PageInfo! }
  type OrderEdge { cursor: String!  node: Order! }
  type PageInfo { hasNextPage: Boolean!  endCursor: String }
  type Order { id: ID!  total: Decimal! }
`;

/** Same schema, but the field a reviewer approved is gone. */
const SDL_FIELD_REMOVED = SDL.replace("type Order { id: ID!", "type Order { reference: String!");

function run(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

/**
 * A reviewed decisions file: not the approve-everything candidate, but one
 * somebody cut down. If a re-bind quietly regenerated instead of preserving,
 * these are the values that would revert.
 */
function reviewed() {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-binding-"));
  const file = (name: string) => join(dir, name);
  writeFileSync(file("schema.graphql"), SDL);
  writeFileSync(file("scalars.json"), JSON.stringify({ Decimal: { schema: { type: "string" } } }));

  expect(
    run(["inventory", "--schema", file("schema.graphql"), "--catalog-id", "shop",
         "--out", file("before.json")]).status,
  ).toBe(0);
  expect(
    run(["candidate", "--inventory", file("before.json"), "--approve-all-discovered",
         "--out", file("decisions.json")]).status,
  ).toBe(0);

  const decisions = JSON.parse(readFileSync(file("decisions.json"), "utf8"));
  decisions.queries[0].approvedOutputFields = ["id"];
  decisions.queries[0].limits.maximumSelectedFields = 1;
  decisions.queries[0].policy.maximumRows = 25;
  writeFileSync(file("decisions.json"), JSON.stringify(decisions, null, 2));

  // The correction that starts all of this. Same schema file, one mapping.
  expect(
    run(["inventory", "--schema", file("schema.graphql"), "--catalog-id", "shop",
         "--scalars", file("scalars.json"), "--out", file("after.json")]).status,
  ).toBe(0);

  return { dir, file };
}

describe("a scalar mapping re-hashes an inventory whose schema did not move", () => {
  it("changes reviewSourceHash and leaves schemaHash alone", () => {
    const { file } = reviewed();
    const before = JSON.parse(readFileSync(file("before.json"), "utf8"));
    const after = JSON.parse(readFileSync(file("after.json"), "utf8"));
    // The premise of every message below: nothing about the schema changed.
    expect(after.schemaHash).toBe(before.schemaHash);
    expect(after.reviewSourceHash).not.toBe(before.reviewSourceHash);
  });

  it("diff names the stale binding and exits 1, instead of reporting health", () => {
    const { file } = reviewed();
    const result = run(["diff", "--inventory", file("after.json"), "--decisions", file("decisions.json")]);

    // The regression, exactly: this printed "nothing to decide" and exited 0
    // while `compile` refused the same pair.
    expect(result.stdout).not.toContain("nothing to decide");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("made against a different inventory");
    // Both hashes named, so the host can see which file is behind.
    const before = JSON.parse(readFileSync(file("before.json"), "utf8"));
    const after = JSON.parse(readFileSync(file("after.json"), "utf8"));
    expect(result.stdout).toContain(before.reviewSourceHash);
    expect(result.stdout).toContain(after.reviewSourceHash);
    // And the way out, named where the host is standing.
    expect(result.stdout).toContain("Nothing you decided is affected");
    expect(result.stdout).toContain("migrate --decisions");
  });

  it("migrate --inventory re-binds, and the review survives it", () => {
    const { file } = reviewed();
    const rebound = run(["migrate", "--decisions", file("decisions.json"),
                         "--inventory", file("after.json"), "--write"]);
    expect(rebound.status).toBe(0);
    expect(rebound.stderr).toContain("Re-bound");

    const decisions = JSON.parse(readFileSync(file("decisions.json"), "utf8"));
    // Not regenerated: a re-bind that quietly re-ran `candidate` would restore
    // every field and the default row budget, discarding the review it claims
    // to preserve.
    expect(decisions.queries[0].approvedOutputFields).toEqual(["id"]);
    expect(decisions.queries[0].policy.maximumRows).toBe(25);

    // The point of the whole exercise: it compiles now.
    const compiled = run(["compile", "--schema", file("schema.graphql"),
                          "--inventory", file("after.json"), "--decisions", file("decisions.json"),
                          "--endpoint", "https://api.example/graphql", "--out", file("catalog.json")]);
    expect(compiled.status, compiled.stderr).toBe(0);
    expect(run(["diff", "--inventory", file("after.json"),
                "--decisions", file("decisions.json")]).status).toBe(0);
  });

  it("refuses to re-bind past a decision, and writes nothing when it refuses", () => {
    const { file } = reviewed();
    writeFileSync(file("moved.graphql"), SDL_FIELD_REMOVED);
    run(["inventory", "--schema", file("moved.graphql"), "--catalog-id", "shop",
         "--scalars", file("scalars.json"), "--out", file("moved.json")]);
    const beforeBytes = readFileSync(file("decisions.json"), "utf8");

    const refused = run(["migrate", "--decisions", file("decisions.json"),
                         "--inventory", file("moved.json"), "--write"]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("Refusing to re-bind");
    // Names the offender, not just the refusal.
    expect(refused.stderr).toContain("graphql.orders: id");
    expect(refused.stderr).toContain("a review that never happened");
    // `--write` was passed and must not have taken effect.
    expect(readFileSync(file("decisions.json"), "utf8")).toBe(beforeBytes);

    // And diff agrees it is a review, not bookkeeping.
    const diffed = run(["diff", "--inventory", file("moved.json"), "--decisions", file("decisions.json")]);
    expect(diffed.status).toBe(1);
    expect(diffed.stdout).toContain("Something you decided is affected");
  });
});

describe("the three drift failures are told apart", () => {
  it("names the inventory options, not the schema, when only they changed", () => {
    const { file } = reviewed();
    const result = run(["compile", "--schema", file("schema.graphql"),
                        "--inventory", file("after.json"), "--decisions", file("decisions.json"),
                        "--endpoint", "https://api.example/graphql"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("made against a different inventory");
    // The old message said "do not match the reviewed schema" here, sending a
    // host to diff their API against yesterday's for a change that never was.
    expect(result.stderr).toContain("The schema itself is unchanged");
    expect(result.stderr).toContain("scalar mapping");
  });

  it("names the schema when the schema really is a different one", () => {
    const { file } = reviewed();
    writeFileSync(file("moved.graphql"), SDL_FIELD_REMOVED);
    const result = run(["compile", "--schema", file("moved.graphql"),
                        "--inventory", file("after.json"), "--decisions", file("decisions.json"),
                        "--endpoint", "https://api.example/graphql"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not the one the inventory was taken from");
  });

  it("names the edit when the inventory file itself was altered", () => {
    const { file } = reviewed();
    const inventory = JSON.parse(readFileSync(file("after.json"), "utf8"));
    inventory.querySelections[0].resultShape = "time-series";
    writeFileSync(file("edited.json"), JSON.stringify(inventory, null, 2));

    const result = run(["compile", "--schema", file("schema.graphql"),
                        "--inventory", file("edited.json"), "--decisions", file("decisions.json"),
                        "--endpoint", "https://api.example/graphql"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("has been edited since it was written");
    // Points at the file that is editable, rather than only refusing.
    expect(result.stderr).toContain('"resultShape"');
  });
});

describe("rebindGraphQlDecisions", () => {
  const inventoryOf = (sdl: string, scalarMappings = {}) =>
    createGraphQlCatalogInventory({
      schema: sdl,
      catalog: { id: "shop", version: "1.0.0", description: "Test." },
      source: { id: "s", label: "Test", description: "Test." },
      queries: [{
        fieldName: "orders",
        capabilityId: "graphql.orders",
        purpose: "Orders.",
        dataTypeId: "Order",
        dataTypeDescription: "An order.",
        resultShape: "collection" as const,
        matchKey: "id",
        scalarMappings,
      }],
    });

  const decisionsFor = (hash: string) => ({
    schemaVersion: "1.0" as const,
    reviewSourceHash: hash,
    queries: [{
      capabilityId: "graphql.orders",
      approvedVisitorArguments: ["first"],
      identityArguments: {},
      approvedOutputFields: ["id"],
      requiredOutputFields: ["id"],
      policy: { authentication: "session" as const, maximumRows: 25, timeoutMs: 5_000 },
      limits: { maximumSelectionDepth: 1, maximumSelectedFields: 1 },
    }],
  });

  it("is a no-op when already bound", () => {
    const inventory = inventoryOf(SDL, { Decimal: { schema: { type: "string" } } });
    const result = rebindGraphQlDecisions(inventory, decisionsFor(inventory.reviewSourceHash));
    expect(result.rebound).toBe(false);
    expect(result.diff.binding.bound).toBe(true);
  });

  it("rebinds when the hash moved and nothing decided did", () => {
    const inventory = inventoryOf(SDL, { Decimal: { schema: { type: "string" } } });
    const result = rebindGraphQlDecisions(inventory, decisionsFor("stale-hash"));
    expect(result.rebound).toBe(true);
    expect(result.decisions.reviewSourceHash).toBe(inventory.reviewSourceHash);
    // The input is not mutated — a caller that refuses the result keeps theirs.
    expect(result.diff.binding.decisionsHash).toBe("stale-hash");
  });

  it("refuses when an approved field is gone", () => {
    const inventory = inventoryOf(SDL_FIELD_REMOVED, { Decimal: { schema: { type: "string" } } });
    const result = rebindGraphQlDecisions(inventory, decisionsFor("stale-hash"));
    expect(result.rebound).toBe(false);
    expect(result.diff.binding.affected).toBe(true);
    expect(result.decisions.reviewSourceHash).toBe("stale-hash");
  });
});
