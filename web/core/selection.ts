/**
 * Selection actions and state derivations shared across application panes.
 *
 * Focus state is centralized in two store properties: {@link AppState.selectedEventIndex} and {@link AppState.cursorTime}, accompanied by context highlight resolution.
 *
 * Core operations:
 * - {@link selectEvent} updates the selected event index and associated cursor timestamp, and clears explicit context selection so the owning context derives from the selected event.
 * - {@link focusedContext} resolves the active execution context, prioritizing explicit context selection over the owning context of the selected event.
 */

import type { AppState, Store } from "./store.js";

/** Return trace timestamp in seconds for the event at `index`, or `null` if absent. */
export function eventTime(state: AppState, index: number | null): number | null {
  if (index === null) return null;
  return state.model?.events[index]?.ts ?? null;
}

/**
 * Select the event at `index` in `model.events` and move the cursor to its timestamp, or clear selection when `index` is null.
 *
 * Updates {@link AppState.cursorTime} to match the event timestamp and clears {@link AppState.selectedContext}. Ignores invalid indices.
 *
 * When `extend` is true, preserves `selectionAnchorIndex` to define a selection range between anchor and `index`.
 */
export function selectEvent(store: Store, index: number | null, extend = false): void {
  if (index === null) {
    store.set({ selectedEventIndex: null, selectionAnchorIndex: null });
    return;
  }
  const time = eventTime(store.get(), index);
  if (time === null) return; // Ignore out-of-range indices or missing models.
  const anchor = extend ? (store.get().selectionAnchorIndex ?? store.get().selectedEventIndex ?? index) : index;
  store.set({ selectedEventIndex: index, selectionAnchorIndex: anchor, cursorTime: time, selectedContext: null });
}

/**
 * Resolve the focused execution-context name, prioritizing explicit context selection over the context of the selected event. Returns `null` if neither is selected.
 */
export function focusedContext(state: AppState): string | null {
  if (state.selectedContext !== null) return state.selectedContext;
  const i = state.selectedEventIndex;
  if (i === null) return null;
  return state.model?.events[i]?.ctxName ?? null;
}
