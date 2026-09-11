import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The CLI is a published `bin` (`renderyes-site`), and nothing else covers it.
 * `pnpm smoke:install` proves the package imports and serves; it never runs a
 * subcommand. So a broken `scan` would ship green — which is how
 * `test/fixture.site.mjs` came to sit here with no test importing it.
 *
 * These run the real binary as a child process rather than importing it: the
 * file is a script with top-level side effects, and the thing under test is
 * what a host gets when they type the command.
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const CLI = resolve(here, "../cli.mjs");
const FIXTURE = resolve(here, "fixture.site.mjs");

const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("scan emits a manifest carrying the registered component", () => {
  const manifest = JSON.parse(run("scan", FIXTURE));
  assert.equal(manifest.site.id, "cli-fixture");
  assert.ok(
    manifest.components.some((component) => component.id === "Notice"),
    "the fixture's one component is missing from the manifest",
  );
});

test("sync writes the same manifest to a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "site-cli-"));
  try {
    const out = join(dir, "catalog.json");
    assert.match(run("sync", FIXTURE, out), /Synced cli-fixture/);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), JSON.parse(run("scan", FIXTURE)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown command explains itself and fails", () => {
  assert.throws(
    () => execFileSync(process.execPath, [CLI, "nope"], { encoding: "utf8", stdio: "pipe" }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(String(error.stderr), /Usage: renderyes-site/);
      return true;
    },
  );
});

test("init refuses to overwrite a site file that already exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "site-cli-"));
  try {
    run("init", dir);
    assert.throws(() => execFileSync(process.execPath, [CLI, "init", dir], { stdio: "pipe" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
