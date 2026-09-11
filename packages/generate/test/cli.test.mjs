import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReviewExportBundle,
  flawedEnvelope,
  goodEnvelope,
  PLAIN_HOST_DIR,
} from "./fixture.mjs";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "generate.mjs");

function run(args, { expectFailure = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
    return { code: 0, stdout };
  } catch (error) {
    if (!expectFailure) throw error;
    return { code: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function setupFiles() {
  const dir = mkdtempSync(join(tmpdir(), "iv-generate-cli-"));
  const bundlePath = join(dir, "bundle.json");
  writeFileSync(bundlePath, JSON.stringify(buildReviewExportBundle()));
  const mockPath = join(dir, "mock.json");
  writeFileSync(mockPath, JSON.stringify([flawedEnvelope(), goodEnvelope()]));
  return { dir, bundlePath, mockPath };
}

test("cli: full run with the mock provider writes artifacts and exits 0", () => {
  const { dir, bundlePath, mockPath } = setupFiles();
  const outDir = join(dir, "out");
  const { code } = run([
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
  ]);
  assert.equal(code, 0);
  assert.ok(existsSync(join(outDir, "PantryShoppingList.view.jsx")));
  assert.ok(existsSync(join(outDir, "verification-report.md")));
  assert.ok(existsSync(join(outDir, "preview.html")));
  assert.ok(existsSync(join(outDir, "sample-rows.json")));
});

test("cli: without --out the artifacts go to stdout as JSON", () => {
  const { bundlePath, mockPath } = setupFiles();
  const { stdout } = run([
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
  ]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.pass, true);
  assert.equal(parsed.rounds, 2);
  assert.ok(parsed.artifacts.some((a) => a.name === "PantryShoppingList.view.jsx"));
});

test("cli: a never-passing draft exits 1 but still emits", () => {
  const { dir, bundlePath } = setupFiles();
  const mockPath = join(dir, "always-flawed.json");
  writeFileSync(
    mockPath,
    JSON.stringify([flawedEnvelope(), flawedEnvelope(), flawedEnvelope()]),
  );
  const outDir = join(dir, "out-failing");
  const result = run(
    [
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
    { expectFailure: true },
  );
  assert.equal(result.code, 1);
  assert.ok(existsSync(join(outDir, "PantryShoppingList.view.jsx")));
  assert.match(
    readFileSync(join(outDir, "verification-report.md"), "utf8"),
    /FAIL — review before registering/,
  );
});

test("cli: refusals and usage errors exit 2", () => {
  const { bundlePath, mockPath } = setupFiles();
  // Existing id → refusal.
  const refusal = run(
    [
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
      "GenericTable",
    ],
    { expectFailure: true },
  );
  assert.equal(refusal.code, 2);
  assert.match(String(refusal.stderr), /already registered/);

  const noCapability = run(["component"], { expectFailure: true });
  assert.equal(noCapability.code, 2);

  // Bare invocation is *not* a usage error — it is someone asking what this is.
  // `capability-catalog/bin/catalog.mjs` fixed the same bug and left the rule in
  // a comment: "Help is a successful outcome, so it goes to stdout and exits 0."
  // This assertion required the opposite, which is why this CLI kept it.
  const noCommand = run([]);
  assert.equal(noCommand.code, 0);
  assert.match(noCommand.stdout, /Usage:/);
});

test("cli: --help is a success, not a usage error", () => {
  // It reported "No command given" on stderr and exited 2 — so the first thing
  // anyone types at this CLI told them they had done something wrong, with a
  // status a script would trip on. `init` and `catalog` both already answered
  // help properly; this one did not, and it is now documented in QUICKSTART as
  // the way to draft a component.
  const { stdout } = run(["--help"]);
  assert.match(stdout, /renderyes-generate component/);

  const bare = run([]);
  assert.equal(bare.code, 0);
  assert.match(bare.stdout, /Usage:/);

  // A genuinely wrong command is still an error.
  const wrong = run(["frobnicate"], { expectFailure: true });
  assert.equal(wrong.code, 2);
});
