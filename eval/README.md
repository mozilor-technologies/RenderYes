# Evaluation

Measures whether the planner picks the right capability and component for a
real prompt — the one thing no other test in this workspace can tell you.
Everything else here verifies that a plan is *legal*; this asks whether it is
*right*.

## Not shipped, not customer-coupled

These files sit inside `renderyes/` but are not part of any package: no
`files` array includes `eval/`, and it is not a workspace member.

The fixture is synthetic and versioned in this repository. A customer's
production catalog would change independently of the baselines,
couple this repo to one host's domain, and put someone else's business
vocabulary in our history. `fixture/finance-catalog.mjs` is a finance catalog
kept under this repository's control.

## Running

```bash
cd packages/planner-eval
OPENAI_API_KEY=... node cli.mjs \
  --catalog ../../eval/fixture/finance-catalog.json \
  --cases   ../../eval/cases/finance.cases.json \
  --runs 3 \
  --out     ../../eval/baselines/finance.baseline.json
```

`--compare <previous baseline>` prints the per-case flip table. A comparison
across different models exits 3 because it would not isolate this repository's
change.

`--provider mock` runs the whole pipeline without a key or any spend. Every
case reports `unsupported`, so it proves the harness works, not the planner.

## The fixture

16 capabilities, 12 data types, 2 join relationships, 5 result shapes.

Sized to be a genuine test. A three-capability catalog measures nothing — the
planner cannot get a choice wrong when there is no choice. It includes
near-misses that require an actual selection:

| Pair | What has to be distinguished |
| --- | --- |
| `spend.byCategory` / `spend.byMerchant` | same question, different grouping |
| `cashflow.trend` / `netWorth.trend` | both trends, different quantity |
| `invoices.list` / `invoices.overdue` | one is a filtered view of the other |
| `subscriptions.list` / `subscriptions.upcoming` | same, on a date field |

Rebuild the JSON after editing the module:

```bash
node eval/fixture/build-catalog.mjs
```

## The corpus

39 cases: single-capability, near-miss pairs, filter/sort/limit, search, join,
multi-capability (including a three-capability prompt), compound two-part
prompts (asserting `minNodes`, so a plan that
answers only half the request fails, and one whose second half the catalog
cannot answer, which must still refuse), expected-`unsupported`, two
prompt-injection attempts, and three genuinely ambiguous prompts.

The ambiguous cases expect `ready` with no capability assertion because there
is no single right answer. They measure whether the planner produces a grounded
result.

## Baselines

Committed under `baselines/`, so a contract change has something to diff
against. Each records the model that produced it — a provider can change the
model behind a name without telling anyone, and a diff across two models
attributes their change to ours.

Run artifacts (`eval-failures.json`, ad-hoc baselines) are gitignored.
