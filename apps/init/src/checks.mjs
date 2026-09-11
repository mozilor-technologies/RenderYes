/**
 * The checks. This file is the product; `doctor` and `init` are frontends.
 *
 * `doctor` runs them and reports. `init` runs them and, at the first failure,
 * performs that level's action. Nothing is asserted in one command and assumed
 * in the other — the split that let six capabilities ship unreachable was
 * exactly this kind of gap, where one path verified what another path took on
 * trust.
 *
 * Every check returns the same shape and never throws. A check that cannot
 * determine an answer says `unknown` rather than guessing, because a wizard
 * confidently wrong about someone else's project is worse than one that admits
 * it cannot see.
 *
 * What none of these do is re-implement a rule the library already enforces.
 * They read what the server reports — publish summaries, probe results,
 * coverage — so this tool cannot drift into disagreeing with the boundary it is
 * supposed to be checking.
 */
import { TOOL_PACKAGES, findSourceFilesContaining } from "./detect.mjs";
// The one list of what a role installs. Rebuilding it here from the package
// tiers dropped the optional starter catalog that the installer adds, so
// INSTALLED under-reported against what the walk itself had just installed.
import { packagesFor } from "./install.mjs";

/** @typedef {"pass"|"fail"|"warn"|"unknown"|"skip"} Status */

function result(id, status, summary, extra = {}) {
  return { id, status, summary, ...extra };
}

/**
 * Drops whole-line comments before a symbol is searched for.
 *
 * A commented-out `resolveViewOwner` — or this tool's own scaffolded remedy
 * text naming a symbol — read as "is set" when the check was plain substring
 * matching. Whole lines only, deliberately: parsing trailing comments means
 * parsing string literals (`"https://…"` contains `//`), and the false-pass
 * being prevented here is commented-out config, which is line-shaped.
 */
function stripCommentLines(text) {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
    })
    .join("\n");
}

const LEVELS = Object.freeze({
  L0: "access",
  L1: "installed",
  L2: "mounted",
  L3: "published",
  L4: "verified",
});

// ─── L0: access ──────────────────────────────────────────────────────────────

/**
 * The scope mapping, not the token.
 *
 * A consumer reaches this tool at all only by having the scope routed — you
 * cannot `npx` a package from a registry you cannot reach — so when `init` is
 * running, this has effectively already passed. It is still worth asserting,
 * because `doctor` may be run in CI against a checkout where the mapping was
 * never committed, and "@renderyes/react not found" points at the package
 * rather than at the missing line that would have found it.
 *
 * A failure only when something would actually need the registry. The walk
 * already decided this — "fine for scaffolding, needed before installing" —
 * while doctor failed unconditionally, so a project installed from local
 * tarballs sat at "Reached: nothing yet" with every real check green. When
 * every package the role wants is already installed, the missing mapping is
 * information, not a gate.
 */
export function checkScopeMapping(project) {
  if (project.scope.configured) {
    return result("scope-mapping", "pass", `@renderyes routed to ${project.scope.registry}`, {
      level: LEVELS.L0,
    });
  }
  const wanted = packagesFor(project.role);
  const missing = wanted.filter((name) => !project.dependencies[name]);
  if (wanted.length > 0 && missing.length === 0) {
    return result(
      "scope-mapping",
      "warn",
      "No @renderyes registry mapping, but every package is already installed",
      {
        level: LEVELS.L0,
        remedy:
          "Fine while nothing needs installing — local tarballs or a vendored install " +
          "work. Before installing or updating from a registry, add the scope mapping " +
          "your organization's registry setup provides.",
      },
    );
  }
  return result(
    "scope-mapping",
    "fail",
    "No @renderyes registry mapping in this project's .npmrc",
    {
      level: LEVELS.L0,
      remedy:
        "Point the @renderyes scope at wherever your organization hosts these " +
        "packages: an `@renderyes:registry=…` line in .npmrc, which your team's " +
        "registry setup usually writes for you. The mapping is safe to commit; an " +
        "auth token is not — keep tokens in ~/.npmrc rather than editing a tracked " +
        ".gitignore to hide a project file.",
    },
  );
}

// ─── L1: installed ───────────────────────────────────────────────────────────

export function checkPackagesInstalled(project) {
  const wanted = packagesFor(project.role);

  if (wanted.length === 0) {
    return result("packages-installed", "unknown", "Could not tell which half lives here", {
      level: LEVELS.L1,
      remedy:
        "No react/next/express/fastify/hono dependency and no @renderyes package. " +
        "Run this from the directory holding the app you are integrating.",
    });
  }

  const missing = wanted.filter((name) => !project.dependencies[name]);
  if (missing.length > 0) {
    return result("packages-installed", "fail", `Not installed: ${missing.join(", ")}`, {
      level: LEVELS.L1,
      remedy: `Install them with the package manager this project already uses${
        project.packageManager ? ` (${project.packageManager})` : ""
      }.`,
    });
  }
  // Named rather than counted. "3 package(s) present" was `wanted.length` — this
  // check's own expectation for the role — which read as a count of what is
  // installed and disagreed with it whenever a host had more.
  //
  // Presence is not enough on its own. This tool is normally run through
  // `npx`, which fetches the newest published version, while the project's
  // libraries are whatever its lockfile pinned — and `pnpm add` is subject to a
  // release-age quarantine that `npx` is not. So the CLI can silently be ahead
  // of the packages it is checking. One install put a newer CLI over older
  // libraries and split an evaluation across two different decoder paths before
  // anyone noticed.
  const drift = versionDrift(project);
  if (drift.length > 0) {
    return result(
      "packages-installed",
      "warn",
      `installed at a different version than this tool: ${drift
        .map((entry) => `${entry.name}@${entry.version} (${entry.direction})`)
        .join(", ")}`,
      {
        level: LEVELS.L1,
        remedy:
          `This CLI is ${project.cliVersion}, and every @renderyes/* package is released ` +
          `in lockstep at one version. Pin the libraries to it — ` +
          `${project.packageManager ?? "npm"} add ${drift
            .map((entry) => `${entry.name}@${entry.wanted}`)
            .join(" ")} — or re-run with a CLI matching what is installed.` +
          " A mismatch surfaces as a runtime error that reads like bad wiring." +
          (project.packageManager === "pnpm"
            ? " If the install looked like it worked and `pnpm add …@latest` then says " +
              "\"Already up to date\", a release-age policy is holding you back from a build " +
              "published recently: add --config.minimumReleaseAge=0 to the command."
            : ""),
      },
    );
  }
  return result("packages-installed", "pass", `present: ${wanted.join(", ")}`, {
    level: LEVELS.L1,
  });
}

/**
 * Order two versions, or `undefined` when either is not plain `x.y.z`.
 *
 * Numeric per part, not lexical: `0.10.0` sorts after `0.9.0`, and a string
 * compare says the opposite. Returning `undefined` rather than guessing keeps
 * the discipline the caller relies on — direction is claimed only when the
 * comparison actually supports one.
 */
function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ""));
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return undefined;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * Installed `@renderyes/*` packages that are not at this CLI's version.
 *
 * Every `@renderyes/*` package is released in lockstep at one version, so the
 * CLI's own version is both the comparison and the answer: anything else is
 * drift, and the fix is always to pin at what this tool is. Direction is
 * claimed only when both sides parse as `x.y.z`. Absent version info means no
 * claim.
 */
function versionDrift(project) {
  if (!project.cliVersion) return [];
  return Object.entries(project.installedVersions ?? {})
    .filter(([, version]) => version !== project.cliVersion)
    .map(([name, version]) => {
      const order = compareVersions(version, project.cliVersion);
      return {
        name,
        version,
        direction: order === undefined ? "different" : order < 0 ? "older" : "newer",
        wanted: project.cliVersion,
      };
    });
}

/**
 * Tools in a host's dependency tree.
 *
 * The review app ships browser assets for a build-time GUI and this package
 * writes files into a project — neither has any business in a deployed
 * application. Installing one is easy to do by reflex, since every other
 * `@renderyes/*` name is a dependency, and nothing else would ever complain.
 */
export function checkNoToolsInstalled(project) {
  const installed = TOOL_PACKAGES.filter((name) => project.dependencies[name]);
  if (installed.length === 0) {
    return result("no-tools-installed", "pass", "No onboarding tools in dependencies", {
      level: LEVELS.L1,
    });
  }
  return result(
    "no-tools-installed",
    "warn",
    `Onboarding tools declared as dependencies: ${installed.join(", ")}`,
    {
      level: LEVELS.L1,
      remedy:
        "Remove them and invoke with npx instead. These are run during onboarding, " +
        "not served — shipping them puts a build-time GUI, or a scaffolder, into a " +
        "production install.",
    },
  );
}

// ─── L2: mounted ─────────────────────────────────────────────────────────────

/**
 * Config a host must decide, with no default available.
 *
 * Two are required by the type system; the rest fail closed or throw at the
 * moment they are needed, which is later and further from the cause. Their
 * absence is diagnosed here rather than at a visitor's request.
 *
 * `requireAdmin` sits on `createViewHttpHandler` rather than the server config,
 * so it is searched for separately — a mount can have every server field right
 * and still leave the publish routes open.
 */
const MOUNT_DECISIONS = Object.freeze([
  {
    symbol: "resolveSession",
    why: "resolves the host's own session; nothing else may inspect it",
  },
  {
    symbol: "allowedUpstreamOrigins",
    why: "fails closed — an absent or empty list rejects every capability at execution",
  },
  {
    symbol: "resolveViewOwner",
    // A warn when absent, not a fail: the library refuses refine and save
    // without an owner key, which is the closed direction — and a host whose
    // visitors are anonymous (the scaffold's own anonymous style) omits it on
    // purpose, because a shared key would file every visitor's views under
    // one world-readable owner.
    absentStatus: "warn",
    why: "refine and saved views refuse to run without it; omit it only for a host that composes statelessly, such as one whose visitors are anonymous",
  },
  {
    symbol: "requireAdmin",
    why: "gates the publish routes; defaulting it open would let an anonymous caller replace the catalog",
  },
]);

export function checkMountDecisions(project) {
  // Comments stripped before matching, here and below: a commented-out symbol
  // is precisely the "looks configured, is not" case these checks exist for.
  const mounts = findSourceFilesContaining(project.root, ["createViewServer"])
    .map((match) => ({ ...match, code: stripCommentLines(match.text) }))
    .filter((match) => match.code.includes("createViewServer"));
  if (mounts.length === 0) {
    return [
      result("mount-exists", "fail", "No createViewServer call found", {
        level: LEVELS.L2,
        remedy: "Write the backend mount, or run this from the repository that holds it.",
      }),
    ];
  }

  const text = mounts.map((match) => match.code).join("\n");
  const checks = [
    result("mount-exists", "pass", `Mount found in ${mounts.length} file(s)`, {
      level: LEVELS.L2,
    }),
  ];

  for (const decision of MOUNT_DECISIONS) {
    checks.push(
      text.includes(decision.symbol)
        ? result(`mount-${decision.symbol}`, "pass", `${decision.symbol} is set`, {
            level: LEVELS.L2,
          })
        : result(`mount-${decision.symbol}`, decision.absentStatus ?? "fail", `${decision.symbol} is not set`, {
            level: LEVELS.L2,
            remedy: `${decision.absentStatus === "warn" ? "" : "Required: "}${decision.why}.`,
          }),
    );
  }

  // A stored catalog is replayed at boot and nowhere else. Without the call the
  // registries are empty after every restart, and the symptom — "no published
  // catalog" for something plainly published — points at publishing.
  const hasStore = text.includes("catalogStore");
  const hasRestore = text.includes("restorePublishedCatalogs");
  if (hasStore && !hasRestore) {
    checks.push(
      result("mount-restore", "fail", "catalogStore is configured but never replayed", {
        level: LEVELS.L2,
        remedy:
          "Call restorePublishedCatalogs() once at boot" +
          (project.framework?.bootStyle === "before-listen"
            ? ", before listen()."
            : " — a module-level await, since a fetch-native handler has no listen() to precede.") +
          " Without it every restart serves an empty registry.",
      }),
    );
  } else if (!hasStore) {
    checks.push(
      result("mount-restore", "warn", "No catalogStore, so publishes are lost on restart", {
        level: LEVELS.L2,
        remedy:
          "Optional and strongly recommended: without it a restart leaves every " +
          "visitor's compose failing until someone republishes by hand.",
      }),
    );
  } else {
    checks.push(
      result("mount-restore", "pass", "Stored catalogs are replayed at boot", {
        level: LEVELS.L2,
      }),
    );
  }

  return checks;
}

/**
 * One catalog id, agreeing everywhere it appears.
 *
 * The most-hit onboarding failure on record, and it is silent: a UI catalog
 * filed under a name nothing looks up publishes with ok: true and then resolves
 * nothing at compose. Cheap to check because the id is a literal in both the
 * provider config and the publish call.
 */
export function checkCatalogIdAgreement(project) {
  const matches = findSourceFilesContaining(project.root, ["catalogId"]);
  const ids = new Set();
  for (const match of matches) {
    for (const found of stripCommentLines(match.text).matchAll(
      /catalogId\s*:\s*["'`]([^"'`]+)["'`]/g,
    )) {
      ids.add(found[1]);
    }
  }
  if (ids.size === 0) {
    // Advisory: this unknown must not cap the level. An id supplied from
    // configuration is a *correct* setup this check simply cannot see, and
    // capping on it left such a host stuck at "installed" forever.
    return result("catalog-id", "unknown", "No literal catalogId found in source", {
      level: LEVELS.L2,
      advisory: true,
      remedy: "Not a problem if it comes from configuration; this check only reads literals.",
    });
  }
  if (ids.size === 1) {
    return result("catalog-id", "pass", `One catalog id in use: ${[...ids][0]}`, {
      level: LEVELS.L2,
    });
  }
  return result("catalog-id", "warn", `More than one catalog id in source: ${[...ids].join(", ")}`, {
    level: LEVELS.L2,
    remedy:
      "A UI catalog is looked up by the capability catalog's id. If these are meant " +
      "to be the same catalog, they have to be the same string — a site named " +
      "`<catalog>-ui` publishes fine and then finds nothing at compose.",
  });
}

// ─── L3/L4: published and verified (live) ────────────────────────────────────

/**
 * Reads the server's own publish summary rather than judging for itself.
 *
 * `uiCatalogRegistered` and `unrenderableDataTypes` are reported by the publish
 * path precisely so a tool like this does not need a second opinion about
 * whether a catalog can render. A second matcher that could disagree with the
 * first is worse than none.
 */
export function interpretCatalogState({ capabilityCatalogs, uiCatalogs, coverage }) {
  const checks = [];

  if (!capabilityCatalogs || capabilityCatalogs.length === 0) {
    checks.push(
      result("capability-catalog", "fail", "No capability catalog published", {
        level: LEVELS.L3,
        remedy: "Approve a schema and publish before anything can compose.",
      }),
    );
    return checks;
  }
  checks.push(
    result(
      "capability-catalog",
      "pass",
      `${capabilityCatalogs.length} published; ${capabilityCatalogs
        .map((entry) => `${entry.catalogId} (${entry.executableCapabilityCount}/${entry.capabilityCount} executable)`)
        .join(", ")}`,
      { level: LEVELS.L3 },
    ),
  );

  const capabilityIds = new Set(capabilityCatalogs.map((entry) => entry.catalogId));
  const uiIds = new Set((uiCatalogs ?? []).map((entry) => entry.catalogId));
  const orphanedUi = [...uiIds].filter((id) => !capabilityIds.has(id));
  const missingUi = [...capabilityIds].filter((id) => !uiIds.has(id));

  if (orphanedUi.length > 0) {
    checks.push(
      result("ui-catalog", "fail", `UI catalog filed under an id no catalog uses: ${orphanedUi.join(", ")}`, {
        level: LEVELS.L3,
        remedy:
          `Republish naming the capability catalog: one of ${[...capabilityIds].join(", ")}. ` +
          "The default is the site's own id, which is why a site called `<catalog>-ui` lands here.",
      }),
    );
  }
  if (missingUi.length > 0) {
    checks.push(
      result("ui-catalog", "fail", `No UI catalog for: ${missingUi.join(", ")}`, {
        level: LEVELS.L3,
        remedy: "Publish one, or nothing has components to render with.",
      }),
    );
  }
  if (orphanedUi.length === 0 && missingUi.length === 0) {
    checks.push(
      result("ui-catalog", "pass", "Every capability catalog has a UI catalog under its id", {
        level: LEVELS.L3,
      }),
    );
  }

  if (coverage) {
    const unrenderable = (coverage.coverage ?? []).filter((row) => row.unrenderable);
    checks.push(
      unrenderable.length === 0
        ? result("coverage", "pass", "Every published data type has a component", {
            level: LEVELS.L3,
          })
        : result(
            "coverage",
            "warn",
            `${unrenderable.length} data type(s) no component can render: ${unrenderable
              .map((row) => `${row.dataTypeId} (${row.shape})`)
              .join(", ")}`,
            {
              level: LEVELS.L3,
              remedy:
                "The planner will never select these, and the visible symptom is a thin " +
                "answer rather than an error. Register a component accepting that shape. " +
                "If the UI catalog came from the review app, it carries a small starter " +
                "set meant as a bootstrap — your own components replace it.",
            },
          ),
    );
  }

  return checks;
}

/** Probe results, read as the server classified them. */
export function interpretProbe(probe) {
  if (!probe || !Array.isArray(probe.results)) {
    return [result("probe", "unknown", "No probe result", { level: LEVELS.L3 })];
  }
  const failed = probe.results.filter((entry) => entry.status === "failed");
  const degraded = probe.results.filter((entry) => entry.status === "degraded");
  const skipped = probe.results.filter((entry) => entry.status === "skipped");
  const checks = [];

  if (failed.length > 0) {
    checks.push(
      result("probe", "fail", `${failed.length} capability/ies the upstream will not serve`, {
        level: LEVELS.L3,
        detail: failed.map((entry) => `${entry.capabilityId}: ${entry.reason}`),
        remedy:
          "Publishing validates a catalog's shape, not whether the upstream will answer " +
          "it. A schema can declare an argument optional that the resolver requires.\n" +
          "Each reason above is the failure that stopped the request, not the whole " +
          "story: a call rejected at the permission layer never reaches argument " +
          "validation, so probe again after fixing these — a capability can have a " +
          "second, independent problem waiting behind the first.",
      }),
    );
  } else {
    checks.push(
      result("probe", "pass", `${probe.results.length - skipped.length} capability/ies answered`, {
        level: LEVELS.L3,
      }),
    );
  }
  if (degraded.length > 0) {
    checks.push(
      result("probe-degraded", "warn", `${degraded.length} answered with field errors`, {
        level: LEVELS.L3,
        detail: degraded.map((entry) => `${entry.capabilityId}: ${entry.reason}`),
      }),
    );
  }
  if (skipped.length > 0) {
    checks.push(
      result("probe-skipped", "pass", `${skipped.length} skipped (needs parameters)`, {
        level: LEVELS.L3,
        detail: skipped.map((entry) => `${entry.capabilityId}: ${entry.reason}`),
      }),
    );
  }

  // Measured, not assumed: the probe repeats each call without the host's
  // credential, so "enforced" means the upstream actually refused.
  const unguarded = probe.results.filter(
    (entry) => entry.upstreamCredential === "not-required",
  );
  if (unguarded.length > 0) {
    checks.push(
      result("upstream-credential", "warn", `${unguarded.length} capability/ies answer without the host credential`, {
        level: LEVELS.L3,
        detail: unguarded.map((entry) => entry.capabilityId),
        remedy:
          "The upstream serves these to anyone who can reach it. That may be correct " +
          "for public data — it is worth knowing which, rather than assuming the " +
          "credential is what protects them.",
      }),
    );
  }

  return checks;
}

/**
 * The one thing that proves the wiring: a real compose through the host's own
 * mount, rendering something.
 *
 * Deliberately run against the reserved `"mock"` provider, so no model key is
 * needed and the result is deterministic. What it proves is the pipeline —
 * mount, session, catalogs, registration, render. What it does not prove is
 * that every capability works: the mock requests the first approved capability
 * and ignores the prompt entirely. The probe is what covers the rest, which is
 * why both are here and neither stands alone.
 */
export function interpretCompose(compose) {
  if (!compose) {
    return result("compose", "unknown", "No compose attempted", { level: LEVELS.L4 });
  }
  // Not a broken install: an incomplete one. Everything this check exercises
  // *below* planning — the mount, the session, the catalogs, the registrations —
  // has already been verified by the levels above, and planning is the one step
  // that cannot be verified without a model. Reported as worth knowing so it
  // does not read as a failure of the wiring the host has just finished.
  if (compose.kind === "plan-provider-not-configured") {
    return result("compose", "warn", "No plan provider configured, so nothing was planned", {
      level: LEVELS.L4,
      remedy:
        "Add one to `planProviders` with its API key in the named environment " +
        "variable. To exercise the pipeline without a model, configure a plan you " +
        'wrote yourself: `planProviders: [{ id: "rehearsal", plans: [myPlan] }]`.',
    });
  }
  // A question is not a failure. The planner can answer this prompt two or more
  // materially different ways and declined to guess between them, which is the
  // clarification path doing its job — and it proves exactly the same wiring a
  // rendered view would. Reported as a failure, it sent a host looking for a
  // broken mount behind a working one.
  if (compose.kind === "needs-clarification") {
    const question = typeof compose.question === "string" ? compose.question.trim() : "";
    return result(
      "compose",
      "pass",
      question
        ? `The planner asked rather than guessed: "${question}"`
        : "The planner asked a clarifying question rather than guessing",
      { level: LEVELS.L4 },
    );
  }
  if (compose.ok !== true) {
    return result("compose", "fail", `Compose failed: ${compose.error ?? "unknown reason"}`, {
      level: LEVELS.L4,
    });
  }
  const messages = Array.isArray(compose.messages) ? compose.messages.length : 0;
  if (messages === 0) {
    return result("compose", "fail", "Compose succeeded and produced no messages to render", {
      level: LEVELS.L4,
      remedy:
        "A view with no messages is a surface with nothing in it. `ok: true` now " +
        "means at least one bound slot delivered, so this is the rarer case of a " +
        "plan that bound nothing at all — check the plan's nodes against the " +
        "published UI catalog.",
    });
  }
  // `ok: true` with `partial: true` is a real answer with a hole in it, and
  // saying so beats a clean tick over a view the visitor sees gaps in.
  if (compose.partial === true) {
    const failed = (compose.requests ?? []).filter((request) => request.ok === false);
    return result("compose", "warn", `Composed a partial view: ${messages} message(s)`, {
      level: LEVELS.L4,
      remedy:
        `${failed.length} of ${(compose.requests ?? []).length} data request(s) did not ` +
        `deliver: ${failed.map((request) => `${request.capabilityId} (${request.error})`).join("; ")}`,
    });
  }
  return result("compose", "pass", `Composed a view: ${messages} message(s)`, {
    level: LEVELS.L4,
  });
}

/** Local checks — repo only, no server needed. */
export function runLocalChecks(project) {
  return [
    checkScopeMapping(project),
    checkPackagesInstalled(project),
    checkNoToolsInstalled(project),
    ...checkMountDecisions(project),
    checkCatalogIdAgreement(project),
  ];
}

export { LEVELS };
