import assert from "node:assert/strict";
import test from "node:test";
import {
  createScriptedGenerateProvider,
  generateComponent,
  loadDataContractFromExport,
  renderPreviewHtml,
} from "../dist/index.js";
import {
  buildReviewExportBundle,
  flawedEnvelope,
  goodEnvelope,
  PLAIN_HOST_DIR,
} from "./fixture.mjs";

function findPreview(result) {
  return result.artifacts.find((artifact) => artifact.name === "preview.html");
}

/** An envelope whose component registers fine but throws in every state. */
function neverRenderingEnvelope() {
  const envelope = goodEnvelope();
  envelope.componentFile = envelope.componentFile.replace(
    'if (state === "error") {',
    'throw new Error("always broken at render time");\n  if (state === "error") {',
  );
  return envelope;
}

test("preview.html is emitted on success with all four states, markup, and stylesheet", async () => {
  const provider = createScriptedGenerateProvider([goodEnvelope()]);
  const contract = loadDataContractFromExport(buildReviewExportBundle());
  const result = await generateComponent({
    contract,
    capabilityId: "pantry.items.list",
    provider,
    hostDir: PLAIN_HOST_DIR,
    componentId: "PantryShoppingList",
  });
  assert.equal(result.pass, true);

  const preview = findPreview(result);
  assert.ok(preview, "preview.html is a standard artifact of a passing run");
  const html = preview.content;

  // The neutral header names the component.
  assert.match(html, /PantryShoppingList — rendered states/);
  // All four state labels appear.
  for (const state of ["ready", "empty", "error", "truncated"]) {
    assert.ok(
      html.includes(`>${state}</h2>`),
      `preview.html labels the "${state}" state`,
    );
  }
  // The component's rendered markup is present (a ready row, the empty copy,
  // the error copy, and the truncation notice).
  assert.match(html, /Item name 1/);
  assert.match(html, /Nothing on the shopping list right now\./);
  assert.match(html, /This data could not be loaded\./);
  assert.match(html, /Showing the first/);
  // The host stylesheet is inlined.
  assert.match(html, /--iv-starter-accent: #047857;/);
  assert.match(html, /\.pantry-list \{/);
  // Self-contained: no external requests, no scripts.
  assert.ok(!/\bsrc\s*=|\bhref\s*=|<script\b/i.test(html), "no external references");
});

test("a failing draft with rendered states still gets a preview.html", async () => {
  // flawedEnvelope fails the render-smoke rubric (identifier as title), but
  // all four states DO render — the preview is exactly the review evidence.
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
  assert.equal(result.pass, false);
  const preview = findPreview(result);
  assert.ok(preview, "failing drafts with at least one rendered state emit a preview");
  assert.match(preview.content, /ready/);
});

test("no preview.html when not a single state rendered", async () => {
  const provider = createScriptedGenerateProvider([
    neverRenderingEnvelope(),
    neverRenderingEnvelope(),
    neverRenderingEnvelope(),
  ]);
  const contract = loadDataContractFromExport(buildReviewExportBundle());
  const result = await generateComponent({
    contract,
    capabilityId: "pantry.items.list",
    provider,
    hostDir: PLAIN_HOST_DIR,
    componentId: "PantryShoppingList",
  });
  assert.equal(result.pass, false);
  assert.equal(findPreview(result), undefined);
  // The rest of the failure-path artifacts are unchanged.
  assert.ok(result.artifacts.some((a) => a.name === "verification-report.md"));
  assert.ok(result.artifacts.some((a) => a.name === "PantryShoppingList.view.jsx"));
});

test("renderPreviewHtml marks absent states instead of dropping them", () => {
  const html = renderPreviewHtml({
    componentId: "Partial<View>",
    stylesheetText: ".a { color: red; }",
    states: { ready: "<div class=\"a\">only ready rendered</div>" },
  });
  // The id is HTML-escaped in the header.
  assert.match(html, /Partial&lt;View&gt; — rendered states/);
  assert.match(html, /only ready rendered/);
  const missing = html.match(/This state did not render/g) ?? [];
  assert.equal(missing.length, 3);
  assert.match(html, /\.a \{ color: red; \}/);
});
