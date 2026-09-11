import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_HOST_DOCS,
  SHIPPED_HOST_DOCS,
  danglingDocLinks,
  rewriteCrossSetLinks,
} from "../scripts/copy-host-docs.mjs";

/**
 * The guides live at the repo root, in a directory no package owns, so they
 * shipped in nothing while the READMEs told consumers to read them. A `prepack`
 * step copies a subset in — and a copy step is exactly the kind of thing that
 * silently stops working, so these assertions run in CI rather than at publish.
 *
 * Two failure modes, both quiet without a test: a doc gets renamed and the copy
 * ships nothing, or a doc gains a link to something outside the shipped set and
 * the tarball's own documentation points at a file it does not contain.
 */

const here = dirname(fileURLToPath(import.meta.url));
const hostDocs = resolve(here, "../../../docs");
const packageJson = JSON.parse(
  await readFile(resolve(here, "../package.json"), "utf8"),
);

test("every doc any package ships exists at its source path", async () => {
  const present = await readdir(hostDocs);
  for (const [pkg, names] of Object.entries(PACKAGE_HOST_DOCS)) {
    for (const name of names) {
      assert.ok(
        present.includes(name),
        `${name} is in ${pkg}'s host-doc set but not in docs/ — the copy would ship nothing`,
      );
    }
  }
});

/**
 * Link-closure is checked per package, not once, because the sets differ: a
 * link to INTEGRATION.md resolves inside `server`'s tarball and dangles inside
 * `react`'s. The source keeps the relative link and the copy step rewrites it
 * to an absolute URL for a package that lacks the target, so what has to be
 * closed is the rewritten copy — which is what actually ships.
 */
test("every package's shipped set is link-closed after rewriting", async () => {
  for (const [pkg, names] of Object.entries(PACKAGE_HOST_DOCS)) {
    for (const name of names) {
      const source = await readFile(resolve(hostDocs, name), "utf8");
      const { markdown } = rewriteCrossSetLinks(source, names);
      assert.deepEqual(
        danglingDocLinks(markdown, names),
        [],
        `${name} still links to a document @renderyes/${pkg} does not ship after the copy step ` +
          "rewrote what it could. Add it to that package's set, or name the package carrying it.",
      );
    }
  }
});

/**
 * A rewritten link points at the forge, so nothing checks it at runtime: the
 * target has to exist in docs/ or the tarball ships a 404.
 */
test("every cross-set link names a document that exists", async () => {
  const present = await readdir(hostDocs);
  for (const [pkg, names] of Object.entries(PACKAGE_HOST_DOCS)) {
    for (const name of names) {
      const source = await readFile(resolve(hostDocs, name), "utf8");
      const { rewritten } = rewriteCrossSetLinks(source, names);
      for (const href of rewritten) {
        assert.ok(
          present.includes(href),
          `${name} (shipped in ${pkg}) links to ${href}, which is not in docs/ — the rewritten ` +
            "absolute URL would 404.",
        );
      }
    }
  }
});

/**
 * `ARCHITECTURE.md` and `PRODUCT.md` are in no package's set on purpose. The
 * rewrite must not quietly turn a link to one into a working absolute URL, or
 * a shipped guide could send an integrating host to a maintainer document —
 * it is left relative so the dangling check rejects the copy instead.
 */
test("a link to a repository-only doc is refused, not rewritten", () => {
  const set = PACKAGE_HOST_DOCS.server;
  for (const name of ["ARCHITECTURE.md", "PRODUCT.md"]) {
    const { markdown, rewritten } = rewriteCrossSetLinks(`see [why](${name})`, set);
    assert.deepEqual(rewritten, [], `${name} must not be rewritten to an absolute URL`);
    assert.deepEqual(
      danglingDocLinks(markdown, set),
      [name],
      `${name} must still read as dangling so copyHostDocs throws`,
    );
  }
});

test("every package with a host-doc set ships and populates it", async () => {
  for (const pkg of Object.keys(PACKAGE_HOST_DOCS)) {
    const manifest = JSON.parse(
      await readFile(resolve(here, "../..", pkg, "package.json"), "utf8"),
    );
    assert.ok(
      manifest.files.includes("docs"),
      `@renderyes/${pkg} copies host guides but \`files\` omits docs/, so nothing ships`,
    );
    assert.match(
      manifest.scripts.prepack ?? "",
      /copy-host-docs\.mjs/,
      `@renderyes/${pkg} declares a host-doc set but never runs the copy`,
    );
  }
});

test("package.json actually ships the docs directory", () => {
  assert.ok(
    packageJson.files.includes("docs"),
    "the copy step writes docs/, but `files` does not include it, so nothing ships",
  );
  assert.equal(
    packageJson.scripts.prepack,
    "node scripts/copy-host-docs.mjs",
    "the copy must run from prepack",
  );
  // Never `prepare`: that also runs on a consumer's install, and a library has
  // no business running scripts on someone else's machine.
  assert.equal(packageJson.scripts.prepare, undefined);
});

test("shipped docs are registry-agnostic and keep tokens out of the project", async () => {
  for (const name of SHIPPED_HOST_DOCS) {
    const markdown = await readFile(resolve(hostDocs, name), "utf8");
    // These guides go to arbitrary hosts. A vendor's registry name, or a
    // wrapper script only one organization has, turns a general instruction
    // into someone else's infrastructure.
    for (const vendorTerm of [/CodeArtifact/i, /codeartifact-login/i]) {
      assert.doesNotMatch(markdown, vendorTerm, `${name} names a specific registry vendor`);
    }
  }
  // The packages install from public npm with no credential, so the only token
  // in the system is the host's own admin token. A quickstart that reintroduces
  // an install-time credential has reintroduced someone else's infrastructure.
  const quickstart = await readFile(resolve(hostDocs, "QUICKSTART.md"), "utf8");
  assert.doesNotMatch(quickstart, /\.npmrc/, "the quickstart names an install-time registry credential");
  assert.match(quickstart, /host admin token/i);
  assert.match(
    quickstart,
    /installing successfully tells you nothing\s+about it/i,
    "the quickstart must keep the distinction that a clean install proves nothing about the admin token",
  );
});

/**
 * The agent brief, and the claims it makes.
 *
 * A doc written for a coding agent is worse than none when it drifts, because
 * an agent believes it — it will not notice that the export it was told to
 * import no longer exists, it will call the function and ship the failure. So
 * every claim in AGENTS.md that can be checked, is.
 *
 * Written from the round-4 failure modes: what a careful integrator actually
 * got wrong, not what the API surface looks like.
 */
test("the agent brief ships, and its checkable claims are still true", async () => {
  const brief = await readFile(resolve(here, "../AGENTS.md"), "utf8");

  // A file that exists in the repository and in no install is the LICENSE
  // mistake; `files` is what decides.
  assert.ok(packageJson.files.includes("AGENTS.md"), "AGENTS.md is not in files");

  const server = await import("../dist/index.js");
  const node = await import("../dist/node.js");

  // "The admin header name is exported as ADMIN_TOKEN_HEADER."
  assert.equal(typeof server.ADMIN_TOKEN_HEADER, "string");
  assert.match(brief, /ADMIN_TOKEN_HEADER/);

  // "Node adapters live under @renderyes/server/node, not the root export."
  assert.equal(typeof node.toNodeHandler, "function");
  assert.equal(typeof node.createFileCatalogStore, "function");
  assert.equal(server.toNodeHandler, undefined, "toNodeHandler leaked to the root export");

  // "restorePublishedCatalogs() must run at startup."
  assert.match(brief, /restorePublishedCatalogs/);

  // The three lifecycle routes it names, with the gate it claims for them.
  for (const path of ["/api/catalog/history", "/api/catalog/rollback", "/api/catalog/delete"]) {
    assert.match(brief, new RegExp(path.replace(/\//g, "\\/")), `brief omits ${path}`);
    const route = server.VIEW_HTTP_ROUTES.find((entry) => entry.path === path);
    assert.ok(route, `brief names ${path}, which has no route`);
    assert.equal(route.admin, true, `brief calls ${path} admin-gated and it is not`);
  }

  // Every other route the brief names must exist too — this is the class of
  // error that makes an agent brief actively harmful.
  for (const [, path] of brief.matchAll(/`(?:GET|POST) (\/api\/[a-z/-]+)`/g)) {
    assert.ok(
      server.VIEW_HTTP_ROUTES.some((entry) => entry.path === path),
      `AGENTS.md names ${path}, which is not a route`,
    );
  }
});
