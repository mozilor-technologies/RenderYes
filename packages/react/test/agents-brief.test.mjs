import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The agent brief, and the claims it makes.
 *
 * A doc written for a coding agent is worse than none when it drifts: an agent
 * believes it, imports the export it was told to import, and ships the failure.
 * So every claim here that can be checked, is.
 */
const here = dirname(fileURLToPath(import.meta.url));

test("the agent brief ships, and its checkable claims are still true", async () => {
  const brief = await readFile(resolve(here, "../AGENTS.md"), "utf8");
  const packageJson = JSON.parse(await readFile(resolve(here, "../package.json"), "utf8"));

  // A file in the repository and in no install is the LICENSE mistake.
  assert.ok(packageJson.files.includes("AGENTS.md"), "AGENTS.md is not in files");

  const react = await import("../dist/index.js");

  // The brief's first remedy: never headline rows.length.
  assert.equal(typeof react.countBeyondPage, "function", "countBeyondPage is not exported");
  assert.match(brief, /countBeyondPage/);
  // And it behaves as described — a floor when the page is not the whole set.
  assert.deepEqual(react.countBeyondPage([1, 2], { complete: true }), { count: 2, exact: true });
  // The two flags it actually reads. `moreAvailable` is not one of them — the
  // brief says so rather than implying the helper covers every case.
  assert.equal(react.countBeyondPage([1, 2], { truncated: true }).exact, false);
  assert.equal(react.countBeyondPage([1, 2], { complete: false }).exact, false);
  assert.deepEqual(react.countBeyondPage([1, 2], { totalRows: 2500 }), { count: 2500, exact: true });

  // The props helpers it tells an agent to use instead of raw Zod.
  for (const name of ["defineHostComponent", "defineProps", "field"]) {
    assert.ok(react[name], `${name} is not exported, and AGENTS.md tells agents to use it`);
    assert.match(brief, new RegExp(name));
  }

  // Every export path the brief names.
  assert.deepEqual(Object.keys(packageJson.exports).sort(), [".", "./ingest-fs", "./package.json"]);

  // The four slot states, exactly. `"loading"` is the plausible wrong guess and
  // the reason this list is written down at all.
  for (const state of ['"pending"', '"ready"', '"empty"', '"error"']) {
    assert.match(brief, new RegExp(state), `brief omits ${state}`);
  }
  assert.doesNotMatch(brief, /"loading"/);
});
