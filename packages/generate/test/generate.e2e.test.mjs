import assert from "node:assert/strict";
import test from "node:test";
import {
  createScriptedGenerateProvider,
  generateComponent,
  GenerateRefusalError,
  loadDataContractFromExport,
} from "../dist/index.js";
import {
  buildReviewExportBundle,
  flawedEnvelope,
  goodEnvelope,
  PLAIN_HOST_DIR,
} from "./fixture.mjs";

/**
 * The end-to-end story the plan promises: a flawed first draft (identifier
 * rendered as a title — the "p_9" failure) is caught by the render-smoke
 * rubric gate, the exact failure message is fed back, and round two passes
 * every mechanical check.
 */
test("repair loop: flawed draft (id-as-title) is caught and fixed on round 2", async () => {
  const provider = createScriptedGenerateProvider([flawedEnvelope(), goodEnvelope()]);
  const contract = loadDataContractFromExport(buildReviewExportBundle());

  const result = await generateComponent({
    contract,
    capabilityId: "pantry.items.list",
    provider,
    hostDir: PLAIN_HOST_DIR,
    componentId: "PantryShoppingList",
  });

  assert.equal(result.pass, true);
  assert.equal(result.rounds, 2);
  assert.equal(provider.requests.length, 2);

  // Round 1 failed on exactly the identifier-as-title gate.
  const firstReport = result.attempts[0].report;
  assert.equal(firstReport.pass, false);
  const smoke = firstReport.checks.find((check) => check.name === "render-smoke");
  assert.equal(smoke.pass, false);
  assert.match(smoke.detail, /identifier value "x_\d"/);

  // The repair prompt carried the exact check message back to the model.
  assert.match(provider.requests[1].userPrompt, /identifier value "x_\d"/);
  assert.match(provider.requests[1].userPrompt, /failed mechanical verification/);

  // Round 2 passed everything.
  const secondReport = result.attempts[1].report;
  assert.equal(secondReport.pass, true);
  for (const check of secondReport.checks) {
    assert.equal(check.pass, true, `${check.name}: ${check.detail}`);
  }
  assert.deepEqual(
    secondReport.checks.map((check) => check.name),
    [
      "esbuild-parse",
      "define-host-component",
      "twin-equality",
      "coverage-delta",
      "render-smoke",
      "authoring-lint",
    ],
  );

  // Folder convention on a plain host: the file plus the two review artifacts,
  // and .jsx because the host has no tsconfig.
  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.name),
    [
      "PantryShoppingList.view.jsx",
      "verification-report.md",
      "preview.html",
      "sample-rows.json",
    ],
  );
  assert.match(
    result.artifacts.find((a) => a.name === "verification-report.md").content,
    /\*\*Overall: PASS\*\*/,
  );
  assert.equal(result.convention, "folder");
  assert.equal(result.corpus.system, "plain-css");
});

test("a draft that never passes is still emitted, with the report marking failures", async () => {
  const provider = createScriptedGenerateProvider([
    flawedEnvelope(),
    flawedEnvelope(),
    flawedEnvelope(),
  ]);
  const contract = loadDataContractFromExport(buildReviewExportBundle());

  const result = await generateComponent({
    contract,
    capabilityId: "pantry.items.list",
    provider,
    hostDir: PLAIN_HOST_DIR,
    componentId: "PantryShoppingList",
  });

  // 1 draft + 2 repair rounds, the plan's bound.
  assert.equal(result.pass, false);
  assert.equal(provider.requests.length, 3);
  assert.equal(result.rounds, 3);
  const report = result.artifacts.find((a) => a.name === "verification-report.md");
  assert.match(report.content, /FAIL — review before registering/);
  // The component file is emitted anyway — reviewable, not discarded.
  assert.ok(result.artifacts.some((a) => a.name === "PantryShoppingList.view.jsx"));
});

test("a malformed envelope is repaired via the zod messages", async () => {
  const provider = createScriptedGenerateProvider([
    { componentFile: "", spec: {}, notes: "nope" },
    goodEnvelope(),
  ]);
  const contract = loadDataContractFromExport(buildReviewExportBundle());

  const result = await generateComponent({
    contract,
    capabilityId: "pantry.items.list",
    provider,
    hostDir: PLAIN_HOST_DIR,
    componentId: "PantryShoppingList",
  });

  assert.equal(result.pass, true);
  assert.ok(result.attempts[0].envelopeIssues.length > 0);
  assert.match(provider.requests[1].userPrompt, /envelope\./);
});

test("refuses an existing component id before any model call", async () => {
  const provider = createScriptedGenerateProvider([goodEnvelope()]);
  const contract = loadDataContractFromExport(buildReviewExportBundle());

  await assert.rejects(
    generateComponent({
      contract,
      capabilityId: "pantry.items.list",
      provider,
      hostDir: PLAIN_HOST_DIR,
      componentId: "GenericTable",
    }),
    GenerateRefusalError,
  );
  assert.equal(provider.requests.length, 0);
});

test("refuses at emission when the model itself picks a registered id", async () => {
  const collidingEnvelope = () => {
    const envelope = goodEnvelope();
    envelope.componentFile = envelope.componentFile.replaceAll(
      "PantryShoppingList",
      "GenericTable",
    );
    envelope.spec = { ...envelope.spec, id: "GenericTable" };
    return envelope;
  };
  const provider = createScriptedGenerateProvider([collidingEnvelope()]);
  const contract = loadDataContractFromExport(buildReviewExportBundle());

  await assert.rejects(
    generateComponent({
      contract,
      capabilityId: "pantry.items.list",
      provider,
      hostDir: PLAIN_HOST_DIR,
      componentId: "PantryShoppingList",
      maximumRepairRounds: 0,
    }),
    /already registered/,
  );
});

test("unknown capability names every approved capability in the error", async () => {
  const provider = createScriptedGenerateProvider([]);
  const contract = loadDataContractFromExport(buildReviewExportBundle());
  await assert.rejects(
    generateComponent({
      contract,
      capabilityId: "pantry.items.wrong",
      provider,
      hostDir: PLAIN_HOST_DIR,
    }),
    /pantry\.items\.list, pantry\.recipes\.list/,
  );
});
