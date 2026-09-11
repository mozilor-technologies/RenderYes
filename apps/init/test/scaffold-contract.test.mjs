import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { frontendRoute, standaloneService } from "../src/templates.mjs";
import { installPackages } from "../src/install.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const ANSWERS = {
  catalogId: "bharat_times",
  sourceLabel: "Books",
  serviceUrl: "http://localhost:4000",
  adminTokenEnv: "RENDERYES_ADMIN_TOKEN",
  placeholder: "What do you want to see?",
  sessionStyle: "cookie",
  ownerStyle: "single-user",
  topology: "standalone",
  outDir: "renderyes-service",
  sourceId: "api",
  upstreamOrigin: "https://api.example.com",
  mountPath: "/api/renderyes",
  planProvider: "openai",
};

/**
 * The scaffold registers the host's own components, so it knows the default is
 * wrong for them.
 *
 * `renderMode` defaults to `"isolated"`, which mounts a shadow root — right for
 * a surface dropped into an unknown page, wrong for components the host wrote:
 * their markup arrives with every class intact and none of them applying,
 * because the stylesheet is outside the boundary. Nothing errors; a correct
 * answer just looks unstyled. This cost a cold install more time than anything
 * else, with the README that explains it already in front of them — which is
 * why the fix belongs in the file the scaffold writes, not in more prose.
 */
test("the scaffolded page renders host components in the page, not a shadow root", () => {
  for (const next of [false, true]) {
    const page = frontendRoute(ANSWERS, { next });
    assert.match(page, /renderMode: "host"/, `next=${next}: renderMode not set`);
    assert.match(
      page,
      /components: views,[\s\S]{0,600}renderMode: "host",[\s\S]{0,40}\}\}/,
      `next=${next}: renderMode is outside the config object`,
    );
  }
});

/**
 * A generated file must import exactly what it uses. The session resolver only
 * throws for a style that has sessions, so the import that carries the class
 * has to follow the same condition.
 */
test("the service imports the error class exactly when it throws it", () => {
  for (const sessionStyle of ["anonymous", "cookie", "bearer", "custom"]) {
    const source = standaloneService({ ...ANSWERS, sessionStyle });
    const imports = /,\s*UnauthenticatedError\s*\}\s*from "@renderyes\/server"/.test(source);
    const throws = /throw new UnauthenticatedError\(/.test(source);
    assert.equal(imports, throws, `${sessionStyle}: import and usage disagree`);
  }
});

test("the generated service parses", () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-parse-"));
  const file = join(dir, "server.mjs");
  writeFileSync(file, standaloneService(ANSWERS));
  assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", file]));
});

/**
 * `--queries` is the only way to inventory part of a large schema. The CLI has
 * always had it; `init` shells out with a fixed argument list and never passed
 * it, so the headless route took the whole schema — dozens of capabilities and
 * tens of megabytes, each needing a decision before anything compiles.
 */
test("--queries reaches the inventory command it belongs to", () => {
  const catalog = readFileSync(resolve(here, "../src/catalog.mjs"), "utf8");
  assert.match(catalog, /\.\.\.\(queries \? \["--queries", queries\] : \[\]\)/);
  const walk = readFileSync(resolve(here, "../src/walk.mjs"), "utf8");
  assert.match(walk, /queries: flags\.queries/);
  const bin = readFileSync(resolve(here, "../bin/init.mjs"), "utf8");
  assert.match(bin, /queries: flag\("queries"\)/);
});

/**
 * A backend that is not Node has no package.json, so the tool tells the host to
 * make one — and then refused the result for having no lockfile, which
 * `npm init -y` does not create. The refusal exists to stop the wrong package
 * manager running inside someone's workspace; a directory holding nothing but a
 * fresh manifest has no workspace to damage.
 */
test("a directory with nothing in it yet installs instead of refusing", () => {
  const root = mkdtempSync(join(tmpdir(), "iv-fresh-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "svc", private: true }));
  const result = installPackages(
    { root, dependencies: {}, packageManager: undefined },
    "backend",
    { dryRun: true },
  );
  assert.equal(result.ok, true, result.summary);
  // npm, because it ships with Node and there is no signal pointing elsewhere.
  assert.match(`${result.summary ?? ""}${result.command ?? ""}`, /npm install/);
});

test("a project that already has dependencies still refuses to guess a manager", () => {
  const root = mkdtempSync(join(tmpdir(), "iv-established-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app" }));
  const result = installPackages(
    { root, dependencies: { express: "4" }, packageManager: undefined },
    "backend",
    { dryRun: true },
  );
  assert.equal(result.ok, false);
  assert.match(result.summary, /lockfile/);
});
