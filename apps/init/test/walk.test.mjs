import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walk } from "../src/walk.mjs";

/**
 * The walk's one promise is resume: re-running continues from the first thing
 * that is not true yet. The bug this file pins is the scaffold step breaking
 * that — any collision was a hard stop, so a second run could never reach the
 * published and verified levels, and the wizard could not demonstrate the very
 * thing it exists to demonstrate.
 */

const FLAGS = Object.freeze({
  yes: true,
  skipInstall: true,
  role: "both",
  topology: "coexist",
});

function project() {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-walk-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "shop" }));
  return dir;
}

async function walkIn(dir, flags = FLAGS) {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return await walk({ ...flags });
  } finally {
    process.chdir(cwd);
  }
}

test("a second run resumes past the scaffold instead of refusing", async () => {
  const dir = project();

  const first = await walkIn(dir);
  assert.equal(first.ok, true);
  // Both runs must reach the sitting boundary — the point where only a running
  // app can answer — not stop at the files.
  assert.match(first.message, /talks to your running app/);

  const second = await walkIn(dir);
  assert.equal(second.ok, true);
  assert.match(second.message, /talks to your running app/);
  assert.doesNotMatch(second.message, /already exist, so nothing was written/);
});

test("existing files are never touched, and missing ones are filled in", async () => {
  const dir = project();
  await walkIn(dir);

  // The host edited a scaffolded file — which the banner in every generated
  // file says is safe — and lost one. Resume must respect the edit and restore
  // only the loss.
  const edited = join(dir, "src", "renderyes", "views", "index.js");
  writeFileSync(edited, "// the host's own registrations\nexport const views = [];\n");
  const lost = join(dir, "src", "renderyes", "page.jsx");
  rmSync(lost);

  const again = await walkIn(dir);
  assert.equal(again.ok, true);
  assert.match(readFileSync(edited, "utf8"), /the host's own registrations/);
  assert.match(readFileSync(lost, "utf8"), /ViewProvider/);
});

/**
 * A second walk must not contradict the first.
 *
 * The third install re-ran the wizard and was re-asked for the catalog id,
 * endpoint, identity and topology with defaults derived from package.json —
 * while `doctor`, reading the same files, printed the true catalog id two lines
 * earlier. The id default was the package name, so pressing Enter filed the UI
 * catalog under a name compose never looks up.
 */
test("a re-run defaults to what is already in the repository", async () => {
  const { existingChoices } = await import("../src/detect.mjs");
  const dir = mkdtempSync(join(tmpdir(), "renderyes-rerun-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "website" }));
  writeFileSync(
    join(dir, "src", "page.jsx"),
    `export const config = {
       serviceUrl: "http://localhost:3000/api/renderyes",
       catalogId: "bharat_times_2808",
     };`,
  );
  const found = existingChoices(dir);
  assert.equal(found.catalogId, "bharat_times_2808");
  assert.equal(found.serviceUrl, "http://localhost:3000/api/renderyes");
  assert.notEqual(found.catalogId, "website", "the package name is what the old default used");
});

test("two disagreeing literals produce no default rather than a guess", async () => {
  const { existingChoices } = await import("../src/detect.mjs");
  const dir = mkdtempSync(join(tmpdir(), "renderyes-rerun-two-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "website" }));
  writeFileSync(join(dir, "src", "a.jsx"), `const a = { catalogId: "one" };`);
  writeFileSync(join(dir, "src", "b.jsx"), `const b = { catalogId: "two" };`);
  assert.equal(existingChoices(dir).catalogId, undefined);
});
