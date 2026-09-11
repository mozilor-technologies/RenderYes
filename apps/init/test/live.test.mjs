import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { checkReachable } from "../src/live.mjs";

/**
 * The reachability probe, against real listeners. It hits an admin-gated route
 * with a token it invented, so the status of the answer is a free reading on
 * the host's own `requireAdmin` — the check these tests pin is that a 2xx to
 * garbage is surfaced rather than silently blessed as "reachable".
 */

/**
 * A listener standing in for a mounted handler.
 *
 * The fingerprint header is set here, once, because that is what the real
 * `createViewHttpHandler` sets on every response — and the probe now requires
 * it. A stub without it is a stub of something else, which is precisely the
 * case `doctor.test.mjs` covers.
 */
function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      response.setHeader("x-renderyes-handler", "1");
      handler(request, response);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const urlOf = (server) => `http://127.0.0.1:${server.address().port}/`;

test("an admin-gated route answering a garbage token is surfaced as an open gate", async () => {
  // GET /api/catalog is admin: true in the route table. A 200 to a token with
  // no reason to be accepted means requireAdmin says yes to anyone — before
  // this check, that read as a plain "Mount is reachable" pass.
  const open = await serve((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end("[]");
  });
  try {
    const checks = await checkReachable(urlOf(open));
    assert.equal(checks.find((check) => check.id === "reachable").status, "pass");
    const gate = checks.find((check) => check.id === "admin-gate");
    // A warn, not a fail: a requireAdmin built on network or mTLS rather than
    // the token legitimately answers yes here.
    assert.equal(gate.status, "warn");
    assert.match(gate.remedy, /mTLS/);
    assert.match(gate.remedy, /replace your catalog/);
  } finally {
    open.close();
  }
});

test("a closed admin gate is the healthy answer, not a warning", async () => {
  const closed = await serve((request, response) => {
    response.statusCode = 401;
    response.end("{}");
  });
  try {
    const checks = await checkReachable(urlOf(closed));
    assert.equal(checks.find((check) => check.id === "reachable").status, "pass");
    assert.equal(checks.find((check) => check.id === "admin-gate"), undefined);
  } finally {
    closed.close();
  }
});

test("HTML where JSON was expected still reads as the wrong mount, not an open gate", async () => {
  // The signature of a framework's 404 page. It must stay a reachability
  // failure — an open-gate warning on top would bury the real problem.
  const wrong = await serve((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<html>not found</html>");
  });
  try {
    const checks = await checkReachable(urlOf(wrong));
    assert.equal(checks.length, 1);
    assert.equal(checks[0].id, "reachable");
    assert.equal(checks[0].status, "fail");
  } finally {
    wrong.close();
  }
});

test("reachability claims the mounted level, never published", async () => {
  // Filed under `published`, a ✓ "Mount is reachable" rendered beneath a
  // heading it had not earned and could contradict a failing mounted-level
  // source scan in the same report. Answering on the wire proves the mount,
  // and only the mount.
  const closed = await serve((request, response) => {
    response.statusCode = 401;
    response.end("{}");
  });
  const open = await serve((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end("[]");
  });
  try {
    for (const server of [closed, open]) {
      for (const check of await checkReachable(urlOf(server))) {
        assert.equal(check.level, "mounted", `${check.id} must sit at the mounted level`);
      }
    }
  } finally {
    closed.close();
    open.close();
  }
});

test("the probe carries the shared admin header name", async () => {
  // ADMIN_TOKEN_HEADER in @renderyes/server — the one name every scaffolded
  // requireAdmin reads. Doctor sending a different header than the mounts the
  // same tool scaffolds would 403 against its own output.
  let seen;
  const server = await serve((request, response) => {
    seen = request.headers;
    response.setHeader("content-type", "application/json");
    response.statusCode = 401;
    response.end("{}");
  });
  try {
    await checkReachable(urlOf(server));
    assert.equal(seen["x-renderyes-admin-token"], "probe-unauthenticated");
  } finally {
    server.close();
  }
});

/**
 * An application that is not rendering, told apart from a mount in the wrong
 * place.
 *
 * The install that produced these: the wizard wrote a second page resolving to
 * a route the host already served, Next refused the build, and every route in
 * the newspaper answered 500 — the mount included. The probe read HTML where
 * JSON belonged and prescribed mounting `createViewHttpHandler`, on a mount the
 * same tool had verified minutes earlier. The mount was never the problem.
 */
test("a Next build error is reported as the application failing, not a bad mount", async () => {
  const broken = await serve((request, response) => {
    response.statusCode = 500;
    response.setHeader("content-type", "text/html");
    response.end(
      "<html><body><h1>Error: You cannot have two parallel pages that resolve to the " +
        "same path. Please check /(frontend)/renderyes and /renderyes.</h1></body></html>",
    );
  });
  try {
    const [check] = await checkReachable(urlOf(broken));
    assert.equal(check.status, "fail");
    assert.match(check.summary, /not rendering/);
    assert.match(check.remedy, /Two pages resolve to the same route/);
    assert.doesNotMatch(
      check.remedy,
      /createViewHttpHandler/,
      "blaming the mount sends the host to re-check the one thing that was correct",
    );
  } finally {
    broken.close();
  }
});

test("HTML that is not a known Next failure still reads as a bad mount", async () => {
  const other = await serve((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<html><body>some other app</body></html>");
  });
  try {
    const [check] = await checkReachable(urlOf(other));
    assert.equal(check.status, "fail");
    assert.match(check.remedy, /createViewHttpHandler/);
  } finally {
    other.close();
  }
});

/**
 * The page, which nothing looked at before.
 *
 * A page with no root layout is served as HTTP 200 with an empty shell, so the
 * status line is not the answer — doctor printed MOUNTED on every line while
 * the surface a visitor opens was dead.
 */
test("a 200 with no root layout is reported as a page that does not render", async () => {
  const { checkPage } = await import("../src/live.mjs");
  const dead = await serve((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end('<script>self.__next_f=[]</script><div data-next-error-digest="NEXT_MISSING_ROOT_TAGS"></div>');
  });
  try {
    const check = await checkPage(urlOf(dead));
    assert.equal(check.status, "fail");
    assert.match(check.summary, /answered 200/);
    assert.match(check.remedy, /no root layout/);
  } finally {
    dead.close();
  }
});

test("a page that renders passes, and an unrecognised body is never called an outage", async () => {
  const { checkPage } = await import("../src/live.mjs");
  const alive = await serve((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<html><body><main>RenderYes</main></body></html>");
  });
  try {
    assert.equal((await checkPage(urlOf(alive))).status, "pass");
  } finally {
    alive.close();
  }
});

/**
 * The level `doctor` never reached and never mentioned.
 *
 * `verified` is the only level that proves the pipeline end to end, and the
 * whole stage was gated behind a supplied prompt. Doctor supplied none, so
 * `interpretCompose` was never called — not even its own "No compose attempted"
 * branch — and no L4 check object existed. A report that caps its level on
 * unresolved checks had nothing to cap on, so an install whose page was dead
 * printed "Reached: published", "nothing blocking", and exited 0, against a
 * README promising both modes run the same checks.
 */
test("a run with no prompt reports verified as unattempted rather than omitting it", async () => {
  const { runLiveChecks } = await import("../src/live.mjs");
  const server = await serve((request, response) => {
    response.setHeader("content-type", "application/json");
    response.statusCode = 401;
    response.end(JSON.stringify({ error: "admin token required" }));
  });
  try {
    const checks = await runLiveChecks(urlOf(server), {});
    const compose = checks.find((check) => check.id === "compose");
    assert.ok(compose, "the level must appear even when nothing ran");
    assert.equal(compose.status, "unknown");
    assert.equal(compose.level, "verified");
    assert.match(compose.summary, /No compose attempted/);
  } finally {
    server.close();
  }
});

test("the report will not call an install verified on a level it never tried", async () => {
  const { render, reachedLevel, exitCode } = await import("../src/report.mjs");
  const { interpretCompose } = await import("../src/checks.mjs");
  const checks = [
    { id: "registry", status: "pass", level: "access", summary: "reachable" },
    { id: "packages-installed", status: "pass", level: "installed", summary: "present" },
    { id: "reachable", status: "pass", level: "mounted", summary: "mounted" },
    { id: "catalog-state", status: "pass", level: "published", summary: "published" },
    interpretCompose(undefined),
  ];
  assert.equal(reachedLevel(checks), "published", "the level never attempted is not reached");
  const report = render(checks);
  assert.match(report, /Reached: published/);
  assert.match(report, /blocked from going further/);
  // Follows from the existing design: a non-advisory unknown blocks, and the
  // level that proves the pipeline is not something to be silent about.
  assert.equal(exitCode(checks), 1);

  // And the same set with the level absent — what shipped — claims verified.
  const without = checks.filter((check) => check.id !== "compose");
  assert.equal(reachedLevel(without), "published");
  assert.equal(exitCode(without), 0, "the old behaviour, kept here as the contrast");
});
