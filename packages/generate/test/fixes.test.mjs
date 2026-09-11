/**
 * Regression pins for the five defects the first live acceptance run exposed
 * (2026-08-21, PantryQL): missing --timeout, amnesiac repair prompts, the
 * emit-nothing envelope-failure path, the advisory-only envelope schema, and
 * the plumbing-loving style-corpus heuristic.
 */
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleStyleCorpus,
  createScriptedGenerateProvider,
  discoverPilotBespokeViews,
  generateComponent,
  GenerateEnvelopeSchema,
  GENERATE_ENVELOPE_JSON_SCHEMA,
  listHostFiles,
  loadDataContractFromExport,
  sliceCapability,
} from "../dist/index.js";
import {
  buildReviewExportBundle,
  flawedEnvelope,
  goodEnvelope,
  PLAIN_HOST_DIR,
} from "./fixture.mjs";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "generate.mjs");

function contract() {
  return loadDataContractFromExport(buildReviewExportBundle());
}

/* ------------------------------------------------------------------ */
/* Fix 2: repair prompts retain the full original contract             */
/* ------------------------------------------------------------------ */

test("repair prompt retains the data contract, corpus, and accepts example", async () => {
  const provider = createScriptedGenerateProvider([
    flawedEnvelope(),
    flawedEnvelope(),
    goodEnvelope(),
  ]);
  const result = await generateComponent({
    contract: contract(),
    capabilityId: "pantry.items.list",
    provider,
    hostDir: PLAIN_HOST_DIR,
    componentId: "PantryShoppingList",
  });
  assert.equal(result.pass, true);

  const original = provider.requests[0].userPrompt;
  const repair1 = provider.requests[1].userPrompt;
  const repair2 = provider.requests[2].userPrompt;

  // The whole original prompt — contract, sample rows, style corpus, and the
  // concrete accepts-shape example — leads every repair round verbatim.
  assert.ok(repair1.startsWith(original), "repair round must start with the original prompt");
  assert.ok(repair2.startsWith(original));
  for (const prompt of [repair1, repair2]) {
    assert.match(prompt, /DATA TYPE ShoppingItem/);
    assert.match(prompt, /SAMPLE ROWS/);
    assert.match(prompt, /HOST STYLE CORPUS/);
    assert.match(prompt, /"accepts": \[/); // the envelope example's slot shape
    assert.match(prompt, /FAILURES \(exact messages from the checks\):/);
  }

  // Token growth is bounded: each repair prompt carries the ORIGINAL prompt
  // once and the MOST RECENT envelope once — never a cumulative history.
  const capabilityHeaders = (prompt) => prompt.split("CAPABILITY\n- id:").length - 1;
  assert.equal(capabilityHeaders(repair2), 1);
  const envelopeSections = (prompt) =>
    prompt.split("YOUR PREVIOUS ENVELOPE").length - 1;
  assert.equal(envelopeSections(repair2), 1);
});

/* ------------------------------------------------------------------ */
/* Fix 3: total envelope failure still emits, marked failing           */
/* ------------------------------------------------------------------ */

test("every-round-invalid envelopes still emit draft-invalid.json + failing report", async () => {
  const invalid = () => ({
    componentFile: "x",
    spec: {
      id: "PantryShoppingList",
      description: "d",
      // accepts entry is a bare string — the unfixable near-miss from the live run
      dataSlots: { items: { accepts: ["ShoppingItem"] } },
    },
    notes: [],
  });
  const provider = createScriptedGenerateProvider([invalid(), invalid(), invalid()]);
  const result = await generateComponent({
    contract: contract(),
    capabilityId: "pantry.items.list",
    provider,
    hostDir: PLAIN_HOST_DIR,
    componentId: "PantryShoppingList",
  });

  assert.equal(result.pass, false);
  assert.equal(result.envelope, undefined);
  assert.equal(result.rounds, 3);
  const names = result.artifacts.map((artifact) => artifact.name);
  assert.deepEqual(names, ["draft-invalid.json", "verification-report.md"]);

  const draft = JSON.parse(
    result.artifacts.find((a) => a.name === "draft-invalid.json").content,
  );
  assert.equal(draft.rounds.length, 3);
  assert.ok(draft.rounds[0].envelopeIssues.length > 0);
  // The raw model output of the last round is preserved for review.
  assert.equal(draft.lastRawModelOutput.componentFile, "x");

  const report = result.artifacts.find((a) => a.name === "verification-report.md");
  assert.match(report.content, /Overall: FAIL/);
  assert.match(report.content, /envelope-schema \| FAIL/);
});

test("cli: every-round-invalid envelopes exit 1 and write the invalid-draft artifacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-generate-invalid-"));
  const bundlePath = join(dir, "bundle.json");
  writeFileSync(bundlePath, JSON.stringify(buildReviewExportBundle()));
  const invalid = { componentFile: "x", spec: {}, notes: [] };
  const mockPath = join(dir, "mock.json");
  writeFileSync(mockPath, JSON.stringify([invalid, invalid, invalid]));
  const outDir = join(dir, "out");

  const code = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        BIN,
        "component",
        "--capability",
        "pantry.items.list",
        "--export",
        bundlePath,
        "--provider",
        "mock",
        "--mock-file",
        mockPath,
        "--host-dir",
        PLAIN_HOST_DIR,
        "--id",
        "PantryShoppingList",
        "--out",
        outDir,
      ],
      (error) => resolve(error ? error.code : 0),
    );
  });
  assert.equal(code, 1);
  assert.ok(existsSync(join(outDir, "draft-invalid.json")));
  assert.match(
    readFileSync(join(outDir, "verification-report.md"), "utf8"),
    /no round produced a schema-valid envelope/,
  );
});

/* ------------------------------------------------------------------ */
/* Fix 1: --timeout plumbs through to the model provider               */
/* ------------------------------------------------------------------ */

test("cli: --timeout <seconds> reaches the provider as its per-call ceiling", async () => {
  // A server that accepts and never responds: the only way the run can end
  // quickly is the CLI-configured timeout firing inside the provider.
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const dir = mkdtempSync(join(tmpdir(), "iv-generate-timeout-"));
  const bundlePath = join(dir, "bundle.json");
  writeFileSync(bundlePath, JSON.stringify(buildReviewExportBundle()));

  try {
    const { code, stderr } = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [
          BIN,
          "component",
          "--capability",
          "pantry.items.list",
          "--export",
          bundlePath,
          "--provider",
          "openai",
          "--base-url",
          `http://127.0.0.1:${port}`,
          "--api-key-env",
          "IV_GENERATE_TEST_KEY",
          "--timeout",
          "1",
          "--host-dir",
          PLAIN_HOST_DIR,
          "--id",
          "PantryShoppingList",
        ],
        {
          env: { ...process.env, IV_GENERATE_TEST_KEY: "test-not-a-real-key" },
          timeout: 30_000,
        },
        (error, _stdout, stderr) => resolve({ code: error ? error.code : 0, stderr }),
      );
    });
    assert.equal(code, 2);
    assert.match(String(stderr), /exceeded its 1000ms timeout/);
  } finally {
    server.close();
  }
});

test("cli: a non-positive --timeout is a usage refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-generate-timeout-bad-"));
  const bundlePath = join(dir, "bundle.json");
  writeFileSync(bundlePath, JSON.stringify(buildReviewExportBundle()));
  const { code, stderr } = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        BIN,
        "component",
        "--capability",
        "pantry.items.list",
        "--export",
        bundlePath,
        "--provider",
        "openai",
        "--timeout",
        "0",
        "--host-dir",
        PLAIN_HOST_DIR,
      ],
      (error, _stdout, stderr) => resolve({ code: error ? error.code : 0, stderr }),
    );
  });
  assert.equal(code, 2);
  assert.match(String(stderr), /--timeout must be a positive number of seconds/);
});

/* ------------------------------------------------------------------ */
/* Fix 4: envelope schema — strict-mode decision + near-miss coercion  */
/* ------------------------------------------------------------------ */

test("envelope JSON schema is strict-incompatible by construction (map-typed objects)", () => {
  // OpenAI strict structured outputs require `additionalProperties: false`
  // on EVERY object; `props` and `dataSlots` are maps keyed by model-chosen
  // names and must carry `additionalProperties: {schema}`. That is the
  // documented reason the schema ships advisory (strict: false) — this test
  // fails the moment someone reshapes the maps, at which point the strict
  // decision must be revisited.
  const spec = GENERATE_ENVELOPE_JSON_SCHEMA.properties.spec;
  assert.equal(typeof spec.properties.props.additionalProperties, "object");
  assert.equal(typeof spec.properties.dataSlots.additionalProperties, "object");
  // Everything else stays strict-shaped: the envelope root rejects unknowns.
  assert.equal(GENERATE_ENVELOPE_JSON_SCHEMA.additionalProperties, false);
});

function envelopeWithSlots(dataSlots) {
  return {
    componentFile: "export default () => null;",
    spec: { id: "X", description: "d", dataSlots },
    notes: [],
  };
}

test("zod envelope coerces the unambiguous near-misses from the live run", () => {
  // Acceptance object mis-nested directly on the slot -> lifted into accepts.
  const misNested = GenerateEnvelopeSchema.safeParse(
    envelopeWithSlots({ items: { dataTypeId: "pantry", shapes: ["collection"] } }),
  );
  assert.equal(misNested.success, true);
  assert.deepEqual(misNested.data.spec.dataSlots.items, {
    accepts: [{ dataTypeId: "pantry", shapes: ["collection"] }],
  });

  // accepts given as one object instead of a one-element array -> wrapped.
  const singleObject = GenerateEnvelopeSchema.safeParse(
    envelopeWithSlots({
      items: { accepts: { dataTypeId: "pantry", shapes: ["collection"] } },
    }),
  );
  assert.equal(singleObject.success, true);
  assert.equal(singleObject.data.spec.dataSlots.items.accepts.length, 1);
});

test("zod envelope refuses ambiguous near-misses with shape-stating messages", () => {
  // A bare string is NOT coerced — nominal vs structural is a real decision.
  const bareString = GenerateEnvelopeSchema.safeParse(
    envelopeWithSlots({ items: { accepts: ["pantry"] } }),
  );
  assert.equal(bareString.success, false);
  assert.match(
    bareString.error.issues[0].message,
    /must be an OBJECT.*dataTypeId.*shapes/s,
  );

  // An unknown key names the allowed vocabulary instead of just rejecting.
  const wrongKey = GenerateEnvelopeSchema.safeParse(
    envelopeWithSlots({ items: { accepts: [{ type: "pantry" }] } }),
  );
  assert.equal(wrongKey.success, false);
  assert.match(
    wrongKey.error.issues.map((issue) => issue.message).join("\n"),
    /Allowed keys: dataTypeId, shapes, shape, requires, minFields/,
  );
});

/* ------------------------------------------------------------------ */
/* Fix 5: style corpus skips plumbing; registration bespoke views discovered  */
/* ------------------------------------------------------------------ */

function pantrySlice() {
  return sliceCapability(contract(), "pantry.items.list");
}

const ITEM_CARD_JSX = `export function ItemCard({ row }) {
  return (
    <article className="item-card">
      <h3>{row?.name ?? "—"}</h3>
      <span className="pill">{row?.quantity} g</span>
      <time>{row?.expiresOn}</time>
    </article>
  );
}
`;

function writePlumbingHost() {
  const dir = mkdtempSync(join(tmpdir(), "iv-generate-plumbing-"));
  mkdirSync(join(dir, "src", "components"), { recursive: true });
  // The trap from the live run: a service file naming every field.
  writeFileSync(
    join(dir, "renderyes-service.mjs"),
    `import { createViewServer } from "@renderyes/server";
// fields: id name quantity expiresOn status purchased price recipeId calories
const fields = ["id", "name", "quantity", "expiresOn", "status", "purchased", "price"];
createViewServer({ fields });
`,
  );
  writeFileSync(join(dir, "src", "components", "ItemCard.jsx"), ITEM_CARD_JSX);
  // A non-component src file that also names fields (an api layer).
  writeFileSync(
    join(dir, "src", "api.js"),
    `export const query = "{ id name quantity expiresOn status price }";\n`,
  );
  writeFileSync(
    join(dir, "src", "styles.css"),
    ":root { --pantry-surface: #fff; }\n.item-card { padding: 1rem; }\n",
  );
  return dir;
}

test("house-component tier skips plumbing files and prefers JSX in the components dir", () => {
  const dir = writePlumbingHost();
  const corpus = assembleStyleCorpus({ hostDir: dir, slice: pantrySlice() });
  const house = corpus.pieces.filter((piece) => piece.kind === "house-component");
  assert.equal(house.length, 1);
  assert.equal(house[0].path, join("src", "components", "ItemCard.jsx"));
  assert.ok(
    corpus.pieces.every((piece) => !piece.path.includes("renderyes-service")),
    `plumbing leaked into the corpus: ${corpus.pieces.map((p) => p.path)}`,
  );
});

test("approval door: defineHostComponent blocks lead to the bespoke component files", () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-generate-listed-fallback-"));
  mkdirSync(join(dir, "src", "components"), { recursive: true });
  writeFileSync(join(dir, "src", "components", "ItemCard.jsx"), ITEM_CARD_JSX);
  writeFileSync(
    join(dir, "src", "components", "OtherGrid.jsx"),
    `export default function OtherGrid() { return <div className="grid" />; }\n`,
  );
  writeFileSync(
    join(dir, "src", "main.jsx"),
    `import { defineHostComponent } from "@renderyes/react";
import { ItemCard } from "./components/ItemCard.jsx";
import OtherGrid from "./components/OtherGrid.jsx";
const a = defineHostComponent({ id: "ItemCard", component: ItemCard });
const b = defineHostComponent({ id: "OtherGrid", component: OtherGrid });
export const components = [a, b];
`,
  );
  writeFileSync(join(dir, "src", "styles.css"), ".item-card { padding: 1rem; }\n");

  // Direct discovery: both component files resolve through their imports.
  const discovered = discoverPilotBespokeViews(listHostFiles(dir));
  assert.deepEqual(
    discovered.map((file) => file.relativePath).sort(),
    [join("src", "components", "ItemCard.jsx"), join("src", "components", "OtherGrid.jsx")],
  );

  // Assembly without a uiManifest (the approval door) includes them as tier 1,
  // ranked so the file naming this data type's fields comes first.
  const corpus = assembleStyleCorpus({ hostDir: dir, slice: pantrySlice() });
  const bespoke = corpus.pieces.filter((piece) => piece.kind === "bespoke-view");
  assert.equal(bespoke.length, 2);
  assert.equal(bespoke[0].path, join("src", "components", "ItemCard.jsx"));
});

test("a defineHostComponent block with an inline component includes its own file", () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-generate-listed-inline-"));
  writeFileSync(
    join(dir, "app.jsx"),
    `import { defineHostComponent } from "@renderyes/react";
function InlineCard({ name }) { return <p>{name}</p>; }
export const card = defineHostComponent({ id: "InlineCard", component: InlineCard });
`,
  );
  const discovered = discoverPilotBespokeViews(listHostFiles(dir));
  assert.deepEqual(
    discovered.map((file) => file.relativePath),
    ["app.jsx"],
  );
});
