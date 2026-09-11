import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every flag the CLI accepts has to appear in the README that ships beside it.
 *
 * `--help` is the authority — it is generated from the same source that parses
 * the arguments, so it cannot describe a flag the CLI does not have. The README
 * can, and did: fifteen of thirty flags were missing, among them `--purposes`
 * and `--shapes`, which are the only headless route past two of the refusals
 * the compile step raises. A host reading the README concluded the tool could
 * not do something it has always done.
 *
 * This is a drift test rather than a generator on purpose. Prose belongs to
 * whoever writes it; what must not drift is the *set*, and that is what this
 * asserts. Adding a flag now fails the build until it is written down.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../bin/catalog.mjs");
const COMMANDS = [
  "candidate",
  "compile",
  "curated",
  "diff",
  "inventory",
  "migrate",
  "publish",
];

function flagsOf(command) {
  const help = execFileSync(process.execPath, [cli, command, "--help"], {
    encoding: "utf8",
  });
  return [...new Set(help.match(/--[a-z][a-z-]+/g) ?? [])].filter(
    (flag) => flag !== "--help",
  );
}

test("every CLI flag is named in the package README", async () => {
  const readme = await readFile(resolve(here, "../README.md"), "utf8");
  const undocumented = [];
  for (const command of COMMANDS) {
    for (const flag of flagsOf(command)) {
      if (!readme.includes(flag)) undocumented.push(`${command} ${flag}`);
    }
  }
  assert.deepEqual(
    undocumented,
    [],
    `The CLI accepts flags the README never mentions:\n  ${undocumented.join("\n  ")}\n` +
      "Document them, or the only way a host finds them is by running --help on a " +
      "tool they did not know to run.",
  );
});
