#!/usr/bin/env node
// Point a pnpm or Yarn app's dependency resolution at the local @renderyes
// tarballs.
//
// Usage: write-local-overrides.mjs <tarball-dir> <pnpm|yarn> <package-name>...
//
// npm can be handed every tarball in one command and resolves them as a set, so
// the rewritten `workspace:*` references find each other. pnpm and Yarn resolve
// each spec on its own, so `@renderyes/server`'s dependency on
// `@renderyes/core@0.2.0` is looked up on the public registry — where nothing
// is published — and the install dies with a 404 naming a package the developer
// never asked for. An override table is the only thing that redirects those
// transitive references at the point they are resolved.
//
// This edits the target's manifest rather than printing instructions because
// the destination differs by manager and by pnpm version, and picking the wrong
// one fails silently: the install succeeds and resolves from the registry
// anyway.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const [tarballDir, packageManager, ...packages] = process.argv.slice(2);

if (!tarballDir || !packageManager || packages.length === 0) {
  console.error("Usage: write-local-overrides.mjs <tarball-dir> <pnpm|yarn> <package>...");
  process.exit(1);
}

const targetDir = process.cwd();
const manifestPath = join(targetDir, "package.json");

if (!existsSync(manifestPath)) {
  console.error(`No package.json in ${targetDir}`);
  process.exit(1);
}

/** `file:` specifier relative to the target, so the manifest stays portable. */
function specifierFor(name) {
  const slug = name.replace("@renderyes/", "");
  const path = relative(targetDir, join(tarballDir, `renderyes-${slug}.tgz`));
  return `file:${path.startsWith(".") ? path : `./${path}`}`;
}

const overrides = Object.fromEntries(packages.map((name) => [name, specifierFor(name)]));

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// Only the two packages a host imports are declared as dependencies. The other
// five reach node_modules as transitive deps of these, redirected to tarballs
// by the override table — declaring every one would tell a reader that packages
// they must never import are theirs to use.
const DIRECT = ["@renderyes/react", "@renderyes/server"];
manifest.dependencies ??= {};
let declared = 0;
for (const name of DIRECT) {
  if (packages.includes(name) && !manifest.dependencies[name]) {
    manifest.dependencies[name] = specifierFor(name);
    declared += 1;
  }
}

if (packageManager === "yarn") {
  manifest.resolutions = { ...(manifest.resolutions ?? {}), ...overrides };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`    Wrote ${packages.length} resolutions to package.json.`);
} else {
  // pnpm reads overrides from pnpm-workspace.yaml when that file declares them
  // (pnpm 10.4+) and from package.json's `pnpm.overrides` otherwise — and the
  // workspace file wins. Writing to package.json while the workspace file also
  // has an overrides block is the trap: the manifest looks correct, pnpm
  // ignores it, and the install 404s on a package that is plainly overridden
  // three lines up.
  const workspacePath = join(targetDir, "pnpm-workspace.yaml");
  const workspaceYaml = existsSync(workspacePath) ? readFileSync(workspacePath, "utf8") : null;

  if (workspaceYaml !== null && /^overrides:/m.test(workspaceYaml)) {
    // An existing block. Merging YAML by hand risks corrupting a file this
    // script does not own, so print what to add and let a human place it.
    console.log("    pnpm-workspace.yaml already declares overrides — add these by hand:");
    for (const [name, spec] of Object.entries(overrides)) {
      console.log(`      "${name}": "${spec}"`);
    }
  } else if (workspaceYaml !== null) {
    const block = [
      "",
      "# Local RenderYes tarballs. pnpm resolves each dependency spec",
      "# independently, so the packed packages' rewritten sibling references",
      "# must be redirected here or they resolve against the public registry.",
      "overrides:",
      ...Object.entries(overrides).map(([name, spec]) => `  "${name}": "${spec}"`),
      "",
    ].join("\n");
    writeFileSync(workspacePath, `${workspaceYaml.replace(/\n*$/, "\n")}${block}`);
    console.log(`    Wrote ${packages.length} overrides to pnpm-workspace.yaml.`);
  } else {
    manifest.pnpm ??= {};
    manifest.pnpm.overrides = { ...(manifest.pnpm.overrides ?? {}), ...overrides };
    console.log(`    Wrote ${packages.length} overrides to package.json (pnpm.overrides).`);
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (declared > 0) {
  console.log(`    Declared ${declared} dependenc${declared === 1 ? "y" : "ies"} in package.json.`);
}
