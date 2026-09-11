import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collisionReport, findCollisions, nextRouteOf, planFiles, writePlan } from "../src/scaffold.mjs";
import { readHandoff } from "../src/walk.mjs";
import { render } from "../src/report.mjs";
import { installPackages, packagesFor } from "../src/install.mjs";
import {
  exampleView,
  expressMount,
  handoffFile,
  manualMount,
  nextRouteHandler,
  standaloneService,
} from "../src/templates.mjs";

/**
 * The scaffold's two promises — never overwrite, never half-write — plus the
 * one thing generated code must be: parseable. A template that produces syntax
 * errors fails at the worst moment, in someone else's repository, on a file
 * they did not write.
 */

const ANSWERS = Object.freeze({
  catalogId: "shop",
  schemaEndpoint: "https://api.example.com/graphql",
  upstreamOrigin: "https://api.example.com",
  adminTokenEnv: "RENDERYES_ADMIN_TOKEN",
  sessionStyle: "cookie",
  ownerStyle: "single-user",
  topology: "standalone",
  frontendOrigin: "https://shop.example.com",
  port: 4200,
  serviceUrl: "http://127.0.0.1:4200/",
  placeholder: "What should I look at today?",
  sourceId: "shop",
  sourceLabel: "Shop",
  mountPath: "/api/renderyes",
});

function emptyProject() {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-scaffold-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "shop" }));
  return { root: dir, manifest: { name: "shop" }, dependencies: {}, framework: undefined };
}

test("a standalone plan writes its own service, manifest and handoff", () => {
  const files = planFiles(emptyProject(), ANSWERS, { role: "both" });
  const paths = files.map((file) => file.path);
  assert.ok(paths.includes(join("renderyes-service", "server.mjs")));
  assert.ok(paths.includes(join("renderyes-service", "package.json")));
  // Standalone means the halves are always apart, so the handoff is not an
  // edge case here — it is how the frontend learns the id and the URL.
  assert.ok(paths.includes("renderyes.handoff.json"));
  // And the views folder, which is the load-bearing part: the starter set is a
  // bootstrap the host replaces.
  assert.ok(paths.some((path) => path.includes("views")));
});

test("a coexist plan mounts into the app instead of standing alone", () => {
  const project = { ...emptyProject(), framework: { id: "next", bootStyle: "module-await" } };
  const files = planFiles(project, { ...ANSWERS, topology: "coexist" }, { role: "backend" });
  const paths = files.map((file) => file.path);
  // route.js on purpose: a generated .ts file fails `next build` under strict
  // type-checking and triggers the TypeScript bootstrap in a JS-only host.
  assert.ok(paths.some((path) => path.includes("route.js")));
  assert.ok(!paths.some((path) => path.includes("route.ts")));
  assert.ok(!paths.some((path) => path.includes("renderyes-service")));
  // No handoff: one repository, nothing crosses a boundary.
  assert.ok(!paths.includes("renderyes.handoff.json"));
});

test("generated JavaScript parses", async () => {
  // The failure this exists to prevent is a template with a stray brace,
  // discovered by a host in their own repo on a file they did not write.
  const project = emptyProject();
  const files = planFiles(project, ANSWERS, { role: "both" });
  writePlan(project.root, files);

  const { execFileSync } = await import("node:child_process");
  for (const file of files.filter((candidate) => candidate.path.endsWith(".mjs"))) {
    execFileSync(process.execPath, ["--check", join(project.root, file.path)]);
  }
  for (const file of files.filter((candidate) => candidate.path.endsWith(".json"))) {
    JSON.parse(readFileSync(join(project.root, file.path), "utf8"));
  }
});

test("every template combination parses, and none interpolates an undefined", async () => {
  // The four wizard defects shared one root: tests verified the templates'
  // text, never their output. The input space is small and enumerable — every
  // session style × owner style × topology × origins known-or-not — so every
  // possible output is generated here and syntax-checked, deduplicated by
  // content since most combinations share most files. No future template edit
  // can ship an unparseable combination past this.
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "renderyes-matrix-"));
  const unique = new Map(); // contents → label of one combination producing it

  for (const sessionStyle of ["cookie", "bearer", "anonymous", "custom"]) {
    for (const ownerStyle of ["single-user", "tenant", "nested", "anonymous", "custom"]) {
      for (const topology of ["standalone", "coexist"]) {
        // Coexist splits again by framework: next scaffolds a route handler,
        // anything else the express-shaped mount.
        const frameworks =
          topology === "coexist"
            ? [undefined, { id: "next", bootStyle: "module-await" }]
            : [undefined];
        for (const framework of frameworks) {
          for (const withOrigins of [true, false]) {
            const label = [
              sessionStyle,
              ownerStyle,
              topology,
              framework?.id ?? "no-framework",
              withOrigins ? "origins" : "no-origins",
            ].join("/");
            const answers = {
              ...ANSWERS,
              sessionStyle,
              ownerStyle,
              topology,
              upstreamOrigin: withOrigins ? ANSWERS.upstreamOrigin : undefined,
              frontendOrigin: withOrigins ? ANSWERS.frontendOrigin : undefined,
            };
            const project = { root: dir, manifest: { name: "shop" }, dependencies: {}, framework };
            for (const file of planFiles(project, answers, { role: "both" })) {
              assert.doesNotMatch(
                file.contents,
                /:\s*undefined[,\s)]|\[undefined\]/,
                `${file.path} (${label}) interpolated an undefined`,
              );
              if (file.path.endsWith(".json")) {
                JSON.parse(file.contents);
                continue;
              }
              // JSX needs a transform to parse; dotenv is not JavaScript.
              // Everything else — including route.js — must parse as a module.
              if (file.path.endsWith(".jsx") || file.path.endsWith(".example")) continue;
              if (!unique.has(file.contents)) unique.set(file.contents, `${file.path} (${label})`);
            }
          }
        }
      }
    }
  }

  let sequence = 0;
  for (const [contents, label] of unique) {
    const path = join(dir, `combination-${sequence++}.mjs`);
    writeFileSync(path, contents);
    try {
      execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
    } catch (cause) {
      assert.fail(`${label} does not parse:\n${cause.stderr}`);
    }
  }
  assert.ok(unique.size >= 48, `expected the matrix to cover the space, saw ${unique.size}`);
});

test("refuses the whole plan when any file exists, and writes none of it", () => {
  const project = emptyProject();
  const files = planFiles(project, ANSWERS, { role: "both" });

  // One collision, on the last file in the plan.
  const last = files.at(-1);
  mkdirSync(join(project.root, last.path, ".."), { recursive: true });
  writeFileSync(join(project.root, last.path), "mine");

  const outcome = writePlan(project.root, files);
  assert.deepEqual(outcome.written, []);
  assert.deepEqual(outcome.refused, [last.path]);
  // The point of checking the whole plan first: a conflict on the last file
  // must not leave the earlier ones behind.
  assert.equal(readFileSync(join(project.root, last.path), "utf8"), "mine");
  assert.equal(findCollisions(project.root, files).length, 1);
});

test("a dry run reports the same plan it would write, and writes nothing", () => {
  const project = emptyProject();
  const files = planFiles(project, ANSWERS, { role: "both" });
  const outcome = writePlan(project.root, files, { dryRun: true });
  assert.deepEqual(outcome.written, []);
  assert.deepEqual(outcome.planned, files.map((file) => file.path));
  assert.deepEqual(findCollisions(project.root, files), []);
});

test("the handoff carries the four crossing facts and no secret", () => {
  const parsed = JSON.parse(handoffFile(ANSWERS));
  assert.equal(parsed.catalogId, "shop");
  assert.equal(parsed.serviceUrl, "http://127.0.0.1:4200/");
  // The variable's *name*, so the receiving side knows what to set. Never a
  // value — this file is handed between people.
  assert.equal(parsed.adminTokenEnv, "RENDERYES_ADMIN_TOKEN");
  assert.equal(parsed.auth.style, "cookie");
  assert.deepEqual(parsed.corsRegistered, ["https://shop.example.com"]);
  assert.ok(!JSON.stringify(parsed).includes("change-me"));
});

test("a handoff is only honoured when it says what it is", () => {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-handoff-"));
  const good = join(dir, "good.json");
  writeFileSync(good, handoffFile(ANSWERS));
  assert.equal(readHandoff(good).catalogId, "shop");

  const wrong = join(dir, "wrong.json");
  writeFileSync(wrong, JSON.stringify({ catalogId: "not-a-handoff" }));
  assert.equal(readHandoff(wrong), undefined);

  writeFileSync(join(dir, "broken.json"), "{not json");
  assert.equal(readHandoff(join(dir, "broken.json")), undefined);
  assert.equal(readHandoff(join(dir, "absent.json")), undefined);
});

test("resolveSession fails closed, with one greppable local exception", () => {
  const service = standaloneService(ANSWERS);
  // Doctrine: a default here would be a guess about who is asking.
  assert.match(service, /throw new UnauthenticatedError\(/);
  // The exception exists so the wizard can prove the pipeline once, and it is
  // an env var rather than a permissive default nobody notices.
  assert.match(service, /RENDERYES_DEV_SESSION/);
  assert.match(service, /Never set it in production/);
});

test("a standalone service always writes CORS; the boot step precedes listen", () => {
  const service = standaloneService(ANSWERS);
  // Cross-origin by construction, so this is not the optional case.
  assert.match(service, /allowedOrigins: \["https:\/\/shop\.example\.com"\]/);
  const restore = service.indexOf("restorePublishedCatalogs");
  const listen = service.indexOf(".listen(");
  assert.ok(restore > 0 && listen > restore, "restore must come before listen");
});

test("the tools tier is never among the packages to install", () => {
  for (const role of ["frontend", "backend", "both"]) {
    const packages = packagesFor(role);
    assert.ok(!packages.includes("@renderyes/catalog-review"));
    assert.ok(!packages.includes("@renderyes/init"));
  }
  assert.ok(packagesFor("backend").includes("@renderyes/server"));
  assert.ok(packagesFor("frontend").includes("@renderyes/react"));
});

test("the dev-session fallback is reachable, and fail-closed holds without it", async () => {
  // The bug this exists for: the placeholder *called* an undefined function, so
  // a ReferenceError fired before the fallback below it could run. That made
  // the fallback dead code and the tool unable to prove the pipeline it had
  // just scaffolded — the wizard's own final step, defeated by its own output.
  //
  // Every other test here passed while that was broken, because none of them
  // ran the generated code. This one does.
  for (const sessionStyle of ["cookie", "bearer", "custom"]) {
    const source = standaloneService({ ...ANSWERS, sessionStyle });
    const start = source.indexOf("async function resolveSession");
    const end = source.indexOf("\n}", source.indexOf("throw new UnauthenticatedError(")) + 2;
    // Evaluated out of its module, so the class it throws has to be handed in.
    class UnauthenticatedError extends Error {}
    const build = () =>
      new Function(
        "request",
        "UnauthenticatedError",
        `${source.slice(start, end)}; return resolveSession(request);`,
      ).bind(null);
    const call = (request) => build()(request, UnauthenticatedError);

    delete process.env.RENDERYES_DEV_SESSION;
    await assert.rejects(
      () => call({}),
      /No session/,
      `${sessionStyle}: must fail closed with no dev variable set`,
    );

    process.env.RENDERYES_DEV_SESSION = "dev-user";
    const session = await call({});
    assert.equal(session.userId, "dev-user", `${sessionStyle}: fallback must be reachable`);
    delete process.env.RENDERYES_DEV_SESSION;
  }
});

test("no generated file interpolates a literal undefined", () => {
  // `JSON.stringify(undefined)` is `undefined`, which lands in the output as a
  // bare `undefined` token — under a comment claiming the value was derived.
  // It failed closed, so nothing was exposed; it was still a lie in a file
  // someone is meant to read and trust.
  const withoutEndpoint = { ...ANSWERS, upstreamOrigin: undefined, frontendOrigin: undefined };
  for (const answers of [ANSWERS, withoutEndpoint]) {
    const project = emptyProject();
    for (const file of planFiles(project, answers, { role: "both" })) {
      assert.doesNotMatch(
        file.contents,
        /:\s*undefined[,\s)]|\[undefined\]/,
        `${file.path} interpolated an undefined`,
      );
    }
  }
});

test("the mount scopes forwarded credentials by destination", () => {
  // The one place a real integrator's hand-written mount was more careful than
  // this scaffold. A catalog names where each capability lives, so forwarding a
  // credential to every destination it *could* name hands whoever publishes the
  // catalog a say in where a visitor's token goes.
  const service = standaloneService(ANSWERS);
  assert.match(service, /resolveHeaders/);
  assert.match(service, /destinationOrigin/);
  assert.match(
    service,
    new RegExp(`destinationOrigin !== ${JSON.stringify(ANSWERS.upstreamOrigin)}`),
  );
});

test("a report never claims nothing is blocking while capping the level", () => {
  // The contradiction: `reachedLevel` stops at a failure *or* an unknown, while
  // the summary counted only failures — so a host saw "Reached: installed",
  // "Nothing blocking", and ticks on every later level.
  const rendered = render([
    { id: "scope-mapping", level: "access", status: "pass", summary: "routed" },
    { id: "catalog-id", level: "installed", status: "unknown", summary: "could not tell" },
  ]);
  assert.match(rendered, /Reached: access — blocked from going further/);
  assert.doesNotMatch(rendered, /Nothing blocking/);
  assert.match(rendered, /could not be determined/);
  assert.match(rendered, /catalog-id/);
});

/**
 * Every relative import a scaffolded file makes must resolve to a file the
 * scaffold actually wrote.
 *
 * The suite checked that templates *parse*, which `publish-ui-catalog.mjs` did
 * while importing `../src/views/index.js` — a flatter layout than the one
 * `planFiles` produces. So the wizard wrote a script, told the host to run it
 * ("re-publish with scripts/publish-ui-catalog.mjs once yours exist"), and the
 * script died on its first import. Parsing proves a file is well-formed; only
 * resolution proves the set is coherent.
 */
test("scaffolded files import each other by paths that exist", () => {
  for (const role of ["backend", "frontend", "both"]) {
    for (const topology of ["coexist", "standalone"]) {
      for (const framework of [{ id: "express" }, { id: "next" }, undefined]) {
      const root = mkdtempSync(join(tmpdir(), `iv-resolve-${role}-`));
      const answers = {
        catalogId: "shop",
        serviceUrl: "http://localhost:3000/api/renderyes",
        adminTokenEnv: "RENDERYES_ADMIN_TOKEN",
        placeholder: "What do you want to see?",
        sessionStyle: "cookie",
        ownerStyle: "single-user",
        topology,
        frontendOrigin: "http://localhost:5173",
        mountPath: "/api/renderyes",
      };
      const files = planFiles({ root, framework }, answers, { role });
      writePlan(root, files, { dryRun: false });
      const written = new Set(files.map((file) => file.path.split("/").join("/")));

      for (const file of files) {
        const directory = file.path.includes("/")
          ? file.path.slice(0, file.path.lastIndexOf("/"))
          : "";
        for (const [, specifier] of file.contents.matchAll(
          /(?:from|import)\s+["'](\.[^"']+)["']/g,
        )) {
          // Resolve the specifier against the importing file's own directory,
          // then compare against what this plan wrote — not against disk, so a
          // stray file from another run cannot make a broken import look fine.
          const parts = [...directory.split("/").filter(Boolean), ...specifier.split("/")];
          const stack = [];
          for (const part of parts) {
            if (part === "." || part === "") continue;
            if (part === "..") stack.pop();
            else stack.push(part);
          }
          const target = stack.join("/");
          assert.ok(
            written.has(target),
            `${role}/${topology}/${framework?.id ?? "none"}: ${file.path} imports "${specifier}" -> ${target}, which the scaffold does not write. Wrote: ${[...written].join(", ")}`,
          );
        }
      }
      }
    }
  }
});

/**
 * The set must be coherent, not just each file well-formed — the same
 * philosophy as the import-resolution test above, applied to the wire.
 *
 * @renderyes/react builds concrete routes from the provider's `serviceUrl`
 * (`${serviceUrl}/api/compose`), and the server handler matches its route
 * table against the pathname it receives. So the pair the scaffold writes —
 * mount path on one side, client serviceUrl on the other — has to cancel out
 * exactly, or no request from the generated frontend can ever reach the
 * generated backend.
 */
const CLIENT_APPENDED_ROUTE = "/api/compose"; // what @renderyes/react appends to serviceUrl

function clientServiceUrlOf(files) {
  const page = files.find((file) => file.path.endsWith("page.jsx"));
  const match = page.contents.match(/serviceUrl: ("[^"]+")/);
  assert.ok(match, "the provider mount must carry a literal serviceUrl");
  return JSON.parse(match[1]);
}

test("standalone: the client URL points at the service root the handler owns", () => {
  const root = mkdtempSync(join(tmpdir(), "iv-coherent-standalone-"));
  const files = planFiles({ root, framework: undefined }, ANSWERS, { role: "both" });
  const serviceUrl = clientServiceUrlOf(files);
  // The standalone service passes every request straight to the handler, so
  // the client must address the origin's root — any path prefix here would
  // produce pathnames the route table has never heard of.
  assert.equal(new URL(serviceUrl).pathname, "/");
  assert.equal(new URL(CLIENT_APPENDED_ROUTE, serviceUrl).pathname, "/api/compose");
});

test("coexist/express: the client's prefix is the mount's prefix, same string", () => {
  const root = mkdtempSync(join(tmpdir(), "iv-coherent-express-"));
  const answers = { ...ANSWERS, topology: "coexist", serviceUrl: "/api/renderyes" };
  const files = planFiles({ root, framework: { id: "express" } }, answers, { role: "both" });
  const serviceUrl = clientServiceUrlOf(files);
  const mount = files.find((file) => file.path === join("src", "renderyes.mjs"));
  // Express strips the app.use() prefix before the handler sees the pathname,
  // so client prefix and mount prefix must be the same string.
  assert.ok(
    mount.contents.includes(`app.use(${JSON.stringify(serviceUrl)}`),
    `mount must be app.use(${JSON.stringify(serviceUrl)}, ...); client says ${serviceUrl}`,
  );
});

test("coexist/next: route directory, stripped prefix and client URL are one string", () => {
  const root = mkdtempSync(join(tmpdir(), "iv-coherent-next-"));
  const answers = { ...ANSWERS, topology: "coexist", serviceUrl: "/api/renderyes" };
  const files = planFiles({ root, framework: { id: "next" } }, answers, { role: "both" });
  const serviceUrl = clientServiceUrlOf(files);

  const route = files.find((file) => file.path.endsWith(join("[...route]", "route.js")));
  assert.ok(route, "a Next host gets a catch-all route.js");
  // app/<mount segments>/[...route]/route.js — the mount path is the directory
  // chain between the app dir and the catch-all.
  const segments = route.path.split("/");
  const mountFromPath = `/${segments.slice(1, segments.indexOf("[...route]")).join("/")}`;
  assert.equal(mountFromPath, serviceUrl);

  // Next hands the handler the *full* pathname, so the route must strip the
  // prefix itself — and strip exactly the prefix the client prepends.
  const declared = route.contents.match(/const MOUNT_PATH = ("[^"]+");/);
  assert.ok(declared, "route.js must declare the mount path it strips");
  const mountPath = JSON.parse(declared[1]);
  assert.equal(mountPath, serviceUrl);
  const arriving = `${serviceUrl}${CLIENT_APPENDED_ROUTE}`;
  assert.equal(arriving.slice(mountPath.length) || "/", "/api/compose");
});

test("the Next route holds its framework contract: no import-time work, no static GET", () => {
  const root = mkdtempSync(join(tmpdir(), "iv-next-contract-"));
  const files = planFiles(
    { root, framework: { id: "next" } },
    { ...ANSWERS, topology: "coexist", serviceUrl: "/api/renderyes" },
    { role: "backend" },
  );
  const route = files.find((file) => file.path.endsWith("route.js")).contents;
  // Next evaluates the module at build time, so nothing may await at import.
  assert.doesNotMatch(route, /^await /m);
  // ...but the replay must still happen, once, before the first request.
  assert.match(route, /restored \?\?= renderYes\.restorePublishedCatalogs\(\)/);
  // Without this, Next prerenders the GET at build time and freezes it.
  assert.match(route, /export const dynamic = "force-dynamic";/);
  assert.match(route, /export const GET = route;/);
  assert.match(route, /export const POST = route;/);
});

test("no catalog store is anchored to import.meta.url, which builds relocate", () => {
  // `new URL("./data/", import.meta.url)` inside a built Next route resolves
  // into .next/, wiped on every rebuild — published catalogs silently vanish.
  // Bundlers also rewrite `new URL(..., import.meta.url)` at build time.
  for (const framework of [undefined, { id: "express" }, { id: "next" }]) {
    const root = mkdtempSync(join(tmpdir(), "iv-store-"));
    const topology = framework ? "coexist" : "standalone";
    for (const file of planFiles({ root, framework }, { ...ANSWERS, topology }, { role: "backend" })) {
      assert.doesNotMatch(
        file.contents,
        /new URL\([^)]*import\.meta\.url/,
        `${file.path} anchors a path to import.meta.url`,
      );
      if (file.contents.includes("createFileCatalogStore")) {
        assert.match(file.contents, /createFileCatalogStore\(join\(process\.cwd\(\)/);
      }
    }
  }
});

test("the example view is exemplary against the component contract", () => {
  const example = exampleView();
  // Registered the way a manual array requires: defineHostComponent takes the
  // contract and the component together. defineView is the spec-plus-default-
  // export convention and produces nothing ViewProvider can render from here.
  assert.match(example, /defineHostComponent\(\{/);
  assert.doesNotMatch(example, /defineView\(/);
  // The three declarations the contract asks for.
  assert.match(example, /accessibility:\s*\{/);
  assert.match(example, /accepts: \[\{ shape: "collection" \}\]/);
  assert.match(example, /props: defineProps\(\{/);
  // The invariants the README documents: an honest count, never the page size,
  // and ungrounded data disclosed rather than presented as authoritative.
  assert.match(example, /countBeyondPage\(/);
  assert.doesNotMatch(example, /\{rows\.length\}/);
  assert.match(example, /sources/);
  assert.match(example, /state === "pending"/);
});

/**
 * The identity the scaffold writes must be one identity.
 *
 * Three generated pieces read the visitor's identity — resolveSession's dev
 * stub, the host adapter's isAuthenticated, and resolveViewOwner — and the
 * class of bug where they disagree (a nested owner reading session.user.id
 * from a flat { userId } stub) has shipped twice. Text assertions cannot see
 * it, so this test *executes* the extracted functions against each other, for
 * every identity style × topology the templates can emit.
 */
function extractBraced(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing "${marker}"`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated "${marker}"`);
}

function extractStatement(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing "${marker}"`);
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if ("({[".includes(character)) depth++;
    else if (")}]".includes(character)) depth--;
    else if (character === ";" && depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated "${marker}"`);
}

test("every identity style × topology: the scaffold's own dev session satisfies its own resolvers", async (t) => {
  const mounts = {
    standalone: (answers) => standaloneService(answers),
    express: (answers) => expressMount(answers),
    next: (answers) => nextRouteHandler(answers),
  };

  for (const [topology, generate] of Object.entries(mounts)) {
    for (const sessionStyle of ["cookie", "bearer", "anonymous", "custom"]) {
      for (const ownerStyle of ["single-user", "tenant", "nested", "anonymous", "custom"]) {
        const label = `${topology}/${sessionStyle}/${ownerStyle}`;
        const source = generate({ ...ANSWERS, sessionStyle, ownerStyle });
        // An anonymous session forces the anonymous identity — the templates
        // normalize, so the pair can never contradict itself.
        const effectiveOwner = sessionStyle === "anonymous" ? "anonymous" : ownerStyle;

        const resolveSession = new Function(
          `${extractBraced(source, "async function resolveSession")}; return resolveSession;`,
        )();
        const host = new Function(`${extractStatement(source, "const host = {")}; return host;`)();

        process.env.RENDERYES_DEV_SESSION = "dev-user";
        let session;
        try {
          session = await resolveSession({});
        } finally {
          delete process.env.RENDERYES_DEV_SESSION;
        }
        assert.ok(session, `${label}: the dev session must resolve`);

        if (effectiveOwner === "anonymous") {
          // No identity, honestly: unauthenticated, and no owner resolver in
          // the config at all — the server refuses refine/save without one,
          // which is the closed direction.
          assert.equal(host.isAuthenticated(session), false, label);
          assert.ok(!source.includes("\n  resolveViewOwner,"), `${label}: config must omit resolveViewOwner`);
          continue;
        }

        assert.equal(
          host.isAuthenticated(session),
          true,
          `${label}: the dev session must count as signed in`,
        );
        assert.ok(source.includes("\n  resolveViewOwner,"), `${label}: config must set resolveViewOwner`);

        const resolveViewOwner = new Function(
          `${extractStatement(source, "const resolveViewOwner")}; return resolveViewOwner;`,
        )();
        if (effectiveOwner === "custom") {
          // The TODO throws by design — a guess here would be a guess about
          // who may read whose views.
          assert.throws(() => resolveViewOwner(session), /not implemented/, label);
          continue;
        }
        const owner = resolveViewOwner(session);
        assert.equal(typeof owner, "string", label);
        assert.ok(owner.length > 0, `${label}: owner key must be non-empty`);
        assert.ok(
          !owner.includes("undefined"),
          `${label}: owner key "${owner}" leaked an undefined identity field`,
        );
      }
    }
  }
});

/**
 * The admin gate every template writes must be constant-time.
 *
 * The scaffold used to emit `headers.get(ADMIN_TOKEN_HEADER) === process.env.X`,
 * and `===` short-circuits on the first mismatched byte — so the routes it
 * gates (publish, rollback, model spending) leaked the token one byte at a
 * time through response timing. Scaffolds teach habits: whatever these
 * templates emit is what every host's requireAdmin looks like forever.
 */
const MOUNT_TEMPLATES = Object.freeze({
  standalone: () => standaloneService(ANSWERS),
  manual: () => manualMount({ ...ANSWERS, topology: "coexist" }),
  express: () => expressMount({ ...ANSWERS, topology: "coexist" }),
  next: () => nextRouteHandler({ ...ANSWERS, topology: "coexist" }),
});

test("every mount compares the admin token in constant time, never with ===", () => {
  for (const [label, generate] of Object.entries(MOUNT_TEMPLATES)) {
    const source = generate();
    assert.match(
      source,
      /import \{ timingSafeEqual \} from "node:crypto";/,
      `${label}: the gate needs its import`,
    );
    assert.match(source, /timingSafeEqual\(/, `${label}: no constant-time compare`);
    // The whole point: no short-circuiting compare against the env token, in
    // any spelling that reads the environment on either side of a ===.
    assert.doesNotMatch(source, /===\s*process\.env/, `${label}: === token compare`);
    assert.doesNotMatch(source, /process\.env\.\w+\s*===/, `${label}: === token compare`);
    assert.match(
      source,
      /requireAdmin: \(request\) => isAdminToken\(request\.headers\.get\(ADMIN_TOKEN_HEADER\)\)/,
      `${label}: requireAdmin must route through the constant-time gate`,
    );
    // The habit only spreads with its reason attached.
    assert.match(source, /Constant-time/, `${label}: the gate must say why`);
  }
});

test("the generated admin gate accepts the token, and fails closed everywhere else", async () => {
  // Text assertions prove the shape; this executes the emitted function, the
  // same way the identity test below runs the resolvers — a template can
  // contain `timingSafeEqual` and still be wrong about lengths or emptiness.
  const { timingSafeEqual } = await import("node:crypto");
  for (const [label, generate] of Object.entries(MOUNT_TEMPLATES)) {
    const isAdminToken = new Function(
      "timingSafeEqual",
      `${extractBraced(generate(), "function isAdminToken")}; return isAdminToken;`,
    )(timingSafeEqual);

    try {
      process.env[ANSWERS.adminTokenEnv] = "correct-token";
      assert.equal(isAdminToken("correct-token"), true, `${label}: the right token must pass`);
      // Same length, wrong bytes — the case a length check alone waves through.
      assert.equal(isAdminToken("crooked-token"), false, `${label}: same-length mismatch`);
      assert.equal(isAdminToken("short"), false, `${label}: a length mismatch must not throw`);
      // headers.get() on an absent header is null, not "".
      assert.equal(isAdminToken(null), false, `${label}: missing header`);
      assert.equal(isAdminToken(""), false, `${label}: empty header`);

      // An unset token must reject every request — never compare against
      // undefined coerced to "undefined", and never let "" match "".
      delete process.env[ANSWERS.adminTokenEnv];
      assert.equal(isAdminToken("correct-token"), false, `${label}: unset env`);
      assert.equal(isAdminToken("undefined"), false, `${label}: unset env vs "undefined"`);
      assert.equal(isAdminToken(""), false, `${label}: unset env vs empty header`);
      assert.equal(isAdminToken(null), false, `${label}: unset env vs missing header`);

      process.env[ANSWERS.adminTokenEnv] = "";
      assert.equal(isAdminToken(""), false, `${label}: empty env vs empty header`);
      assert.equal(isAdminToken("anything"), false, `${label}: empty env`);
    } finally {
      delete process.env[ANSWERS.adminTokenEnv];
    }
  }
});

/**
 * Detection promises support; this is the list that can keep it.
 *
 * The wizard detects four backend frameworks and writes two mount templates.
 * A fastify or hono host defaulted to `coexist` on detection alone and was
 * handed the Express file — `app.use` with a Node req/res handler, which
 * fastify has no equivalent for and hono means differently. Nothing failed
 * until the host ran it.
 */
test("only a framework with a mount template defaults to mounting", async () => {
  const { hasMountTemplate, MOUNTABLE_FRAMEWORKS } = await import("../src/scaffold.mjs");
  const { conductInterview } = await import("../src/interview.mjs");

  assert.deepEqual([...MOUNTABLE_FRAMEWORKS].sort(), ["express", "next"]);
  for (const id of ["next", "express"]) assert.ok(hasMountTemplate(id), `${id} is templated`);
  for (const id of ["fastify", "hono", undefined]) {
    assert.equal(hasMountTemplate(id), false, `${id} has no mount template`);
  }

  // Non-interactive so the default is what gets taken, not a prompt.
  for (const [framework, expected] of [
    ["next", "coexist"],
    ["express", "coexist"],
    ["fastify", "standalone"],
    ["hono", "standalone"],
  ]) {
    const answers = await conductInterview(
      { root: "/tmp/x", framework: { id: framework }, manifest: { name: "host" } },
      { yes: true },
      { interactive: false },
    );
    assert.equal(
      answers.topology,
      expected,
      `${framework} should default to ${expected}, got ${answers.topology}`,
    );
  }
});

/**
 * The seam that lets a host's own components become half of a bundle.
 *
 * Without it the headless route can only publish the capability catalog, and
 * the UI catalog goes as a second call under an id typed a second time — which
 * is the mismatch that publishes cleanly and resolves nothing at compose. The
 * two ways it could quietly stop working are a missing `--emit` and an admin
 * token demanded for a step that talks to nothing, so both are pinned.
 */
test("the publish script can write its manifest instead of posting it", () => {
  const root = mkdtempSync(join(tmpdir(), "iv-emit-"));
  const answers = {
    catalogId: "shop",
    sourceLabel: "Shop",
    serviceUrl: "http://localhost:3000/api/renderyes",
    adminTokenEnv: "RENDERYES_ADMIN_TOKEN",
    placeholder: "What do you want to see?",
    sessionStyle: "cookie",
    ownerStyle: "single-user",
    topology: "coexist",
    mountPath: "/api/renderyes",
  };
  const files = planFiles({ root, framework: { id: "next" } }, answers, { role: "both" });
  const script = files.find((file) => file.path.endsWith("publish-ui-catalog.mjs"));
  assert.ok(script, "no publish script was scaffolded");

  assert.match(script.contents, /--emit/);
  assert.match(script.contents, /--ui-manifest/);
  // Writing a file reaches no server, so neither the mount URL nor the admin
  // token may gate it. Both guards must name `emitTo`.
  assert.match(script.contents, /if \(!adminToken && !emitTo\)/);
  assert.match(script.contents, /if \(!emitTo\) \{\n\s+console\.error\(/);
});

/**
 * The scaffolded publish script, actually executed.
 *
 * Everything about this file was checked except whether it runs. The suite
 * asserted the template parses, then that its relative imports resolve to files
 * the scaffold writes — and it passed both while being unrunnable, because
 * `views/index.js` imports a `.jsx` component and Node refuses that extension
 * outright. `ERR_UNKNOWN_FILE_EXTENSION`, a stack trace, no instruction. Every
 * doc and wizard message said to run it with bare `node`.
 *
 * So: run it. The stub stands in for `@renderyes/site-sdk` — this is testing
 * the loader boundary, not the manifest builder, and the real package would
 * drag React into a test suite that deliberately has no dependencies.
 */
test("the scaffolded publish script says what to do when Node cannot load JSX", () => {
  const root = mkdtempSync(join(tmpdir(), "iv-runscript-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "host", private: true, type: "module" }),
  );
  const answers = {
    catalogId: "shop",
    sourceLabel: "Shop",
    serviceUrl: "http://localhost:3000/api/renderyes",
    adminTokenEnv: "RENDERYES_ADMIN_TOKEN",
    placeholder: "What do you want to see?",
    sessionStyle: "cookie",
    ownerStyle: "single-user",
    topology: "coexist",
    mountPath: "/api/renderyes",
  };
  writePlan(root, planFiles({ root, framework: { id: "next" } }, answers, { role: "both" }), {
    dryRun: false,
  });

  // Stubs for the two packages the script and the views index import. A missing
  // package is deliberately *not* caught by the loader guard — that is "install
  // your dependencies", a different problem with a different answer — so both
  // have to resolve before the `.jsx` failure is the one under test.
  const stub = (name, body) => {
    const dir = join(root, "node_modules", "@renderyes", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: `@renderyes/${name}`, type: "module", main: "index.js" }),
    );
    writeFileSync(join(dir, "index.js"), body);
  };
  stub(
    "site-sdk",
    "export const defineSite = (s) => s;\nexport const defineSurface = (s) => s;\nexport const toSiteManifest = (s) => s;\n",
  );
  stub(
    "starter-catalog",
    ["createDataTable", "createDetailPanel", "createMetricCard", "createRecordWithLines"]
      .map((name) => `export const ${name} = () => ({ definition: { id: "${name}" } });`)
      .join("\n") + "\n",
  );

  const run = spawnSync(process.execPath, [join(root, "scripts", "publish-ui-catalog.mjs"), "--emit", "ui.json"], {
    cwd: root,
    encoding: "utf8",
  });

  // Exit 2 — a refusal it can explain, not a crash.
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /Node cannot load JSX/);
  // The remedy, with the caller's own arguments carried through, so it is a
  // command to paste rather than one to reconstruct.
  assert.match(run.stderr, /npx tsx scripts\/publish-ui-catalog\.mjs --emit ui\.json/);
  // And none of the raw failure survives into what the host reads.
  assert.doesNotMatch(run.stderr, /ERR_UNKNOWN_FILE_EXTENSION/);
});

test("the scaffolded publish script refuses a bare view spec instead of publishing it", () => {
  // `views.map((view) => view.definition ?? view)` filed anything without a
  // `.definition` as though it were a component definition. A `defineView`
  // spec has no renderer, so what got published was the wrong shape — accepted
  // here, rejected somewhere else, or worse, accepted everywhere and rendering
  // nothing. The fallback was silent, which is the part that made it costly.
  const root = mkdtempSync(join(tmpdir(), "iv-badshape-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "host", private: true, type: "module" }),
  );
  const answers = {
    catalogId: "shop",
    sourceLabel: "Shop",
    serviceUrl: "http://localhost:3000/api/renderyes",
    adminTokenEnv: "RENDERYES_ADMIN_TOKEN",
    placeholder: "What do you want to see?",
    sessionStyle: "cookie",
    ownerStyle: "single-user",
    topology: "coexist",
    mountPath: "/api/renderyes",
  };
  writePlan(root, planFiles({ root, framework: { id: "next" } }, answers, { role: "both" }), {
    dryRun: false,
  });

  const stub = (name, body) => {
    const dir = join(root, "node_modules", "@renderyes", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: `@renderyes/${name}`, type: "module", main: "index.js" }),
    );
    writeFileSync(join(dir, "index.js"), body);
  };
  stub(
    "site-sdk",
    "export const defineSite = (s) => s;\nexport const defineSurface = (s) => s;\nexport const toSiteManifest = (s) => s;\n",
  );
  // The scaffolded views index imports a `.jsx` component, and Node refuses
  // that extension before any of this file's code runs — the loader guard is a
  // separate test. Replaced with plain JS exporting one wrong shape, so what
  // fails here is the shape check under test.
  const index = planFiles({ root, framework: { id: "next" } }, answers, { role: "both" }).find(
    (file) => file.path.endsWith(join("views", "index.js")),
  );
  assert.ok(index, "no views index was scaffolded");
  writeFileSync(
    join(root, index.path),
    'export const views = [{ id: "Spec", dataSlots: { rows: {} } }];\n',
  );

  const run = spawnSync(
    process.execPath,
    [join(root, "scripts", "publish-ui-catalog.mjs"), "--emit", "ui.json"],
    { cwd: root, encoding: "utf8" },
  );

  assert.notEqual(run.status, 0, "a wrong component shape must not publish");
  assert.match(
    `${run.stderr}${run.stdout}`,
    /is not a registered component/,
    `expected the shape to be named, got: ${run.stderr || run.stdout}`,
  );
  // Names which entry, and what to export instead.
  assert.match(`${run.stderr}${run.stdout}`, /Spec/);
  assert.match(`${run.stderr}${run.stdout}`, /defineHostComponent/);
});

/**
 * No message anywhere may tell a host to run that script with bare `node`.
 *
 * Three docs and two wizard messages did, which is how an unrunnable script
 * stayed documented as the way to publish a UI catalog.
 */
test("nothing instructs bare node for the publish script", () => {
  const roots = [
    join(import.meta.dirname, "..", "src"),
    join(import.meta.dirname, "..", "bin"),
  ];
  for (const dir of roots) {
    for (const entry of readdirSync(dir)) {
      const text = readFileSync(join(dir, entry), "utf8");
      assert.doesNotMatch(
        text,
        /(?<!npx tsx )(?<!tsx )\bnode scripts\/publish-ui-catalog/,
        `${entry} tells a host to run the publish script with bare node`,
      );
    }
  }
});

/**
 * The standalone service's one dependency, in the directory that needs it.
 *
 * The service runs from its own folder with its own package.json, and the
 * installer ran at the host root — so `@renderyes/server` landed where the
 * service could not import it and `npm start` failed on its first line, after a
 * wizard run that reported success.
 *
 * The manifest also declared `"@renderyes/server": "^0.1.0"`, which cannot
 * resolve: every build that exists is a timestamped prerelease
 * range the scaffold had guessed rather than a published version. So the
 * dependency was in the wrong place *and* unresolvable in the right one.
 */
test("the standalone manifest declares no version it cannot resolve", () => {
  const answers = {
    catalogId: "shop",
    sourceLabel: "Shop",
    serviceUrl: "http://localhost:4000",
    adminTokenEnv: "RENDERYES_ADMIN_TOKEN",
    placeholder: "What?",
    sessionStyle: "cookie",
    ownerStyle: "single-user",
    topology: "standalone",
    frontendOrigin: "http://localhost:5173",
    mountPath: "/api/renderyes",
  };
  const root = mkdtempSync(join(tmpdir(), "iv-standalone-"));
  const files = planFiles({ root, framework: undefined }, answers, { role: "both" });
  const manifest = files.find((file) => file.path.endsWith("renderyes-service/package.json"));
  assert.ok(manifest, "no standalone package.json was planned");

  const parsed = JSON.parse(manifest.contents);
  assert.equal(parsed.scripts.start, "node server.mjs");
  // The installer writes the version that actually resolved. Anything hardcoded
  // here is a guess about a registry this package cannot see.
  assert.equal(
    parsed.dependencies,
    undefined,
    "a hardcoded dependency range cannot match the timestamped prereleases that exist",
  );
});

test("installPackages can target the service directory rather than the repo root", () => {
  const root = mkdtempSync(join(tmpdir(), "iv-into-"));
  const service = join(root, "renderyes-service");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(service, { recursive: true });

  // Records the directory it was invoked in.
  const fake = join(root, "bin", "npm");
  writeFileSync(fake, `#!/bin/sh\npwd > ${JSON.stringify(join(root, "cwd.txt"))}\n`);
  chmodSync(fake, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${join(root, "bin")}:${previousPath}`;
  try {
    const result = installPackages(
      { root, packageManager: "npm", dependencies: {} },
      "backend",
      { into: service, packages: ["@renderyes/server"] },
    );
    assert.equal(result.ok, true, result.summary);
    // Named in the summary, so a host can see where it went.
    assert.match(result.summary, /into .*renderyes-service/);
  } finally {
    process.env.PATH = previousPath;
  }

  // realpath: macOS reports /private/var for /var.
  assert.equal(
    realpathSync(readFileSync(join(root, "cwd.txt"), "utf8").trim()),
    realpathSync(service),
  );
});

/**
 * Only Express gets the Express file.
 *
 * `hasMountTemplate` was added to stop fastify and hono receiving
 * `app.use(path, handler)` — a method fastify does not have and hono does not
 * mean. But it only steered the *interview's default topology*, and a host
 * passing `--topology coexist`, or arriving through a handoff, walked straight
 * past it into the same bare `else`. So did a host whose framework was not
 * detected at all.
 */
test("a non-Express host is never handed the Express mount", () => {
  const answers = {
    catalogId: "shop",
    sourceLabel: "Shop",
    serviceUrl: "http://localhost:3000/api/renderyes",
    adminTokenEnv: "RENDERYES_ADMIN_TOKEN",
    placeholder: "What?",
    sessionStyle: "cookie",
    ownerStyle: "single-user",
    mountPath: "/api/renderyes",
    topology: "coexist",
  };
  const mountFor = (framework) =>
    planFiles({ root: "/tmp/does-not-matter", framework }, answers, { role: "backend" })[0];

  // The one that has a template keeps it.
  assert.match(mountFor({ id: "express" }).contents, /export async function mountRenderYes\(app\)/);

  for (const framework of [{ id: "fastify" }, { id: "hono" }, undefined]) {
    const file = mountFor(framework);
    const label = framework?.id ?? "undetected";
    // Never the Express shape.
    assert.doesNotMatch(file.contents, /app\.use\(/, `${label} was handed app.use()`);
    assert.doesNotMatch(file.contents, /mountRenderYes/, `${label} was handed the Express mount`);
    // Always something runnable: the handler, and the boot step that replays
    // catalogs — omitting which makes the first request after a restart look
    // like a publish that never happened.
    assert.match(file.contents, /export const handler = createViewHttpHandler/, label);
    assert.match(file.contents, /export async function startRenderYes/, label);
    // And the one decision it cannot make, written out both ways.
    assert.match(file.contents, /TODO: attach `handler` at \/api\/renderyes/, label);
    assert.match(file.contents, /c\.req\.raw/, `${label} lacks the Request\/Response shape`);
    assert.match(file.contents, /toNodeHandler/, `${label} lacks the Node req\/res shape`);
    // Named, so the host knows why they got the manual file rather than code.
    if (framework) assert.match(file.why, new RegExp(`${framework.id} has no template`));
  }
});

/**
 * The outage the third install round produced, as a test.
 *
 * A Payload host keeps its root layout inside `(frontend)`, so the scaffolded
 * page must be moved there to render at all. The next run then found
 * `src/app/renderyes/page.jsx` missing — because it is — and wrote it again.
 * Next refuses two parallel routes resolving to `/renderyes`, so every route
 * in the application 500s, the newspaper's homepage included. Reproduced twice
 * by the tester, interactively and with `--yes`.
 */
function nextProjectWithGroups(groups) {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-routes-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "paper" }));
  mkdirSync(join(dir, "src", "app"), { recursive: true });
  for (const group of groups) {
    mkdirSync(join(dir, "src", "app", group), { recursive: true });
    writeFileSync(join(dir, "src", "app", group, "layout.tsx"), "export default function L(){}");
  }
  return { root: dir, manifest: { name: "paper" }, dependencies: {}, framework: { id: "next" } };
}

test("a page the host moved into a route group is not written a second time", () => {
  const project = nextProjectWithGroups(["(frontend)", "(payload)"]);
  const files = planFiles(project, ANSWERS, { role: "frontend" });
  writePlan(project.root, files);

  // The host moves it where it renders — the only way to get a root layout in
  // a Payload app — and deletes what the wizard wrote.
  const moved = join(project.root, "src", "app", "(frontend)", "renderyes");
  mkdirSync(moved, { recursive: true });
  writeFileSync(join(moved, "page.jsx"), readFileSync(join(project.root, "src", "app", "(renderyes)", "renderyes", "page.jsx")));
  rmSync(join(project.root, "src", "app", "(renderyes)"), { recursive: true, force: true });

  const second = planFiles(project, ANSWERS, { role: "frontend" });
  const report = collisionReport(project.root, second);
  const page = report.find((entry) => entry.planned.endsWith(join("renderyes", "page.jsx")));
  assert.ok(page, "the page must be reported as already present");
  assert.equal(page.sameRoute, true);
  assert.equal(page.existing, join("src", "app", "(frontend)", "renderyes", "page.jsx"));

  const fresh = second.filter((file) => !new Set(report.map((e) => e.planned)).has(file.path));
  assert.equal(
    fresh.some((file) => file.path.endsWith("page.jsx")),
    false,
    "a second page serving /renderyes is what takes the host down",
  );
});

test("a host whose root layout is in one group gets the page in that group", () => {
  const project = nextProjectWithGroups(["(site)"]);
  const files = planFiles(project, ANSWERS, { role: "frontend" });
  const page = files.find((file) => file.path.endsWith("page.jsx"));
  assert.equal(page.path, join("src", "app", "(site)", "renderyes", "page.jsx"));
  assert.equal(
    files.some((file) => file.path.endsWith("layout.jsx")),
    false,
    "the host's own layout serves it; writing another would be a second root",
  );
});

test("a host with several root layouts gets a group and a layout of its own", () => {
  const project = nextProjectWithGroups(["(frontend)", "(payload)"]);
  const files = planFiles(project, ANSWERS, { role: "frontend" });
  assert.equal(
    files.find((file) => file.path.endsWith("page.jsx")).path,
    join("src", "app", "(renderyes)", "renderyes", "page.jsx"),
  );
  const layout = files.find((file) => file.path.endsWith("layout.jsx"));
  assert.equal(layout.path, join("src", "app", "(renderyes)", "layout.jsx"));
  // The failure this prevents: a 200 with an empty shell and
  // NEXT_MISSING_ROOT_TAGS, which every status-code check reads as healthy.
  assert.match(layout.contents, /<html/);
  assert.match(layout.contents, /<body/);
});

test("a host with a root layout keeps the ungrouped path", () => {
  const dir = mkdtempSync(join(tmpdir(), "renderyes-routes-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "paper" }));
  mkdirSync(join(dir, "src", "app"), { recursive: true });
  writeFileSync(join(dir, "src", "app", "layout.tsx"), "export default function L(){}");
  const files = planFiles(
    { root: dir, manifest: {}, dependencies: {}, framework: { id: "next" } },
    ANSWERS,
    { role: "frontend" },
  );
  assert.equal(
    files.find((file) => file.path.endsWith("page.jsx")).path,
    join("src", "app", "renderyes", "page.jsx"),
  );
});

test("route paths ignore groups and private folders", () => {
  const app = join("src", "app");
  assert.equal(nextRouteOf(join(app, "renderyes", "page.jsx"), app), "/renderyes");
  assert.equal(nextRouteOf(join(app, "(frontend)", "renderyes", "page.tsx"), app), "/renderyes");
  assert.equal(nextRouteOf(join(app, "(a)", "(b)", "renderyes", "page.js"), app), "/renderyes");
  assert.equal(nextRouteOf(join(app, "_private", "renderyes", "page.jsx"), app), undefined);
  assert.equal(nextRouteOf(join(app, "renderyes", "route.js"), app), undefined);
  assert.equal(nextRouteOf(join("other", "renderyes", "page.jsx"), app), undefined);
});

/**
 * The provider the walk promised to compose with.
 *
 * The walk collects a sample question and says it composes it once to prove the
 * wiring, then scaffolded no `planProviders` at all — so the compose it had just
 * promised could only refuse, reported as a warning about configuration the
 * wizard itself had declined to offer.
 */
test("a chosen plan provider is written as a name, never a key", () => {
  const project = emptyProject();
  const answers = {
    ...ANSWERS,
    planProvider: { id: "openai", apiKeyEnv: "OPENAI_API_KEY", model: "gpt-5.6" },
  };
  for (const topology of ["standalone", "coexist"]) {
    const files = planFiles({ ...project, framework: { id: "express" } }, { ...answers, topology }, {
      role: "backend",
    });
    const server = files.find((file) => file.contents.includes("createViewServer"));
    // Anchored and uncommented. `/planProviders: \[/` alone also matches the
    // commented example the no-provider branch writes, so it passed against a
    // scaffold that configured nothing.
    assert.match(server.contents, /^\s*planProviders: \[$/m);
    assert.match(server.contents, /^\s*apiKeyEnv: "OPENAI_API_KEY",$/m);
    assert.match(server.contents, /model: "gpt-5\.6"/);
    // The rule the whole design rests on: a name, never a value.
    assert.doesNotMatch(server.contents, /apiKey:\s*["'`]/);
  }
});

test("no provider chosen writes the gap and how to close it, not silence", () => {
  const files = planFiles(
    { ...emptyProject(), framework: { id: "express" } },
    { ...ANSWERS, topology: "coexist" },
    { role: "backend" },
  );
  const server = files.find((file) => file.contents.includes("createViewServer"));
  assert.match(server.contents, /No plan provider chosen/);
  assert.match(server.contents, /planProviders: \[\{ id: "openai"/);
  assert.doesNotMatch(
    server.contents,
    /^\s*planProviders: \[$/m,
    "an unchosen provider must not scaffold a live config",
  );
});
