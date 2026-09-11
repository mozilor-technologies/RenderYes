import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnvVar } from "../src/env.mjs";

/**
 * One reader, shared by `doctor` and the walk. The bug this file pins is not in
 * the parsing — it is that the first version was private to one frontend, so
 * the same project passed `doctor` and stalled the walk on a token that was
 * sitting in `.env` exactly where the scaffold's own docs said to put it.
 */

function dotenv(contents) {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents);
  return path;
}

test("the environment wins over the file, and quotes are stripped from the file", () => {
  const file = dotenv(`RENDERYES_TEST_TOKEN="from-file"\nOTHER=x\n`);

  process.env.RENDERYES_TEST_TOKEN = "from-shell";
  try {
    assert.equal(readEnvVar("RENDERYES_TEST_TOKEN", file), "from-shell");
  } finally {
    delete process.env.RENDERYES_TEST_TOKEN;
  }

  assert.equal(readEnvVar("RENDERYES_TEST_TOKEN", file), "from-file");
});

test("absence is undefined, never a guess", () => {
  const file = dotenv("SOMETHING_ELSE=value\n");
  assert.equal(readEnvVar("RENDERYES_TEST_TOKEN", file), undefined);
  assert.equal(readEnvVar("RENDERYES_TEST_TOKEN", join(tmpdir(), "does-not-exist.env")), undefined);
  assert.equal(readEnvVar(undefined, file), undefined);
});

test("a commented-out line does not count as set", () => {
  // The scaffolded .env.example ships RENDERYES_DEV_SESSION commented out so
  // copying it forward is safe; the reader must not resurrect it.
  const file = dotenv("# RENDERYES_TEST_TOKEN=dev-user\n");
  assert.equal(readEnvVar("RENDERYES_TEST_TOKEN", file), undefined);
});
