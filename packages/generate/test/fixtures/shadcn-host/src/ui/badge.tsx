import * as React from "react";

/** Fixture shadcn primitive — enough to demonstrate the host's idiom. */
export function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium">
      {children}
    </span>
  );
}
