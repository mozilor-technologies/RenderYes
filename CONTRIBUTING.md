# Contributing

Thanks for considering it. RenderYes sits on a host's security boundary, so
changes here get read closely — that is the bar, not a comment on any
particular patch.

## The model

Fork, branch, open a pull request against `main`. Maintainers review and merge;
releases are cut by maintainers only. Please open an issue before starting
anything large, so we can agree the shape before you spend the time.

CI runs on every pull request. Runs from a fork need a maintainer to approve
them, so the first check on your first PR may sit pending for a while.

## What has to pass

`pnpm check` must be green — the command block lives in
[`README.md`](README.md#development), which is its single copy. For anything touching a package's exports, its
`files` list, or the packaging scripts, also run:

```bash
pnpm smoke:install
```

That packs the tarballs, installs them into scratch npm and pnpm projects, and
serves a real request through each. It is the only check that exercises the
packed artifacts — everything else runs inside the workspace, where pnpm links
`workspace:*` to source and an import resolves whether or not the package would
survive being packed.

## Before you open the PR

- Run `pnpm changeset` and commit the file it writes. It records which
  packages you changed and how, and it is what the changelog is built from.
  A change nobody releases can use `pnpm changeset --empty`.
- Read [`AGENTS.md`](AGENTS.md). It is the operating brief for this repository
  and it is short.
- Documentation and examples must match actual behaviour. A change that makes a
  doc wrong is not finished.
- Each doc has one job — see the documentation map in
  [`README.md`](README.md). Put a new paragraph where its subject lives rather
  than where you happened to be reading.

## Developing the packages themselves


You need Node.js 22+ and pnpm 10.

```bash
pnpm install
pnpm check          # typecheck + lint + test + build
```

That is the whole development loop. `pnpm smoke:install` additionally packs the
tarballs, installs them into a scratch directory, and serves one request through
them — worth running after changing any package's exports or its `files` list,
because nothing else exercises the packed artifacts.

To try local changes inside a real app, install packed tarballs instead of the
registry build:

```bash
pnpm sync:local --install /path/to/your-app
```

This detects your app's package manager and does the right thing for it. The
"right thing" differs, and the difference is not cosmetic — the npm recipe
fails outright under pnpm and Yarn, because `pnpm pack` rewrites each
`workspace:*` link to a plain version number that the install then asks the
registry for.

### npm

npm resolves an argument list as one set, so naming every tarball in a single
command satisfies each rewritten reference locally:

```bash
npm install /path/to/dist-packages/*.tgz                     # works
npm install /path/to/dist-packages/renderyes-server.tgz    # 404s
```

### pnpm and Yarn

Both resolve each dependency spec independently, so the same one-command trick
still sends every sibling to the registry:

```bash
pnpm add ./dist-packages/*.tgz     # ERR_PNPM_FETCH_404 — the list does not help
```

Redirect the names instead. Declare only the two packages you import, and
override every `@renderyes/*` name so transitive references resolve to
tarballs too:

```jsonc
// package.json
{
  "dependencies": {
    "@renderyes/react": "file:../dist-packages/renderyes-react.tgz",
    "@renderyes/server": "file:../dist-packages/renderyes-server.tgz"
  },
  "pnpm": {
    "overrides": {
      "@renderyes/capability-catalog": "file:../dist-packages/renderyes-capability-catalog.tgz",
      "@renderyes/core": "file:../dist-packages/renderyes-core.tgz",
      "@renderyes/data-runtime": "file:../dist-packages/renderyes-data-runtime.tgz",
      "@renderyes/planner": "file:../dist-packages/renderyes-planner.tgz",
      "@renderyes/react": "file:../dist-packages/renderyes-react.tgz",
      "@renderyes/server": "file:../dist-packages/renderyes-server.tgz",
      "@renderyes/site-sdk": "file:../dist-packages/renderyes-site-sdk.tgz",
      "@renderyes/starter-catalog": "file:../dist-packages/renderyes-starter-catalog.tgz"
    }
  }
}
```

Yarn reads the same table as `resolutions` at the top level of `package.json`.

**If your app has a `pnpm-workspace.yaml`, the overrides go there instead**, as a
top-level `overrides:` block. pnpm 10.4+ reads overrides from the workspace file
when it declares them, and the workspace file wins — so a table written into
`package.json` while `pnpm-workspace.yaml` also has one is silently ignored, and
the install 404s on a package that is plainly overridden a few lines above.

`pnpm sync:local --install` writes whichever of these three the target needs.

### Release-age policies

If your app sets `minimumReleaseAge` (pnpm) or an equivalent supply-chain guard,
the install can fail with `ERR_PNPM_NO_MATURE_MATCHING_VERSION` pointing at
`@a2ui/web_core`, not at anything named `@renderyes`.

`@renderyes/react` accepts `@a2ui/web_core >=0.10.5 <0.11.0`. The policy fails
when every version available in that range is newer than the configured age
threshold. Add A2UI to `minimumReleaseAgeExclude`, or lower the threshold for
this install.

## Releasing

Maintainers only. All eleven public packages release together at one version —
`.changeset/config.json` fixes them into a single group, and `pnpm check` fails
if they ever disagree.

```bash
pnpm changeset version   # consumes the pending changesets, bumps all eleven
pnpm install             # refreshes the lockfile after the bumps
pnpm check
git commit -am "Release X.Y.Z"
git tag vX.Y.Z && git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which re-runs `pnpm check` and
`pnpm smoke:install` before publishing and waits for an approval on the `release`
environment. A tag that disagrees with the manifests fails there rather than
publishing — versions cannot be reused, so the gate is worth the wait.
