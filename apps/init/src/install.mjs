/**
 * Installing through the host's own package manager.
 *
 * Never a hardcoded `npm install`: running the wrong manager inside a pnpm
 * workspace leaves a stray lockfile and a flat `node_modules` that shadows the
 * store, and the failure surfaces later looking unrelated. The manager comes
 * from the lockfile, and an undetectable one is reported rather than guessed.
 *
 * Nothing from the tools tier is ever installed. This package, and the review
 * app, are invoked with npx — installing either puts a scaffolder or a
 * build-time GUI into a deployed application.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BACKEND_PACKAGES,
  FRONTEND_OPTIONAL,
  FRONTEND_PACKAGES,
} from "./detect.mjs";

export const ADD_COMMAND = Object.freeze({
  npm: (packages) => ["install", ...packages],
  // The flag as well as the environment variable, not instead of it. An
  // install on pnpm 11.21 took a build 30 hours older than the one it was
  // handed while `npm_config_minimum_release_age` was set, and then reported
  // "Already up to date" — the environment form is honoured on pnpm 10 and was
  // not enough there. This form parses and installs on pnpm 10.23; whether it
  // is the one pnpm 11 honours has not been verified against pnpm 11 here.
  pnpm: (packages) => ["add", "--config.minimumReleaseAge=0", ...packages],
  yarn: (packages) => ["add", ...packages],
  bun: (packages) => ["add", ...packages],
});

export function packagesFor(role, { includeStarter = true } = {}) {
  const packages = [];
  if (role === "frontend" || role === "both") {
    packages.push(...FRONTEND_PACKAGES);
    if (includeStarter) packages.push(...FRONTEND_OPTIONAL);
  }
  if (role === "backend" || role === "both") {
    packages.push(...BACKEND_PACKAGES);
  }
  // Deduped: `site-sdk` is in both tiers because both halves import it, and
  // role `both` would otherwise name it twice — on the install command line,
  // in the dry-run plan, and in every check that counts what is missing.
  return [...new Set(packages)];
}

export const INSTALL_TIMEOUT_MS = 10 * 60_000;

export function installPackages(
  project,
  role,
  { dryRun = false, timeoutMs = INSTALL_TIMEOUT_MS, into, packages } = {},
) {
  // `into` is for the standalone topology, where the server runs from its own
  // directory with its own package.json. Installing its dependency at the host
  // root put `@renderyes/server` where the service could not import it, and
  // `npm start` in that directory failed on the first line — after a wizard run
  // that reported success.
  const directory = into ?? project.root;
  const wanted =
    packages ??
    packagesFor(role).filter(
      (name) =>
        // The parent having it does not mean this directory does. A standalone
        // service has its own manifest and is deployed on its own, so a package
        // the parent installed is not one the service can rely on — and a
        // tarball install into the parent left the service with an empty
        // manifest and a working import, by directory walk, until it moved.
        directory !== project.root || !project.dependencies[name],
    );
  if (wanted.length === 0) {
    return { ok: true, skipped: true, summary: "Every package is already installed" };
  }
  if (!project.packageManager) {
    // A lockfile is the only honest signal of which manager a project uses, and
    // running the wrong one in a workspace leaves damage that outlives the
    // install — so this refuses rather than guessing. With one exception: a
    // directory holding nothing but a fresh `package.json` has no workspace to
    // damage and no manager to get wrong, which is exactly what a host with a
    // non-Node backend has after being told to make one. Refusing there closed
    // the only door this tool had just opened.
    const untouched =
      Object.keys(project.dependencies ?? {}).length === 0 &&
      !existsSync(join(directory, "node_modules"));
    if (!untouched) {
      return {
        ok: false,
        summary: "No lockfile, so the package manager is unknown",
        remedy: `Install these yourself, with whatever this project uses: ${wanted.join(" ")}`,
      };
    }
  }
  const packageManager = project.packageManager ?? "npm";

  const args = ADD_COMMAND[packageManager](wanted);
  const command = `${packageManager} ${args.join(" ")}`;
  if (dryRun) return { ok: true, dryRun: true, summary: `Would run: ${command}` };

  const run = spawnSync(packageManager, args, {
    cwd: directory,
    stdio: "inherit",
    // Windows resolves package managers through shell shims.
    shell: process.platform === "win32",
    // A backstop, not a deadline. `stdio: "inherit"` is deliberate — a person
    // watching can answer a prompt — but nobody is watching under `--yes` or in
    // CI, and a package manager waiting on an answer it will never get is
    // indistinguishable from a slow install. It waited forever.
    //
    // Generous, because a cold install of this set genuinely takes minutes and
    // killing a real one halfway is its own kind of damage.
    timeout: timeoutMs,
    env: childEnvironment(packageManager),
  });
  if (run.error?.code === "ETIMEDOUT" || run.signal === "SIGTERM") {
    return {
      ok: false,
      summary: `\`${command}\` was still running after ${Math.round(timeoutMs / 60_000)} minutes and was stopped`,
      remedy:
        "Almost always a prompt with nobody to answer it — a build-script " +
        "approval, or a registry login that has expired. Run the command yourself " +
        "so you can see and answer it:\n" +
        `  ${command}\n` +
        "Then re-run this; it picks up from the first thing that is not true yet.",
    };
  }
  if (run.status !== 0) {
    return {
      ok: false,
      summary: `\`${command}\` exited with ${run.status ?? "a signal"}`,
      remedy:
        "A 401 here is usually an expired registry auth token — re-run your " +
        "organization's registry login. A 404 naming a @renderyes package means " +
        "the scope mapping is missing or points at public npm.",
    };
  }
  return {
    ok: true,
    summary: `Installed ${wanted.length} package(s)${into ? ` into ${into}` : ""}`,
    // Said out loud, because it was done on the host's behalf and it outlives
    // this command. `minimumReleaseAge` is a supply-chain gate a host sets
    // deliberately; this install steps around it to reach a build published
    // minutes ago. On a host that had one, the *next* ordinary pnpm command
    // failed its policy check over the lockfile this install had just written,
    // with an error suggesting someone had bypassed the gate by hand.
    ...(packageManager === "pnpm"
      ? {
          note:
            "Installed with pnpm's minimumReleaseAge set to 0, so a just-published " +
            "build could be resolved. If this project sets that gate, your next pnpm " +
            "command may refuse the lockfile this wrote. Exempt the @renderyes scope " +
            "in pnpm-workspace.yaml to keep the gate for everything else.",
        }
      : {}),
  };
}

/**
 * The child's environment, with one setting overridden for pnpm.
 *
 * `minimumReleaseAge` makes pnpm refuse versions published in the last N
 * minutes. It is a good default against a compromised publish and exactly wrong
 * here: the build a tester is being handed was published minutes ago, on
 * purpose, and pnpm silently resolves to an older one or none at all. The
 * symptom is a version that does not match what they were told to install.
 *
 * Set through the environment *and* through pnpm's own flag. The environment
 * form alone was chosen because an unknown variable is inert everywhere while
 * an unknown flag is a parse error on some managers — but it was observed doing
 * nothing on pnpm 11.21, so the flag is passed too, on the pnpm command only.
 * npm, yarn and bun never see either.
 */
function childEnvironment(packageManager) {
  if (packageManager !== "pnpm") return process.env;
  return { ...process.env, npm_config_minimum_release_age: "0" };
}
