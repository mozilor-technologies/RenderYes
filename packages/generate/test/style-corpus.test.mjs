import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleStyleCorpus,
  detectConvention,
  detectFileExtension,
  detectStyleSystem,
  loadDataContractFromExport,
  sliceCapability,
  STYLE_CORPUS_BUDGET_BYTES,
} from "../dist/index.js";
import {
  buildReviewExportBundle,
  LISTED_HOST_DIR,
  PLAIN_HOST_DIR,
  SHADCN_HOST_DIR,
  TAILWIND_HOST_DIR,
} from "./fixture.mjs";

function slice() {
  return sliceCapability(
    loadDataContractFromExport(buildReviewExportBundle()),
    "pantry.items.list",
  );
}

test("detects the three style systems from their marker files", () => {
  assert.equal(detectStyleSystem(SHADCN_HOST_DIR), "shadcn");
  assert.equal(detectStyleSystem(TAILWIND_HOST_DIR), "tailwind");
  assert.equal(detectStyleSystem(PLAIN_HOST_DIR), "plain-css");
});

test("detects folder vs registration convention", () => {
  assert.equal(detectConvention(PLAIN_HOST_DIR), "folder");
  assert.equal(detectConvention(LISTED_HOST_DIR), "listed");
});

test("a host with view files is folder-convention even if defineHostComponent appears", () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-generate-host-"));
  writeFileSync(join(dir, "legacy.jsx"), "defineHostComponent({});\n");
  writeFileSync(join(dir, "thing.view.jsx"), "export const spec = 1;\n");
  assert.equal(detectConvention(dir), "folder");
});

test("emits .tsx only when the host has a tsconfig", () => {
  assert.equal(detectFileExtension(PLAIN_HOST_DIR), ".jsx");
  const dir = mkdtempSync(join(tmpdir(), "iv-generate-ts-host-"));
  writeFileSync(join(dir, "tsconfig.json"), "{}\n");
  assert.equal(detectFileExtension(dir), ".tsx");
});

test("plain-css corpus: token block + stylesheet, tokens detected", () => {
  const corpus = assembleStyleCorpus({ hostDir: PLAIN_HOST_DIR, slice: slice() });
  assert.equal(corpus.system, "plain-css");
  assert.equal(corpus.hasTokens, true);
  const kinds = corpus.pieces.map((piece) => piece.kind);
  assert.ok(kinds.includes("theme"), `expected a theme piece in ${kinds}`);
  assert.ok(kinds.includes("stylesheet"), `expected a stylesheet piece in ${kinds}`);
  assert.match(
    corpus.pieces.find((piece) => piece.kind === "theme").content,
    /--iv-starter-surface/,
  );
  assert.ok(corpus.stylesheetText.includes(".pantry-item"));
});

test("shadcn corpus: components.json plus one ui primitive", () => {
  const corpus = assembleStyleCorpus({ hostDir: SHADCN_HOST_DIR, slice: slice() });
  assert.equal(corpus.system, "shadcn");
  assert.equal(corpus.hasTokens, true);
  const paths = corpus.pieces.map((piece) => piece.path);
  assert.ok(paths.includes("components.json"), String(paths));
  assert.ok(
    paths.some((path) => path.includes("ui/")),
    `expected a ui/ file in ${paths}`,
  );
});

test("tailwind corpus: the config is the theme artifact", () => {
  const corpus = assembleStyleCorpus({ hostDir: TAILWIND_HOST_DIR, slice: slice() });
  assert.equal(corpus.system, "tailwind");
  assert.ok(
    corpus.pieces.some(
      (piece) => piece.kind === "theme" && piece.path === "tailwind.config.js",
    ),
    JSON.stringify(corpus.pieces.map((piece) => piece.path)),
  );
});

test("--style overrides replace assembly and still respect the budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-generate-style-"));
  const small = join(dir, "small.css");
  writeFileSync(small, ".a { color: red; }\n");
  const huge = join(dir, "huge.css");
  writeFileSync(huge, `${".b { padding: 1px; }\n".repeat(3000)}`);

  const corpus = assembleStyleCorpus({
    hostDir: PLAIN_HOST_DIR,
    slice: slice(),
    overrideFiles: [small, huge],
  });
  assert.deepEqual(
    corpus.pieces.map((piece) => piece.kind),
    ["override", "override"],
  );
  assert.ok(corpus.totalBytes <= STYLE_CORPUS_BUDGET_BYTES);
  assert.match(corpus.pieces[1].content, /trimmed by @renderyes\/generate/);
});

test("total corpus never exceeds the 25KB budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-generate-big-host-"));
  writeFileSync(
    join(dir, "styles.css"),
    `:root { --iv-starter-fg: #111; }\n${".rule { margin: 0; }\n".repeat(5000)}`,
  );
  const corpus = assembleStyleCorpus({ hostDir: dir, slice: slice() });
  assert.ok(
    corpus.totalBytes <= STYLE_CORPUS_BUDGET_BYTES,
    `${corpus.totalBytes} > ${STYLE_CORPUS_BUDGET_BYTES}`,
  );
});

test("registered bespoke views lead the corpus, capped at two whole files", () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-generate-views-host-"));
  const contract = loadDataContractFromExport(buildReviewExportBundle());
  // Three view files claiming registered ids; only GenericTable is registered.
  writeFileSync(
    join(dir, "generic-table.view.jsx"),
    'export const spec = { id: "GenericTable" }; // renders ShoppingItem rows\n',
  );
  writeFileSync(
    join(dir, "unregistered.view.jsx"),
    'export const spec = { id: "SomethingElse" };\n',
  );
  const corpus = assembleStyleCorpus({
    hostDir: dir,
    slice: sliceCapability(contract, "pantry.items.list"),
    uiManifest: contract.uiManifest,
  });
  const bespoke = corpus.pieces.filter((piece) => piece.kind === "bespoke-view");
  assert.equal(bespoke.length, 1);
  assert.equal(bespoke[0].path, "generic-table.view.jsx");
});
