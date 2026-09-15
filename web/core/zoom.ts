/**
 * Zoom and pan operations coordinating {@link TimeScale} mutations and store synchronization.
 *
 * Actions in this module update the active {@link TimeScale} and invoke {@link publishWindow} to synchronize {@link AppState.view} across subscribed timeline, CPU load, and data plot panes.
 *
 * Core calculations are implemented in {@link TimeScale}; this module routes input from the toolbar zoom selector, menu actions, keyboard shortcuts, and canvas wheel/drag handlers.
 */

import { eventTime } from "./selection.js";
import type { Store } from "./store.js";
import type { TimeScale } from "../trace-ui-toolkit/time-scale.js";

/** Span multiplier for a zoom-in step. Its reciprocal zooms out. */
export const ZOOM_STEP = 1 / 1.6;
/** Fraction of the visible window covered by one keyboard pan step. */
export const PAN_STEP_FRAC = 0.15;
/** Fraction of the visible time span used when zooming to an individual event. */
export const SELECTION_ZOOM_FACTOR = 0.125;

/** Mirror active {@link TimeScale} window bounds into the store. */
export function publishWindow(store: Store, ts: TimeScale): void {
  store.set({ view: { t0: ts.t0, t1: ts.t1 } });
}

/** Reset the visible window to the full trace time domain. */
export function zoomToFit(store: Store, ts: TimeScale): void {
  ts.zoomToFit();
  publishWindow(store, ts);
}

/** Set the visible window to `span` seconds, centered on `centerTime` when provided. */
export function zoomToSpan(store: Store, ts: TimeScale, span: number, centerTime?: number): void {
  ts.zoomToSpan(span, centerTime ?? undefined);
  publishWindow(store, ts);
}

/** Zoom in by {@link ZOOM_STEP} around `centerTime`, defaulting to the window midpoint. */
export function zoomIn(store: Store, ts: TimeScale, centerTime?: number | null): void {
  ts.zoomByFactor(ZOOM_STEP, centerTime ?? undefined);
  publishWindow(store, ts);
}

/** Zoom out by {@link ZOOM_STEP} around `centerTime`, defaulting to the window midpoint. */
export function zoomOut(store: Store, ts: TimeScale, centerTime?: number | null): void {
  ts.zoomByFactor(1 / ZOOM_STEP, centerTime ?? undefined);
  publishWindow(store, ts);
}

/** Zoom the visible window to cover the time range `[t0, t1]`. */
export function zoomToRange(store: Store, ts: TimeScale, t0: number, t1: number): void {
  ts.zoomToSelection(t0, t1);
  publishWindow(store, ts);
}

/**
 * Zoom the visible window to the current selection.
 *
 * Fits multi-event ranges to the window; centers single events with a span scaled by {@link SELECTION_ZOOM_FACTOR}. Returns false if no event is selected.
 */
export function zoomToSelectedEvent(store: Store, ts: TimeScale): boolean {
  const s = store.get();
  const t = eventTime(s, s.selectedEventIndex);
  if (t === null) return false;
  const anchor = eventTime(s, s.selectionAnchorIndex);
  if (anchor !== null && anchor !== t) {
    ts.zoomToSelection(Math.min(anchor, t), Math.max(anchor, t));
  } else {
    ts.zoomToSpan(ts.spanSeconds * SELECTION_ZOOM_FACTOR, t);
  }
  publishWindow(store, ts);
  return true;
}

/** Pan the window by a pixel offset. Positive values shift viewport forward in time. */
export function panByPixels(store: Store, ts: TimeScale, dxPixels: number): void {
  ts.panByPixels(dxPixels);
  publishWindow(store, ts);
}

/** Pan the window by a fraction of the visible width. Positive values shift forward in time. */
export function panByFraction(store: Store, ts: TimeScale, frac: number): void {
  ts.panByPixels(frac * ts.plotWidthPx);
  publishWindow(store, ts);
}
