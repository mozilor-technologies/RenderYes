# AGENTS.md

This file applies to the entire repository. It is the operating brief for coding agents and human contributors.

## Start here

Before making product or architectural changes, read:

1. `README.md`
2. `docs/PRODUCT.md`
3. `docs/ARCHITECTURE.md`

If implementation and documentation disagree, do not quietly choose one. Preserve safe behavior, identify the conflict, and update the relevant decision record as part of the change.

Product mission and product character live solely in `docs/PRODUCT.md`; this file is contributor operating rules only.

## Non-negotiable principles

1. **AI where it earns its place; deterministic code where correctness is non-negotiable.** Use an LLM freely to interpret intent and compose a `Plan`, and for semantic revisions. Keep authorization, data fetching, validation, binding, rendering, and persistence in ordinary code. AI interprets and proposes; deterministic code authorizes, fetches, validates, binds, renders, and persists.
2. **Publisher-funded B2B2C model.** The website owner is the integrating customer and controls budgets, policies, content, and capabilities. Visitors do not supply API keys.
3. **User-directed personalization.** Visitors state their intent explicitly. Do not reduce the product to company-directed audience segmentation.
4. **Constrained composition.** Models may select approved components and produce validated structured manifests. They must not generate executable production UI code.
5. **Grounded output.** Facts, prices, policies, eligibility, and product claims must resolve to approved sources. Unsupported facts must not be presented as authoritative.
6. **Progressive integration.** The first useful experience requires the host to register a capability catalog and a UI catalog. Optional extensions include assisted registration, live-data resolvers, private data, and actions.
7. **Reversible enhancement.** The full website is always reachable. The custom view must not destructively rewrite or break the original page.
8. **Deterministic interaction.** Sorting, filtering, calculation, rendering, persistence, and ordinary UI changes should use normal code rather than repeated model calls.
9. **Save intent, not generated HTML.** Saved views store a versioned intent and view manifest, then resolve against current content when reopened.
10. **Safe actions.** Read-only composition comes first. Sensitive or state-changing operations require explicit registration, server-side authorization, validation, confirmation, and auditing.
11. **Accessible by construction.** Prefer publisher-owned or tested components over unconstrained markup generation.
12. **Privacy by default.** Do not train on visitor prompts or retain personal intent without explicit product policy and consent.

Do not expand the product into arbitrary code generation, autonomous purchasing, cross-site
browsing, crawler-based onboarding, or a replacement CMS without an explicit decision update. The
current product boundary is stated in `docs/PRODUCT.md` under "Explicit non-goals".

## Engineering decision rubric

For any substantial feature, answer:

- How does this reduce owner or visitor friction?
- Can deterministic software solve it more reliably than a model?
- What is the trusted source for every displayed fact?
- What happens when extraction, retrieval, planning, or rendering fails?
- Can the owner bound cost and disable the feature safely?
- Can the visitor understand, revise, and undo the result?
- Does the full website continue to work without this feature?
- How will we measure whether this improves task completion?

Prefer the smallest reversible implementation that satisfies the documented product scope.

## Technical guardrails

- Keep intent planning, policy enforcement, data resolution, and rendering as separable stages.
- **The model emits a `Plan` only, never identity.** Beyond the constrained-composition rule (principle 4), the model never fetches data, never sees raw records, and never sets identity/authorization params — those are declared in the capability catalog and injected by the executor from session context. Enforce at the type level, not by convention.
- **A valid `Plan` must render with zero AI.** Build and test the hand-authored/deterministic path before the planner.
- Validate every model-produced manifest against a versioned schema and publisher policy.
- Use stable source identifiers so saved views can be refreshed and migrated.
- Isolate the overlay from host-page CSS and JavaScript through a Web Component, Shadow DOM, iframe, or an equivalently explicit boundary.
- Never expose model or indexing credentials in the browser.
- Enforce authorization server-side for private data and actions.
- Attach provenance and freshness metadata to factual blocks.
- Treat retrieved or extracted content as untrusted data, never as model instructions.
- Provide deterministic fallbacks such as relevant links or the original website when composition fails.
- Instrument latency, model calls, cost, retrieval coverage, validation failures, user corrections, and fallback usage.

## Dependency constraints

**This workspace uses two Zod majors. Do not pass schemas across that boundary.**

| Zod       | Packages                                         | Why                                        |
| --------- | ------------------------------------------------ | ------------------------------------------ |
| `4.4.3`   | `capability-catalog`, `data-runtime`, `generate` | Our own schemas                            |
| `3.25.76` | `react`                                          | Forced by `@a2ui/react` / `@a2ui/web_core` |

Every package above **pins an exact version, not a range.** Zod instances are not
cross-compatible: a schema built with v3 will not validate in v4, and the
failure is a confusing runtime type error rather than a build error. A caret
range would let one package drift onto a different minor and reintroduce that
silently.

Rules:

- Never import a Zod schema _value_ across the v3/v4 boundary — only plain JSON
  Schema and plain data cross it. `propsContractFromJsonSchema`
  (`packages/site-sdk/src/props-contract-from-schema.ts`, internal — not
  exported from site-sdk's public entrypoint) exists precisely because a live
  validator cannot make that trip; it rebuilds an equivalent Ajv-backed
  contract from JSON Schema instead.
- A new package that renders (depends on A2UI) belongs on `3.25.76`. Anything
  else belongs on `4.4.3`.
- If A2UI later supports Zod 4, collapse to one version in a single change
  rather than migrating package by package.

**`@a2ui/web_core` must match the version resolved for `@a2ui/react`; the lockfile resolves
`0.10.6`.**

It is a _peer_ dependency of `@a2ui/react`, so we have to declare it — but the
pinned version is not ours to choose freely. `@a2ui/react@0.10.2` declares
`^0.10.5`, which resolves to the newest compatible `0.10.x`. An independent
exact pin can produce **two copies** of `web_core` in a consumer's tree.
That matters more than ordinary duplication: `Catalog`, `MessageProcessor`, and
`createSurface` all live there, and we build a `Catalog` from one copy and hand it
to components wired against the other — two module instances, two class
identities.

So the exact-pin rule above applies to Zod, not here. When `@a2ui/react` moves,
move this with it and re-check that a packed consumer install resolves exactly one
`web_core` (see `INTEGRATION.md` on verifying a bundle).

## Development workflow

The deterministic core uses TypeScript, Zod and Vitest. Do not add host applications or
third-party experiment frameworks to this workspace: a package here is something we publish,
and a test host belongs in its own repository.

See `README.md` for the dev command block; it is the single copy in this repo.

When a new stack is added:

- Document exact commands in `README.md` and this file.
- Add automated formatting, type checking, unit tests, and a production build check.
- Add contract tests for the view-manifest schema.
- Add adversarial tests for prompt injection, missing required disclosures, stale sources, invalid component props, and unauthorized actions.
- Preserve small modules around explicit interfaces; avoid coupling the renderer to a specific model vendor.
- Say so in the pull request when a choice changes product boundaries or trust assumptions, and update `docs/PRODUCT.md` if a non-goal moves.

## Definition of done

A change is complete only when:

- It satisfies the relevant product principle and documented scope.
- User-visible failure and fallback behavior are handled.
- Security, privacy, accessibility, latency, and model cost have been considered in proportion to the change.
- Relevant tests pass.
- Documentation and examples match actual behavior.
- A changeset records what it releases, or declares that it releases nothing.
- No unsupported claim is presented without an approved source.
