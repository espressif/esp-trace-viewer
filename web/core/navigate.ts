/**
 * Navigation actions for the event stream, supporting timestamp jumps, index jumps, stepping, and boundary navigation.
 *
 * Each action computes a target event index and invokes {@link selectEvent}, updating the shared selection and cursor position. This synchronizes the event list scroll position and cursor markers across timeline and CPU load views. Functions in this module contain no DOM dependencies.
 *
 * `model.events` is ordered by ascending timestamp (see {@link ../../src/trace/processor.TraceModel}). {@link nearestEventIndex} uses binary search on timestamps, while context stepping performs a bounded linear scan.
 */

import type { TraceEvent } from "../../src/trace/index.js";
import { focusedContext, selectEvent } from "./selection.js";
import type { Store } from "./store.js";

/** Step direction: 1 for forward (later in time), -1 for backward (earlier in time). */
export type StepDir = 1 | -1;

/**
 * Return the index of the event with timestamp nearest to `time`, or null when `events` is empty.
 *
 * Performs binary search assuming `events` is ordered by ascending timestamp. On ties, returns the lower index.
 */
export function nearestEventIndex(events: readonly TraceEvent[], time: number): number | null {
  const n = events.length;
  if (n === 0) return null;
  let lo = 0;
  let hi = n - 1;
  // Find the first index whose ts >= time (lower bound).
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.ts < time) lo = mid + 1;
    else hi = mid;
  }
  // `lo` is the first ts >= time; the nearest is either it or its predecessor.
  if (lo > 0) {
    const before = events[lo - 1]!.ts;
    const after = events[lo]!.ts;
    if (time - before <= after - time) return lo - 1;
  }
  return lo;
}

/**
 * Snap `time` to the nearest timestamp in `times` if within `tolerance` seconds. Returns `time` unchanged otherwise.
 */
export function snapToNearestTime(times: readonly number[], time: number, tolerance: number): number {
  const n = times.length;
  if (n === 0) return time;
  let lo = 0;
  let hi = n - 1;
  // First index whose time >= `time` (lower bound); nearest is it or its predecessor.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < time) lo = mid + 1;
    else hi = mid;
  }
  let nearest = times[lo]!;
  if (lo > 0 && time - times[lo - 1]! <= nearest - time) nearest = times[lo - 1]!;
  return Math.abs(nearest - time) <= tolerance ? nearest : time;
}

/** Clamp `index` to the range `[0, count - 1]`, or return `null` if `count` is 0. */
function clampIndex(index: number, count: number): number | null {
  if (count === 0) return null;
  return Math.max(0, Math.min(count - 1, index));
}

/** Select the event closest to `time` in seconds and move the cursor to its timestamp. */
export function goToTimestamp(store: Store, time: number): void {
  const events = store.get().model?.events;
  if (!events) return;
  const i = nearestEventIndex(events, time);
  if (i !== null) selectEvent(store, i);
}

/** Select the event corresponding to 1-based sequence number `num`, clamping to available bounds. */
export function goToEventNumber(store: Store, num: number): void {
  const count = store.get().model?.events.length ?? 0;
  const i = clampIndex(Math.trunc(num) - 1, count);
  if (i !== null) selectEvent(store, i);
}

/** Select the first event in the trace. */
export function goToStart(store: Store): void {
  if ((store.get().model?.events.length ?? 0) > 0) selectEvent(store, 0);
}

/** Select the last event in the trace. */
export function goToEnd(store: Store): void {
  const count = store.get().model?.events.length ?? 0;
  if (count > 0) selectEvent(store, count - 1);
}

/**
 * Step event selection by one position in direction `dir` without wrapping.
 *
 * If no event is currently selected, selects the first event when stepping forward or the last event when stepping backward.
 */
export function stepEvent(store: Store, dir: StepDir): void {
  const count = store.get().model?.events.length ?? 0;
  if (count === 0) return;
  const cur = store.get().selectedEventIndex;
  const next = cur === null ? (dir === 1 ? 0 : count - 1) : clampIndex(cur + dir, count)!;
  selectEvent(store, next);
}

/**
 * Step to the adjacent event belonging to the focused context without wrapping.
 *
 * Scans linearly from the current selection. Performs no operation if no context is focused or if no matching events remain in the direction.
 */
export function stepEventInContext(store: Store, dir: StepDir): void {
  const state = store.get();
  const events = state.model?.events;
  if (!events || events.length === 0) return;
  const ctx = focusedContext(state);
  if (ctx === null) return;
  const start = state.selectedEventIndex ?? (dir === 1 ? -1 : events.length);
  for (let i = start + dir; i >= 0 && i < events.length; i += dir) {
    if (events[i]!.ctxName === ctx) {
      selectEvent(store, i);
      return;
    }
  }
}
