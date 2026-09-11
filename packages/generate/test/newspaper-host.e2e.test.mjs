import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReviewExportBundle } from "./fixture.mjs";

/**
 * The whole CLI, against a host shaped like a newspaper: Tailwind over
 * a custom-property token layer, with an existing component establishing the
 * idiom.
 *
 * The other fixtures exercise corpus *detection* in isolation; the tailwind one
 * was a lone config file that nothing ever drove end to end. This is the case
 * that has to hold before anyone is told "run generate to make it look native",
 * and the load-bearing half is the negative: a draft that invents hex values
 * instead of composing the host's tokens must be *caught*, not emitted. Without
 * that, routing a host here would be routing them to an unbounded model.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "generate.mjs");
const HOST = join(HERE, "fixtures", "newspaper-host");

const SPEC = {
  id: "ArticleDigest",
  version: "1.0.0",
  description:
    "Lists recent articles as cards with kicker, headline and byline — the view for " +
    "any request about what has been published lately.",
  props: { title: { type: "string", default: "Latest" } },
  dataSlots: {
    items: { accepts: [{ dataTypeId: "ShoppingItem", shapes: ["collection"] }] },
  },
  accessibility: {
    label: "Article digest",
    description: "Recent articles as cards.",
  },
};

/** A draft in the host's idiom, or one that invents its own values. */
function draft({ inIdiom }) {
  const card = inIdiom ? "bt-card" : "digest-card";
  const styleAttr = inIdiom
    ? ""
    : ' style={{ background: "#fffdf8", color: "#16130f", border: "1px solid #d9d2c5" }}';
  return {
    componentFile: `import { defineView, field } from "@renderyes/react";

export const spec = defineView({
  id: "ArticleDigest",
  version: "1.0.0",
  description:
    "Lists recent articles as cards with kicker, headline and byline — the view for " +
    "any request about what has been published lately.",
  props: { title: field.string({ default: "Latest" }) },
  dataSlots: {
    items: { accepts: [{ dataTypeId: "ShoppingItem", shapes: ["collection"] }] },
  },
  accessibility: {
    label: "Article digest",
    description: "Recent articles as cards.",
  },
});

export default function ArticleDigest({ title, items, state, errorMessage, sources, completeness }) {
  if (state === "error") {
    return <p role="alert" className="bt-error">{errorMessage ?? "This data could not be loaded."}</p>;
  }
  const rows = Array.isArray(items) ? items : [];
  if (state === "empty" || rows.length === 0) {
    return <p className="bt-empty">Nothing published yet.</p>;
  }
  return (
    <section className="${card}"${styleAttr} aria-label="Article digest">
      <h2 className="bt-headline">{title ?? "Latest"}</h2>
      {sources && sources.length === 0 ? (
        <p className="bt-note">Not attributed to a source - treat these as unverified.</p>
      ) : null}
      {completeness && completeness.complete === false ? (
        <p className="bt-note">Showing the first {completeness.rowCount} of {completeness.totalRows}.</p>
      ) : null}
      <ul className="bt-list">
        {rows.map((row, index) => (
          <li key={typeof row?.id === "string" ? row.id : index} className="bt-item">
            <p className="bt-kicker">{row?.status ?? "unknown"}</p>
            <h3 className="bt-headline">{row?.name ?? "\\u2014"}</h3>
            <p className="bt-byline">
              {typeof row?.quantity === "number" ? row.quantity + " g" : "\\u2014"}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
`,
    spec: SPEC,
    notes: ["Cards in the host's own idiom."],
  };
}

function run(args, { expectFailure = false } = {}) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8" }) };
  } catch (error) {
    if (!expectFailure) throw error;
    return { code: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function setup(envelopes) {
  const dir = mkdtempSync(join(tmpdir(), "iv-newspaper-"));
  const bundlePath = join(dir, "bundle.json");
  writeFileSync(bundlePath, JSON.stringify(buildReviewExportBundle()));
  const mockPath = join(dir, "mock.json");
  writeFileSync(mockPath, JSON.stringify(envelopes));
  return { dir, bundlePath, mockPath };
}

function invoke({ dir, bundlePath, mockPath }, options = {}) {
  const outDir = join(dir, "out");
  return {
    outDir,
    ...run(
      [
        "component",
        "--export", bundlePath,
        "--capability", "pantry.items.list",
        "--host-dir", HOST,
        "--provider", "mock",
        "--mock-file", mockPath,
        "--out", outDir,
      ],
      options,
    ),
  };
}

test("a draft in the host's idiom passes every gate and emits a .tsx component", () => {
  const files = setup([draft({ inIdiom: true })]);
  const { code, outDir } = invoke(files);
  assert.equal(code, 0);

  // .tsx, because the host has a tsconfig — the emitted file has to be
  // something their build already compiles.
  assert.ok(
    existsSync(join(outDir, "verification-report.md")),
    "every run leaves its verification report",
  );
  const emitted = readFileSync(join(outDir, "ArticleDigest.view.tsx"), "utf8");
  // The host's classes, not ours and not invented ones.
  assert.match(emitted, /bt-card/);
  assert.doesNotMatch(emitted, /#[0-9a-fA-F]{6}/, "no invented hex values survived");
});

test("a draft that invents its own colours is caught, not emitted as good", () => {
  // The gate that makes routing a host here defensible. The corpus demonstrates
  // tokens, so hardcoded values are a fidelity failure — and the run has to say
  // so rather than handing over a component that looks foreign on their page.
  const files = setup([draft({ inIdiom: false })]);
  const { code, stdout, stderr } = invoke(files, { expectFailure: true });
  assert.notEqual(code, 0, "an off-idiom draft must not exit 0");
  const output = `${stdout}${stderr}`;
  assert.match(output, /token|hex|color/i, `expected the fidelity failure named, got: ${output.slice(0, 400)}`);
});

test("the run repairs an off-idiom first attempt when a good one follows", () => {
  // The realistic case: attempt one drifts, the repair prompt carries the
  // verifier's own complaint, attempt two composes from tokens.
  const files = setup([draft({ inIdiom: false }), draft({ inIdiom: true })]);
  const { code, outDir } = invoke(files);
  assert.equal(code, 0, "a repaired draft is a successful run");
  const emitted = readFileSync(join(outDir, "ArticleDigest.view.tsx"), "utf8");
  assert.doesNotMatch(emitted, /#[0-9a-fA-F]{6}/);
});
