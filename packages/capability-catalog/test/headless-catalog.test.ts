import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compileApprovedGraphQlCatalog,
  compileGraphQlOperation,
} from "../src/graphql.js";

/**
 * Schema file to a compiling decisions file, with no browser anywhere.
 *
 * The first decisions file was previously obtainable only by clicking through a
 * review app that ships to people with a clone of this repository. A host
 * integrating from a registry had a schema and no route to a catalog at all,
 * and CI had none either — so nothing about onboarding could be scripted,
 * reproduced, or checked by anything but a person.
 *
 * These run the real binary against a real schema and then compile what it
 * produced. A test that only asserted the CLI printed JSON would pass for a
 * candidate that no host could publish.
 */

const CLI = fileURLToPath(new URL("../bin/catalog.mjs", import.meta.url));

const SDL = `
  type Query {
    "List orders."
    orders(first: Int, after: String, channel: String): OrderConnection
    order(id: ID!): Order
  }
  type OrderConnection { edges: [OrderEdge!]!  pageInfo: PageInfo! }
  type OrderEdge { cursor: String!  node: Order! }
  type PageInfo { hasNextPage: Boolean!  endCursor: String }
  type Order { id: ID!  number: String!  total: TaxedMoney }
  type TaxedMoney { currency: String!  gross: Money }
  type Money { amount: Float! }
`;

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-catalog-"));
  const schemaPath = join(dir, "schema.graphql");
  writeFileSync(schemaPath, SDL);
  return { dir, schemaPath };
}

function run(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; status?: number };
    return { stdout: failure.stdout ?? "", status: failure.status ?? 1 };
  }
}

describe("schema to a first candidate decisions file, headless", () => {
  it("takes inventory, proposes a candidate, and the candidate compiles", () => {
    const { dir, schemaPath } = workspace();
    const inventoryPath = join(dir, "inventory.json");
    const decisionsPath = join(dir, "decisions.json");

    expect(
      run([
        "inventory",
        "--schema",
        schemaPath,
        "--catalog-id",
        "shop",
        "--queries",
        "orders",
        "--out",
        inventoryPath,
      ]).status,
    ).toBe(0);
    expect(
      run([
        "candidate",
        "--inventory",
        inventoryPath,
        "--approve-all-discovered",
        "--out",
        decisionsPath,
      ]).status,
    ).toBe(0);

    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    const decisions = JSON.parse(readFileSync(decisionsPath, "utf8"));

    // The assertion that matters: what came out of the terminal is publishable.
    const compiled = compileApprovedGraphQlCatalog(SDL, inventory, decisions);
    expect(compiled.catalog.capabilities.map((entry) => entry.id)).toEqual([
      "graphql.orders",
    ]);

    // And the compiled capability can actually be executed against a Relay API:
    // a candidate that omitted `first` would compile and then be rejected by
    // any upstream that requires a page size, which Saleor does.
    const operation = compileGraphQlOperation(
      SDL,
      compiled.bindings.get("graphql.orders")!,
      { capabilityId: "graphql.orders", params: { first: 5 } },
      {},
    );
    expect(operation.variables).toEqual({ first: 5 });
  });

  it("refuses to approve anything without being told to, in those words", () => {
    const { dir, schemaPath } = workspace();
    const inventoryPath = join(dir, "inventory.json");
    run(["inventory", "--schema", schemaPath, "--catalog-id", "shop", "--out", inventoryPath]);

    // The dangerous act is explicit and greppable in a shell history. A default
    // that approved everything would be a security review nobody performed.
    const refused = run(["candidate", "--inventory", inventoryPath]);
    expect(refused.status).toBe(2);
  });

  it("approves paging arguments and no filtering ones", () => {
    const { dir, schemaPath } = workspace();
    const inventoryPath = join(dir, "inventory.json");
    const decisionsPath = join(dir, "decisions.json");
    run([
      "inventory",
      "--schema",
      schemaPath,
      "--catalog-id",
      "shop",
      "--queries",
      "orders",
      "--out",
      inventoryPath,
    ]);
    run([
      "candidate",
      "--inventory",
      inventoryPath,
      "--approve-all-discovered",
      "--out",
      decisionsPath,
    ]);

    const decisions = JSON.parse(readFileSync(decisionsPath, "utf8"));
    // `channel` is filtering — what a visitor may steer, which is a decision.
    expect(decisions.queries[0].approvedVisitorArguments).toEqual(["first", "after"]);
    // Session, not public: the restrictive side of a guess about who may read
    // the data. The probe measures what the upstream actually enforces.
    expect(decisions.queries[0].policy.authentication).toBe("session");
    expect(decisions.queries[0].identityArguments).toEqual({});
  });

  it("caps a capability whose discovery exceeds the decisions ceilings, and says so", () => {
    // One commerce schema: 26 of 86 queries discover more than 500 fields
    // (one of them 1904). Writing the raw count into `limits` produced a
    // candidate the decisions format itself rejected — on the documented
    // headless route, as a Zod dump that read as the operator's mistake.
    const wide = Array.from({ length: 600 }, (_, index) => `f${index}: String`).join("\n    ");
    const wideSdl = `
      type Query {
        "One record with more fields than one capability may approve."
        wide: Wide
      }
      type Wide {
        id: ID!
        ${wide}
      }
    `;
    const dir = mkdtempSync(join(tmpdir(), "renderyes-catalog-wide-"));
    const schemaPath = join(dir, "schema.graphql");
    writeFileSync(schemaPath, wideSdl);
    const inventoryPath = join(dir, "inventory.json");
    const decisionsPath = join(dir, "decisions.json");

    expect(
      run(["inventory", "--schema", schemaPath, "--catalog-id", "shop", "--out", inventoryPath]).status,
    ).toBe(0);
    const candidate = spawnSync(
      process.execPath,
      [CLI, "candidate", "--inventory", inventoryPath, "--approve-all-discovered", "--out", decisionsPath],
      { encoding: "utf8" },
    );
    expect(candidate.status).toBe(0);
    // The cut is loud, not silent: a cap nobody mentions reads as "approved
    // everything" when it did not.
    expect(candidate.stderr).toMatch(/601 discovered, 500 kept/);

    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    const decisions = JSON.parse(readFileSync(decisionsPath, "utf8"));
    expect(decisions.queries[0].approvedOutputFields).toHaveLength(500);
    expect(decisions.queries[0].limits.maximumSelectedFields).toBe(500);
    // `id` is shallow and first, so the cut keeps it — required fields must
    // never name a field the decisions dropped.
    expect(decisions.queries[0].approvedOutputFields).toContain("id");

    // The assertion that matters: the capped candidate is publishable.
    const compiled = compileApprovedGraphQlCatalog(wideSdl, inventory, decisions);
    expect(compiled.catalog.capabilities.map((entry) => entry.id)).toEqual(["graphql.wide"]);
  });

  it("a candidate matches its own inventory, so diff has nothing to decide", () => {
    const { dir, schemaPath } = workspace();
    const inventoryPath = join(dir, "inventory.json");
    const decisionsPath = join(dir, "decisions.json");
    run(["inventory", "--schema", schemaPath, "--catalog-id", "shop", "--out", inventoryPath]);
    run([
      "candidate",
      "--inventory",
      inventoryPath,
      "--approve-all-discovered",
      "--out",
      decisionsPath,
    ]);

    // Exit 0 is what a CI gate reads. The four commands have to close the loop
    // or the loop is not a loop.
    const diff = run(["diff", "--inventory", inventoryPath, "--decisions", decisionsPath]);
    expect(diff.status).toBe(0);
    expect(diff.stdout).toMatch(/nothing to decide/);
  });

  it("names a query it skipped, and why", () => {
    const { schemaPath } = workspace();
    // `order(id: ID!)` is supported; a typo is not the same as unsupported, and
    // silence would let one look like the other.
    const result = run([
      "inventory",
      "--schema",
      schemaPath,
      "--catalog-id",
      "shop",
      "--queries",
      "orders,nosuchquery",
    ]);
    expect(result.status).toBe(0);
    const inventory = JSON.parse(result.stdout);
    expect(inventory.queries).toHaveLength(1);
  });
});

describe("result shapes a schema cannot express", () => {
  // Discovery proposes four of nine shapes, and the CLI passed its guess
  // straight through with no way to correct it — while `reviewSourceHash`
  // covers the selections, so hand-editing the emitted inventory is refused as
  // review drift. Five shapes were therefore unreachable through the headless
  // route entirely, even though the compile accepts every one of them.
  const TREE = `
    type Query {
      "Browse categories."
      tree: Category
      "List orders."
      orders(first: Int): OrderConnection
    }
    type OrderConnection { edges: [OrderEdge!]!  pageInfo: PageInfo! }
    type OrderEdge { cursor: String!  node: Order! }
    type PageInfo { hasNextPage: Boolean!  endCursor: String }
    type Order { id: ID!  number: String! }
    type Category { id: ID!  name: String!  children: [Category!] }
  `;

  function treeWorkspace() {
    const dir = mkdtempSync(join(tmpdir(), "renderyes-shapes-"));
    const schemaPath = join(dir, "schema.graphql");
    writeFileSync(schemaPath, TREE);
    return { dir, schemaPath };
  }

  it("--shapes overrides the guess, and the result still compiles", () => {
    const { dir, schemaPath } = treeWorkspace();
    const shapesPath = join(dir, "shapes.json");
    writeFileSync(shapesPath, JSON.stringify({ tree: "hierarchy" }));
    const inventoryPath = join(dir, "inventory.json");

    const inventoried = spawnSync(
      process.execPath,
      [CLI, "inventory", "--schema", schemaPath, "--catalog-id", "shop",
       "--shapes", shapesPath, "--out", inventoryPath],
      { encoding: "utf8" },
    );
    expect(inventoried.status, inventoried.stderr).toBe(0);
    // Said out loud: a host cannot act on a limit nobody mentions.
    expect(inventoried.stderr).toContain("override(s) applied from --shapes");

    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    const shapeOf = (id: string) =>
      inventory.querySelections.find((entry: { capabilityId: string }) => entry.capabilityId === id)
        ?.resultShape;
    expect(shapeOf("graphql.tree")).toBe("hierarchy");
    // Untouched keys keep discovery's proposal.
    expect(shapeOf("graphql.orders")).toBe("collection");

    // The assertion that matters: overriding does not break the compile. The
    // shape must be settled before the inventory is hashed, which is exactly why
    // this is a flag and not an edit.
    const candidate = spawnSync(
      process.execPath,
      [CLI, "candidate", "--inventory", inventoryPath, "--approve-all-discovered",
       "--schema", schemaPath, "--out", join(dir, "decisions.json")],
      { encoding: "utf8" },
    );
    expect(candidate.status, candidate.stderr).toBe(0);
    expect(candidate.stderr).toContain("Compiles.");
  });

  it("names the whole vocabulary when given a shape that is not one", () => {
    const { dir, schemaPath } = treeWorkspace();
    const shapesPath = join(dir, "shapes.json");
    writeFileSync(shapesPath, JSON.stringify({ tree: "treeish" }));
    const refused = spawnSync(
      process.execPath,
      [CLI, "inventory", "--schema", schemaPath, "--catalog-id", "shop", "--shapes", shapesPath],
      { encoding: "utf8" },
    );
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("hierarchy");
    expect(refused.stderr).toContain("media-collection");
  });

  it("editing the emitted inventory is refused, which is why the flag exists", () => {
    const { dir, schemaPath } = treeWorkspace();
    const inventoryPath = join(dir, "inventory.json");
    expect(
      run(["inventory", "--schema", schemaPath, "--catalog-id", "shop", "--out", inventoryPath]).status,
    ).toBe(0);

    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    const target = inventory.querySelections.find(
      (entry: { capabilityId: string }) => entry.capabilityId === "graphql.tree",
    );
    expect(target.resultShape).toBe("entity");
    target.resultShape = "hierarchy";
    const editedPath = join(dir, "edited.json");
    writeFileSync(editedPath, JSON.stringify(inventory, null, 2));

    const candidate = spawnSync(
      process.execPath,
      [CLI, "candidate", "--inventory", editedPath, "--approve-all-discovered", "--schema", schemaPath],
      { encoding: "utf8" },
    );
    // Refusing is correct — the hash is what makes decisions auditable. What
    // was missing was any other route to the decision.
    expect(candidate.status).toBe(2);
    expect(candidate.stderr).toMatch(/drift/);
  });
});

describe("fields discovery cannot place", () => {
  it("candidate names them, and --semantic-types carries the host's decision", () => {
    // The dead end this pins: "approve everything discovered" refused its own
    // output — compile rightly demands a semantic type for a field discovery
    // could not place, named each one, and the CLI had no way to answer short
    // of hand-editing the emitted JSON. The overrides stay a host decision;
    // the flag only carries it.
    const sdl = `
      type Query {
        "List orders."
        orders(first: Int, after: String): OrderConnection
      }
      type OrderConnection { edges: [OrderEdge!]!  pageInfo: PageInfo! }
      type OrderEdge { cursor: String!  node: Order! }
      type PageInfo { hasNextPage: Boolean!  endCursor: String }
      type Order { id: ID!  zorp: Float }
    `;
    const dir = mkdtempSync(join(tmpdir(), "renderyes-semantic-"));
    const schemaPath = join(dir, "schema.graphql");
    writeFileSync(schemaPath, sdl);
    const inventoryPath = join(dir, "inventory.json");
    expect(
      run(["inventory", "--schema", schemaPath, "--catalog-id", "shop", "--out", inventoryPath]).status,
    ).toBe(0);

    const refused = spawnSync(
      process.execPath,
      [CLI, "candidate", "--inventory", inventoryPath, "--approve-all-discovered", "--schema", schemaPath],
      { encoding: "utf8" },
    );
    expect(refused.status).toBe(2);
    // The refusal must carry the route forward, not just the complaint.
    expect(refused.stderr).toContain("--semantic-types");
    const keys = [...refused.stderr.matchAll(/"([^"]+)" \([A-Za-z]+!?\)/g)].map(
      (match) => match[1],
    );
    expect(keys.length).toBeGreaterThan(0);

    const overridesPath = join(dir, "semantic-types.json");
    writeFileSync(
      overridesPath,
      JSON.stringify(Object.fromEntries(keys.map((key) => [key, "quantity"]))),
    );
    const decisionsPath = join(dir, "decisions.json");
    const accepted = spawnSync(
      process.execPath,
      [
        CLI, "candidate", "--inventory", inventoryPath, "--approve-all-discovered",
        "--schema", schemaPath, "--semantic-types", overridesPath, "--out", decisionsPath,
      ],
      { encoding: "utf8" },
    );
    expect(accepted.status, accepted.stderr).toBe(0);
    const decisions = JSON.parse(readFileSync(decisionsPath, "utf8"));
    expect(Object.keys(decisions.semanticTypeOverrides)).toEqual(keys);
  });
});

describe("candidate reports contract cost before anything publishes", () => {
  /**
   * `contractBytes` existed only on the publish summary — after every decision
   * it should inform. Approving forty more fields is a token-budget decision,
   * so the number now prints where the approving happens, and compiling here
   * also means a candidate that cannot compile fails at creation rather than
   * at publish.
   */
  it("prints the projected planning-contract size and per-compose worst case with --schema", () => {
    const { dir, schemaPath } = workspace();
    const inventoryPath = join(dir, "inventory.json");

    expect(
      run([
        "inventory",
        "--schema",
        schemaPath,
        "--catalog-id",
        "shop",
        "--queries",
        "orders",
        "--out",
        inventoryPath,
      ]).status,
    ).toBe(0);

    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "candidate",
        "--inventory",
        inventoryPath,
        "--approve-all-discovered",
        "--schema",
        schemaPath,
        "--out",
        join(dir, "decisions.json"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    // The same estimator the publish summary reports as `contractBytes` — the
    // manifest-bytes number this used to print was a second estimator, and it
    // drifted low (the contract adds the per-capability request schemas).
    expect(result.stderr).toMatch(
      /Compiles\. Data-planning contract: \d+ bytes \(~\d+ tokens\)/,
    );
    // A compose can retry the plan up to 3 times, so the decision-time number
    // includes the per-compose worst case.
    expect(result.stderr).toMatch(/retries up to 3 times/);
    // This used to require the sentence "Fewer approved fields is the lever",
    // which measurement says is the smallest of the three levers: twelve
    // projected fields down to four returns 17% of the contract, halving the
    // capability count returns 50%, and not advertising a filter vocabulary
    // returns 73%. The assertion was pinning the advice that sent a host to do
    // the most tedious available work for the least return, so it now requires
    // a named lever with the bytes it is worth.
    expect(result.stderr).toMatch(/Largest single lever|Over the ~\d+-token budget/);
    expect(result.stderr).toMatch(/returns \d+ bytes/);
    expect(result.stderr).not.toContain("Fewer approved fields is the lever");
  });

  it("the inventory points at the candidate --schema estimate", () => {
    const { dir, schemaPath } = workspace();
    const inventoried = spawnSync(
      process.execPath,
      [CLI, "inventory", "--schema", schemaPath, "--catalog-id", "shop",
       "--queries", "orders", "--out", join(dir, "inventory.json")],
      { encoding: "utf8" },
    );
    expect(inventoried.status).toBe(0);
    expect(inventoried.stderr).toMatch(/candidate --schema/);
    expect(inventoried.stderr).toMatch(/up\nto 3 times per compose|up to 3 times per compose/);
  });
});

/**
 * The verbs that turn a decisions file into something a server will accept.
 *
 * `inventory` and `candidate` produced a decisions file and stopped, because nothing in
 * the package could do anything with one — so the documented headless route
 * ended at a file, and a host who wanted it published had to go back to the
 * browser app the route existed to replace.
 */
describe("compile, curated, publish", () => {
  function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  function approved() {
    const { dir, schemaPath } = workspace();
    const inventoryPath = join(dir, "inventory.json");
    const decisionsPath = join(dir, "decisions.json");
    expect(
      cli(["inventory", "--schema", schemaPath, "--catalog-id", "shop",
           "--queries", "orders", "--out", inventoryPath]).status,
    ).toBe(0);
    expect(
      cli(["candidate", "--inventory", inventoryPath, "--approve-all-discovered",
           "--out", decisionsPath]).status,
    ).toBe(0);
    return { dir, schemaPath, inventoryPath, decisionsPath };
  }

  it("compiles a decisions file into the body the publish route takes", () => {
    const { dir, schemaPath, inventoryPath, decisionsPath } = approved();
    const outPath = join(dir, "catalog.json");
    const result = cli([
      "compile", "--schema", schemaPath, "--inventory", inventoryPath,
      "--decisions", decisionsPath, "--endpoint", "https://api.example/graphql",
      "--out", outPath,
    ]);
    expect(result.status).toBe(0);

    const payload = JSON.parse(readFileSync(outPath, "utf8"));
    expect(payload.bindingKind).toBe("graphql");
    expect(payload.endpoint).toBe("https://api.example/graphql");
    expect(payload.catalog.capabilities.length).toBeGreaterThan(0);
    // Not a bundle, and it says so: publishing this alone leaves the planner a
    // catalog with no component that can render any of it, and the symptom is
    // a compose that renders nothing rather than an error.
    expect(payload.format).toBeUndefined();
    expect(result.stderr).toContain("capability half only");
  });

  it("refuses to compile without an endpoint, rather than emitting an unpublishable file", () => {
    const { schemaPath, inventoryPath, decisionsPath } = approved();
    const result = cli([
      "compile", "--schema", schemaPath, "--inventory", inventoryPath, "--decisions", decisionsPath,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Missing --endpoint");
    expect(result.stderr).toContain("allowedUpstreamOrigins");
  });

  it("emits a review-export bundle when given a UI manifest", () => {
    const { dir, schemaPath, inventoryPath, decisionsPath } = approved();
    const uiPath = join(dir, "ui.json");
    // Shape only — what matters here is that the halves arrive under one id.
    writeFileSync(
      uiPath,
      JSON.stringify({ schemaVersion: "1.0", site: { id: "shop" }, components: [], surfaces: [] }),
    );
    const outPath = join(dir, "bundle.json");
    expect(
      cli(["compile", "--schema", schemaPath, "--inventory", inventoryPath, "--decisions", decisionsPath,
           "--endpoint", "https://api.example/graphql", "--ui-manifest", uiPath,
           "--out", outPath]).status,
    ).toBe(0);

    const bundle = JSON.parse(readFileSync(outPath, "utf8"));
    expect(bundle.format).toBe("renderyes-review-export");
    expect(bundle.catalogId).toBe("shop");
    // The id the server files the UI catalog under comes from here, not from
    // the manifest's own site id — which is how a site named `<catalog>-ui`
    // used to publish cleanly and resolve nothing.
    expect(bundle.ui.manifest.site.id).toBe("shop");
    expect(bundle.requirements.upstreamOrigins).toEqual(["https://api.example"]);
  });

  it("names what is wrong when --ui-manifest is not a manifest", () => {
    const { dir, schemaPath, inventoryPath, decisionsPath } = approved();
    const uiPath = join(dir, "ui.json");
    writeFileSync(uiPath, JSON.stringify({ published: true }));
    const result = cli([
      "compile", "--schema", schemaPath, "--inventory", inventoryPath, "--decisions", decisionsPath,
      "--endpoint", "https://api.example/graphql", "--ui-manifest", uiPath,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("is not a site manifest");
  });

  /**
   * The one refusal in this CLI that is about who may read data rather than
   * about a missing argument.
   */
  it("will not curate without the words, and --yes is not the words", () => {
    const { dir, schemaPath } = workspace();
    const outPath = join(dir, "curated.json");
    const base = [
      "curated", "--schema", schemaPath, "--catalog-id", "shop",
      "--endpoint", "https://api.example/graphql", "--out", outPath,
    ];

    const bare = cli(base);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain("--confirm-visitor-safe");

    // The invariant, stated as a test because it is the kind that erodes: a
    // blanket "ask me nothing" answers prompts, and this is a question about
    // visitor access. One must never come to mean the other.
    const yes = cli([...base, "--yes"]);
    expect(yes.status).toBe(2);
    expect(yes.stderr).toContain("--confirm-visitor-safe");

    const confirmed = cli([...base, "--confirm-visitor-safe"]);
    expect(confirmed.status).toBe(0);
    expect(JSON.parse(readFileSync(outPath, "utf8")).catalog.capabilities.length)
      .toBeGreaterThan(0);
  });

  it("takes the admin token from the environment and never from an argument", () => {
    const { dir, schemaPath, inventoryPath, decisionsPath } = approved();
    const outPath = join(dir, "catalog.json");
    expect(
      cli(["compile", "--schema", schemaPath, "--inventory", inventoryPath, "--decisions", decisionsPath,
           "--endpoint", "https://api.example/graphql", "--out", outPath]).status,
    ).toBe(0);

    const result = cli(
      ["publish", "--service-url", "http://127.0.0.1:9/mount", "--file", outPath],
      { RENDERYES_ADMIN_TOKEN: "" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("RENDERYES_ADMIN_TOKEN is not set");
    // Said explicitly, because the obvious next thing a blocked host tries is
    // to pass it as a flag, and there is no flag to find.
    expect(result.stderr).toContain("process list");
  });
});

/**
 * A result shape can be set in two places, and only one of them wins.
 *
 * `--shapes` writes it into the inventory; a reviewer writes it into the
 * decisions file, which overrides. A host who used the flag and later edited
 * the decisions file has two answers on disk and no indication which is in
 * force — and the symptom of losing is not an error, it is a view rendered as
 * the wrong kind of thing.
 */
describe("resultShape set in both places", () => {
  it("says which one won, instead of resolving it in silence", () => {
    const { dir, schemaPath } = workspace();
    const inventoryPath = join(dir, "inventory.json");
    const decisionsPath = join(dir, "decisions.json");
    const shapesPath = join(dir, "shapes.json");
    writeFileSync(shapesPath, JSON.stringify({ orders: "time-series" }));

    const run = (args: string[]) =>
      spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

    expect(
      run(["inventory", "--schema", schemaPath, "--catalog-id", "shop", "--queries", "orders",
           "--shapes", shapesPath, "--out", inventoryPath]).status,
    ).toBe(0);
    expect(
      run(["candidate", "--inventory", inventoryPath, "--approve-all-discovered",
           "--out", decisionsPath]).status,
    ).toBe(0);

    // The reviewer changes their mind, in the file that is theirs.
    const decisions = JSON.parse(readFileSync(decisionsPath, "utf8"));
    decisions.queries[0].resultShape = "collection";
    writeFileSync(decisionsPath, JSON.stringify(decisions, null, 2));

    const compiled = run([
      "compile", "--schema", schemaPath, "--inventory", inventoryPath,
      "--decisions", decisionsPath, "--endpoint", "https://api.example/graphql",
      "--out", join(dir, "catalog.json"),
    ]);
    expect(compiled.status).toBe(0);
    // Both values named, and which is in force — a warning that reported only
    // "shapes disagree" would leave the host to work out the direction.
    expect(compiled.stderr).toContain('the decisions file says "collection"');
    expect(compiled.stderr).toContain('the inventory says "time-series"');
    expect(compiled.stderr).toContain("The decisions file wins");

    // And it really did win.
    const catalog = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8"));
    expect(catalog.catalog.capabilities[0].output.shape).toBe("collection");
  });

  it("stays quiet when only one of them states a shape", () => {
    const { dir, schemaPath } = workspace();
    const inventoryPath = join(dir, "inventory.json");
    const decisionsPath = join(dir, "decisions.json");
    const run = (args: string[]) =>
      spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

    run(["inventory", "--schema", schemaPath, "--catalog-id", "shop", "--queries", "orders",
         "--out", inventoryPath]);
    run(["candidate", "--inventory", inventoryPath, "--approve-all-discovered",
         "--out", decisionsPath]);
    const compiled = run([
      "compile", "--schema", schemaPath, "--inventory", inventoryPath,
      "--decisions", decisionsPath, "--endpoint", "https://api.example/graphql",
      "--out", join(dir, "catalog.json"),
    ]);
    expect(compiled.status).toBe(0);
    expect(compiled.stderr).not.toContain("resultShape:");
  });
});

/**
 * Help, which was the one thing a host types before anything else.
 *
 * `--help` used to fall through to "Unknown command" on stderr with exit 2, and
 * `inventory --help` answered "Missing --schema" — so the first two guesses
 * both looked like the tool was broken. Nothing caught it because no test had
 * ever run the binary without a job to do.
 */
describe("help", () => {
  function cli(args: string[]) {
    return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  }

  it("answers --help, -h and no arguments on stdout, successfully", () => {
    for (const args of [["--help"], ["-h"], []]) {
      const result = cli(args);
      // stdout and 0, not stderr and 2: asking what a tool does is not an error,
      // and a pipeline that checks the exit code should not see a failure.
      expect(result.status, `for ${JSON.stringify(args)}`).toBe(0);
      expect(result.stdout).toContain("renderyes-catalog");
      expect(result.stderr).toBe("");
    }
  });

  it("names every command, and what each one produces", () => {
    const overview = cli(["--help"]).stdout;
    for (const command of [
      "inventory", "candidate", "curated", "compile", "publish", "diff", "migrate",
    ]) {
      expect(overview).toContain(command);
      const help = cli([command, "--help"]);
      expect(help.status, command).toBe(0);
      // The two facts a directory of similar-looking JSON files cannot tell you.
      expect(help.stdout, command).toContain("Produces:");
      expect(help.stdout, command).toContain("Whose is it?");
    }
  });

  it("states the schema-change loop where a host looks for it", () => {
    // Twice on purpose: in the overview, and under `diff`, which is the command
    // a host reaches for when a schema has already moved under them.
    for (const args of [["--help"], ["diff", "--help"]]) {
      const text = cli(args).stdout;
      expect(text, JSON.stringify(args)).toContain("When the schema changes");
      expect(text).toMatch(/inventory\s+again, over the new schema/);
    }
  });

  it("does not run a command that was only being asked about", () => {
    // `inventory --help` must not read a schema, and must not complain about
    // one being absent.
    const result = cli(["inventory", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Missing --schema");
  });

  it("points a failure at the help for the command that failed", () => {
    const result = cli(["compile", "--schema", "/does/not/exist"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("renderyes-catalog compile --help");
  });
});

/**
 * The headless dead end.
 *
 * A schema an upstream generates carries no field descriptions, so every
 * capability got the placeholder purpose — which the compile refuses, correctly,
 * because publishing it would describe the capability to the planner as an
 * unfinished review. The two ways out it named were editing the generated schema
 * and editing an inventory whose hash covers the purpose. Neither is a headless
 * route, so a generated schema had none at all.
 */
describe("a schema whose fields carry no description", () => {
  function cli(args: string[]) {
    return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  }

  function plainSchema() {
    const dir = mkdtempSync(join(tmpdir(), "iv-nodesc-"));
    const schemaPath = join(dir, "schema.graphql");
    writeFileSync(
      schemaPath,
      "type Query { posts(limit: Int): [Post!]! }\ntype Post { id: ID!, title: String!, slug: String! }\n",
    );
    return { dir, schemaPath };
  }

  function publishable(dir: string, schemaPath: string, extra: string[]) {
    const inventoryPath = join(dir, "inventory.json");
    const decisionsPath = join(dir, "decisions.json");
    const outPath = join(dir, "catalog.json");
    cli(["inventory", "--schema", schemaPath, "--catalog-id", "demo", "--out", inventoryPath, ...extra]);
    cli(["candidate", "--inventory", inventoryPath, "--approve-all-discovered", "--out", decisionsPath]);
    return {
      outPath,
      result: cli([
        "compile", "--schema", schemaPath, "--inventory", inventoryPath,
        "--decisions", decisionsPath, "--endpoint", "https://api.example/graphql",
        "--out", outPath,
      ]),
    };
  }

  it("cannot reach a publishable catalog without --purposes", () => {
    const { dir, schemaPath } = plainSchema();
    const { result } = publishable(dir, schemaPath, []);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/placeholder purpose/);
  });

  it("reaches one with --purposes, and the prose survives to the catalog", () => {
    const { dir, schemaPath } = plainSchema();
    const purposesPath = join(dir, "purposes.json");
    writeFileSync(purposesPath, JSON.stringify({ posts: "Lists published articles for a reader." }));
    const { outPath, result } = publishable(dir, schemaPath, ["--purposes", purposesPath]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(readFileSync(outPath, "utf8"));
    expect(payload.catalog.capabilities[0].purpose).toBe("Lists published articles for a reader.");
  });

  it("refuses the placeholder handed back to it", () => {
    const { dir, schemaPath } = plainSchema();
    const purposesPath = join(dir, "purposes.json");
    writeFileSync(
      purposesPath,
      JSON.stringify({ posts: "Review the purpose of graphql.posts before publishing." }),
    );
    const result = cli([
      "inventory", "--schema", schemaPath, "--catalog-id", "demo",
      "--out", join(dir, "inventory.json"), "--purposes", purposesPath,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/placeholder itself/);
  });
});
