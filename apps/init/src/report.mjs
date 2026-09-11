/**
 * One renderer, shared by both commands, so a finding reads identically
 * whether `doctor` reported it or `init` stopped on it.
 *
 * Exit codes follow `renderyes-catalog diff`: non-zero only when a human has
 * to decide something. A warning is information, not a gate — a pipeline that
 * fails on "no catalogStore configured" would be failing on a choice the host
 * is entitled to make.
 */

const MARK = Object.freeze({
  pass: "✓",
  fail: "✗",
  warn: "!",
  unknown: "?",
  skip: "·",
});

const LEVEL_ORDER = Object.freeze(["access", "installed", "mounted", "published", "verified"]);

export function groupByLevel(checks) {
  const grouped = new Map(LEVEL_ORDER.map((level) => [level, []]));
  for (const check of checks) {
    const level = check.level ?? "other";
    if (!grouped.has(level)) grouped.set(level, []);
    grouped.get(level).push(check);
  }
  return grouped;
}

/**
 * Whether a check stops a level being declared reached.
 *
 * Shared with `exitCode` rather than restated there: the two answered the same
 * question with different predicates, so a run blocked only by a non-advisory
 * unknown printed "blocked from going further" and exited 0 — a script reading
 * the status saw health the report denied.
 */
function blocks(check) {
  return check.status === "fail" || (check.status === "unknown" && !check.advisory);
}

/**
 * The highest level every check of which passed, counting warnings as passing.
 *
 * A level is reached or it is not; there is no partial. `init` resumes at the
 * first level that is not reached, which is the whole of its state model.
 *
 * An unknown blocks like a failure — a level cannot be declared reached on the
 * strength of something this tool could not see — unless the check marked
 * itself `advisory`, meaning "not seeing an answer is itself an acceptable
 * answer". Without that distinction a host whose catalog id comes from
 * configuration, which is correct, could never reach past "installed".
 */
export function reachedLevel(checks) {
  let reached;
  for (const level of LEVEL_ORDER) {
    const forLevel = checks.filter((check) => check.level === level);
    if (forLevel.length === 0) break;
    if (forLevel.some(blocks)) break;
    reached = level;
  }
  return reached;
}

export function render(checks) {
  const lines = [];
  for (const [level, forLevel] of groupByLevel(checks)) {
    if (forLevel.length === 0) continue;
    lines.push("");
    lines.push(level.toUpperCase());
    for (const check of forLevel) {
      lines.push(`  ${MARK[check.status] ?? "·"} ${check.summary}`);
      for (const line of check.detail ?? []) {
        lines.push(`      ${line}`);
      }
      // Only for things that need action. Printing a remedy beside a pass is
      // how a report becomes something people stop reading. Unknown counts:
      // its remedy is how to give this tool more to look at, or the reassurance
      // that not answering is fine.
      if (
        check.remedy &&
        (check.status === "fail" || check.status === "warn" || check.status === "unknown")
      ) {
        lines.push(`      → ${check.remedy}`);
      }
    }
  }

  const failures = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");
  const level = reachedLevel(checks);

  // `reachedLevel` stops at a failure *or* an unknown, so the summary has to
  // account for both. Counting only failures produced the contradiction this
  // exists to prevent: "Reached: installed" beside "Nothing blocking", with
  // every later level showing ticks — a reader concludes they are stuck for no
  // reason, when two things simply could not be determined.
  const levelIndex = level ? LEVEL_ORDER.indexOf(level) : -1;
  const unresolved = checks.filter(
    (check) =>
      check.status === "unknown" &&
      // Advisory unknowns do not cap the level, so naming one as "what stops
      // the level going higher" would reintroduce the contradiction.
      !check.advisory &&
      check.level &&
      LEVEL_ORDER.indexOf(check.level) === levelIndex + 1,
  );

  // What actually capped the level, named. `reachedLevel` stops at the first
  // level holding a blocking check *or holding none at all*, and the summary
  // used to report only where it stopped. A fully green PUBLISHED block above
  // "Reached: nothing yet" is that second case — some earlier level could not
  // be determined — and with nothing named, the two read as a contradiction in
  // the tool rather than as a fact about the install.
  const cappingLevel = LEVEL_ORDER[levelIndex + 1];
  const cappedBy = cappingLevel
    ? checks.filter((check) => check.level === cappingLevel && blocks(check))
    : [];
  const cappingReason = !cappingLevel
    ? ""
    : cappedBy.length > 0
      ? ` — ${cappingLevel} is blocked by ${cappedBy.map((check) => check.id).join(", ")}`
      : checks.some((check) => check.level === cappingLevel)
        ? ""
        : ` — nothing was checked at ${cappingLevel}`;

  lines.push("");
  lines.push(
    level
      ? `Reached: ${level}${failures.length > 0 || unresolved.length > 0 ? " — blocked from going further" : ""}${cappingReason}`
      : `Reached: nothing yet${cappingReason}`,
  );
  if (failures.length > 0) {
    lines.push(`${failures.length} blocking, ${warnings.length} worth knowing.`);
  } else if (unresolved.length > 0) {
    // Named, because "could not tell" is a different situation from "wrong",
    // and the remedy is usually to give this tool more to look at.
    lines.push(
      `Nothing failing. ${unresolved.length} thing(s) could not be determined, which is ` +
        `what stops the level going higher: ${unresolved.map((check) => check.id).join(", ")}.`,
    );
  } else if (warnings.length > 0) {
    lines.push(`Nothing blocking. ${warnings.length} worth knowing.`);
  } else {
    lines.push("Nothing blocking.");
  }

  return lines.join("\n");
}

export function exitCode(checks) {
  return checks.some(blocks) ? 1 : 0;
}
