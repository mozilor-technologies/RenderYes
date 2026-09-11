/**
 * Report types in their own module so `emit.ts` (renders the report) and
 * `verify.ts` (produces it, and uses `emit.ts`'s twin derivation) share them
 * without an import cycle — the workspace lint treats package-internal cycles
 * as errors for good reason.
 */
export interface VerificationCheck {
  name: string;
  pass: boolean;
  detail: string;
}

/** The four lifecycle states the render-smoke check mounts. */
export type RenderedStateName = "ready" | "empty" | "error" | "truncated";

export interface VerificationReport {
  /** True only when every check passed. Warnings live in a check's detail. */
  pass: boolean;
  checks: VerificationCheck[];
  /**
   * The HTML `renderToString` produced for each state that rendered without
   * throwing — the raw material of the preview.html artifact. A state that
   * threw is simply absent; the map is empty when the draft never mounted.
   */
  renderedStates?: Partial<Record<RenderedStateName, string>>;
}

export function failingDetails(report: VerificationReport): string[] {
  return report.checks
    .filter((check) => !check.pass)
    .map((check) => `${check.name}: ${check.detail}`);
}
