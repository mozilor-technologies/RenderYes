import assert from "node:assert/strict";
import test from "node:test";
import { installPackages } from "../src/install.mjs";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveCatalogId,
  detectPackageManager,
  detectRole,
  detectScopeMapping,
  inspectProject,
} from "../src/detect.mjs";
import {
  checkCatalogIdAgreement,
  checkMountDecisions,
  checkNoToolsInstalled,
  checkPackagesInstalled,
  interpretCatalogState,
  interpretCompose,
  interpretProbe,
  runLocalChecks,
} from "../src/checks.mjs";
import { packagesFor } from "../src/install.mjs";
import { exitCode, reachedLevel } from "../src/report.mjs";

/**
 * The checks are the product, so they are tested directly rather than through
 * the CLI. Each one encodes a failure this project has actually seen — a
 * misfiled catalog id, an expired token, a publish with nothing to render — so
 * a test here is a regression test on a real onboarding failure, not on a
 * string.
 */

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-init-"));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return dir;
}

test("derives a catalog id from the package name, scope dropped", () => {
  // The scope says who publishes the app, not which catalog this is.
  assert.equal(deriveCatalogId({ name: "@acme/storefront" }), "storefront");
  assert.equal(deriveCatalogId({ name: "Shop_Dashboard v2" }), "shop-dashboard-v2");
  assert.equal(deriveCatalogId({ name: "@acme/---" }), undefined);
  assert.equal(deriveCatalogId({}), undefined);
});

test("reads the package manager from the lockfile rather than defaulting", () => {
  assert.equal(detectPackageManager(fixture({ "pnpm-lock.yaml": "" })), "pnpm");
  assert.equal(detectPackageManager(fixture({ "yarn.lock": "" })), "yarn");
  // Undefined, not "npm": running the wrong one in a workspace leaves a second
  // lockfile and a node_modules layout the first did not expect.
  assert.equal(detectPackageManager(fixture({ "package.json": "{}" })), undefined);
});

test("detects which halves of the integration live here", () => {
  assert.equal(detectRole({ react: "19" }), "frontend");
  assert.equal(detectRole({ express: "4" }), "backend");
  assert.equal(detectRole({ react: "19", next: "15" }), "both");
  assert.equal(detectRole({ "@renderyes/server": "0.1.0" }), "backend");
  assert.equal(detectRole({ lodash: "4" }), undefined);
});

test("tools in a host's dependencies are flagged, not accepted", () => {
  const clean = checkNoToolsInstalled({ dependencies: { "@renderyes/react": "1" } });
  assert.equal(clean.status, "pass");

  const dirty = checkNoToolsInstalled({
    dependencies: { "@renderyes/catalog-review": "1" },
  });
  assert.equal(dirty.status, "warn");
  assert.match(dirty.remedy, /npx/);
});

test("a UI catalog under an id nothing uses is reported as the blocking failure", () => {
  // The most-hit onboarding failure on record, and silent: a site named
  // `<catalog>-ui` publishes with ok: true and resolves nothing at compose.
  const checks = interpretCatalogState({
    capabilityCatalogs: [
      { catalogId: "shop", capabilityCount: 4, executableCapabilityCount: 4 },
    ],
    uiCatalogs: [{ catalogId: "shop-ui" }],
  });
  const ui = checks.find((check) => check.id === "ui-catalog");
  assert.equal(ui.status, "fail");
  assert.match(ui.summary, /shop-ui/);
  // Names the id they should have used, rather than only the one they did.
  assert.match(ui.remedy, /shop/);
});

test("agreeing catalogs pass, and unrenderable types warn rather than block", () => {
  const checks = interpretCatalogState({
    capabilityCatalogs: [
      { catalogId: "shop", capabilityCount: 2, executableCapabilityCount: 2 },
    ],
    uiCatalogs: [{ catalogId: "shop" }],
    coverage: {
      coverage: [
        { dataTypeId: "order", shape: "collection", unrenderable: false },
        { dataTypeId: "customer", shape: "entity", unrenderable: true },
      ],
    },
  });
  assert.equal(checks.find((check) => check.id === "ui-catalog").status, "pass");
  const coverage = checks.find((check) => check.id === "coverage");
  // A warning: the planner simply never selects it, and the visible symptom is
  // a thinner answer rather than an error.
  assert.equal(coverage.status, "warn");
  assert.match(coverage.summary, /customer/);
  assert.match(coverage.remedy, /bootstrap/);
});

test("a probe that answers without the host credential is surfaced, not hidden", () => {
  const checks = interpretProbe({
    results: [
      { capabilityId: "a", status: "ok", upstreamCredential: "not-required" },
      { capabilityId: "b", status: "skipped", reason: "requires parameters (id)" },
    ],
  });
  const unguarded = checks.find((check) => check.id === "upstream-credential");
  assert.equal(unguarded.status, "warn");
  // Skipped is not a problem — there was nothing the probe refused to invent.
  assert.equal(checks.find((check) => check.id === "probe-skipped").status, "pass");
});

test("compose with ok:true and no messages is a failure, not a pass", () => {
  // A surface with nothing in it. The comment here used to say "`ok` describes
  // the request, not the answer" — true of the old envelope, and no longer:
  // `ok: true` now means at least one bound slot delivered, so this is the
  // narrower case of a plan that bound nothing at all.
  const empty = interpretCompose({ ok: true, messages: [] });
  assert.equal(empty.status, "fail");
  assert.match(empty.remedy, /bound nothing at all/);
  assert.equal(interpretCompose({ ok: true, messages: [{}] }).status, "pass");
  assert.equal(interpretCompose({ ok: false, error: "nope" }).status, "fail");
});

test("a partial view is reported as one, and a missing provider is not a failure", () => {
  // Both follow the server's own envelope. A clean tick over a view the visitor
  // sees gaps in is the class of false green this whole pass exists to remove.
  const partial = interpretCompose({
    ok: true,
    partial: true,
    messages: [{}],
    requests: [
      { capabilityId: "posts.list", ok: true },
      { capabilityId: "polls.list", ok: false, error: "upstream refused" },
    ],
  });
  assert.equal(partial.status, "warn");
  assert.match(partial.summary, /partial/);
  assert.match(partial.remedy, /polls\.list \(upstream refused\)/);
  assert.match(partial.remedy, /1 of 2/);

  // Planning is the one step that cannot be verified without a model, and
  // everything below it has already been checked by the levels above. Reported
  // as worth knowing rather than as the wiring being broken.
  const unplanned = interpretCompose({
    ok: false,
    kind: "plan-provider-not-configured",
    error: "No plan provider is configured, so no plan can be produced. …",
  });
  assert.equal(unplanned.status, "warn");
  assert.match(unplanned.remedy, /planProviders/);
  assert.match(unplanned.remedy, /rehearsal/);
});

test("a commented-out decision does not count as set", () => {
  // Substring matching read a symbol in a comment as configuration — a
  // commented-out `resolveViewOwner` is exactly the "looks configured, is not"
  // case these checks exist for.
  const dir = fixture({
    "package.json": "{}",
    "src/mount.ts": [
      "createViewServer({ host, resolveSession });",
      "// resolveViewOwner: (session) => session.userId,",
      '/* allowedUpstreamOrigins: ["https://api.example.com"], */',
    ].join("\n"),
  });
  const byId = new Map(checkMountDecisions(inspectProject(dir)).map((check) => [check.id, check]));
  assert.equal(byId.get("mount-exists").status, "pass");
  assert.equal(byId.get("mount-resolveSession").status, "pass");
  // A warn, not a fail: the library refuses refine/save without an owner key
  // (the closed direction), and an anonymous-visitor host omits it on purpose.
  assert.equal(byId.get("mount-resolveViewOwner").status, "warn");
  assert.equal(byId.get("mount-allowedUpstreamOrigins").status, "fail");
});

test("a mount that exists only in a comment is no mount at all", () => {
  const dir = fixture({
    "package.json": "{}",
    "src/note.ts": "// createViewServer lives in the backend repository",
  });
  const checks = checkMountDecisions(inspectProject(dir));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].id, "mount-exists");
  assert.equal(checks[0].status, "fail");
});

test("catalog ids in comments are not ids in use, and no literal is advisory", () => {
  const agreeing = fixture({
    "package.json": "{}",
    "src/a.ts": '// catalogId: "shop-ui" — the old name, kept for history\nconst config = { catalogId: "shop" };',
  });
  const agreed = checkCatalogIdAgreement(inspectProject(agreeing));
  assert.equal(agreed.status, "pass");
  assert.match(agreed.summary, /shop$/);

  // An id supplied from configuration is a correct setup this check cannot
  // see. `advisory` is what keeps that unknown from capping the level forever.
  const configured = fixture({
    "package.json": "{}",
    "src/a.ts": "const config = { catalogId: fromConfig() };",
  });
  const unknown = checkCatalogIdAgreement(inspectProject(configured));
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.advisory, true);
});

test("a level counts as reached only when nothing in it is unresolved", () => {
  assert.equal(
    reachedLevel([
      { level: "access", status: "pass" },
      { level: "installed", status: "warn" },
      { level: "mounted", status: "fail" },
    ]),
    // A warning does not block: it is information about a choice the host is
    // entitled to make.
    "installed",
  );
  // Unknown blocks like a failure — a level cannot be declared reached on the
  // strength of something this tool could not see.
  assert.equal(
    reachedLevel([
      { level: "access", status: "pass" },
      { level: "installed", status: "unknown" },
    ]),
    "access",
  );
  // Unless the check itself says not seeing an answer is acceptable. Without
  // this, a host whose catalog id comes from configuration — which is correct —
  // could never reach past "installed".
  assert.equal(
    reachedLevel([
      { level: "access", status: "pass" },
      { level: "installed", status: "unknown", advisory: true },
    ]),
    "installed",
  );
});

test("exit code is non-zero only when a human has to decide", () => {
  assert.equal(exitCode([{ status: "pass" }, { status: "warn" }]), 0);
  assert.equal(exitCode([{ status: "fail" }]), 1);
});

test("reads a whole project and reports what is missing", () => {
  const dir = fixture({
    "package.json": JSON.stringify({
      name: "@acme/shop",
      dependencies: { react: "19", express: "4", "@renderyes/react": "0.1.0" },
    }),
    "package-lock.json": "",
    ".npmrc": "@renderyes:registry=https://example.invalid/npm/renderyes/\n",
    "src/mount.ts": "createViewServer({ host, resolveSession: r => r });",
  });
  const project = inspectProject(dir);
  assert.equal(project.role, "both");
  assert.equal(project.framework.id, "express");
  assert.equal(project.framework.bootStyle, "before-listen");

  const checks = runLocalChecks(project);
  const byId = new Map(checks.map((check) => [check.id, check]));
  assert.equal(byId.get("scope-mapping").status, "pass");
  assert.equal(byId.get("packages-installed").status, "fail");
  assert.equal(byId.get("mount-exists").status, "pass");
  assert.equal(byId.get("mount-resolveSession").status, "pass");
  // The no-default decisions this mount left out. resolveViewOwner warns
  // rather than fails — its absence is fail-closed in the library itself.
  assert.equal(byId.get("mount-allowedUpstreamOrigins").status, "fail");
  assert.equal(byId.get("mount-resolveViewOwner").status, "warn");
  assert.equal(byId.get("mount-requireAdmin").status, "fail");
});

test("INSTALLED asks for exactly what the installer installs — one list, one owner", () => {
  // The check used to rebuild its list from the package tiers and dropped the
  // optional starter catalog the installer adds, so a project the walk had
  // just installed was under-reported by the walk's own doctor.
  for (const role of ["frontend", "backend", "both"]) {
    const everything = Object.fromEntries(packagesFor(role).map((name) => [name, "0.1.0"]));
    assert.equal(
      checkPackagesInstalled({ role, dependencies: everything }).status,
      "pass",
      `${role}: everything packagesFor installs must satisfy the check`,
    );
    for (const name of packagesFor(role)) {
      const missingOne = { ...everything };
      delete missingOne[name];
      const check = checkPackagesInstalled({ role, dependencies: missingOne });
      assert.equal(check.status, "fail", `${role}: missing ${name} must fail`);
      assert.match(check.summary, new RegExp(name));
    }
  }
});

test("the scope mapping is read where the package manager reads it", () => {
  // A workspace keeps one .npmrc at its root while this tool runs in an app
  // folder below it, and a token-holding user keeps the mapping in ~/.npmrc:
  // both installs succeed, so ACCESS reporting them as unconfigured was a
  // false negative the walk's own install step then contradicted.
  const workspace = fixture({
    ".npmrc": "@renderyes:registry=https://registry.example.invalid/npm/\n",
    "apps/shop/package.json": "{}",
  });
  const fromApp = detectScopeMapping(join(workspace, "apps", "shop"), {
    home: fixture({ "unrelated.txt": "" }),
  });
  assert.equal(fromApp.configured, true);
  assert.equal(fromApp.registry, "https://registry.example.invalid/npm/");
  assert.equal(fromApp.source, join(workspace, ".npmrc"));

  const home = fixture({
    ".npmrc": [
      "//registry.example.invalid/npm/:_authToken=not-read-by-this-tool",
      "@renderyes:registry=https://registry.example.invalid/npm/",
    ].join("\n"),
  });
  const fromHome = detectScopeMapping(fixture({ "package.json": "{}" }), { home });
  assert.equal(fromHome.configured, true);
  assert.equal(fromHome.source, join(home, ".npmrc"));
});

/**
 * Installing, when the package manager wants an answer nobody is there to give.
 *
 * `stdio: "inherit"` is deliberate — a person watching the wizard can answer a
 * build-script approval or a registry challenge. But under `--yes` or in CI
 * nobody is watching, and a package manager blocked on a prompt looks exactly
 * like a slow install. It waited forever, with no message.
 */
test("a stalled install is stopped and explained, not waited on", () => {
  const root = mkdtempSync(join(tmpdir(), "iv-install-stall-"));
  // A "package manager" that does what a prompt does: reads stdin and never
  // returns. Named `npm` so ADD_COMMAND resolves, and put first on PATH.
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, "npm");
  writeFileSync(fake, "#!/bin/sh\nread answer\n");
  chmodSync(fake, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  let result;
  try {
    result = installPackages(
      { root, packageManager: "npm", dependencies: {} },
      "backend",
      { timeoutMs: 700 },
    );
  } finally {
    process.env.PATH = previousPath;
  }

  assert.equal(result.ok, false);
  assert.match(result.summary, /was stopped/);
  // The likely cause and the command to run by hand, so the next move is
  // obvious rather than "try again and hope".
  assert.match(result.remedy, /prompt with nobody to answer it/);
  assert.match(result.remedy, /npm install @renderyes\//);
});

/**
 * pnpm's `minimumReleaseAge` refuses versions published in the last N minutes.
 * Good against a compromised publish; exactly wrong for a tester being handed a
 * build published minutes ago on purpose, who then silently gets an older one.
 */
test("pnpm is told not to skip a just-published build", () => {
  const root = mkdtempSync(join(tmpdir(), "iv-install-age-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  // Records the setting it was given, then exits cleanly.
  const fake = join(binDir, "pnpm");
  writeFileSync(
    fake,
    `#!/bin/sh\necho "\${npm_config_minimum_release_age-unset}" > ${JSON.stringify(join(root, "seen.txt"))}\n`,
  );
  chmodSync(fake, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    installPackages({ root, packageManager: "pnpm", dependencies: {} }, "backend", {});
  } finally {
    process.env.PATH = previousPath;
  }

  // Through the environment, not `--config.minimumReleaseAge=0`: an unknown
  // environment variable is inert everywhere, an unknown flag is a parse error
  // on some versions.
  assert.equal(readFileSync(join(root, "seen.txt"), "utf8").trim(), "0");
});

/**
 * The release-age guard, and the recovery route when it fails anyway.
 *
 * An install on pnpm 11.21 took a build 30 hours older than the one it had just
 * been handed, with the environment form of this setting in place, and then
 * answered `pnpm add …@latest` with "Already up to date" — so the host had no
 * way forward from the symptom.
 */
test("the pnpm command carries the release-age override, and no other manager does", async () => {
  const { ADD_COMMAND } = await import("../src/install.mjs");
  assert.deepEqual(ADD_COMMAND.pnpm(["a"]), ["add", "--config.minimumReleaseAge=0", "a"]);
  for (const manager of ["npm", "yarn", "bun"]) {
    assert.equal(
      ADD_COMMAND[manager](["a"]).some((argument) => argument.includes("minimumReleaseAge")),
      false,
      `${manager} would treat an unknown flag as a parse error`,
    );
  }
});

test("drift on pnpm names the release-age policy as a cause worth checking", () => {
  const check = checkPackagesInstalled({
    root: "/tmp",
    role: "backend",
    packageManager: "pnpm",
    dependencies: { "@renderyes/server": "0.1.0", "@renderyes/site-sdk": "0.1.0" },
    installedVersions: {
      "@renderyes/server": "0.1.0",
      "@renderyes/site-sdk": "0.1.0",
    },
    cliVersion: "0.2.0",
  });
  assert.equal(check.status, "warn");
  assert.match(check.remedy, /Already up to date/);
  assert.match(check.remedy, /minimumReleaseAge=0/);
});
