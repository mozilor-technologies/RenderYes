/**
 * The walk: run the checks, act on the first level that is not reached.
 *
 * This is the only place that decides *what to do*; every judgement about
 * whether something is true lives in `checks.mjs`, which `doctor` runs too.
 * That split is the point — the failure mode this whole tool exists to prevent
 * is one path verifying what another path assumes.
 *
 * Stateless by construction. There is no progress file: each level re-derives
 * whether it is satisfied, so interrupting the walk and re-running it continues
 * from the first thing that is still not true. The one place that cannot be
 * derived is the boundary between sittings — L3 onwards needs the host's app
 * running, because publishing has to go through their own `requireAdmin` rather
 * than around it — and that is stated rather than discovered.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { existingChoices, inspectProject } from "./detect.mjs";
import { readEnvVar } from "./env.mjs";
import { runLocalChecks } from "./checks.mjs";
import { runLiveChecks } from "./live.mjs";
import { conductInterview } from "./interview.mjs";
import { installPackages, packagesFor } from "./install.mjs";
import { collisionReport, planFiles, writePlan } from "./scaffold.mjs";
import { compileAndPublish, findBundle, inventoryAndCandidate, publishBundle } from "./catalog.mjs";
import { reachedLevel } from "./report.mjs";

const say = (message) => console.error(message);

/** A handoff written by the other repository's run, if one was passed. */
export function readHandoff(path) {
  if (!path || !existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed.format === "renderyes.handoff" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function walk(flags) {
  const project = inspectProject(process.cwd());
  if (!project.manifest) {
    return {
      ok: false,
      message:
        `No package.json in ${project.root}.\n\n` +
        `If your app is Node, run this from its directory — the one with the\n` +
        `package.json — rather than from a parent.\n\n` +
        `If your backend is not Node at all, there is nothing here to integrate\n` +
        `into and the standalone service is the whole answer. It is its own Node\n` +
        `project beside your app, so give it a directory to live in:\n\n` +
        `  mkdir renderyes-service && cd renderyes-service && npm init -y\n` +
        `  npx @renderyes/init --topology standalone\n\n` +
        `That directory is what this tool needs; your app is reached over HTTP.`,
    };
  }

  const handoff = readHandoff(flags.handoff);
  const role = flags.role ?? project.role;

  say(
    `RenderYes · ${project.root}\n` +
      `  package manager: ${project.packageManager ?? "unknown"}\n` +
      `  server framework: ${project.framework?.id ?? "none — this only picks the boot style"}\n` +
      `  role:            ${role ?? "unknown"}` +
      (handoff ? `\n  handoff:         ${handoff.catalogId} at ${handoff.serviceUrl}` : ""),
  );

  if (!role) {
    return {
      ok: false,
      message:
        "Could not tell whether this is the frontend, the backend, or both. " +
        "Pass --role frontend|backend|both.",
    };
  }

  // ─── L0/L1 ──────────────────────────────────────────────────────────────
  const before = runLocalChecks(project);
  // Only when this run is going to install. Scaffolding writes files and needs
  // no registry at all, so gating it on the scope mapping stopped the part that
  // works for a reason that did not apply to it.
  const scope = before.find((check) => check.id === "scope-mapping");
  if (scope.status === "fail" && !flags.skipInstall && !flags.dryRun) {
    return { ok: false, message: `${scope.summary}\n\n${scope.remedy}` };
  }
  if (scope.status === "fail") {
    say("\n· No @renderyes registry mapping — fine for scaffolding, needed before installing.");
  }

  // Skippable because a host may manage dependencies itself — a curated
  // allowlist, a monorepo that installs from the root, a policy that reviews
  // every addition. Scaffolding still works; the packages just have to exist
  // before the code that imports them runs.
  if (flags.skipInstall) {
    say("\n· Skipped installing (--skip-install). The scaffolded files import these:");
    for (const name of packagesFor(role)) say(`    ${name}`);
  } else {
    const install = installPackages(project, role, { dryRun: flags.dryRun });
    say(`\n${install.ok ? "✓" : "✗"} ${install.summary}`);
    if (install.note) say(`  ${install.note}`);
    if (!install.ok) return { ok: false, message: install.remedy ?? install.summary };

  }

  // ─── L2 ─────────────────────────────────────────────────────────────────
  // A handoff supplies what the other side already decided, so the same string
  // is never typed twice — which is the single most-hit onboarding failure.
  const answers = handoff
    ? {
        ...(await conductInterview(project, {
          ...flags,
          catalogId: handoff.catalogId,
          serviceUrl: handoff.serviceUrl,
          adminTokenEnv: handoff.adminTokenEnv,
          sessionStyle: handoff.auth?.style,
          topology: "coexist",
        }, { interactive: !flags.yes })),
      }
    : await conductInterview(
        project,
        // What is already in the repository outranks what package.json implies,
        // and is outranked by a flag the host passed on this run. A re-run that
        // re-asks with defaults contradicting the files it is about to check is
        // how a second walk files the UI catalog under an id compose never
        // looks up.
        {
          ...existingChoices(project.root),
          // Undefined flag keys must not shadow what was read from the repo.
          ...Object.fromEntries(Object.entries(flags).filter(([, value]) => value !== undefined)),
        },
        { interactive: !flags.yes },
      );

  if (flags.outDir) answers.outDir = flags.outDir;

  // An existing file is a level that is already reached, not an error. The
  // first version hard-stopped on any collision, which made `published` and
  // `verified` unreachable on every second run — the walk refusing to resume
  // is the walk breaking its own one promise. Never-overwrite still holds
  // absolutely: existing files are left exactly as they are, whether an
  // earlier run wrote them or the host did, and the checks that follow judge
  // what is actually in them rather than what this run intended.
  const files = planFiles(project, answers, { role });
  const collisions = collisionReport(project.root, files);
  const existing = new Set(collisions.map((entry) => entry.planned));
  const fresh = files.filter((file) => !existing.has(file.path));
  // What is already there, named by where it actually is. A page the host moved
  // into a route group is reported at the path serving the route, not at the
  // path this run would have used — the second reads as a file the host has
  // never seen.
  const describe = (entry) =>
    entry.sameRoute
      ? `${entry.existing}\n      already serves this route; not written again`
      : entry.existing;

  if (flags.dryRun) {
    // The file list without the answers behind it is half a preview: these five
    // decide the *contents* of every file above, and one of them is derived from
    // `package.json`'s name. A newspaper whose app is the stock template name
    // got the catalog id `website`, silently, and found out much later.
    say("\nDerived from your project (these decide what goes in the files):");
    for (const [label, value] of [
      ["catalog id", answers.catalogId],
      ["service URL", flags.serviceUrl ?? answers.serviceUrl],
      ["topology", answers.topology],
      ["session model", answers.sessionStyle ?? answers.session],
      ["view owner", answers.ownerStyle ?? answers.owner],
      ["mount path", answers.mountPath],
      ["admin token env", flags.adminTokenEnv ?? answers.adminTokenEnv],
    ]) {
      if (value !== undefined && value !== null && value !== "") {
        say(`  ${String(label).padEnd(18)} ${value}`);
      }
    }
    if (fresh.length > 0) {
      say("\nWould write:");
      for (const file of fresh) say(`  ${file.path}\n      ${file.why}`);
    }
    if (existing.size > 0) {
      say(`\nWould leave untouched (already there, never overwritten):`);
      for (const entry of collisions) say(`  ${describe(entry)}`);
    }
    return { ok: true, message: "Dry run: nothing installed, nothing written." };
  }

  const written = writePlan(project.root, fresh, { dryRun: false });
  if (existing.size > 0) {
    say(`\n· ${existing.size} file(s) already there, left untouched — this tool never overwrites:`);
    for (const entry of collisions) say(`  ${describe(entry)}`);
  }
  if (written.written.length > 0) {
    say(`\n✓ Wrote ${written.written.length} file(s):`);
    for (const file of fresh) say(`  ${file.path}\n      ${file.why}`);
  } else {
    say("\n✓ Everything is already scaffolded; continuing to what is not true yet.");
  }

  // The standalone service runs from its own directory, with its own
  // package.json, and its dependency belongs there. It was installed at the host
  // root instead — so `npm start` in the service directory failed on its first
  // import, after a wizard run that reported success. Done here rather than at
  // the install step above because the directory does not exist until now.
  //
  // In addition to the root install, not instead of it: a `both`-role host still
  // needs the frontend packages where its components live.
  if (answers.topology === "standalone" && role !== "frontend" && !flags.skipInstall) {
    const serviceDirectory = join(project.root, answers.outDir ?? "renderyes-service");
    if (existsSync(join(serviceDirectory, "package.json"))) {
      const service = installPackages(project, role, {
        into: serviceDirectory,
        packages: packagesFor("backend"),
      });
      say(`${service.ok ? "✓" : "✗"} ${service.summary}`);
      if (!service.ok) return { ok: false, message: service.remedy ?? service.summary };
    }
  }

  // ─── The sitting boundary ───────────────────────────────────────────────
  const serviceUrl = flags.serviceUrl ?? answers.serviceUrl;
  // Environment first, then `.env` — the scaffold's own documented pattern puts
  // the token in the file, not the shell, and `doctor` already reads it there.
  const adminToken = readEnvVar(flags.adminTokenEnv ?? answers.adminTokenEnv, flags.envFile);

  if (!serviceUrl.startsWith("http")) {
    return {
      ok: true,
      message:
        `\nEverything past here talks to your running app.\n\n` +
        `  1. Fill in the TODOs in what was just written.\n` +
        `  2. Set ${[answers.adminTokenEnv, answers.planProvider?.apiKeyEnv]
          .filter(Boolean)
          .join(" and ")} (and RENDERYES_DEV_SESSION for local verification)\n` +
        `     wherever your app already reads environment variables — a .env file it\n` +
        `     loads, or your shell. Nothing here reads or writes that file.\n` +
        `  3. Start the app.\n` +
        `  4. Re-run me with --service-url <where the handler is mounted>.\n\n` +
        `Re-running is safe: nothing is remembered, so it picks up from the first\n` +
        `thing that is not true yet.`,
    };
  }

  if (!adminToken) {
    return {
      ok: true,
      message:
        `\n${answers.adminTokenEnv} is not set in this shell or in a .env file here, so the\n` +
        `catalog step cannot authenticate against your own admin gate. Set it and\n` +
        `re-run with --service-url (--env-file <path> if it lives somewhere else).`,
    };
  }

  // ─── L3 ─────────────────────────────────────────────────────────────────
  // One pass asking the full question. When a catalog is already published this
  // is the verified set too — re-running the same checks after learning nothing
  // changed just fired the probe twice per walk.
  // The page is a separate surface from the mount, on a route of its own, and
  // nothing used to look at it: an install reported MOUNTED on every line while
  // the page a visitor opens served an empty shell. Only for a Next host that
  // asked for the frontend, since that is the only case where this tool wrote a
  // route and knows its URL.
  const pageUrl =
    role !== "backend" && project.framework?.id === "next"
      ? new URL(
          "renderyes",
          answers.topology === "standalone" && answers.frontendOrigin
            ? `${answers.frontendOrigin.replace(/\/+$/, "")}/`
            : `${new URL(serviceUrl).origin}/`,
        ).toString()
      : undefined;

  const live = await runLiveChecks(serviceUrl, {
    adminToken,
    catalogId: answers.catalogId,
    prompt: answers.placeholder,
    ...(pageUrl ? { pageUrl } : {}),
  });
  const blocked = live.find((check) => check.status === "fail" && check.id === "reachable");
  if (blocked) {
    return { ok: false, message: `${blocked.summary}\n\n${blocked.remedy}` };
  }

  const alreadyPublished = live.find(
    (check) => check.id === "capability-catalog" && check.status === "pass",
  );

  // A level satisfied once used to mean "skip", so handing the walk new
  // `--decisions` over a published catalog silently kept the old one and
  // reported it as current — the host edits a file, re-runs, and nothing they
  // changed takes effect. Inputs named on this run are a request to compile
  // them; only an unnamed input can be answered by what is already published.
  // Only inputs a host *named*. A bundle is discovered on disk by `findBundle`,
  // not passed, so its presence says nothing about whether this run was meant
  // to republish — treating it as intent would re-publish on every walk.
  const inputsNamed = Boolean(flags.decisionsPath || flags.schemaPath);

  let verified = live;
  if (!alreadyPublished || inputsNamed) {
    // The reviewed decisions come first, because a host holding them has already
    // done the step the schema route stops at. Checked before `--schema` so
    // that passing both — which is what the next command printed below tells
    // them to do — continues rather than overwriting their edits.
    if (flags.decisionsPath) {
      const inventoryPath =
        flags.inventoryPath ?? join(project.root, `${answers.catalogId}.inventory.json`);
      if (!existsSync(inventoryPath)) {
        return {
          ok: false,
          message:
            `--decisions was given but no inventory is at ${inventoryPath}.\n\n` +
            `Compiling needs both: the inventory is what the decisions were made\n` +
            `against, and its hash is what proves they were made against this schema\n` +
            `and not an older one. Pass --inventory <file>, or re-run with --schema.`,
        };
      }
      if (!flags.schemaPath) {
        return {
          ok: false,
          message:
            "--decisions needs --schema too: the catalog is compiled from the schema, " +
            "and the inventory records which schema was read rather than carrying it.",
        };
      }
      if (!flags.schemaEndpoint) {
        return {
          ok: false,
          message:
            "--decisions needs --endpoint: every approved capability executes against " +
            "that URL, and its origin is what the server checks before publishing.",
        };
      }
      say("\nCompiling your decisions and publishing them…");
      const published = compileAndPublish({
        cwd: project.root,
        schemaPath: flags.schemaPath,
        inventoryPath,
        decisionsPath: flags.decisionsPath,
        endpoint: flags.schemaEndpoint,
        uiManifest: flags.uiManifest,
        serviceUrl,
        adminToken,
        catalogId: answers.catalogId,
      });
      if (!published.ok) {
        return { ok: false, message: `${published.stage} failed:\n${published.message}` };
      }
      say(published.notes);
      if (!published.bundled) {
        say(
          `\nThat is the capability half. Nothing renders until your components are\n` +
            `published under "${answers.catalogId}":\n` +
            role === "backend"
              ? `  (frontend side) npx tsx scripts/publish-ui-catalog.mjs`
              : `  npx tsx scripts/publish-ui-catalog.mjs`,
        );
      }
      verified = await runLiveChecks(serviceUrl, {
        adminToken,
        catalogId: answers.catalogId,
        prompt: answers.placeholder,
        ...(pageUrl ? { pageUrl } : {}),
      });
    } else if (flags.schemaPath) {
      say("\nTaking inventory of your schema and proposing decisions…");
      const candidate = inventoryAndCandidate({
        cwd: project.root,
        schemaPath: flags.schemaPath,
        catalogId: answers.catalogId,
        rows: flags.rows,
        semanticTypes: flags.semanticTypes,
        shapes: flags.shapes,
        queries: flags.queries,
      });
      if (!candidate.ok) {
        return { ok: false, message: `${candidate.stage} failed:\n${candidate.message}` };
      }
      say(candidate.notes);
      return {
        ok: true,
        message:
          `\nA candidate decisions file is at ${candidate.decisionsPath}.\n\n` +
          `It approves visitor access to every field discovery found — a starting point,\n` +
          `not a review. Cut it down, decide the visitor and identity arguments, then\n` +
          `\`diff\` it against ${candidate.inventoryPath}.\n\n` +
          `When it says what you mean, this same command publishes it:\n` +
          `  npx @renderyes/init --service-url ${serviceUrl} \\\n` +
          `    --schema ${flags.schemaPath} --decisions ${candidate.decisionsPath} \\\n` +
          `    --endpoint ${flags.schemaEndpoint ?? "<your GraphQL endpoint>"}\n\n` +
          `The review app can do the same interactively, against your running mount:\n` +
          `  npx @renderyes/catalog-review --host-url ${serviceUrl}`,
      };
    }

    const bundle = findBundle({ cwd: project.root, catalogId: answers.catalogId });
    if (bundle) {
      say(`\nPublishing ${bundle}…`);
      const published = await publishBundle({ serviceUrl, adminToken, bundlePath: bundle });
      if (!published.ok) return { ok: false, message: `Publish failed: ${published.message}` };
      say(`✓ Published "${published.summary.catalogId}".`);
      // The publish changed what is true, so the first pass is stale — this is
      // the one path that genuinely needs a second look.
      verified = await runLiveChecks(serviceUrl, {
        adminToken,
        catalogId: answers.catalogId,
        prompt: answers.placeholder,
        ...(pageUrl ? { pageUrl } : {}),
      });
    } else {
      return {
        ok: true,
        message:
          `\nNo published catalog answered at ${serviceUrl}, and no schema or\n` +
          `bundle was named. That is what this run could see: a mount still\n` +
          `starting up answers the same way as one with nothing published, so\n` +
          `if you published a moment ago, run this again before doing anything.\n\n` +
          `Either:\n` +
          `  npx @renderyes/init --schema <file>            headless candidate\n` +
          `  npx @renderyes/catalog-review --host-url ...  review in a browser\n\n` +
          `GraphQL only for now: the catalog CLI and the export bundle are both\n` +
          `GraphQL-shaped, so an OpenAPI catalog is published from the review app\n` +
          `against a running mount rather than from a file.`,
      };
    }
  }

  // ─── L4 ─────────────────────────────────────────────────────────────────
  const level = reachedLevel(verified);
  const compose = verified.find((check) => check.id === "compose");

  return {
    ok: level === "verified",
    checks: verified,
    message:
      compose?.status === "pass"
        ? `\n✓ ${compose.summary}\n\n` +
          `That went through your own mount, session resolution and registrations. It proves\n` +
          `the wiring; it does not prove every capability works, which is what the probe\n` +
          `above covers.\n\n` +
          `Next, to make it look like your site: write your own components in the views\n` +
          `folder that was scaffolded — one file each, and the only route to a view that is\n` +
          `fully yours. The starter set is a bootstrap; it takes your typeface and colours\n` +
          `through the \`--iv-starter-*\` custom properties, which is enough to blend but\n` +
          `not enough to match. Re-publish with \`npx tsx scripts/publish-ui-catalog.mjs\`\n` +
          `once yours exist. (Under a loader, not bare \`node\`: it imports your JSX.)\n\n` +
          `\`npx @renderyes/generate component\` can draft one from your own stylesheet\n` +
          `and existing components, and refuses a draft that invents values your design\n` +
          `system already has. Read what it writes before you keep it.`
        : `\nReached: ${level ?? "nothing"}. See the report above for what is blocking.`,
  };
}
