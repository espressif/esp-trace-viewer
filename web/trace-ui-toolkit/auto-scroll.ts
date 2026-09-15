/**
 * Calculates visible window bounds for auto-scrolling during live capture.
 *
 * When auto-scroll is enabled, the visible window follows the trailing edge of incoming events. The right edge aligns with the domain end while preserving window duration. Disabling auto-scroll preserves the current window offset; re-enabling aligns the window with the current domain end.
 *
 * The calculation handles two zoom states: when zoomed in, it preserves the current time span, aligns the right edge with `domainEnd`, and clamps the start to `domainStart`. When fully zoomed out, it expands the window to cover the full domain.
 *
 * The function is pure and operates on numerical bounds without DOM dependencies.
 */

/** Visible time window interval `[t0, t1]` in seconds. */
export interface Window {
  t0: number;
  t1: number;
}

/**
 * Calculates the visible window aligned with the tail of `[domainStart, domainEnd]`.
 *
 * @param domainStart Start of the trace domain, in seconds.
 * @param domainEnd   End of the trace domain, in seconds.
 * @param span        Duration to preserve, in seconds (current view width).
 * @param wasFullyZoomedOut Whether the view previously covered the full domain; when true, the returned window covers the updated full domain.
 */
export function followTail(
  domainStart: number,
  domainEnd: number,
  span: number,
  wasFullyZoomedOut: boolean,
): Window {
  const domainSpan = Math.max(0, domainEnd - domainStart);
  // Expand to cover the full domain when previously zoomed out.
  if (wasFullyZoomedOut) return { t0: domainStart, t1: domainEnd };
  // Return the full domain when the requested span equals or exceeds domain duration.
  const keep = Math.min(Math.max(span, 0), domainSpan);
  if (keep <= 0 || keep >= domainSpan) return { t0: domainStart, t1: domainEnd };
  return { t0: domainEnd - keep, t1: domainEnd };
}
