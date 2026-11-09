import { useId } from "react";
import type { UnderstoodInput } from "@renderyes/core";
import { useViewCompose } from "./use-compose.js";

/**
 * What the view on screen was built from, as a row of values the visitor can
 * correct.
 *
 * A planner reads a sentence and narrows a request by it — "Visitors from:
 * Germany, France, California", "Platform: shopify". Until this existed those
 * choices were invisible: a visitor who named four places and got laws for
 * three could not tell that the fourth matched nothing, or fix a value the
 * planner misread without rephrasing the whole request.
 *
 * Every value shown comes from the service's `understood` summary, which is
 * derived in code from the validated plan and the catalog. Every edit is a
 * `setInput` refinement: no model call, and only values the catalog declares
 * can be chosen. "Not found" values are the visitor's own words that matched
 * nothing the site lists; they are shown, never chosen.
 */
export const UNDERSTOOD_STYLES = `
.renderyes-scope .renderyes-understood { margin: 0; padding: 10px 14px; border: 1px solid var(--iv-border);
  border-radius: var(--iv-radius); background: var(--iv-surface-subtle); display: grid; gap: 8px; }
.renderyes-scope .renderyes-understood-title { margin: 0; font-size: 12px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .04em; color: var(--iv-muted); }
.renderyes-scope .renderyes-understood-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.renderyes-scope .renderyes-understood-label { font-size: 14px; font-weight: 600; color: var(--iv-fg); margin-right: 2px; }
.renderyes-scope .renderyes-understood-chip { display: inline-flex; align-items: center; gap: 4px; min-height: 28px;
  padding: 0 4px 0 10px; border-radius: 999px; border: 1px solid var(--iv-border); background: var(--iv-surface);
  font-size: 13px; color: var(--iv-fg); }
.renderyes-scope .renderyes-understood-chip.is-fixed { padding-right: 10px; }
.renderyes-scope .renderyes-understood-remove { border: 0; background: transparent; color: var(--iv-muted);
  font-size: 15px; line-height: 1; padding: 4px 6px; border-radius: 999px; cursor: pointer; }
.renderyes-scope .renderyes-understood-remove:hover { background: var(--iv-surface-subtle); color: var(--iv-fg); }
.renderyes-scope .renderyes-understood-select { min-height: 28px; padding: 0 8px; border-radius: 8px;
  border: 1px solid var(--iv-border); background: var(--iv-surface); color: var(--iv-fg); font: inherit; font-size: 13px; }
.renderyes-scope .renderyes-understood-missing { display: inline-flex; align-items: center; min-height: 28px;
  padding: 0 10px; border-radius: 999px; border: 1px dashed #d4a72c; background: #fff8e6; color: #6b5300; font-size: 13px; }
.renderyes-scope .renderyes-understood :is(button, select):disabled { opacity: .6; cursor: wait; }
.renderyes-scope .renderyes-understood :is(button, select):focus-visible { outline: 2px solid var(--iv-accent); outline-offset: 2px; }
`;

/**
 * The editable summary of what the current view was narrowed by. Renders
 * nothing before a view exists, or when the view was narrowed by nothing a
 * visitor can change.
 */
export function ViewUnderstood() {
  const { understood, editInput, busy, messages } = useViewCompose();
  if (messages.length === 0 || understood.length === 0) return null;
  return (
    <section className="renderyes-understood" aria-label="What this view is based on">
      <p className="renderyes-understood-title">Based on</p>
      {understood.map((entry) => (
        <UnderstoodRow
          key={`${entry.requestId}:${entry.kind}:${entry.name}`}
          entry={entry}
          busy={busy}
          onChange={(values) => void editInput(entry, values)}
        />
      ))}
    </section>
  );
}

function UnderstoodRow({
  entry,
  busy,
  onChange,
}: {
  entry: UnderstoodInput;
  busy: boolean;
  onChange: (values: readonly string[]) => void;
}) {
  const labelId = useId();
  const unchosen = entry.options.filter((option) => !entry.values.includes(option));
  return (
    <div className="renderyes-understood-row" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="renderyes-understood-label">
        {entry.label}:
      </span>
      {entry.multiple || !entry.editable ? (
        <>
          {entry.values.map((value) =>
            entry.editable ? (
              <span key={value} className="renderyes-understood-chip">
                {value}
                <button
                  type="button"
                  className="renderyes-understood-remove"
                  aria-label={`Remove ${value}`}
                  disabled={busy || (entry.required && entry.values.length === 1)}
                  onClick={() => onChange(entry.values.filter((kept) => kept !== value))}
                >
                  ×
                </button>
              </span>
            ) : (
              <span key={value} className="renderyes-understood-chip is-fixed">
                {value}
              </span>
            ),
          )}
          {entry.editable && unchosen.length > 0 ? (
            <select
              className="renderyes-understood-select"
              aria-label={`Add to ${entry.label}`}
              value=""
              disabled={busy}
              onChange={(event) => {
                const added = event.currentTarget.value;
                if (added) onChange([...entry.values, added]);
              }}
            >
              <option value="">Add…</option>
              {unchosen.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : null}
        </>
      ) : (
        <select
          className="renderyes-understood-select"
          aria-label={entry.label}
          value={entry.values[0] ?? ""}
          disabled={busy}
          onChange={(event) => {
            const chosen = event.currentTarget.value;
            if (chosen) onChange([chosen]);
          }}
        >
          {entry.values.length === 0 ? <option value="">Choose…</option> : null}
          {entry.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )}
      {entry.notFound.map((term) => (
        <span
          key={`missing:${term}`}
          className="renderyes-understood-missing"
          title={`This site lists nothing for ${term}, so it is not part of this view.`}
        >
          Not found: {term}
        </span>
      ))}
    </div>
  );
}
