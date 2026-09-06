/** Time formatting shared by the UI. No business rules live here. */

/**
 * "just now" / "12m ago" / "3h ago" / "2d ago".
 *
 * Used wherever we show how stale a scan is, which is most places that show
 * availability at all — the whole product rests on the user knowing how old
 * the data is.
 */
export function timeAgo(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
