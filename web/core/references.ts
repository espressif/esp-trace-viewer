/**
 * Reference markers and time-delta measurement logic for timeline views.
 *
 * Reference markers define points along the shared time axis for calculating intervals. Markers are stored in {@link AppState.references} to coordinate rendering across panes and preserve positions during zoom and pan operations.
 *
 * This module provides pure, immutable operations for adding, toggling, and clearing markers, as well as calculating time and event deltas without DOM dependencies.
 */

import type { ReferenceMarker } from "./store.js";

/** Return the next available marker ID: one greater than the current maximum, or 1 if empty. */
export function nextReferenceId(refs: readonly ReferenceMarker[]): number {
  let max = 0;
  for (const r of refs) if (r.id > max) max = r.id;
  return max + 1;
}

/**
 * Toggle a reference marker at `time`.
 *
 * If a marker exists within `tolerance` seconds, removes the nearest marker; otherwise adds a new marker with an ID from {@link nextReferenceId}. Returns an updated marker array.
 */
export function toggleReference(
  refs: readonly ReferenceMarker[],
  time: number,
  tolerance = 0,
): ReferenceMarker[] {
  let nearest = -1;
  let best = Infinity;
  for (let i = 0; i < refs.length; i++) {
    const d = Math.abs(refs[i]!.time - time);
    if (d <= tolerance && d < best) {
      best = d;
      nearest = i;
    }
  }
  if (nearest >= 0) return refs.filter((_, i) => i !== nearest);
  return [...refs, { id: nextReferenceId(refs), time }];
}

/** Return an empty reference marker array. */
export function clearReferences(): ReferenceMarker[] {
  return [];
}

/** Return a copy of reference markers ordered by ascending timestamp. */
export function sortedByTime(refs: readonly ReferenceMarker[]): ReferenceMarker[] {
  return [...refs].sort((a, b) => a.time - b.time);
}

/**
 * Count events falling within the half-open interval `[lo, hi)` using binary search over sorted `timestamps`.
 */
export function eventsInRange(timestamps: readonly number[], lo: number, hi: number): number {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return lowerBound(timestamps, b) - lowerBound(timestamps, a);
}

/** Return the first index `i` where `arr[i] >= t` in a sorted array. */
function lowerBound(arr: readonly number[], t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Measured span between two timestamps, containing time difference and event count. */
export interface DeltaSpan {
  /** Start timestamp in seconds. */
  from: number;
  /** End timestamp in seconds. */
  to: number;
  /** Span duration in seconds (`to - from`). */
  dt: number;
  /** Number of events in the half-open range `[from, to)`. */
  events: number;
}

/** Complete measurement derived from reference markers and optional cursor position. */
export interface ReferenceMeasurement {
  /** Reference marker timestamps in ascending order. */
  refs: number[];
  /** Spans between adjacent reference marker pairs in chronological order. */
  spans: DeltaSpan[];
  /**
   * Span from the nearest reference marker to the cursor, or `null` if none exists or times coincide.
   */
  toCursor: DeltaSpan | null;
}

/** Construct a {@link DeltaSpan} for the interval between two timestamps. */
export function deltaSpan(a: number, b: number, timestamps: readonly number[]): DeltaSpan {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  return { from, to, dt: to - from, events: eventsInRange(timestamps, from, to) };
}

/**
 * Calculate intervals between adjacent sorted reference markers and from the nearest reference marker to `cursorTime`.
 *
 * `timestamps` supplies sorted event timestamps for event count calculations. If the cursor coincides with the nearest marker, `toCursor` is `null`.
 */
export function measureReferences(
  refs: readonly ReferenceMarker[],
  cursorTime: number | null,
  timestamps: readonly number[] = [],
): ReferenceMeasurement {
  const times = sortedByTime(refs).map((r) => r.time);
  const spans: DeltaSpan[] = [];
  for (let i = 1; i < times.length; i++) {
    spans.push(deltaSpan(times[i - 1]!, times[i]!, timestamps));
  }
  let toCursor: DeltaSpan | null = null;
  if (times.length > 0 && cursorTime !== null) {
    let nearest = times[0]!;
    for (const t of times) if (Math.abs(t - cursorTime) < Math.abs(nearest - cursorTime)) nearest = t;
    if (cursorTime !== nearest) toCursor = deltaSpan(nearest, cursorTime, timestamps);
  }
  return { refs: times, spans, toCursor };
}
