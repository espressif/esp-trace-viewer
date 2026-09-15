/**
 * Time ranges the event lists and the statistics table aggregate over.
 *
 * The Events/Logs dock and the Statistics workspace offer the same three choices — visible window, selection, full range — and keep them independently. This module resolves a choice into a concrete interval so both surfaces interpret the wording the same way.
 *
 * Events are instants, so a selection of one event resolves to a zero-length interval: an event list can still contain that timestamp, while runtime statistics have no elapsed time to accumulate.
 */

import { eventTime } from "./selection.js";
import type { AppState, Scope } from "./store.js";

/** A resolved half-open time interval in seconds. */
export interface ScopeWindow {
  t0: number;
  t1: number;
}

/**
 * Resolve a scope choice against current state.
 *
 * Returns `null` for a selection scope with nothing selected, which callers read as "no rows in scope" rather than "everything".
 */
export function resolveScope(state: AppState, scope: Scope): ScopeWindow | null {
  if (scope === "full") return { t0: state.domain.start, t1: state.domain.end };
  if (scope === "visible") return { t0: state.view.t0, t1: state.view.t1 };
  const focus = eventTime(state, state.selectedEventIndex);
  if (focus === null) return null;
  const anchor = eventTime(state, state.selectionAnchorIndex) ?? focus;
  return { t0: Math.min(anchor, focus), t1: Math.max(anchor, focus) };
}

/** True when `t` falls inside the resolved window, endpoints included. */
export function inScope(w: ScopeWindow | null, t: number): boolean {
  return w !== null && t >= w.t0 && t <= w.t1;
}
