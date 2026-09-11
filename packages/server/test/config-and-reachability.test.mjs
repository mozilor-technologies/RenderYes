import assert from "node:assert/strict";
import test from "node:test";
import { createViewServer } from "../dist/index.js";

const MINIMAL = { resolveSession: () => ({ id: "u1" }) };

/**
 * The mount a host writes is `server.mjs` — plain JavaScript — so the option
 * types never run. An unknown key used to be accepted and dropped, and the one
 * that cost the most was `onEvent`: an option of `compose()`, wired per call.
 * Passed here it produced no events and no complaint, which is indistinguishable
 * from a hook that does not work, and was reported as exactly that.
 */
test("createViewServer refuses an option it does not take", () => {
  assert.throws(
    () => createViewServer({ ...MINIMAL, onEvent: () => {} }),
    (error) => {
      assert.match(error.message, /does not take/);
      assert.match(error.message, /"onEvent"/);
      // The remedy has to be executable, so it must name where the option goes.
      assert.match(error.message, /compose\(\)/);
      assert.match(error.message, /server\.compose\(/);
      return true;
    },
  );
});

test("it names a plain typo without inventing a home for it", () => {
  assert.throws(
    () => createViewServer({ ...MINIMAL, resolveSesion: () => ({}) }),
    (error) => {
      assert.match(error.message, /"resolveSesion"/);
      assert.doesNotMatch(error.message, /compose\(\)/);
      return true;
    },
  );
});

test("a correctly configured server still builds", () => {
  assert.doesNotThrow(() => createViewServer(MINIMAL));
});
