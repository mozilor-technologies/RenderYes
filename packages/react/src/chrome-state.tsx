import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SavedViewSummary } from "./use-compose.js";

/**
 * Ephemeral state the chrome shows but the session does not own.
 *
 * A save confirmation, a pin confirmation, whether the My-views menu is open,
 * and the rows it last fetched. None of it belongs on the compose session —
 * reopening a saved view should not clear a confirmation, and the session has
 * no opinion about an open menu.
 *
 * It lives in a context rather than inside one component because the trigger
 * and the display are in different parts: a pin is clicked on a panel, inside
 * the surface, and confirmed in the saved bar above it. While both were inside
 * one 620-line component that was a local `useState`; extracting the parts is
 * what makes the coupling visible, and a context is the honest name for it.
 *
 * Mounted by `ViewProvider`, so every part works standalone under it.
 */
interface ChromeState {
  /** True for a few seconds after a successful save. */
  savedConfirmed: boolean;
  confirmSaved: () => void;
  /** True for a few seconds after a successful pin. */
  pinConfirmed: boolean;
  confirmPinned: () => void;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  /** `null` means "not fetched yet" — distinct from "fetched, and empty". */
  savedRows: readonly SavedViewSummary[] | null;
  setSavedRows: (rows: readonly SavedViewSummary[] | null) => void;
}

/** How long a save or pin confirmation stays on screen. */
export const CONFIRMATION_MS = 4000;

const ChromeStateContext = createContext<ChromeState | undefined>(undefined);

export function ViewChromeProvider({ children }: { children: ReactNode }) {
  return (
    <ChromeStateContext.Provider value={useChromeStateValue()}>
      {children}
    </ChromeStateContext.Provider>
  );
}

/**
 * The chrome state for the surrounding provider.
 *
 * Throws rather than falling back to local state: a part that silently made its
 * own copy would confirm a save nobody could see, which is worse than a clear
 * error naming the missing provider.
 */
export function useChromeState(): ChromeState {
  const value = useContext(ChromeStateContext);
  if (!value) {
    throw new Error("RenderYes chrome must be used inside a <ViewProvider>");
  }
  return value;
}

function useChromeStateValue(): ChromeState {
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [pinConfirmed, setPinConfirmed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [savedRows, setSavedRows] = useState<readonly SavedViewSummary[] | null>(null);

  // One timer per kind, cleared on unmount. A confirmation whose timer outlives
  // the component sets state on something gone.
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
      if (pinTimer.current) clearTimeout(pinTimer.current);
    },
    [],
  );

  const confirmSaved = useCallback(() => {
    setSavedConfirmed(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedConfirmed(false), CONFIRMATION_MS);
  }, []);

  const confirmPinned = useCallback(() => {
    setPinConfirmed(true);
    if (pinTimer.current) clearTimeout(pinTimer.current);
    pinTimer.current = setTimeout(() => setPinConfirmed(false), CONFIRMATION_MS);
  }, []);

  return {
    savedConfirmed,
    confirmSaved,
    pinConfirmed,
    confirmPinned,
    menuOpen,
    setMenuOpen,
    savedRows,
    setSavedRows,
  };
}

/**
 * Chrome options, set by whoever composes the parts.
 *
 * Distinct from the state above: these are a host's choices, and every one has
 * a working default — so a part mounted with no options provider behaves the
 * way the full workspace would. `useChromeState` throws instead, because a
 * missing *state* provider means a confirmation nobody can see.
 */
export interface ChromeOptions {
  /** Whether the saved-view controls are offered at all. */
  savedViewsEnabled: boolean;
  /** Whether panels can be dragged into a new order. */
  rearrangeEnabled: boolean;
}

const DEFAULT_CHROME_OPTIONS: ChromeOptions = {
  savedViewsEnabled: true,
  rearrangeEnabled: true,
};

const ChromeOptionsContext = createContext<ChromeOptions>(DEFAULT_CHROME_OPTIONS);

export function ViewChromeOptionsProvider({
  options,
  children,
}: {
  options: Partial<ChromeOptions>;
  children: ReactNode;
}) {
  const value = { ...DEFAULT_CHROME_OPTIONS, ...options };
  return (
    <ChromeOptionsContext.Provider value={value}>{children}</ChromeOptionsContext.Provider>
  );
}

export function useChromeOptions(): ChromeOptions {
  return useContext(ChromeOptionsContext);
}
