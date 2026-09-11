import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every flag `init` accepts has to appear in the README that ships beside it.
 *
 * Same drift test `@renderyes/capability-catalog` runs, pointed at this
 * package — it was written for one CLI and never aimed at the other, and this
 * one had drifted by thirteen flags. `--help` is the authority: it is written
 * beside the parser, so it cannot describe a flag that does not exist. The
 * README can, and did not describe ones that do.
 *
 * A drift test rather than a generator, on purpose. The prose belongs to
 * whoever writes it; what must not drift is the *set*.
 */
const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../bin/init.mjs");

function documentedFlags() {
  // `spawnSync`, because this CLI prints help to stderr and `execFileSync`
  // returns stdout alone. Reading the wrong stream yields an empty string, and
  // a drift test over an empty set passes whatever the README says — the exact
  // failure mode this file exists to prevent, so it is asserted against below.
  const run = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  const text = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const flags = [...new Set(text.match(/--[a-z][a-z-]+/g) ?? [])].filter(
    (flag) => flag !== "--help",
  );
  assert.ok(flags.length > 0, "read no flags from --help — the test would pass vacuously");
  return flags;
}

test("every flag --help offers is named in the README", () => {
  const readme = readFileSync(resolve(here, "../README.md"), "utf8");
  const undocumented = documentedFlags().filter((flag) => !readme.includes(flag));
  assert.deepEqual(
    undocumented,
    [],
    `\`--help\` offers flags the README never mentions:\n  ${undocumented.join("\n  ")}\n` +
      "Document them, or the only way a host finds them is by running --help on a " +
      "tool they did not know to run.",
  );
});

/**
 * The reverse direction, which the catalog CLI's test does not check: a README
 * naming a flag the tool does not accept sends a host to type something that
 * fails, which is worse than an undocumented flag.
 */
test("the README names no flag the tool does not accept", () => {
  const readme = readFileSync(resolve(here, "../README.md"), "utf8");
  const offered = new Set(documentedFlags());
  const claimed = [...new Set(readme.match(/--[a-z][a-z-]+/g) ?? [])];
  const phantom = claimed.filter(
    (flag) => !offered.has(flag) && flag !== "--help" && !flag.startsWith("--conditions"),
  );
  assert.deepEqual(
    phantom,
    [],
    `The README names flags \`--help\` does not offer:\n  ${phantom.join("\n  ")}`,
  );
});
