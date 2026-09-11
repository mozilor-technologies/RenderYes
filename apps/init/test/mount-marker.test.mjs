import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMountMarker, inspectProject } from "../src/detect.mjs";
import { planFiles } from "../src/scaffold.mjs";

/**
 * The tool wrote the layout, so it should not be guessing at it afterwards.
 *
 * `detectRole` reads dependencies. That is right for a host's own tree and
 * wrong for a directory this tool created: run from the app directory it said
 * `unknown` and told the host to run it from the directory holding the app —
 * which is where they were — and run from the standalone service it said
 * `both` and demanded React of a service that renders nothing.
 */
function scaffoldPlan(overrides = {}) {
  return planFiles(
    { root: "/tmp/does-not-matter", framework: undefined },
    {
      catalogId: "bharat_times",
      topology: "standalone",
      outDir: "renderyes-service",
      serviceUrl: "http://localhost:4000",
      sourceId: "api",
      upstreamOrigin: "https://api.example.com",
      ...overrides,
    },
    { role: "backend" },
  );
}

test("the scaffold records what it decided, at the root and in the service", () => {
  const paths = scaffoldPlan().map((file) => file.path);
  assert.ok(paths.includes("renderyes.mount.json"), "root marker missing");
  assert.ok(
    paths.includes(join("renderyes-service", "renderyes.mount.json")),
    "service marker missing",
  );
});

test("the service's own marker says backend, not what its parent looks like", () => {
  const file = scaffoldPlan().find(
    (entry) => entry.path === join("renderyes-service", "renderyes.mount.json"),
  );
  assert.equal(JSON.parse(file.contents).role, "backend");
});

test("detection reads the marker back and prefers it over dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "iv-marker-"));
  // A tree that looks like a frontend to the detector.
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "x", dependencies: { react: "18.0.0" } }),
  );
  assert.equal(inspectProject(root).role, "frontend", "precondition: detected as frontend");

  writeFileSync(
    join(root, "renderyes.mount.json"),
    JSON.stringify({ catalogId: "x", role: "backend", topology: "standalone" }),
  );
  assert.equal(inspectProject(root).role, "backend", "marker must win");
});

test("a missing or corrupt marker leaves detection exactly as it was", () => {
  const root = mkdtempSync(join(tmpdir(), "iv-marker-bad-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "x", dependencies: { react: "18.0.0" } }),
  );
  assert.equal(readMountMarker(root), undefined);
  writeFileSync(join(root, "renderyes.mount.json"), "{ not json");
  assert.equal(readMountMarker(root), undefined, "corrupt marker must not throw");
  assert.equal(inspectProject(root).role, "frontend");
});

/**
 * A clarifying question is the clarification path working.
 *
 * The planner can answer the prompt two or more materially different ways and
 * declined to guess between them. Everything `verified` exists to prove — the
 * mount, the session, both catalogs, the registrations, a real model call — is
 * proven by getting a question back. Reported as `Compose failed`, it sent a
 * host hunting for a broken mount behind a working one.
 */
test("doctor reports a clarifying question as reached, not as a failure", async () => {
  const { interpretCompose } = await import("../src/checks.mjs");
  const check = interpretCompose({
    ok: false,
    kind: "needs-clarification",
    question: "Open reports, or reports you opened?",
  });
  assert.equal(check.status, "pass");
  assert.match(check.summary, /asked rather than guessed/);
  assert.match(check.summary, /Open reports/);
});

test("a real compose failure is still a failure", async () => {
  const { interpretCompose } = await import("../src/checks.mjs");
  const check = interpretCompose({ ok: false, error: "Unknown catalog." });
  assert.equal(check.status, "fail");
  assert.match(check.summary, /Compose failed/);
});
