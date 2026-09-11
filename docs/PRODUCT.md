# Product principles

This page defines product direction and acceptance criteria. It is not a list
of shipped features. For current behavior, use
[`ARCHITECTURE.md`](ARCHITECTURE.md) and [`API.md`](API.md).

## Mission

Help people turn a complex website into a focused interface for the task they actually came to complete, without requiring the website owner to rebuild the site or the visitor to learn how to prompt an AI system.

## Product sentiment

The product should feel like the website listened—not like a chatbot took over.

The tone is:

- **Empowering:** the visitor explicitly declares their needs.
- **Calm:** the product removes noise and presents a clear working surface.
- **Trustworthy:** factual blocks show their sources and freshness.
- **Respectful:** the website owner's brand, rules, required information, and business flows remain intact.
- **Practical:** AI is used when it creates utility, not as decoration.
- **Reversible:** the visitor can inspect, revise, save, or leave the custom view at any time.

## Participants and responsibilities

### Website owner

The website owner is the customer and runtime sponsor. They control:

- Content and approved data sources
- Available components and actions
- Mandatory disclosures and presentation policies
- Branding and accessibility requirements
- Authentication and authorization
- Model provider, budget, rate limits, and retention
- Analytics and experimentation

### Visitor

The visitor controls:

- Their stated goal
- Relevant preferences and constraints
- Optional content to include, hide, or prioritize
- Sorting, filtering, comparison, and layout preferences
- Whether to save, revise, or discard the view

### RenderYes runtime

The runtime mediates between them. It must not grant a visitor capabilities the publisher has not exposed, and it must not use publisher policy to disguise unsupported claims as personalization.

## Experience principles

### Start from intent, not a blank conversation

Use the current page, site category, and approved capabilities to offer example intents. Ask for one natural-language goal. Avoid prolonged interviews; ask a clarifying question only when its answer would materially change the view.

### Make the canvas primary

Chat is a construction and revision mechanism. After the first request, the composed interface becomes primary. Sorting, filtering, calculators, disclosure expansion, removal, and reordering should be direct UI interactions.

### Show useful progress immediately

Render a stable shell and grounded partial results while slower retrieval or data resolution completes. Never fill latency with fabricated content.

### Explain through provenance, not model theatre

Display source links, freshness, selected constraints, and required disclosures. Do not expose chain-of-thought or anthropomorphize ordinary processing.

### Preserve continuity

Calls to action initially enter existing website flows. The visitor can always return to the original page. A custom view is an enhancement, not a fork of the website.

### Save a living view

Persist the goal, constraints, component configuration, source identifiers, and schema versions. Resolve them against current data when reopened and make material changes visible.

## Friction criteria

### Owner friction

- Initial integration should reuse the host's existing components and data by registering a capability catalog and a UI catalog.
- Assisted registration (drafting catalog entries from the host's code) should lower that setup cost and stay reviewable.
- Useful read-only composition should precede live-data resolvers and actions.
- Model expertise must not be required.
- Costs must be measurable, capped, and degradable.
- Feature removal must leave the existing site functioning normally.

### Visitor friction

- No account, API key, or permission prompt before first value.
- No requirement to write a perfect prompt.
- One request should normally produce a useful first view.
- Suggested intents should be relevant to the current page.
- Normal interface changes should not require another model call.
- Saving should be one action; anonymous local saving comes first.
- Failures should fall back to grounded links or the original website.

### Trust friction

- Claims must be grounded in approved sources.
- Mandatory information cannot be hidden by the planner.
- Unsupported or stale content must be clearly identified.
- Private data follows existing authentication and permissions.
- Sensitive actions require explicit confirmation.
- Visitors should be able to understand why a block is present.

## Technology selection principle

Use the simplest reliable technique for each task:

| Problem                                        | Preferred first approach                                       |
| ---------------------------------------------- | -------------------------------------------------------------- |
| Know the site's data & components              | Host-registered capability + UI catalogs (not a crawler)       |
| Parse visitor intent                           | Small structured-output language model                         |
| Resolve genuine ambiguity                      | More capable model or one targeted question                    |
| Choose data loaders                            | Constrained planner over the capability catalog                |
| Select components & layout                     | Constrained planner over the UI catalog                        |
| Fetch data & apply auth                        | Deterministic host loaders; identity injected from session     |
| Enforce policies                               | Deterministic policy engine                                    |
| Validate output                                | Versioned schema validation                                    |
| Sort, filter, calculate, save                  | Normal application code                                        |
| Find relevant catalog entries (large catalogs) | Embedding retrieval over `purpose` text                        |
| Render UI                                      | Trusted, tested host components                                |
| Draft catalog entries from a host repo (later) | Build-time scan + model-assisted drafting for review           |
| Handle irregular legacy pages (later)          | Constrained extraction; output stays untrusted until validated |

## Initial friction budget

These are product targets, not claims about current implementation:

| Measure                              |                             Target |
| ------------------------------------ | ---------------------------------: |
| Owner installation after preview     |                   Under 15 minutes |
| Visitor input before first view      |                        One request |
| Signup required for first use        |                               None |
| First visible grounded result        |                    Under 2 seconds |
| Initial complete view                | Under 5 seconds for a typical view |
| Model calls for typical initial view |                                One |
| Model calls for sort/filter/remove   |                               Zero |
| Critical factual fabrication         |                     Zero tolerance |

Measure these targets by page type, device, geography, and model route. A global average can hide regressions within those groups.

## Product test

Before accepting a feature, ask:

> Does this make it easier for a website owner to offer the capability, or easier and safer for a visitor to complete their goal?

If the answer is neither, the work is likely infrastructure or AI spectacle with no demonstrated product value.

## Explicit non-goals

- Arbitrary generated JS/HTML/CSS/React at runtime.
- Automatic form submission, purchase, application, or account modification.
- Private user-data ingestion; cross-site autonomous research.
- Replacing the host's CMS, navigation, or search.
- Mandatory visitor accounts (anonymous local save comes first).
- Frozen saved copies of business data (save intent, resolve fresh).
- Crawler/sitemap onboarding (that is a later integration level, not the MVP).
- Perfect support for every website structure.

## Kill / reconsider signals

- Visitors mostly want better _search_, not a composed interface.
- A small model cannot produce good plans over a real catalog (planning is an open research
  problem for this domain, not a routing problem).
- Grounding / mandatory-content guarantees cannot be met consistently.
- Latency prevents the view from beating ordinary navigation.
- Operating cost is not justified by improved outcomes.
- Owners are unwilling to give visitors meaningful control over presentation.

These are learning outcomes. The product is built to reveal them early and cheaply.
