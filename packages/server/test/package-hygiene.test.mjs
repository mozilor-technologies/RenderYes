import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packagesDir = join(workspace, "packages");

function manifests() {
  return readdirSync(packagesDir)
    .map((name) => join(packagesDir, name, "package.json"))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    })
    .map((file) => ({ file, json: JSON.parse(readFileSync(file, "utf8")) }));
}

/**
 * Every subpath export needs a `default` condition, not only `import`.
 *
 * A conditions object matching neither the caller's conditions is a hard
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`, not a fallback to the file. Anything
 * resolving through the CommonJS loader — `tsx`, which the scaffolded publish
 * script has to use because plain Node cannot parse the host's JSX — therefore
 * could not import these packages at all. A cold install could not run the
 * publish command the tool itself printed.
 *
 * `default` points at the same ESM build; Node 22 loads it from `require` fine.
 * It is the catch-all, so it must stay last: conditions match in order.
 */
test("every conditional export has a default condition, listed last", () => {
  const offenders = [];
  for (const { json } of manifests()) {
    for (const [subpath, entry] of Object.entries(json.exports ?? {})) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const keys = Object.keys(entry);
      if (!keys.includes("default")) {
        offenders.push(`${json.name} ${subpath}: no default condition`);
      } else if (keys[keys.length - 1] !== "default") {
        offenders.push(`${json.name} ${subpath}: default is not last (${keys.join(", ")})`);
      }
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join("\n  ")}`);
});

/**
 * No source file may contain a raw NUL byte.
 *
 * One did, as a delimiter in a dedupe key — a sound choice of separator written
 * the wrong way. Git, grep, ripgrep and GitHub's diff viewer all classify a file
 * containing NUL as binary, so searches skipped it silently and code review
 * could not show a diff of it. The escape sequence has the identical value.
 */
test("no source file contains a raw NUL byte", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith("."))
        continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js|jsx)$/.test(entry.name)) {
        if (readFileSync(full).includes(0)) offenders.push(full.slice(workspace.length + 1));
      }
    }
  };
  walk(packagesDir);
  walk(join(workspace, "apps"));
  assert.deepEqual(offenders, [], `\n  ${offenders.join("\n  ")}`);
});
