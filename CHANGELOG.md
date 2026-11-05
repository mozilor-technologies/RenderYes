# Changelog

All eleven public `@renderyes/*` packages release together at one version.
[Changesets](https://github.com/changesets/changesets) generates per-package
changelogs from the changeset files committed with each pull request.

## 0.2.0

System One: a small classifier that decides what a visitor asked for with no
language model. `@renderyes/server` gains a System One plan provider; its
uncertain band asks the visitor to choose instead of refusing; and it answers
follow-ups (a panel added to the view, "as a table", compound prompts, host
rules) without a model. The planning context carries `previousPlan`, and
`@renderyes/react` puts a × on each panel of a multi-panel view. A self-host
container recipe and an optional fine-tuning guide ship alongside. See each
package's changelog for details.

## 0.1.1

First release published through npm trusted publishing, so every tarball
carries provenance. No functional change to any package.

## 0.1.0

Initial public release.
