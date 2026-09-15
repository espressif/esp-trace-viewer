/**
 * Content search over the event stream.
 *
 * This module builds lists of events matching a query and steps through matches forward and backward with wrapping.
 *
 * ### Query Matching
 * Queries match as case-insensitive substrings against an event's searchable text: event name, context name, and parameters formatted as `key=value`.
 *
 * ### Scope
 * {@link findMatches} searches the optionally filtered event set passed by the caller. Search operates over the currently visible events without modifying filter state.
 *
 * ### Performance
 * Matching performs a linear scan over the provided events without maintaining an index.
 */

import { type ParamValue, type TraceEvent } from "../../src/trace/index.js";

/** Format a parameter value for search indexing. */
function paramText(v: ParamValue): string {
  if (Array.isArray(v)) return v.map((n) => `0x${(n >>> 0).toString(16)}`).join(" ");
  return String(v);
}

/**
 * Generate lowercased search text for an event, combining event name, context name, and parameters formatted as `key=value`.
 */
export function searchableText(e: TraceEvent): string {
  let s = `${e.name} ${e.ctxName}`;
  for (const k of Object.keys(e.params)) s += ` ${k}=${paramText(e.params[k]!)}`;
  return s.toLowerCase();
}

/**
 * Determine whether an event matches a lowercased search query.
 */
export function matchesQuery(e: TraceEvent, queryLower: string): boolean {
  return searchableText(e).includes(queryLower);
}

/**
 * Return absolute indices of events matching `query` in ascending chronological order.
 *
 * `visible` supplies filtered event indices, or `null` to search all events. Returns an empty array if `query` is blank.
 */
export function findMatches(
  events: readonly TraceEvent[],
  query: string,
  visible: Int32Array | null,
): number[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const out: number[] = [];
  if (visible) {
    for (let i = 0; i < visible.length; i++) {
      const abs = visible[i]!;
      if (matchesQuery(events[abs]!, q)) out.push(abs);
    }
  } else {
    for (let i = 0; i < events.length; i++) {
      if (matchesQuery(events[i]!, q)) out.push(i);
    }
  }
  return out;
}

/**
 * Find index in `matches` of the first match at or after absolute event index `current`.
 *
 * Returns 0 if `current` is null or exceeds the last match index, and -1 if `matches` is empty.
 */
export function firstMatchPos(matches: readonly number[], current: number | null): number {
  if (matches.length === 0) return -1;
  if (current === null) return 0;
  const i = lowerBound(matches, current);
  return i < matches.length ? i : 0;
}

/**
 * Find index in `matches` of the next match after `current`, wrapping to the start. Returns -1 if `matches` is empty.
 */
export function nextMatchPos(matches: readonly number[], current: number | null): number {
  if (matches.length === 0) return -1;
  if (current === null) return 0;
  const i = upperBound(matches, current);
  return i < matches.length ? i : 0;
}

/**
 * Find index in `matches` of the previous match before `current`, wrapping to the end. Returns -1 if `matches` is empty.
 */
export function prevMatchPos(matches: readonly number[], current: number | null): number {
  if (matches.length === 0) return -1;
  if (current === null) return matches.length - 1;
  const i = lowerBound(matches, current);
  return i > 0 ? i - 1 : matches.length - 1;
}

/** Return the first index where `matches[i] >= value` using binary search. */
function lowerBound(matches: readonly number[], value: number): number {
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Return the first index where `matches[i] > value` using binary search. */
function upperBound(matches: readonly number[], value: number): number {
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
