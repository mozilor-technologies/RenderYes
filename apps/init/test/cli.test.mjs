import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The CLI as a process, because the failure pinned here only exists as one:
 * without a terminal, a readline prompt over piped or closed stdin never
 * resolves, and the process died on an unsettled top-level await — no exit
 * code, no message, just a hang until whatever spawned it gave up. Every run
 * below must end on its own, quickly, with an exit code a script can act on.
 */

const CLI = fileURLToPath(new URL("../bin/init.mjs", import.meta.url));

function project() {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-cli-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "shop", dependencies: { express: "4" } }),
  );
  return dir;
}

function run(dir, args, { stdin = "ignore" } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: dir, timeout: 15_000 },
      (failure, stdout, stderr) => {
        if (failure && failure.killed) {
          reject(new Error(`timed out; the CLI hung instead of exiting:\n${stderr}`));
          return;
        }
        resolve({ status: failure?.code ?? 0, stdout, stderr });
      },
    );
    if (stdin === "pipe-empty") child.stdin.end();
    // "ignore" leaves stdin as execFile created it; closing it immediately is
    // the closed-pipe case either way.
    else child.stdin?.end();
  });
}

test("a walk without a terminal and without --yes exits 2 and names the flags", async () => {
  const outcome = await run(project(), []);
  assert.equal(outcome.status, 2);
  assert.match(outcome.stderr, /--yes/);
  // Every question has a flag, and the refusal is where someone learns that.
  for (const flag of ["--endpoint", "--session", "--owner", "--topology", "--catalog-id"]) {
    assert.ok(outcome.stderr.includes(flag), `guidance must name ${flag}`);
  }
});

test("an empty piped stdin gets the same refusal, not a hang", async () => {
  const outcome = await run(project(), ["--role", "backend"], { stdin: "pipe-empty" });
  assert.equal(outcome.status, 2);
  assert.match(outcome.stderr, /--yes/);
});

test("--yes runs to a clean exit with stdin closed", async () => {
  // --dry-run --skip-install keeps the run local: no install, no writes, no
  // network, no dependence on this machine's registry configuration.
  const outcome = await run(project(), ["--yes", "--dry-run", "--skip-install", "--role", "backend"]);
  assert.equal(outcome.status, 0);
  assert.doesNotMatch(outcome.stderr, /stdin is not a terminal/);
});

test("doctor never prompts, so it runs without a terminal as it always did", async () => {
  const outcome = await run(project(), ["doctor", "--role", "backend"]);
  // Non-zero because the project genuinely lacks packages — the point is that
  // it *finished* and reported, rather than waiting on questions it never asks.
  assert.equal(outcome.status, 1);
  assert.match(outcome.stdout, /Reached:/);
});

test("usage documents a flag for every question the interview can ask", async () => {
  const outcome = await run(project(), ["--help"]);
  assert.equal(outcome.status, 0);
  for (const flag of [
    "--catalog-id",
    "--endpoint",
    "--admin-token-env",
    "--session",
    "--owner",
    "--topology",
    "--frontend-origin",
    "--prompt",
    "--rows",
  ]) {
    assert.ok(outcome.stderr.includes(flag), `usage must document ${flag}`);
  }
});
