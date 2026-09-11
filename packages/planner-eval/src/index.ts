/**
 * A quality harness for the planner.
 *
 * Everything else in this workspace verifies that a plan is *legal* —
 * `validatePlan`, `validatePlanDataBindings`, `validateCandidate` all fail
 * closed on an invalid plan, and the planner's own tests use a scripted provider
 * so they assert plumbing, not judgement. None of that can tell you whether a
 * real model, given a real prompt, picks the right capability and the right
 * component. That gap is what this package measures.
 *
 * Two design choices matter more than the rest:
 *
 * - **Cases assert properties, not exact plans.** Pinning the whole plan JSON
 *   tests memorisation and breaks on every harmless variation. A case says "it
 *   must select this capability and render this component", as a subset check.
 * - **Every case runs N times and reports a rate.** A model is stochastic; a
 *   single green run is not a measurement. Cases that neither always pass nor
 *   always fail are flagged `unstable`, and those are the ones a prompt change
 *   can actually move.
 */
export {
  checkPlan,
  readPlanFacts,
  walkNodes,
  type CheckId,
  type CheckOutcome,
  type EvalCase,
  type EvalExpectation,
  type PlanFacts,
} from "./checks.js";
export {
  runEvalSuite,
  type CaseReport,
  type CheckSummary,
  type EvalReport,
  type RunEvalSuiteInput,
} from "./run.js";
export {
  compareToBaseline,
  formatBaselineComparison,
  formatEvalReport,
  toBaseline,
  type BaselineComparison,
  type BaselineDelta,
  type CaseFlip,
  type EvalBaseline,
} from "./baseline.js";
