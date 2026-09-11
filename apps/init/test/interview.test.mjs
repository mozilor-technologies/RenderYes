import assert from "node:assert/strict";
import test from "node:test";
import { conductInterview } from "../src/interview.mjs";

/**
 * The interview's own guarantees, run non-interactively (which is also how
 * `--yes` runs it): flags win, defaults are derived, and — the one with
 * security weight — nothing shaped like a secret can pass through the
 * admin-token question into generated files.
 */

const PROJECT = { manifest: { name: "shop" }, framework: undefined };

test("an admin-token answer that is not a variable NAME is refused, with the reason", async () => {
  // The question collects the *name* of an environment variable, because the
  // answer is interpolated into scaffolded source. A pasted token value here
  // would be written into the host's repository.
  for (const value of ["sk-live-abc123", "my token", "token=abc", "lower_case"]) {
    await assert.rejects(
      conductInterview(PROJECT, { adminTokenEnv: value }, { interactive: false }),
      /not an environment variable name[\s\S]*never the token itself/,
      `"${value}" must be refused`,
    );
  }
});

test("real variable names pass, including the derived default", async () => {
  for (const name of [undefined, "RENDERYES_ADMIN_TOKEN", "MY_APP_ADMIN_KEY_2"]) {
    const answers = await conductInterview(
      PROJECT,
      { ...(name ? { adminTokenEnv: name } : {}) },
      { interactive: false },
    );
    assert.match(answers.adminTokenEnv, /^[A-Z][A-Z0-9_]*$/);
  }
});

test("an anonymous session forecloses the identity question", async () => {
  // There is no visitor identity to ask about: the templates omit
  // resolveViewOwner (the server refuses refine/save without one, which is
  // the closed direction), so an owner answer would have to be ignored.
  const answers = await conductInterview(
    PROJECT,
    { sessionStyle: "anonymous" },
    { interactive: false },
  );
  assert.equal(answers.sessionStyle, "anonymous");
  assert.equal(answers.ownerStyle, "anonymous");
});

test("--endpoint answers the endpoint question and derives the origin allowlist", async () => {
  const answers = await conductInterview(
    PROJECT,
    { schemaEndpoint: "https://api.example.com/graphql" },
    { interactive: false },
  );
  assert.equal(answers.schemaEndpoint, "https://api.example.com/graphql");
  assert.equal(answers.upstreamOrigin, "https://api.example.com");
});

/**
 * The two ids the wizard hands downstream, and the installs they broke.
 *
 * `sourceId` was the catalog id, so the scaffolded `resolveProvenance` returned
 * a value the catalog does not declare in `sources` and all nine capabilities
 * failed execution on a fresh install. `catalogId` was accepted unvalidated by
 * a prompt that calls it a durable storage key, and rejected three steps later
 * by the half that renders.
 */
test("the scaffolded source id is the one the compiled catalog declares", async () => {
  const answers = await conductInterview(
    { root: "/tmp", manifest: { name: "paper" }, dependencies: {}, framework: undefined },
    { catalogId: "paper", schemaEndpoint: "https://api.example.com/graphql", yes: true },
    { interactive: false },
  );
  assert.equal(answers.sourceId, "paper-source");
  assert.notEqual(answers.sourceId, answers.catalogId);
});

test("a catalog id the UI half would reject is refused at the prompt", async () => {
  await assert.rejects(
    conductInterview(
      { root: "/tmp", manifest: { name: "paper" }, dependencies: {}, framework: undefined },
      { catalogId: "bharat times 2808", schemaEndpoint: "https://api.example.com/graphql", yes: true },
      { interactive: false },
    ),
    /must match/,
  );
});
