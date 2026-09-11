/**
 * Every public package releases at one version, so assert they agree.
 *
 * `release.yml` compares the tag against `packages/core/package.json` alone. If
 * ten packages are bumped and one is missed, that guard still passes and
 * `pnpm publish -r` ships the straggler at its old version — which cannot be
 * corrected, because a published version number can never be reused.
 *
 * Runs in `pnpm check`, so a mismatch fails in CI on the bump commit rather
 * than during the release it would break.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const manifests = [];
for (const group of ["packages", "apps"]) {
  for (const entry of await readdir(resolve(workspace, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = resolve(workspace, group, entry.name, "package.json");
    let pkg;
    try {
      pkg = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue; // a directory without a manifest is not a workspace package
    }
    // Private packages are never published, so their version is nobody's contract.
    if (pkg.private) continue;
    manifests.push({
      name: pkg.name,
      version: pkg.version,
      path: `${group}/${entry.name}`,
    });
  }
}

const versions = new Map();
for (const m of manifests) {
  if (!versions.has(m.version)) versions.set(m.version, []);
  versions.get(m.version).push(m.name);
}

if (versions.size > 1) {
  console.error("Public packages disagree on their version:\n");
  for (const [version, names] of [...versions].sort()) {
    console.error(`  ${version}`);
    for (const name of names.sort()) console.error(`    ${name}`);
  }
  console.error(
    "\nBump every public package together, or publishing ships the odd one out",
  );
  console.error("at the wrong version — permanently, since a version cannot be reused.");
  process.exit(1);
}

console.log(`${manifests.length} public packages, all at ${[...versions.keys()][0]}`);
