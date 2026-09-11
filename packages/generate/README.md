# @renderyes/generate

A dev-time CLI that has a model draft a bespoke, host-styled component from your
approved data contract, verifies it mechanically, and emits a reviewable diff.

It **never registers anything**. You read the diff and register the component
yourself, exactly as you would hand-written code, and the model is never called
again at build time or at runtime.

Optional. Nothing else in RenderYes depends on it — it exists because writing
the first component against an unfamiliar data contract is the slowest part of
an integration, not because generated components are better than yours.

## Install

A dev dependency **in your frontend project**: it declares `react`/`react-dom`
peers and reads your existing components and stylesheets to match them.

```bash
npm install --save-dev @renderyes/generate
```

## Use

Point it at a capability and the decisions file that approved it:

```bash
npx --package @renderyes/generate renderyes-generate component \
  --capability books.list \
  --schema ./schema.graphql \
  --decisions ./decisions.json \
  --inventory ./inventory.json \
  --host-dir . \
  --out ./generated --write
```

Or, if you exported a review bundle from the review UI, the one flag replaces
the three:

```bash
npx --package @renderyes/generate renderyes-generate component \
  --capability books.list --export ./review-export.json --out ./generated --write
```

Requires a model API key read from an environment variable: `OPENAI_API_KEY` by
default, or the variable named by `--api-key-env`.

## What it emits

Into `--out`, or to stdout without it:

| Artifact | What it is |
|---|---|
| the component `.tsx` | the draft, in your project's idiom |
| `registration.patch` | the `defineHostComponent` call to add, as a diff — **only** when your tree registers components inline and a registration file is found; the report says so when it is not emitted |
| `preview.html` | the draft rendered against sample rows, openable in a browser |
| `authoring-lint` | what the mechanical checks found |
| `coverage-delta` | which data types gained a component, and which still have none |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | generated, and every mechanical check passed |
| `1` | artifacts emitted, verification failing — read the report before registering |
| `2` | usage error or refusal; nothing generated, nothing written |

`1` is the interesting one: the draft exists and is wrong in a way a check
caught. That is the intended outcome for a hard contract, not a failure of the
run.

## Options

Run `renderyes-generate component --help` for the authoritative list.

| Flag | |
|---|---|
| `--capability <id>` | which approved capability the component renders. Required |
| `--export <file>` | a review-export bundle, instead of `--schema`/`--decisions` |
| `--schema <file>` `--decisions <file>` | the GraphQL schema and the decisions that approved it |
| `--inventory <file>` | the inventory those decisions were derived from |
| `--catalog-id <id>` | when there is no inventory: derive one, with `--source-label`, `--queries`, `--depth`, `--scalars` |
| `--host-dir <dir>` | root of your project, for style detection. Defaults to the working directory |
| `--style <file>` | explicit style-corpus files, replacing detection. Repeatable |
| `--convention auto\|folder\|listed` | where generated components belong in your tree |
| `--id <ComponentId>` | component id. Defaults to one derived from the data type |
| `--provider openai\|gemini\|mock` | defaults to `openai` |
| `--model <model>` `--api-key-env <NAME>` `--base-url <url>` | provider configuration |
| `--timeout <seconds>` | ceiling per model call. Defaults to 480, because whole-component drafts routinely exceed a provider's generic 60s |
| `--mock-file <file>` | scripted envelopes, with `--provider mock` |
| `--rounds <n>` | repair rounds after the first draft. Defaults to 2 |
| `--out <dir>` | write artifacts here instead of stdout |
| `--write` | allow `--out` to overwrite existing files |

## A known gap

Style detection reads `.css`. A project whose design tokens live in `.scss`, a
`theme.ts`, or styled-components is reported as having no tokens, which silently
disables the check that would otherwise catch an invented palette. Pass
`--style` explicitly on such a project, and read the draft's colours yourself.
