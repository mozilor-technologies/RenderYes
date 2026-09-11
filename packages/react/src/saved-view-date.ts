/**
 * A summary's timestamp as a short human date, or `null` when the service sent
 * something unparseable — a menu row missing its date beats one showing
 * "Invalid Date".
 */
export function savedViewDate(iso: string): string | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return new Date(time).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
