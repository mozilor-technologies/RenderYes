#!/usr/bin/env bash
# Prove the packed tarballs actually install and run outside this workspace.
#
# Usage: scripts/smoke-install.sh
#
# Every other test in this repo runs against the workspace, where pnpm links
# `workspace:*` to the source directory and every import resolves whether or not
# the package would survive being packed. That gap has already produced two
# failures a full green suite could not see:
#
#   - `pnpm pack` rewrites `workspace:*` to a plain version number, so a lone
#     tarball looks up its `@renderyes/*` siblings on the public registry and
#     404s. The error names the dependency, not the packing step, so it reads as
#     a missing package rather than as the wrong install command.
#   - A new export path (`./node`) can be declared in package.json and left out
#     of `files`, which resolves in the workspace and not from a tarball.
#
# So this installs into a scratch directory that has never seen this repo, and
# then does the smallest thing that requires the whole chain to be real: builds a
# server, mounts the handler, and serves one request.
#
# It does that twice, once per package manager. npm takes the whole tarball list
# in one command; pnpm resolves each spec independently and needs an override
# table instead, which `sync-local-packages.sh` writes. Checking only npm is how
# the pnpm path stayed broken while this script reported success — a real host
# on pnpm hit a 404 naming `@renderyes/capability-catalog`, a package it had
# never asked for.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARBALL_DIR="$ROOT_DIR/dist-packages"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> Packing tarballs"
bash "$ROOT_DIR/scripts/sync-local-packages.sh" > /dev/null

echo "==> [npm] Installing into a scratch project at $WORK_DIR/npm-host"
mkdir -p "$WORK_DIR/npm-host"
cd "$WORK_DIR/npm-host"
npm init -y > /dev/null
# All of them, in one command, which is the documented way and the only one that
# works — see the note at the top of sync-local-packages.sh.
npm install "$TARBALL_DIR/"*.tgz > /dev/null

echo "==> [npm] Importing and serving one request"
cat > smoke.mjs <<'NODE'
import { createViewServer, createViewHttpHandler } from "@renderyes/server";
import { toNodeHandler, createFileCatalogStore } from "@renderyes/server/node";
import { defineView, ingestViews, useViewCompose, ViewProvider } from "@renderyes/react";

for (const [name, value] of Object.entries({
  toNodeHandler,
  createFileCatalogStore,
  defineView,
  ingestViews,
  useViewCompose,
  ViewProvider,
})) {
  if (value === undefined) throw new Error(`${name} did not resolve from the installed tarball`);
}

const server = createViewServer({
  host: { isAuthenticated: () => true, hasPermission: () => true, getSessionValue: () => undefined },
  resolveSession: () => ({}),
  allowedUpstreamOrigins: ["https://api.example.com"],
});

const handler = createViewHttpHandler(server, { requireAdmin: () => true });
const response = await handler(new Request("http://localhost/api/providers"));
if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`);

const payload = await response.json();
if (payload.ok !== true) throw new Error(`expected ok:true, got ${JSON.stringify(payload)}`);

// The registries must survive a restart, which is the one behaviour that cannot
// be checked without touching a real filesystem.
createFileCatalogStore(new URL("./data", import.meta.url));
if ((await server.restorePublishedCatalogs()).failures.length !== 0) {
  throw new Error("restorePublishedCatalogs reported failures on an empty store");
}
NODE
node smoke.mjs

# The pnpm host. Shaped like a real one: a lockfile and a workspace file, so
# the override table has to land in pnpm-workspace.yaml rather than package.json
# — the placement that a manifest-only fix gets wrong silently, because pnpm
# reads the workspace file first and ignores the manifest's overrides entirely.
echo "==> [pnpm] Installing into a scratch pnpm project at $WORK_DIR/pnpm-host"
mkdir -p "$WORK_DIR/pnpm-host"
cd "$WORK_DIR/pnpm-host"
npm init -y > /dev/null
printf 'packages: []\n' > pnpm-workspace.yaml
touch pnpm-lock.yaml
bash "$ROOT_DIR/scripts/sync-local-packages.sh" --install "$WORK_DIR/pnpm-host" > /dev/null

if [ -f "package-lock.json" ]; then
  echo "A pnpm project was given an npm lockfile — two lockfiles, diverging installs." >&2
  exit 1
fi
if ! grep -q "^overrides:" pnpm-workspace.yaml; then
  echo "No override table in pnpm-workspace.yaml; the transitive deps will 404." >&2
  exit 1
fi

echo "==> [pnpm] Importing and serving one request"
cat > smoke.mjs <<'NODE'
import { createViewServer, createViewHttpHandler } from "@renderyes/server";
import { toNodeHandler, createFileCatalogStore } from "@renderyes/server/node";
import { defineView, ingestViews, useViewCompose, ViewProvider } from "@renderyes/react";

for (const [name, value] of Object.entries({
  toNodeHandler,
  createFileCatalogStore,
  defineView,
  ingestViews,
  useViewCompose,
  ViewProvider,
})) {
  if (value === undefined) throw new Error(`${name} did not resolve under pnpm`);
}

const server = createViewServer({
  host: { isAuthenticated: () => true, hasPermission: () => true, getSessionValue: () => undefined },
  resolveSession: () => ({}),
  allowedUpstreamOrigins: ["https://api.example.com"],
});

const handler = createViewHttpHandler(server, { requireAdmin: () => true });
const response = await handler(new Request("http://localhost/api/providers"));
if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`);
NODE
node smoke.mjs

# The state of a fresh clone, and of anyone deleting a lockfile to force a clean
# install: the packages are declared, and there is no lockfile to detect them by.
# This used to fall through every branch of the manager detection and skip with a
# warning while still reporting "Install complete." — the script did nothing and
# said it succeeded, which is the worst outcome available to it.
echo "==> [no lockfile] Installing into a declared-deps project with no lockfile"
mkdir -p "$WORK_DIR/nolock-host"
cd "$WORK_DIR/nolock-host"
npm init -y > /dev/null
# Declared exactly as a real consumer does, so FRESH_TARGET stays 0.
node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.dependencies = {
  "@renderyes/react": "file:'"$TARBALL_DIR"'/renderyes-react.tgz",
  "@renderyes/server": "file:'"$TARBALL_DIR"'/renderyes-server.tgz",
};
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2));
'
rm -f package-lock.json pnpm-lock.yaml yarn.lock
bash "$ROOT_DIR/scripts/sync-local-packages.sh" --install "$WORK_DIR/nolock-host" > /dev/null

if [ ! -d "node_modules/@renderyes/react" ]; then
  echo "No lockfile meant no install: the script skipped and reported success." >&2
  exit 1
fi

echo "==> [no lockfile] Importing the two direct dependencies"
cat > smoke.mjs <<'NODE'
// Only the direct dependencies. Probing a transitive package from the app root
// passes only while hoisting happens to lift it there, and hoisting is not a
// contract — importing react evaluates the rest anyway.
import { createViewServer } from "@renderyes/server";
import { ViewProvider } from "@renderyes/react";
if (!createViewServer || !ViewProvider) throw new Error("direct dependency did not resolve");
NODE
node smoke.mjs

# A declared packageManager must win over the npm default, or a pnpm project
# that lost its lockfile gets a package-lock.json written into it.
echo "==> [packageManager] A declared manager decides, with no lockfile present"
mkdir -p "$WORK_DIR/declared-host"
cd "$WORK_DIR/declared-host"
npm init -y > /dev/null
node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.packageManager = "pnpm@10.20.0";
pkg.dependencies = {
  "@renderyes/react": "file:'"$TARBALL_DIR"'/renderyes-react.tgz",
};
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2));
'
bash "$ROOT_DIR/scripts/sync-local-packages.sh" --install "$WORK_DIR/declared-host" > /dev/null

if [ -f "package-lock.json" ]; then
  echo "A declared pnpm project was given an npm lockfile." >&2
  exit 1
fi

echo "==> Smoke install passed (npm, pnpm, no-lockfile, declared packageManager)"
