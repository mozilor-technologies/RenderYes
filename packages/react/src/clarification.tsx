import type { FC } from "react";

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
`;


export interface ClarificationPromptProps {
  clarification: { question: string; options?: readonly string[] } | null;
  onAnswer: (answer: string) => void;
  busy: boolean;
}

export const ClarificationPrompt: FC<ClarificationPromptProps> = ({
  clarification,
  onAnswer,
  busy,
}) => {
  if (!clarification) return null;

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
      {clarification.options?.length ? (
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
