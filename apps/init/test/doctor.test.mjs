import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackagesInstalled, checkScopeMapping } from "../src/checks.mjs";
import { inspectProject } from "../src/detect.mjs";

/**
 * The doctor CLI, run for real. Both bugs pinned here were found by running it
 * against a project installed from local tarballs: `--role` was parsed and
 * never applied (flags are module scope, so --service-url worked and --role
 * silently did not), and a missing registry mapping failed unconditionally —
 * capping the report at "Reached: nothing yet" while every real check was
 * green, in direct disagreement with the walk's own "fine for scaffolding,
 * needed before installing".
 */

const CLI = fileURLToPath(new URL("../bin/init.mjs", import.meta.url));

function backendProject() {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-doctor-"));
  // `react` present so detection says "both" — the flag has to actually win.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "shop-backend",
      // A *complete* backend install: `site-sdk` too, because the server half
      // builds the UI manifest it publishes and `server` re-exports none of
      // that authoring API.
      dependencies: {
        react: "19",
        express: "4",
        "@renderyes/server": "0.1.0",
        "@renderyes/site-sdk": "0.1.0",
      },
    }),
  );
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "src", "mount.mjs"),
    [
      'import { createViewServer } from "@renderyes/server";',
      "const renderYes = createViewServer({",
      "  resolveSession,",
      "  resolveViewOwner,",
      '  allowedUpstreamOrigins: ["https://api.example.com"],',
      "  catalogStore: store,",
      "});",
      "await renderYes.restorePublishedCatalogs();",
      "const handler = createViewHttpHandler(renderYes, { requireAdmin });",
    ].join("\n"),
  );
  return dir;
}

function doctor(dir, args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, "doctor", ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (failure) {
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", status: failure.status ?? 1 };
  }
}

test("doctor honours --role, and a tarball install is not pinned at nothing", () => {
  const dir = backendProject();

  const overridden = doctor(dir, ["--role", "backend"]);
  // The flag applied: no complaint about frontend packages in a backend run.
  assert.doesNotMatch(overridden.stdout, /@renderyes\/react/);
  // And the missing registry mapping is information, not a cap: everything the
  // role wants is installed, so the level reflects what is actually true.
  assert.match(overridden.stdout, /Reached: mounted/);
  assert.equal(overridden.status, 0);

  // Without the override, detection says "both" and the frontend packages are
  // genuinely missing — that must still fail, or the flag fixed nothing.
  const detected = doctor(dir, []);
  assert.match(detected.stdout, /@renderyes\/react/);
  assert.equal(detected.status, 1);
});

test("the mapping fails only when something would need the registry", () => {
  const installed = {
    role: "backend",
    scope: { configured: false },
    dependencies: { "@renderyes/server": "0.1.0", "@renderyes/site-sdk": "0.1.0" },
  };
  const warned = checkScopeMapping(installed);
  assert.equal(warned.status, "warn");
  assert.match(warned.remedy, /local tarballs/);

  const missing = checkScopeMapping({
    role: "backend",
    scope: { configured: false },
    dependencies: {},
  });
  assert.equal(missing.status, "fail");

  // Role unknown means nothing can be shown installed — stay conservative.
  const unknown = checkScopeMapping({ role: undefined, scope: { configured: false }, dependencies: {} });
  assert.equal(unknown.status, "fail");
});

test("doctor reports libraries older than the CLI running against them", () => {
  // The install failure this exists for: `npx` fetches the newest published
  // version while `pnpm add` is subject to a release-age quarantine, so the CLI
  // ran ahead of the libraries — silently. Presence-only checking called that
  // install complete, and the mismatch went on to split an evaluation across
  // two decoder paths.
  const dir = mkdtempSync(join(tmpdir(), "renderyes-drift-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "shop",
      dependencies: { express: "4", "@renderyes/server": "0.1.0", "@renderyes/site-sdk": "0.1.0" },
    }),
  );
  for (const [name, version] of [
    ["server", "0.1.0"],
    ["site-sdk", "0.1.0"],
  ]) {
    const pkg = join(dir, "node_modules", "@renderyes", name);
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: `@renderyes/${name}`, version }));
  }

  const project = inspectProject(dir);
  assert.equal(
    project.installedVersions["@renderyes/server"],
    "0.1.0",
    "installed versions come from node_modules, not the declared range",
  );

  const check = checkPackagesInstalled({ ...project, role: "backend", cliVersion: "0.2.0" });
  assert.equal(check.status, "warn", "presence alone must not read as healthy");
  assert.match(check.summary, /different version than this tool/);
  assert.match(check.summary, /\(older\)/, "direction is claimed when both versions parse");
  assert.match(check.summary, /0\.1\.0/);
  // The remedy is a command, with the version to pin at, not a description.
  assert.match(check.remedy, /@renderyes\/server@0\.2\.0/);

  // And a matched install stays a plain pass — the check must not warn always.
  const matched = checkPackagesInstalled({ ...project, role: "backend", cliVersion: "0.1.0" });
  assert.equal(matched.status, "pass");
});

test("a JSON API that is not ours does not read as a healthy mount", async () => {
  const { checkReachable } = await import("../src/live.mjs");
  const { createServer } = await import("node:http");

  // The false ✓ this closes: `doctor` reported "Mount is reachable" from any
  // response at the service URL — on a real install, the host's own front page
  // — and later from any JSON. A proxy, a different API, or a stale process on
  // the port all passed, at the level a downstream failure gets diagnosed from.
  const impostor = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, catalogs: [] }));
  });
  await new Promise((resolve) => impostor.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${impostor.address().port}`;
  try {
    const [check] = await checkReachable(url);
    assert.equal(check.status, "fail", "a plausible JSON answer is not proof of a mount");
    assert.match(check.summary, /not from a RenderYes handler/);
    assert.match(check.remedy, /proxy|older process|--service-url/);
  } finally {
    await new Promise((resolve) => impostor.close(resolve));
  }

  // And the real handler's header is what distinguishes it.
  const genuine = createServer((_request, response) => {
    response.writeHead(401, {
      "content-type": "application/json",
      "x-renderyes-handler": "1",
    });
    response.end(JSON.stringify({ ok: false, error: "Not authenticated." }));
  });
  await new Promise((resolve) => genuine.listen(0, "127.0.0.1", resolve));
  const genuineUrl = `http://127.0.0.1:${genuine.address().port}`;
  try {
    const [check] = await checkReachable(genuineUrl);
    assert.equal(check.status, "pass");
    assert.match(check.summary, /admin gate/);
  } finally {
    await new Promise((resolve) => genuine.close(resolve));
  }
});

/**
 * Lockstep releases mean the CLI's own version is both the comparison and the
 * answer, so the two things worth pinning are that a partial mismatch is caught
 * per package, and that ordering is numeric rather than lexical.
 */
test("only the packages that actually differ are reported, each pinned at the CLI's version", () => {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-drift-partial-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "paper",
      dependencies: {
        "@renderyes/server": "0.2.0",
        "@renderyes/site-sdk": "0.2.0",
        "@renderyes/capability-catalog": "0.2.0",
      },
    }),
  );
  for (const [name, version] of [
    ["server", "0.2.0"],
    ["site-sdk", "0.1.0"],
    ["capability-catalog", "0.1.0"],
  ]) {
    const pkg = join(dir, "node_modules", "@renderyes", name);
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: `@renderyes/${name}`, version }));
  }
  const check = checkPackagesInstalled({
    ...inspectProject(dir),
    role: "backend",
    cliVersion: "0.2.0",
  });
  assert.equal(check.status, "warn");
  assert.match(check.remedy, /@renderyes\/site-sdk@0\.2\.0/);
  assert.match(check.remedy, /@renderyes\/capability-catalog@0\.2\.0/);
  assert.doesNotMatch(
    check.summary,
    /@renderyes\/server@/,
    "a package already at the CLI's version is not drift and must not be listed",
  );
});

test("version ordering is numeric, so 0.10.0 is newer than 0.9.0", () => {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-drift-order-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "paper",
      dependencies: { "@renderyes/server": "0.10.0", "@renderyes/site-sdk": "0.10.0" },
    }),
  );
  for (const name of ["server", "site-sdk"]) {
    const pkg = join(dir, "node_modules", "@renderyes", name);
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: `@renderyes/${name}`, version: "0.10.0" }),
    );
  }

  const check = checkPackagesInstalled({ ...inspectProject(dir), role: "backend", cliVersion: "0.9.0" });
  assert.equal(check.status, "warn");
  assert.match(
    check.summary,
    /\(newer\)/,
    "a lexical compare calls 0.10.0 older than 0.9.0, which is backwards",
  );
});

/**
 * `verified` attempted rather than skipped.
 *
 * The whole L4 stage was gated behind a supplied prompt, and doctor supplied
 * none — so the one check that proves the pipeline end to end was never run,
 * and the report had nothing to be blocked by. This runs the real binary
 * against a stub mount and asserts the compose call happens.
 */
test("the doctor binary composes without being given a prompt", async () => {
  const { createServer } = await import("node:http");
  // `spawn`, not `spawnSync`: a synchronous child blocks this process's event
  // loop, so the stub server below could never answer and the test would fail
  // whatever the binary did.
  const { spawn } = await import("node:child_process");
  const hit = [];
  const server = createServer((request, response) => {
    hit.push(request.url ?? "");
    response.setHeader("x-renderyes-handler", "1");
    response.setHeader("content-type", "application/json");
    if (request.headers["x-renderyes-admin-token"] === "probe-unauthenticated") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "admin token required" }));
      return;
    }
    if (request.url?.includes("compose")) {
      response.end(JSON.stringify({ ok: true, messages: [{ kind: "component" }] }));
      return;
    }
    response.end(JSON.stringify([{ catalogId: "shop" }]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  // A real project directory: doctor reads the one it is run from, and an
  // unconfigured folder stops before it ever reaches the mount.
  const fixture = mkdtempSync(join(tmpdir(), "renderyes-doctor-l4-"));
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "p",
      dependencies: { "@renderyes/server": "0.1.0", "@renderyes/site-sdk": "0.1.0" },
    }),
  );
  for (const name of ["server", "site-sdk"]) {
    const pkg = join(fixture, "node_modules", "@renderyes", name);
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: `@renderyes/${name}`, version: "0.1.0" }));
  }
  try {
    const child = spawn(
      process.execPath,
      [
        new URL("../bin/init.mjs", import.meta.url).pathname,
        "doctor", "--service-url", url, "--admin-token-env", "IV_TEST_TOKEN",
        "--role", "backend",
      ],
      { cwd: fixture, env: { ...process.env, IV_TEST_TOKEN: "t" }, stdio: "ignore" },
    );
    await new Promise((resolve) => child.on("close", resolve));
    // No --prompt anywhere: doctor has to supply its own or this level is never
    // tried, which is the state the third install found it in.
    assert.ok(
      hit.some((path) => path.includes("compose")),
      `doctor never composed; it requested: ${hit.join(", ")}`,
    );
  } finally {
    server.close();
  }
});

test("runLiveChecks composes when given a prompt", async () => {
  const { createServer } = await import("node:http");
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.url);
    response.setHeader("x-renderyes-handler", "1");
    response.setHeader("content-type", "application/json");
    const token = request.headers["x-renderyes-admin-token"];
    if (token === "probe-unauthenticated") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "admin token required" }));
      return;
    }
    if (request.url?.includes("compose")) {
      response.end(JSON.stringify({ ok: true, messages: [{ kind: "component" }] }));
      return;
    }
    if (request.url?.includes("ui-catalog")) {
      response.end(JSON.stringify([{ catalogId: "shop" }]));
      return;
    }
    if (request.url?.includes("probe")) {
      response.end(JSON.stringify({ ok: true, capabilities: [] }));
      return;
    }
    if (request.url?.includes("coverage")) {
      response.end(JSON.stringify({ capabilities: [] }));
      return;
    }
    response.end(JSON.stringify([{ catalogId: "shop" }]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const { runLiveChecks } = await import("../src/live.mjs");
    // No prompt passed: the default is doctor's, and the stage must still run.
    await runLiveChecks(url, { adminToken: "t", prompt: "Show me what is here." });
    assert.ok(
      seen.some((path) => path?.includes("compose")),
      "the level that proves the pipeline must actually be attempted",
    );
  } finally {
    server.close();
  }
});
