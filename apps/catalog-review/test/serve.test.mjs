import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * `serve.mjs` is a local tool with no authentication that reads a host's schema,
 * and it is still a server: it resolves a request path against a root and reads
 * whatever it lands on. It had no test at all.
 *
 * Driven as a child process rather than by importing the module, because
 * `serve.mjs` calls `server.listen` at import time. That is also what a consumer
 * runs (`npx renderyes-catalog-review`), so this exercises the shipped entry
 * point rather than a testable rearrangement of it.
 *
 * On the `withinRoot` guard, and why no test here proves it works: every
 * traversal attempt is flattened before the guard sees it, because
 * `new URL(path, base).pathname` resolves `..` segments and decodes `%2e%2e`
 * per the URL spec. `/../../package.json` arrives as `/package.json`. Setting
 * `withinRoot = true` therefore breaks nothing, which was verified by mutation.
 *
 * The guard is not wrong — it is unreachable, and worth keeping as the thing
 * that makes the handler safe if the URL parse is ever replaced with raw string
 * handling. What the traversal test below pins is the observable contract (these
 * paths never return file contents), not the execution of that branch. Read it
 * as a regression test on behaviour, not as coverage of the check.
 */

const SERVE = fileURLToPath(new URL("../serve.mjs", import.meta.url));

/**
 * serve.mjs binds whatever PORT it is handed and logs that number, so passing 0
 * would leave the test unable to learn the real port. Ask the OS for a free one
 * first instead of guessing a range and hoping.
 */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVE], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("serve.mjs did not start")), 10_000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes(`:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve.mjs exited early with code ${code}`));
    });
  });

  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      child.kill();
      await new Promise((resolve) => child.on("exit", resolve));
    },
  };
}

/** The hashed asset filenames change every build, so read them from the page. */
async function assetPaths() {
  const html = await readFile(
    fileURLToPath(new URL("../dist/index.html", import.meta.url)),
    "utf8",
  );
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
}

test("serves the built review UI and its assets", async () => {
  const server = await startServer();
  try {
    const index = await fetch(`${server.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /text\/html/);

    const [firstAsset] = await assetPaths();
    assert.ok(firstAsset, "index.html should reference at least one asset");
    const asset = await fetch(`${server.base}${firstAsset}`);
    assert.equal(asset.status, 200);
    // Served as its own type, not as HTML — an asset delivered as text/html
    // fails in the browser with nothing pointing at the cause.
    assert.doesNotMatch(asset.headers.get("content-type"), /text\/html/);
  } finally {
    await server.close();
  }
});

test("never serves a file from outside the dist root", async () => {
  const server = await startServer();
  try {
    // Behaviour, not branch coverage — see the note at the top of this file.
    // These are the shapes an attempt actually takes, including percent-encoded
    // ones, and none of them may come back as file contents.
    for (const attempt of [
      "/../package.json",
      "/../../package.json",
      "/assets/../../serve.mjs",
      "/%2e%2e/package.json",
      "/..%2f..%2fpackage.json",
    ]) {
      const response = await fetch(`${server.base}${attempt}`);
      assert.notEqual(response.status, 200, `${attempt} must not be served`);
      // And it must not leak the file as an SPA fallback either.
      const body = await response.text();
      assert.doesNotMatch(body, /"name": "@renderyes\/catalog-review"/);
      assert.doesNotMatch(body, /createServer/);
    }
  } finally {
    await server.close();
  }
});

test("an unknown route falls back to the app, but an unknown asset does not", async () => {
  const server = await startServer();
  try {
    // A single-page app owns its routing, so an extensionless path is a client
    // route rather than a missing file.
    const route = await fetch(`${server.base}/approve/graphql`);
    assert.equal(route.status, 200);
    assert.match(route.headers.get("content-type"), /text\/html/);

    // But a missing asset must 404. Serving index.html here would hand the
    // browser HTML labelled as JavaScript, which fails confusingly.
    const missing = await fetch(`${server.base}/assets/does-not-exist.js`);
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /<!doctype html>/i);
  } finally {
    await server.close();
  }
});

test("the proxy's default admin header is the shared one, still env-overridable", async () => {
  // ADMIN_TOKEN_HEADER in @renderyes/server, inlined in serve.mjs because
  // this tool does not depend on that package. The old default,
  // x-catalog-publish-token, disagreed with every scaffolded requireAdmin and
  // the resulting 403 read as a wrong token rather than a wrong header.
  const source = await readFile(SERVE, "utf8");
  assert.match(source, /RENDERYES_ADMIN_HEADER \?\? "x-renderyes-admin-token"/);
  assert.doesNotMatch(source, /x-catalog-publish-token/);
});
