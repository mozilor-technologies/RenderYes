import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleStyleCorpus,
  loadDataContractFromExport,
  sliceCapability,
  synthesizeSampleRows,
  verifyDraft,
} from "../dist/index.js";
import { buildReviewExportBundle, goodEnvelope, PLAIN_HOST_DIR } from "./fixture.mjs";

function setup() {
  const contract = loadDataContractFromExport(buildReviewExportBundle());
  const slice = sliceCapability(contract, "pantry.items.list");
  const corpus = assembleStyleCorpus({
    hostDir: PLAIN_HOST_DIR,
    slice,
    uiManifest: contract.uiManifest,
  });
  const sampleRows = synthesizeSampleRows({
    dataType: slice.dataType,
    requiredOutputFields: slice.requiredOutputFields,
  });
  return { contract, slice, corpus, sampleRows };
}

function verify(envelope, overrides = {}) {
  const { contract, slice, corpus, sampleRows } = setup();
  return verifyDraft({
    envelope,
    slice,
    plannerManifest: contract.plannerManifest,
    uiManifest: contract.uiManifest,
    corpus,
    fileExtension: ".jsx",
    sampleRows,
    ...overrides,
  });
}

function check(report, name) {
  const found = report.checks.find((entry) => entry.name === name);
  assert.ok(found, `report has no check named ${name}`);
  return found;
}

test("twin equality fails when the envelope spec drifts from the file", async () => {
  const envelope = goodEnvelope();
  envelope.spec = { ...envelope.spec, description: "A different description." };
  const report = await verify(envelope);
  const twin = check(report, "twin-equality");
  assert.equal(twin.pass, false);
  assert.match(twin.detail, /\$\.description/);
  // The other structural checks still ran and still pass.
  assert.equal(check(report, "define-host-component").pass, true);
  assert.equal(check(report, "render-smoke").pass, true);
});

test("twin equality fails when the spec's dataSlots acceptance drifts", async () => {
  const envelope = goodEnvelope();
  envelope.spec = {
    ...envelope.spec,
    dataSlots: {
      items: { accepts: [{ dataTypeId: "Recipe", shapes: ["collection"] }] },
    },
  };
  const report = await verify(envelope);
  assert.equal(check(report, "twin-equality").pass, false);
  assert.match(check(report, "twin-equality").detail, /dataSlots/);
});

test("a view that fetches fails the authoring lint with the rule named", async () => {
  const envelope = goodEnvelope();
  // Never invoked at render time — the lint is a source-level gate.
  envelope.componentFile = `const refresh = () => fetch("/api/items");\n${envelope.componentFile}`;
  const report = await verify(envelope);
  const lint = check(report, "authoring-lint");
  assert.equal(lint.pass, false);
  assert.match(lint.detail, /fetch\(\) — views take data through props/);
});

test("interactive elements fail the read-only gate", async () => {
  const envelope = goodEnvelope();
  envelope.componentFile = envelope.componentFile.replace(
    '<h2 className="pantry-heading">{title ?? "Shopping list"}</h2>',
    '<h2 className="pantry-heading">{title ?? "Shopping list"}</h2><button type="button">Buy all</button>',
  );
  const report = await verify(envelope);
  const smoke = check(report, "render-smoke");
  assert.equal(smoke.pass, false);
  assert.match(smoke.detail, /read-only rule.*<button>/);
});

test("hard-coded hex colors fail when the corpus has tokens", async () => {
  const envelope = goodEnvelope();
  envelope.componentFile = envelope.componentFile.replace(
    'className="pantry-list"',
    'className="pantry-list" style={{ background: "#ff0000" }}',
  );
  const report = await verify(envelope);
  assert.match(check(report, "render-smoke").detail, /hex color/);
});

test("classNames missing from the host stylesheet fail in plain-CSS mode", async () => {
  const envelope = goodEnvelope();
  envelope.componentFile = envelope.componentFile.replace(
    'className="pantry-heading"',
    'className="fancy-invented-heading"',
  );
  const report = await verify(envelope);
  assert.match(check(report, "render-smoke").detail, /fancy-invented-heading/);
});

test("a component rendering error and empty identically fails distinctness", async () => {
  const envelope = goodEnvelope();
  // Collapse the error branch onto the empty rendering: a visitor could no
  // longer tell a broken request from a genuine zero.
  envelope.componentFile = envelope.componentFile.replace(
    '<p role="alert" className="pantry-error">{errorMessage ?? "This data could not be loaded."}</p>',
    '<p className="pantry-empty">Nothing on the shopping list right now.</p>',
  );
  const report = await verify(envelope);
  const smoke = check(report, "render-smoke");
  assert.equal(smoke.pass, false);
  assert.match(smoke.detail, /identical output/);
});

test("a source file that does not parse fails fast and marks dependents not-run", async () => {
  const envelope = goodEnvelope();
  envelope.componentFile = "export const spec = defineView({; nonsense";
  const report = await verify(envelope);
  assert.equal(check(report, "esbuild-parse").pass, false);
  assert.match(check(report, "define-host-component").detail, /not run/);
  assert.equal(report.pass, false);
});

test("a file without the spec export fails through ingestViews' own error", async () => {
  const envelope = goodEnvelope();
  envelope.componentFile = envelope.componentFile.replace(
    "export const spec = defineView(",
    "const spec = defineView(",
  );
  const report = await verify(envelope);
  const contract = check(report, "define-host-component");
  assert.equal(contract.pass, false);
  assert.match(contract.detail, /does not export `spec`/);
});

test("relative imports are rejected — a generated view must be self-contained", async () => {
  const envelope = goodEnvelope();
  envelope.componentFile = `import helper from "./helper.js";\n${envelope.componentFile}`;
  const report = await verify(envelope);
  assert.match(check(report, "define-host-component").detail, /self-contained/);
});

test("unused completeness is a warning in the lint detail, not a failure", async () => {
  const envelope = goodEnvelope();
  // Remove the completeness disclosure; the component still handles state.
  envelope.componentFile = envelope.componentFile.replace(
    /\{completeness && completeness\.complete === false \? \([\s\S]*?\) : null\}/,
    "",
  );
  envelope.componentFile = envelope.componentFile.replace("\n  completeness,\n", "\n");
  const report = await verify(envelope);
  const lint = check(report, "authoring-lint");
  assert.equal(lint.pass, true);
  assert.match(lint.detail, /warning: the component never reads `completeness`/);
  // But it now renders truncated identically to ready, which IS a failure.
  assert.equal(check(report, "render-smoke").pass, false);
});

/**
 * A draft that renders one row per record and no value from any of them.
 *
 * This is the shape that shipped: the generator emitted `field(row, path)` —
 * `field` is an object of prop builders and is not callable — and the draft's
 * own `readField` try/catch swallowed the throw, so every cell showed an em
 * dash over ten rows. All six checks passed. `render-smoke` reported
 * "ready/empty/error/truncated all render, distinctly", which was true and
 * said nothing about whether any data had arrived.
 */
function blindEnvelope() {
  return {
    componentFile: `import { defineView, field } from "@renderyes/react";

export const spec = defineView({
  id: "PantryShoppingList",
  version: "1.0.0",
  description:
    "Displays the visitor's pantry shopping list as cards grouped by purchase status — " +
    "the view for any request about what still needs buying.",
  props: { title: field.string({ default: "Shopping list" }) },
  dataSlots: {
    items: { accepts: [{ dataTypeId: "ShoppingItem", shapes: ["collection"] }] },
  },
  accessibility: {
    label: "Shopping list",
    description: "Pantry shopping items grouped by purchase status.",
  },
});

export default function PantryShoppingList({ title, items, state, errorMessage, completeness }) {
  if (state === "error") {
    return <p role="alert">{errorMessage ?? "This data could not be loaded."}</p>;
  }
  const rows = Array.isArray(items) ? items : [];
  if (state === "empty" || rows.length === 0) {
    return <p>Nothing on the shopping list right now.</p>;
  }
  return (
    <section aria-label="Shopping list">
      <h3>{title}</h3>
      {completeness && completeness.complete === false ? (
        <p>Showing only the first of them.</p>
      ) : null}
      <ul>
        {rows.map((row, index) => (
          <li key={index}>
            <span>{"\\u2014"}</span> <span>{"\\u2014"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
`,
    spec: goodEnvelope().spec,
    notes: [],
  };
}

test("render-smoke fails a draft whose screen owes nothing to the data", async () => {
  const report = await verify(blindEnvelope());
  const smoke = check(report, "render-smoke");
  assert.equal(smoke.pass, false);
  assert.match(smoke.detail, /identical output for two different row sets/);
});

test("render-smoke still passes a draft that formats every value it binds", async () => {
  // The guard against the obvious wrong implementation: this draft renders
  // money through `Intl.NumberFormat` and dates through `toLocaleDateString`,
  // so none of its inputs appear verbatim in the HTML. Asserting that a sample
  // value shows up would fail it.
  const report = await verify(goodEnvelope());
  const smoke = check(report, "render-smoke");
  assert.equal(smoke.pass, true, smoke.detail);
});
