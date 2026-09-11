import { ViewTrigger, type ViewTriggerProps } from "./trigger.js";

/**
 * The floating entry point, under its original name.
 *
 * `ViewTrigger` is the same component. This was a separate 190-line
 * implementation with its own prompt row, its own copy of the revision rule and
 * its own error rendering, which is why it lacked suggestions, saved views,
 * pins and the refusal card — features nobody decided to leave out.
 *
 * `onOpen` keeps its meaning: given, the host owns the click and no panel
 * opens, which is `mode="link"`.
 */
export function ViewLauncher({
  label,
  onOpen,
  ...page
}: Omit<ViewTriggerProps, "mode" | "href">) {
  return (
    <ViewTrigger
      {...page}
      {...(label !== undefined ? { label } : {})}
      {...(onOpen ? { mode: "link" as const, onOpen } : { mode: "dialog" as const })}
    />
  );
}
