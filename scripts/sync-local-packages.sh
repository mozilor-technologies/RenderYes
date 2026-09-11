#!/usr/bin/env bash
# Pack the @renderyes/* packages into stable, version-less tarballs so a
# consumer's package.json `file:` references never need hand-editing again after
# a package version bump, and optionally install them into a consuming app.
#
# Usage:
#   scripts/sync-local-packages.sh                    # just refresh the tarballs
#   scripts/sync-local-packages.sh --install          # ...and install into the default consumers
#   scripts/sync-local-packages.sh --install <dir>... # ...and install into these apps instead
#
# IMPORTANT for anyone installing these by hand: install the tarballs *together*,
# in one command — and only npm can be handed them that way.
#
#   npm install /path/to/dist-packages/*.tgz          # works
#   npm install /path/to/dist-packages/renderyes-server.tgz   # 404s
#   pnpm add ./dist-packages/*.tgz                    # ALSO 404s — see below
#
# `pnpm pack` rewrites each `workspace:*` dependency to a plain version number,
# so a lone tarball's transitive `@renderyes/*` deps get looked up on the
# public registry, where nothing is published. The error names the dependency
# ("@renderyes/capability-catalog@0.2.0 is not in this registry") rather than
# the packing step, so it reads as a missing package rather than as the wrong
# install command. Naming them all at once satisfies every reference locally —
# but only under npm, which resolves the argument list as one set. pnpm
# resolves each tarball independently, so its siblings 404 regardless; a pnpm
# host needs `overrides` remapping every package name to a tarball instead.
# The install loop below detects the target's package manager and does the
# right one; docs/QUICKSTART.md documents both shapes for hand-installs.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Repo-local, not /tmp. A consumer's package.json has to name this path, and
# `/tmp` made that path eight `../` segments long, machine-specific, and
# liable to vanish — a temp directory is not somewhere a committed dependency
# reference should point. Inside the repository and git-ignored: this used to
# resolve to the repository's *parent*, which wrote build output beside the
# checkout instead of into it.
TARBALL_DIR="$ROOT_DIR/dist-packages"
# Apps to install into when `--install` is given with no directories.
#
# These are this checkout's own test hosts, and they exist only as a default —
# pass your own directories after `--install` and these are ignored entirely.
# They used to be the *only* option, hardcoded, which made this script useless
# to anyone who cloned the repo: it packed the tarballs, then tried to install
# them into two paths that exist on one machine.
#
# There is no default any more. It used to name two directories that existed on
# one machine, which is the failure this comment already describes: for everyone
# else the script packed tarballs and then tried to install them into paths that
# were not there. Name your own consuming app after `--install`.
#
# Install into *both* halves if your integration has two — a package change that
# reaches the browser and not the host server it talks to fails in ways that look
# like the frontend's fault.
DEFAULT_CONSUMER_DIRS=()

# Package names as declared in each package's package.json ("name" field).
# Every package a consumer app can install, not just the browser-side ones.
# `server` and `planner` were missing, so a host running the backend pointed at
# a tarball this script never produced — the path resolved to nothing and the
# install failed with no indication that the packing step was the gap.
PACKAGES=(
  "@renderyes/capability-catalog"
  "@renderyes/core"
  "@renderyes/data-runtime"
  "@renderyes/planner"
  "@renderyes/react"
  "@renderyes/server"
  "@renderyes/site-sdk"
  "@renderyes/starter-catalog"
)

# Packed but never installed into a consumer: tools a host *runs*, not
# libraries it imports. `catalog-review` ships a bin (`npx
# @renderyes/catalog-review`) and was documented as installable before
# anything produced a tarball for it, so the documented command had nothing to
# resolve. Adding it to PACKAGES above would have fixed the packing and put a
# build-time GUI into every consumer's node_modules, which is the opposite of
# what a runtime dependency list should mean.
#
# `generate` and `init` joined the list for exactly the reason above: both are
# documented as `npx @renderyes/...` commands — the wizard in QUICKSTART §1,
# the component drafter in §3 — and nothing here packed either, so the
# documented command had nothing to resolve in a vendored test.
TOOL_PACKAGES=(
  "@renderyes/catalog-review"
  "@renderyes/generate"
  "@renderyes/init"
)

DO_INSTALL=0
CONSUMER_DIRS=()
for arg in "$@"; do
  case "$arg" in
    --install)
      DO_INSTALL=1
      ;;
    --)
      # pnpm forwards a literal "--" separator when invoked as
      # `pnpm sync:local -- --install`; ignore it.
      ;;
    -*)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--install] [consumer-dir...]" >&2
      exit 1
      ;;
    *)
      # A target app to install into. Resolved to an absolute path now, because
      # the install loop below cd's between directories and a relative path
      # would then mean something different on each iteration.
      if [ ! -d "$arg" ]; then
        echo "Not a directory: $arg" >&2
        exit 1
      fi
      CONSUMER_DIRS+=("$(cd "$arg" && pwd)")
      ;;
  esac
done

# Naming directories without --install would silently do nothing, which is the
# failure mode this script already had once.
if [ "$DO_INSTALL" -eq 0 ] && [ "${#CONSUMER_DIRS[@]}" -gt 0 ]; then
  echo "Directories were given without --install, so nothing would be installed." >&2
  echo "Usage: $0 --install ${CONSUMER_DIRS[0]}" >&2
  exit 1
fi

if [ "$DO_INSTALL" -eq 1 ] && [ "${#CONSUMER_DIRS[@]}" -eq 0 ]; then
  echo "--install needs at least one directory to install into." >&2
  echo "Usage: $0 --install /path/to/your-app [/path/to/another]" >&2
  exit 1
fi

mkdir -p "$TARBALL_DIR"

cd "$ROOT_DIR"

# Build before packing. `pnpm pack` does not build — it tars whatever is in each
# package's `files` list, which is `dist`. So a package whose source changed but
# whose dist was never rebuilt packs the *previous* build, silently, and the
# tarball looks perfectly fresh: right filename, right mtime, right version.
#
# The symptom lands in the consumer's browser as "x is not a function" for an
# export that plainly exists in the source, which sends whoever is debugging it
# to the consumer, then to the install, then to the tarball — three places that
# are all fine — before anyone suspects the build. That has now cost a debugging
# session twice, so this runs unconditionally rather than being left to whoever
# remembers.
echo "==> Building all packages"
pnpm -r --filter "./packages/**" build

for pkg in "${PACKAGES[@]}" "${TOOL_PACKAGES[@]}"; do
  slug="${pkg#@renderyes/}"
  stable="$TARBALL_DIR/renderyes-${slug}.tgz"
  echo "==> Packing $pkg -> $stable"
  # --out with a full path writes the tarball directly under a stable,
  # version-less filename, so package.json file: references never need to
  # change again just because a package's version number bumped.
  pnpm --filter "$pkg" pack --out "$stable"
done

echo "==> All tarballs refreshed in $TARBALL_DIR"
echo "    Reference them from a consumer as, e.g.:"
echo "      \"@renderyes/react\": \"file:<relative path to dist-packages>/renderyes-react.tgz\""
echo
echo "    On pnpm or Yarn, override EVERY package, not only the ones you import."
echo "    Packing rewrites \`workspace:*\` to plain registry ranges, so a sibling"
echo "    dependency like \`@renderyes/core\` is looked up on the registry and 404s"
echo "    unless it is overridden too:"
for pkg in "${PACKAGES[@]}"; do
  slug="${pkg#@renderyes/}"
  echo "      \"$pkg\": \"file:<dir>/renderyes-$slug.tgz\""
done
echo "    (\`--install\` writes this table for you.)"

if [ "$DO_INSTALL" -eq 1 ]; then
  for CONSUMER_DIR in "${CONSUMER_DIRS[@]}"; do
    if [ ! -d "$CONSUMER_DIR" ]; then
      echo "Consumer app not found at $CONSUMER_DIR; skipping." >&2
      continue
    fi

    echo "==> Installing refreshed tarballs in $CONSUMER_DIR"
    cd "$CONSUMER_DIR"

    # A plain `npm install` is not enough. The tarball path and the package
    # version are both unchanged, so npm considers the lockfile entry satisfied
    # and leaves the *old* extracted copy in node_modules — it prints "up to
    # date" and installs nothing. That is the worst possible failure here: the
    # script reports success, and the consumer keeps building against a stale
    # package until someone wonders why a newly added export can't be resolved.
    #
    # Naming each tarball explicitly with --force makes npm re-extract it.
    # --no-save because package.json already declares these as `file:`
    # dependencies at exactly these paths; this refreshes what's installed
    # without rewriting the manifest.
    # Whether this consumer already declares any of them, which decides `--save`
    # below. Not which tarballs to install: that is always all of them.
    DECLARED_COUNT=0
    for pkg in "${PACKAGES[@]}"; do
      if grep -q "\"$pkg\"" package.json; then
        DECLARED_COUNT=$((DECLARED_COUNT + 1))
      fi
    done

    # Every tarball, not the declared subset. `pnpm pack` rewrote each
    # `workspace:*` dependency to a plain version number, so a consumer
    # declaring only react and server has transitive references to
    # `@renderyes/core@0.1.0` and friends that resolve against the public
    # registry, where nothing is published.
    #
    # Passing the subset appeared to work for as long as a lockfile already
    # recorded those siblings from an earlier install. On a genuinely clean
    # install it 404s on a package the consumer never named and cannot fix — the
    # failure this script's own header documents, reintroduced by filtering.
    # `--no-save` keeps the manifest honest: the six extras land in node_modules
    # because they are needed there, not in package.json as if a host chose them.
    specs=()
    for pkg in "${PACKAGES[@]}"; do
      specs+=("$TARBALL_DIR/renderyes-${pkg#@renderyes/}.tgz")
    done

    # A consumer that declares none of them is a *new* target — someone wiring
    # RenderYes into an app for the first time. Refusing to install anything
    # was right when the only consumers were this checkout's own two apps and an
    # empty result meant a typo; it is wrong now that a directory can be named on
    # the command line, where it turns the intended use of this script into a
    # no-op with a confusing message.
    #
    # All of them, not just react and server: `pnpm pack` rewrote every
    # `workspace:*` to a plain version, so a subset resolves its siblings against
    # the public registry and 404s. Only react and server are meant to be
    # imported; the rest are here to satisfy those rewritten references.
    FRESH_TARGET=0
    if [ "$DECLARED_COUNT" -eq 0 ]; then
      echo "    No @renderyes/* dependencies declared here — installing all of them."
      FRESH_TARGET=1
    fi

    # Which package manager the target uses, decided before anything is
    # installed. Getting this wrong writes a package-lock.json into a pnpm
    # project: two lockfiles, and installs that drift from what CI resolves.
    # That happened to a real host, because the fresh-target branch below used
    # to run `npm install` unconditionally and was checked *before* the
    # lockfile branches, so a pnpm app that had not yet declared the packages
    # got npm regardless of its lockfile.
    #
    # A lockfile is an artifact, so it is the wrong *only* signal: a fresh clone
    # has none (they are commonly gitignored), and forcing a clean install means
    # deleting one deliberately. This used to fall through every branch in that
    # case — the fresh-target branch does not fire, because package.json already
    # declares the packages — and skip with a warning while still reporting
    # "Install complete." The script did nothing and said it succeeded.
    #
    # `packageManager` is checked first because it is a *declaration* and
    # survives exactly that case. node_modules evidence comes next: an existing
    # .pnpm store is proof of what installed here, whatever is missing now.
    # Guessing npm for a pnpm project is what writes a second lockfile into it.
    DECLARED_PM="$(node -e 'try{const p=require("./package.json").packageManager;if(p)process.stdout.write(String(p).split("@")[0])}catch{}' 2>/dev/null || true)"

    if [ "$DECLARED_PM" = "pnpm" ] || [ "$DECLARED_PM" = "yarn" ] || [ "$DECLARED_PM" = "npm" ]; then
      TARGET_PM="$DECLARED_PM"
    elif [ -f "pnpm-lock.yaml" ] || [ -f "pnpm-workspace.yaml" ]; then
      TARGET_PM="pnpm"
    elif [ -f "yarn.lock" ]; then
      TARGET_PM="yarn"
    elif [ -f "package-lock.json" ]; then
      TARGET_PM="npm"
    elif [ -d "node_modules/.pnpm" ]; then
      TARGET_PM="pnpm"
    elif [ -f "node_modules/.yarn-state.yml" ]; then
      TARGET_PM="yarn"
    else
      # Nothing declares or evidences a manager. npm is the default for the same
      # reason it is for a brand new directory: it is the one manager that takes
      # the whole tarball list in one command. Said out loud, because it is a
      # guess and the consequence of a wrong one is a second lockfile.
      TARGET_PM="npm"
      if [ "$FRESH_TARGET" -eq 0 ]; then
        echo "    No lockfile and no packageManager field — assuming npm." >&2
        echo "    If this is a pnpm or Yarn project, add a packageManager field" >&2
        echo "    to package.json so this is not a guess." >&2
      fi
    fi

    case "$TARGET_PM" in
      npm)
        if [ "$FRESH_TARGET" -eq 1 ]; then
          # Saved, not --no-save: nothing declares these yet, so without writing
          # them into package.json the next plain `npm install` would remove them.
          npm install --save "${specs[@]}"
        else
          npm install --no-save --force "${specs[@]}"
        fi
        ;;
      pnpm | yarn)
        # pnpm and Yarn resolve each dependency spec independently, so handing
        # them the tarball list does not satisfy the rewritten `workspace:*`
        # references the way npm's single-set resolution does — every sibling
        # is looked up on the registry and 404s. The fix is an override table
        # mapping every package name to a local tarball, so a transitive
        # `@renderyes/core@0.2.0` resolves to a file too.
        node "$ROOT_DIR/scripts/write-local-overrides.mjs" "$TARBALL_DIR" "$TARGET_PM" \
          "${PACKAGES[@]}"
        if [ "$TARGET_PM" = "pnpm" ]; then
          pnpm install
        else
          yarn install
        fi
        ;;
    esac

    echo "    Installed ${#specs[@]} package(s)."
    if [ "$FRESH_TARGET" -eq 1 ]; then
      echo "    Import from @renderyes/react (frontend) and @renderyes/server"
      echo "    (backend). The rest are transitive — see docs/QUICKSTART.md."
    fi

    # Vite pre-bundles dependencies into node_modules/.vite/deps and keys the
    # cache on the manifest and lockfile. Refreshing a tarball changes neither
    # — the path and version are identical — so Vite happily keeps serving the
    # *previous* pre-bundle of a package that has just been replaced under it.
    #
    # The failure is baffling in the browser and nowhere else: the installed
    # dist exports the new method, TypeScript resolves it, the build succeeds,
    # and the running dev server throws "x is not a function" from a file it
    # pre-bundled hours ago. Same shape as the npm "up to date" problem above,
    # one layer further down.
    if [ -d "node_modules/.vite" ]; then
      rm -rf "node_modules/.vite"
      echo "    Cleared Vite's pre-bundled dep cache (restart the dev server)."
    fi
  done

  echo "==> Install complete."
  echo "    Restart any running host server: it holds its packages in memory,"
  echo "    so a refreshed tarball does nothing until the process is replaced."
fi
