import type { FC, KeyboardEvent } from "react";
import type { ClarificationCandidate } from "@renderyes/core";

/**
 * The planner's question, rendered as a question.
 *
 * `needs-clarification` travels on `RUN_ERROR` for wire-compatibility — a third
 * terminal event type would be invisible to clients that drop unknown events, so
 * they would wait for a terminal frame that never came. `useViewCompose` puts the
 * question text in `error` as the degraded-but-true fallback for a host that
 * handles neither field.
 *
 * That fallback was all any shipped component did, which made a question
 * indistinguishable from a refusal: red text in the error slot, no options even
 * when the planner supplied them, and no way to answer other than retyping the
 * original prompt. Worse than a missing feature, because it made the branch
 * unobservable — a host could not tell whether it had ever fired.
 *
 * Two kinds of answer set reach here. `options` are strings the language
 * model wrote; answering sends the string back as prose. `candidates` are
 * approved capabilities the server read from its catalog when a planner with
 * no language model was unsure which one the visitor meant; answering sends
 * the capability id, and the view is then planned with no model call at all.
 * Candidates win when both are present, because an id is an answer a planner
 * can act on without reading, and the labels are the same text anyway.
 *
 * Rendered by both `ViewWorkspace` and `ViewLauncher` from here rather than
 * duplicated, so the two cannot drift on what a question looks like.
 */
export const CLARIFICATION_STYLES = `
.renderyes-scope .renderyes-clarify { margin: 12px 0 0; padding: 12px 14px; border-radius: 10px;
  background: #eef4ff; border: 1px solid #cddffb; display: flex; flex-direction: column; gap: 10px; }
.renderyes-scope .renderyes-clarify-question { margin: 0; color: #0b3d91; font-size: 14px; font-weight: 600; }
.renderyes-scope .renderyes-clarify-options { display: flex; flex-wrap: wrap; gap: 8px; }
.renderyes-scope .renderyes-clarify-option { min-height: 34px; padding: 0 12px; border: 1px solid var(--iv-accent);
  border-radius: 999px; background: var(--iv-accent-fg); color: var(--iv-accent); font-weight: 600; font-size: 13px; cursor: pointer; }
.renderyes-scope .renderyes-clarify-option:disabled { opacity: .6; cursor: wait; }
.renderyes-scope .renderyes-clarify-option:focus-visible { outline: 2px solid var(--iv-accent); outline-offset: 2px; }
.renderyes-scope .renderyes-clarify-escape { align-self: flex-start; margin: 0; padding: 4px 0; border: 0;
  background: transparent; color: #0b3d91; font-size: 13px; font-weight: 500; text-decoration: underline; cursor: pointer; }
.renderyes-scope .renderyes-clarify-escape:focus-visible { outline: 2px solid var(--iv-accent); outline-offset: 2px; }
`;

/** The copy on the way out of a capability question. One string, so the two renderings cannot drift. */
export const CLARIFICATION_ESCAPE_LABEL = "None of these — show me the full site";

export interface ClarificationPromptProps {
  clarification: {
    question: string;
    options?: readonly string[];
    candidates?: readonly ClarificationCandidate[];
  } | null;
  onAnswer: (answer: string) => void;
  /** Picks a candidate by capability id. Required only when `candidates` can appear. */
  onChoose?: (capabilityId: string) => void;
  busy: boolean;
  /**
   * The way out when none of the candidates is right. A host with a route of
   * its own passes `onExit`, which is called instead of navigating; otherwise
   * the control is a link to `href`, or to the page the visitor is on when
   * that is not given either — for a dialog, the full site is the page under
   * it. Rendered only with candidates: a free-text question already has its
   * way out in the prompt box.
   */
  escape?: { href?: string; onExit?: () => void };
}

/**
 * Roving focus across the chips: arrows move, Home and End jump, Enter and
 * Space activate as any button does. Buttons are in the tab order on their
 * own, so this adds a faster path rather than being the only one.
 */
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  const keys = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const chips = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
  );
  if (chips.length === 0) return;
  const index = chips.findIndex((chip) => chip === document.activeElement);
  let next = index;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    next = index < 0 ? 0 : (index + 1) % chips.length;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    next = index <= 0 ? chips.length - 1 : index - 1;
  } else if (event.key === "Home") {
    next = 0;
  } else {
    next = chips.length - 1;
  }
  event.preventDefault();
  chips[next]?.focus();
}

export const ClarificationPrompt: FC<ClarificationPromptProps> = ({
  clarification,
  onAnswer,
  onChoose,
  busy,
  escape,
}) => {
  if (!clarification) return null;
  const choose = onChoose;
  const candidates = choose && clarification.candidates?.length ? clarification.candidates : null;

  return (
    // `status`, not `alert`: a question is not a failure, and announcing it as
    // one is the same mistake as styling it as one.
    <div
      className="renderyes-clarify"
      role="status"
    >
      <p
        className="renderyes-clarify-question"
      >
        {clarification.question}
      </p>
      {candidates ? (
        <>
          <div
            className="renderyes-clarify-options"
            role="group"
            aria-label={clarification.question}
            onKeyDown={moveFocus}
          >
            {candidates.map((candidate) => (
              <button
                key={candidate.capabilityId}
                type="button"
                className="renderyes-clarify-option"
                onClick={() => choose?.(candidate.capabilityId)}
                disabled={busy}
              >
                {candidate.label}
              </button>
            ))}
          </div>
          {escape?.onExit ? (
            <button
              type="button"
              className="renderyes-clarify-escape"
              onClick={escape.onExit}
              disabled={busy}
            >
              {CLARIFICATION_ESCAPE_LABEL}
            </button>
          ) : (
            // A plain link, so it works with the keyboard, opens in a new tab
            // on request, and needs no script to be the way out. Resolved at
            // render: the page under a dialog is the full site.
            <a
              className="renderyes-clarify-escape"
              href={escape?.href ?? currentPageHref()}
            >
              {CLARIFICATION_ESCAPE_LABEL}
            </a>
          )}
        </>
      ) : clarification.options?.length ? (
        <div
          className="renderyes-clarify-options"
        >
          {clarification.options.map((option) => (
            <button
              key={option}
              className="renderyes-clarify-option"
              onClick={() => onAnswer(option)}
              disabled={busy}
            >
              {option}
            </button>
          ))}
        </div>
      ) : (
        // No options offered, so the prompt box is the answer box. Saying so
        // matters: without it the question reads as rhetorical and the visitor
        // has no reason to think typing will resume the same exchange.
        <p
          className="renderyes-clarify-question"
          // Not a variant worth a class: the same question element, lighter,
          // when it is a statement rather than a prompt.
          style={{ fontWeight: 400 }}
        >
          Answer above to continue.
        </p>
      )}
    </div>
  );
};

/** The page the visitor is on, or the root when there is no window (server render). */
function currentPageHref(): string {
  if (typeof window === "undefined" || !window.location) return "/";
  const { pathname, search } = window.location;
  return `${pathname}${search}` || "/";
}
