import type { ReactNode } from "react";
import { ClarificationPrompt } from "./clarification.js";
import { useChromeOptions, useChromeState } from "./chrome-state.js";
import { useSavedViews, useViewCompose } from "./use-compose.js";
import { savedViewDate } from "./saved-view-date.js";

/**
 * The parts a workspace is made of, each rendering standalone.
 *
 * `ViewWorkspace` was one 620-line component that owned the prompt row, the
 * suggestions, the saved-view bar, four kinds of notice and the surface. A host
 * who wanted its layout with their own search box, or its layout without saved
 * views, had no way to say so — the only choices were the whole thing or the
 * hook.
 *
 * Every part below reads the session and the chrome state from context, so it
 * can be mounted anywhere under a `ViewProvider`, in any order, and omitting
 * one is how you turn that feature off.
 */


export interface ViewPromptProps {
  placeholder?: string;
  /** Renders a back affordance above the row when the host wants one. */
  onExit?: () => void;
  exitLabel?: string;
  /**
   * Extra controls placed inside the row, after Start over.
   *
   * The row is a container, not an owner. Save and My views sit here visually
   * while belonging to the saved-view feature, and an earlier cut of this had
   * `ViewPrompt` render them itself — which meant mounting the prompt without
   * the saved bar still produced a My-views button, so omitting a part was not
   * the off switch it is documented to be. Caught by the test that mounts a
   * prompt and a surface and nothing else.
   */
  children?: ReactNode;
}

/**
 * The prompt row: input, send, and start-over once there is a view.
 *
 * The `hasView ? revise() : submit()` rule lives here now, once. It was written
 * twice — in the workspace and in the launcher — each with a comment pointing at
 * the other, which is how the two drifted.
 */
export function ViewPrompt({
  placeholder,
  onExit,
  exitLabel = "Back",
  children,
}: ViewPromptProps) {
  const { prompt, setPrompt, busy, messages, submit, revise, startOver } = useViewCompose();
  const hasView = messages.length > 0;
  const send = () => void (hasView ? revise() : submit());

  return (
    <>
      {onExit ? (
        <button
          className="renderyes-workspace-exit"
          onClick={onExit}
        >
          ← {exitLabel}
        </button>
      ) : null}
      <div
        className="renderyes-row"
      >
        <input
          className="renderyes-input"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) send();
          }}
          placeholder={
            hasView ? "Change this view…" : (placeholder ?? "What do you want to see?")
          }
          aria-label={
            hasView ? "Describe a change to this view" : "Describe what you want"
          }
        />
        <button
          className="renderyes-send"
          onClick={send}
          disabled={busy}
        >
          {busy ? "Composing…" : hasView ? "Refine" : "Go"}
        </button>
        {hasView ? (
          <button
            className="renderyes-start-over"
            onClick={startOver}
            disabled={busy}
          >
            Start over
          </button>
        ) : null}
        {children}
      </div>
    </>
  );
}

const EXIT_FALLBACK_STYLE = {
  alignSelf: "flex-start" as const,
  border: 0,
  background: "transparent",
  color: "#1f6feb",
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer" as const,
  padding: "4px 0",
};

/**
 * Host-written prompts for the empty state, and for a refusal.
 *
 * A refusal that only says no is a dead end; the same chips are the way out of
 * one, which is why this is a part rather than markup inside two places.
 */
export function ViewSuggestions({
  suggestions,
  label,
}: {
  suggestions?: readonly string[];
  label?: string;
}) {
  const { busy, submit } = useViewCompose();
  if (!suggestions || suggestions.length === 0) return null;
  return (
    <>
      {label ? (
        <p
          className="renderyes-chips-label"
        >
          {label}
        </p>
      ) : null}
      <div
        className="renderyes-chips"
      >
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            className="renderyes-chip"
            disabled={busy}
            onClick={() => void submit({ prompt: suggestion })}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * Save and My views, for placing inside a prompt row.
 *
 * Separate from `ViewSavedBar` because these two live *inside* the row while
 * the confirmations and the menu render beneath it — one part cannot render
 * into two places. Pass it as `ViewPrompt`'s children; omit it and the row has
 * no saved-view controls.
 */
export function ViewSavedControls() {
  const { busy, messages } = useViewCompose();
  const { savedViewsEnabled } = useChromeOptions();
  const hasView = messages.length > 0;
  const { save, listSaved } = useSavedViews();
  const { menuOpen, setMenuOpen, setSavedRows, confirmSaved } = useChromeState();

  async function handleSave() {
    const result = await save();
    // On failure the hook has already routed its own copy through `error`;
    // saying anything more here would report the same failure twice.
    if (!result.ok) return;
    confirmSaved();
  }

  async function toggleSavedMenu() {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    setMenuOpen(true);
    setSavedRows(null);
    // Fetched on every open, not cached from the first: a save since then
    // belongs in the list. Not `silent` — this click *is* the explicit "show
    // my saved views" the hook's silent mode exists to contrast with, so a
    // failure reports through the hook's normal error copy.
    setSavedRows(await listSaved());
  }

  if (!savedViewsEnabled) return null;
  return (
    <>
      {hasView && !busy ? (
        <button
          className="renderyes-save"
          onClick={() => void handleSave()}
        >
          Save view
        </button>
      ) : null}
      {/* Rendered even before any view is composed: reopening is most useful on
          the empty workspace, where "come back to what I had" is the whole
          reason to be here. */}
      <button
        className="renderyes-my-views"
        onClick={() => void toggleSavedMenu()}
        aria-expanded={menuOpen}
      >
        My views
      </button>
    </>
  );
}

/**
 * The saved-view panel: confirmations, and the My-views menu.
 *
 * Renders beneath the prompt row. Omit it and a host keeps composing with no
 * saved-view surface at all — which is what `savedViews={false}` used to mean,
 * now expressible by not mounting the part.
 */
export function ViewSavedBar() {
  const { savedViewsEnabled } = useChromeOptions();
  const { listSaved, reopen, deleteSaved } = useSavedViews();
  const { busy } = useViewCompose();
  const { savedConfirmed, pinConfirmed, menuOpen, setMenuOpen, savedRows, setSavedRows } =
    useChromeState();

  async function handleDelete(viewId: string) {
    const deleted = await deleteSaved(viewId);
    // Failure keeps the row: the view still exists, and the hook has already
    // put "Couldn't delete that view" on screen.
    if (!deleted) return;
    setSavedRows(await listSaved());
  }

  if (!savedViewsEnabled) return null;
  return (
    <>
      {savedConfirmed ? (
        <p
          className="renderyes-save-confirmation"
          role="status"
        >
          Saved — this view now has its own URL
        </p>
      ) : null}
      {pinConfirmed ? (
        // The Save confirmation's pattern — transient, announced via
        // role="status" — with copy that says where the pin went, since
        // unlike Save it does not change the page's own URL.
        <p
          className="renderyes-save-confirmation"
          role="status"
        >
          Pinned — find it in My views
        </p>
      ) : null}
      {menuOpen ? (
        <div
          className="renderyes-saved-menu"
        >
          {savedRows === null ? (
            <p
              className="renderyes-saved-empty"
            >
              Loading…
            </p>
          ) : savedRows.length === 0 ? (
            <p
              className="renderyes-saved-empty"
            >
              Nothing saved yet — compose a view and press Save.
            </p>
          ) : (
            savedRows.map((row) => {
              // The list falls back to the saved prompt: v1's save takes
              // no label, and the prompt is the visitor's own words for
              // what the view is.
              const name = row.label ?? row.prompt;
              const date = savedViewDate(row.updatedAt);
              return (
                <div
                  key={row.id}
                  className="renderyes-saved-row"
                >
                  <button
                    className="renderyes-saved-open"
                    onClick={() => {
                      setMenuOpen(false);
                      void reopen(row.id);
                    }}
                    disabled={busy}
                  >
                    <span>{name}</span>
                    {date ? (
                      <span
                        className="renderyes-saved-date"
                      >
                        {date}
                      </span>
                    ) : null}
                    {row.stale ? (
                      // The summary already knows the catalog or components
                      // moved; saying so here beats finding out after the
                      // reopen renders something subtly different.
                      <span
                        className="renderyes-saved-stale"
                      >
                        Changed since saved
                      </span>
                    ) : null}
                  </button>
                  <button
                    className="renderyes-saved-delete"
                    onClick={() => void handleDelete(row.id)}
                    disabled={busy}
                    aria-label={`Delete saved view ${name}`}
                  >
                    ×
                  </button>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </>
  );
}

/**
 * Everything the chrome says between the prompt and the view: a stale notice, a
 * clarifying question, a refusal, an error, and the empty state's suggestions.
 *
 * One part because these are mutually exclusive states of the same slot, and
 * treating them as independent conditions is how a clarification came to render
 * as an error message as well as a question. The order below is the precedence.
 */
export function ViewNotices({ suggestions }: { suggestions?: readonly string[] }) {
  const {
    busy,
    error,
    errorKind,
    clarification,
    answerClarification,
    staleReason,
    messages,
  } = useViewCompose();
  const hasView = messages.length > 0;
  const hasChips = Boolean(suggestions && suggestions.length > 0);

  return (
    <>
      {staleReason ? (
        // A reopened view that replayed against a catalog that has moved since
        // it was saved. It rendered — individual slots degrade on their own —
        // but "it rendered" is not "it is the same view", and without this line
        // an older answer is presented as current. Same class as an undisclosed
        // truncation, and reachable by any bookmark now that saved views have
        // URLs.
        <p className="renderyes-stale" role="status">
          Reopened from a saved view, but the site has changed since it was
          saved: {staleReason}
        </p>
      ) : null}
      <ClarificationPrompt
        clarification={clarification}
        onAnswer={(answer) => void answerClarification(answer)}
        busy={busy}
      />
      {error && !clarification && errorKind === "unsupported" ? (
        // A refusal is an answer, not a malfunction: it gets a designed card
        // that says what the site could not do and, when the host supplied
        // suggestions, what it can do — a dead end becomes the discovery
        // surface the empty workspace already has.
        <div
          className="renderyes-refusal"
          role="status"
        >
          <p
            className="renderyes-refusal-title"
          >
            This site can't answer that one
          </p>
          <p
            className="renderyes-refusal-reason"
          >
            {error}
          </p>
          <ViewSuggestions suggestions={suggestions} label="Things it can answer:" />
        </div>
      ) : error && !clarification ? (
        // Suppressed while a clarification is outstanding: the hook puts the
        // question in `error` too, for hosts that render neither field, so
        // showing both prints the same sentence as a question and again as a
        // failure.
        <>
          <p
            className="renderyes-error"
            role="alert"
          >
            {error}
          </p>
          {errorKind === "invalid" && hasChips ? (
            // The message says rephrasing helps; the chips are rephrasings that
            // are known to work. Without them "try other wording" is advice
            // with no example, on the exact failure where the visitor's own
            // wording is what tripped the planner.
            <ViewSuggestions suggestions={suggestions} label="Try one of these:" />
          ) : null}
        </>
      ) : null}
      {!hasView && !error && !busy && hasChips ? (
        <ViewSuggestions suggestions={suggestions} label="Try one of these:" />
      ) : null}
    </>
  );
}
