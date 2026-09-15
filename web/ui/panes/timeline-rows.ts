/**
 * Geometry and data model for the timeline pane.
 *
 * This module transforms the merged, context-tagged {@link TraceEvent} stream into per-lane run intervals and provides window and level-of-detail primitives for canvas rendering:
 *
 * - {@link reconstructTimeline} transforms events into per-context run intervals and per-core unified execution intervals.
 * - {@link visibleRange} returns the index range of intervals intersecting the `[t0, t1]` time window using binary search.
 * - {@link coalesceToPixels} combines visible intervals into pixel-column bars to bound rendering cost by canvas width.
 * - {@link intervalAtTime} locates the interval covering a given timestamp using binary search.
 *
 * All timestamps and intervals use seconds on the same scale as {@link ../../core/time-scale.TimeScale}.
 */

import { classifyContext } from "../../core/context-type.js";
import { classifyEvent } from "../../core/event-class.js";
import { EVTID } from "../../../src/trace/events.js";
import type { TraceEvent } from "../../../src/trace/index.js";

/** Interval defined by `[start, end)` in seconds. */
export interface TimeSpan {
  start: number;
  end: number;
}

/** Sentinel context name the parser uses when no context is known. */
export const NO_CONTEXT = "None";

/** Shared empty set standing in for "no core is switched off". */
const EMPTY_CORES: ReadonlySet<number> = new Set<number>();

/**
 * Continuous execution interval for a single context on a specific core. Intervals within a lane are sorted chronologically by `start` and do not overlap.
 */
export interface RunInterval {
  /** Start time in seconds. */
  start: number;
  /** End time in seconds. */
  end: number;
  /** Context name acting as the lane identifier. */
  key: string;
  /** Source core ID. */
  coreId: number;
  /** True if the interval ran inside an interrupt handler. */
  isr: boolean;
  /** Absolute index in `model.events` of the event opening the run. */
  eventIndex: number;
}

/**
 * In-run event mark representing an API call (`log: false`) or log message (`log: true`). Marks within a lane are sorted chronologically by `t`.
 */
export interface EventMark {
  /** Event timestamp in seconds. */
  t: number;
  /** True for log messages (`svPrint`), false for API calls. */
  log: boolean;
  /** Absolute index of the event in `model.events`. */
  eventIndex: number;
  /** Core the event was recorded on, so the CPU filter can drop it along with the run it sits in. */
  coreId: number;
}

/**
 * Task ready interval (`[start, end)`) during which a task was runnable (`svTaskStartReady`) before executing or leaving the ready state. Intervals within a lane are sorted chronologically by `start` and do not overlap.
 */
export interface ReadyInterval {
  /** Timestamp when the task became ready in seconds. */
  start: number;
  /** Timestamp when the task began executing, stopped being ready, or trace ended. */
  end: number;
  /** Context name of the readied task. */
  key: string;
  /** Absolute index of the opening event in `model.events`. */
  eventIndex: number;
}

/** Pixel-space bar produced by {@link coalesceToPixels}. */
export interface PixelBar {
  /** Left edge coordinate in CSS pixels from canvas origin. */
  x0: number;
  /** Right edge coordinate in CSS pixels. */
  x1: number;
  /** Context name of the dominant interval by elapsed time. */
  key: string;
  /** True if the dominant interval ran in an interrupt handler. */
  isr: boolean;
  /** Absolute event index of the dominant context's initial interval in the bar. */
  eventIndex: number;
  /** Number of source intervals coalesced into this bar. */
  count: number;
}

/** Derived timeline data produced by {@link reconstructTimeline}. */
export interface TimelineData {
  /** Per-core unified execution intervals, `"None"` boundaries included. */
  unifiedByCore: Map<number, RunInterval[]>;
  /**
   * Per-core unified execution intervals without the `"None"` boundaries: what the unified lane paints and hit-tests. Kept apart from {@link unifiedByCore} so the lane does not filter the whole track on every frame.
   */
  paintedByCore: Map<number, RunInterval[]>;
  /** Per-context execution intervals keyed by context name. */
  byContext: Map<string, RunInterval[]>;
  /** Per-context event marks keyed by context name. */
  marksByContext: Map<string, EventMark[]>;
  /** Per-core event marks containing all API and log events on each core. */
  marksByCore: Map<number, EventMark[]>;
  /** Per-context ready intervals keyed by context name. */
  readyByContext: Map<string, ReadyInterval[]>;
  /** Sorted core IDs present in the trace. */
  cores: number[];
  /**
   * Cores each context actually ran on, ascending.
   *
   * A task pinned to one core lists one; a task that migrates lists every core it was seen on, which is what the lane gutter and the statistics table report rather than assuming a single home core.
   */
  coresByContext: Map<string, number[]>;
}

/**
 * Reconstructs per-context and per-core run intervals from the event stream.
 *
 * Each event is tagged with the active executing context (`ctxName`). Scanning events per core, a run interval spans from the first event of a context to the first event of a subsequent different context on that core. The final run extends to `domainEnd`. Successive events within the same context coalesce into a single continuous interval.
 *
 * Multi-core traces are processed per core; context execution on one core is independent of other cores. Events tagged with `"None"` bound runs and appear in unified tracks; they do not generate per-context lanes.
 *
 * An `svOverflow` event marks the end of an interval in which the target dropped events on that core. The run open on the core ends at the previous event on the core rather than at the overflow, and the interval from there to the overflow is recorded in the core's unified track as a `"None"` run so that consumers see a boundary rather than a switch; it belongs to no context lane, and the unified lane does not paint it. Runs after the gap open at their own events as usual.
 *
 * The pass also records per-lane {@link EventMark} entries for API calls and log messages within each run.
 *
 * When `taskNames` is provided, `svTaskStartReady` and `svTaskStopReady` events are synthesized into per-context {@link ReadyInterval} records. A ready interval opens at `svTaskStartReady` and closes when the task begins running, when an explicit `svTaskStopReady` occurs, at the start of a gap on any core, or at `domainEnd`. Ready events occurring while a task is already executing or already marked ready are discarded. Preemption also opens a ready interval: if a task run ends before `domainEnd` without an intervening `svTaskStopReady`, a ready interval begins at run end, unless a gap lies between the two runs, in which case nothing is known about the task in between.
 */
export function reconstructTimeline(
  events: readonly TraceEvent[],
  domainEnd: number,
  taskNames?: ReadonlyMap<number, string>,
): TimelineData {
  const unifiedByCore = new Map<number, RunInterval[]>();
  const paintedByCore = new Map<number, RunInterval[]>();
  const byContext = new Map<string, RunInterval[]>();
  const marksByContext = new Map<string, EventMark[]>();
  const marksByCore = new Map<number, EventMark[]>();
  // Raw ready and not-ready edges per task name.
  const readyEdges = new Map<string, { t: number; eventIndex: number }[]>();
  const stopEdges = new Map<string, number[]>();

  /** Record an API/log event as a mark on its core (Unified) and context lane. */
  const mark = (e: TraceEvent, idx: number): void => {
    const cls = classifyEvent(e);
    if (cls !== "api" && cls !== "message") return;
    const m: EventMark = { t: e.ts, log: cls === "message", eventIndex: idx, coreId: e.coreId };
    let core = marksByCore.get(e.coreId);
    if (!core) marksByCore.set(e.coreId, (core = []));
    core.push(m);
    if (e.ctxName !== NO_CONTEXT) {
      let lane = marksByContext.get(e.ctxName);
      if (!lane) marksByContext.set(e.ctxName, (lane = []));
      lane.push(m);
    }
  };

  /** Active execution context and opening event per core. */
  interface Open {
    key: string;
    isr: boolean;
    start: number;
    idx: number;
  }
  const open = new Map<number, Open>();
  /** Timestamp of the last event seen per core, which is where a gap on that core starts. */
  const lastTs = new Map<number, number>();
  /** Start of every gap on any core, sorted after the scan; ready intervals cannot be trusted past one. */
  const gapStarts: number[] = [];

  const push = (iv: RunInterval): void => {
    let uni = unifiedByCore.get(iv.coreId);
    if (!uni) unifiedByCore.set(iv.coreId, (uni = []));
    uni.push(iv);
    if (iv.key !== NO_CONTEXT) {
      let painted = paintedByCore.get(iv.coreId);
      if (!painted) paintedByCore.set(iv.coreId, (painted = []));
      painted.push(iv);
      let lane = byContext.get(iv.key);
      if (!lane) byContext.set(iv.key, (lane = []));
      lane.push(iv);
    }
  };

  /** Returns the task name for a readied task identifier. */
  const taskName = (tid: number): string => taskNames?.get(tid) ?? `task0x${tid.toString(16)}`;

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    mark(e, i);
    if (taskNames) {
      if (e.id === EVTID.TASK_START_READY) {
        const key = taskName(e.params["tid"] as number);
        let edges = readyEdges.get(key);
        if (!edges) readyEdges.set(key, (edges = []));
        edges.push({ t: e.ts, eventIndex: i });
      } else if (e.id === EVTID.TASK_STOP_READY) {
        const key = taskName(e.params["tid"] as number);
        let stops = stopEdges.get(key);
        if (!stops) stopEdges.set(key, (stops = []));
        stops.push(e.ts);
      }
    }
    const cur = open.get(e.coreId);
    const prevTs = lastTs.get(e.coreId);
    lastTs.set(e.coreId, e.ts);
    if (e.id === EVTID.OVERFLOW) {
      // Events were lost between the previous event on this core and here: the open run ends at that previous event, and the interval up to the overflow belongs to no context.
      const gapStart = prevTs ?? e.ts;
      if (cur) {
        push({
          start: cur.start,
          end: Math.max(cur.start, gapStart),
          key: cur.key,
          coreId: e.coreId,
          isr: cur.isr,
          eventIndex: cur.idx,
        });
      }
      open.set(e.coreId, { key: NO_CONTEXT, isr: false, start: gapStart, idx: i });
      gapStarts.push(gapStart);
      continue;
    }
    if (!cur) {
      open.set(e.coreId, { key: e.ctxName, isr: e.inIrq, start: e.ts, idx: i });
      continue;
    }
    if (e.ctxName !== cur.key) {
      push({
        start: cur.start,
        end: Math.max(cur.start, e.ts),
        key: cur.key,
        coreId: e.coreId,
        isr: cur.isr,
        eventIndex: cur.idx,
      });
      open.set(e.coreId, { key: e.ctxName, isr: e.inIrq, start: e.ts, idx: i });
    }
  }

  for (const [coreId, cur] of open) {
    push({
      start: cur.start,
      end: Math.max(cur.start, domainEnd),
      key: cur.key,
      coreId,
      isr: cur.isr,
      eventIndex: cur.idx,
    });
  }

  gapStarts.sort((a, b) => a - b);

  // Synthesize ready intervals from edges, run starts, and explicit stop edges.
  const readyByContext = new Map<string, ReadyInterval[]>();
  const taskKeys = new Set(taskNames?.values() ?? []);
  const keys = new Set(readyEdges.keys());
  for (const key of byContext.keys()) if (taskKeys.has(key)) keys.add(key);
  for (const key of keys) {
    const runs = byContext.get(key) ?? [];
    const stops = stopEdges.get(key) ?? [];
    const explicit = readyEdges.get(key) ?? [];
    // Merge explicit ready edges with synthesized preemption edges at run endings. A task run ending without an explicit stop-ready edge is treated as preempted unless:
    // - an explicit stop-ready edge occurs within the run,
    // - an explicit ready edge occurs before the subsequent run, or
    // - the intervening interval consists solely of ISRs or contains an idle task run.
    let edges = explicit;
    if (taskKeys.has(key)) {
      const merged: { t: number; eventIndex: number }[] = [];
      let ei = 0; // Unmerged explicit edge index.
      let xi = 0; // Explicit edge index at or after tested gap.
      let si = 0; // Stop edge index after run start.
      for (let ri = 0; ri < runs.length; ri++) {
        const r = runs[ri]!;
        while (ei < explicit.length && explicit[ei]!.t <= r.end) merged.push(explicit[ei++]!);
        if (r.end >= domainEnd) continue;
        const nextStart = ri + 1 < runs.length ? runs[ri + 1]!.start : domainEnd;
        if (nextStart <= r.end) continue;
        while (si < stops.length && stops[si]! <= r.start) si++;
        if (si < stops.length && stops[si]! <= r.end) continue;
        while (xi < explicit.length && explicit[xi]!.t < r.end) xi++;
        if (xi < explicit.length && explicit[xi]!.t <= nextStart) continue;
        if (!gapShowsPreemption(unifiedByCore.get(r.coreId), key, r.end, nextStart)) continue;
        merged.push({ t: r.end, eventIndex: r.eventIndex });
      }
      while (ei < explicit.length) merged.push(explicit[ei++]!);
      edges = merged;
    }
    const out: ReadyInterval[] = [];
    let lastEnd = -Infinity;
    for (const edge of edges) {
      // Skip if already marked ready or currently executing.
      if (edge.t < lastEnd) continue;
      if (intervalAtTime(runs, edge.t)) continue;
      const nextRun = firstStartAtOrAfter(runs, edge.t);
      let end = nextRun < runs.length ? runs[nextRun]!.start : domainEnd;
      // Locate first stop-ready edge following the ready timestamp.
      let lo = 0;
      let hi = stops.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (stops[mid]! <= edge.t) lo = mid + 1;
        else hi = mid;
      }
      if (lo < stops.length && stops[lo]! < end) end = stops[lo]!;
      // A gap on any core cuts the interval short: whether the task stayed ready is unknown past it. A gap starting at the edge itself does not count; the edge is a recorded event, so the task was ready from there.
      const gap = firstAfter(gapStarts, edge.t);
      if (gap < gapStarts.length && gapStarts[gap]! < end) end = gapStarts[gap]!;
      if (end > domainEnd) end = domainEnd;
      if (end <= edge.t) continue;
      out.push({ start: edge.t, end, key, eventIndex: edge.eventIndex });
      lastEnd = end;
    }
    if (out.length) readyByContext.set(key, out);
  }

  const cores = [...unifiedByCore.keys()].sort((a, b) => a - b);

  const coresByContext = new Map<string, number[]>();
  for (const [key, runs] of byContext) {
    const seen = new Set<number>();
    for (const r of runs) seen.add(r.coreId);
    coresByContext.set(key, [...seen].sort((a, b) => a - b));
  }

  return { unifiedByCore, paintedByCore, byContext, marksByContext, marksByCore, readyByContext, cores, coresByContext };
}

/**
 * Returns true if the time gap `(t0, t1)` between runs of `key` represents preemption. Returns false if the gap contains only ISR intervals, if the core entered the idle task during the gap, or if the core lost events during the gap (a `"None"` interval), since then nothing is known about the task in between.
 */
function gapShowsPreemption(unified: readonly RunInterval[] | undefined, key: string, t0: number, t1: number): boolean {
  if (!unified) return false;
  let sawOther = false;
  for (let i = firstEndAfter(unified, t0); i < unified.length && unified[i]!.start < t1; i++) {
    const iv = unified[i]!;
    if (iv.isr || iv.key === key) continue;
    if (iv.key === NO_CONTEXT) return false;
    if (classifyContext(iv.key, false) === "Idle") return false;
    sawOther = true;
  }
  return sawOther;
}

/** Returns the first index `i` where `values[i] > t` in an ascending array, or `values.length` if none. */
function firstAfter(values: readonly number[], t: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Returns the first index `i` where `intervals[i].end > t`. Uses binary search on monotonic interval endpoints. Returns `intervals.length` if all intervals end at or before `t`.
 */
export function firstEndAfter<T extends TimeSpan>(intervals: readonly T[], t: number): number {
  let lo = 0;
  let hi = intervals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (intervals[mid]!.end > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Returns the first index `i` where `intervals[i].start >= t`. Uses binary search on sorted interval start times. Returns `intervals.length` if none match.
 */
export function firstStartAtOrAfter<T extends TimeSpan>(intervals: readonly T[], t: number): number {
  let lo = 0;
  let hi = intervals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (intervals[mid]!.start >= t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Returns the index slice `[lo, hi)` of `intervals` intersecting `[t0, t1]`. Both boundaries are found via binary search in O(log n) time.
 */
export function visibleRange<T extends TimeSpan>(
  intervals: readonly T[],
  t0: number,
  t1: number,
): { lo: number; hi: number } {
  const lo = firstEndAfter(intervals, t0);
  const hi = firstStartAtOrAfter(intervals, t1);
  return { lo, hi: Math.max(lo, hi) };
}

/**
 * Returns the index slice `[lo, hi)` of `marks` falling within `[t0, t1]`. Both boundaries are found via binary search.
 */
export function marksInRange(
  marks: readonly EventMark[],
  t0: number,
  t1: number,
): { lo: number; hi: number } {
  const bound = (target: number): number => {
    let lo = 0;
    let hi = marks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid]!.t < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const lo = bound(t0);
  const hi = bound(t1);
  return { lo, hi: Math.max(lo, hi) };
}

/**
 * Returns the index of the mark nearest to timestamp `t`, or -1 if `marks` is empty. Uses binary search to find the insertion point and returns the closer adjacent mark.
 */
export function nearestMarkIndex(marks: readonly EventMark[], t: number): number {
  if (marks.length === 0) return -1;
  let lo = 0;
  let hi = marks.length; // Index with marks[i].t >= t.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 0;
  if (lo === marks.length) return marks.length - 1;
  // Return the closer mark between insertion neighbors.
  return t - marks[lo - 1]!.t <= marks[lo]!.t - t ? lo - 1 : lo;
}

/**
 * Combines intervals intersecting `[t0, t1]` into pixel-space bars, merging intervals that occupy the same pixel column. Output is bounded by `widthPx + 1` bars regardless of interval count, ensuring O(widthPx) rendering time.
 *
 * Timestamps map onto `[offsetPx, widthPx]` matching {@link ../../core/time-scale.TimeScale.timeToX}.
 *
 * Bars are expanded to a minimum width of `minBarPx` so sub-pixel intervals remain visible. Each coalesced bar represents the context that occupied the greatest total duration within the column.
 *
 * Intervals recorded on a core listed in `hiddenCores` are left out, which is how a task that migrates between cores shows only the runs on the cores still switched on.
 */
export function coalesceToPixels(
  intervals: readonly RunInterval[],
  t0: number,
  t1: number,
  widthPx: number,
  offsetPx = 0,
  minBarPx = 1,
  hiddenCores: ReadonlySet<number> = EMPTY_CORES,
): PixelBar[] {
  const out: PixelBar[] = [];
  const span = t1 - t0;
  const plotW = widthPx - offsetPx;
  if (span <= 0 || plotW <= 0) return out;
  const sx = plotW / span;

  const { lo, hi } = visibleRange(intervals, t0, t1);
  let cur: PixelBar | null = null;
  // Per-bar occupancy map tracking accumulated visible width per context.
  const held = new Map<string, { w: number; iv: RunInterval }>();
  let bestW = -1;

  for (let i = lo; i < hi; i++) {
    const iv = intervals[i]!;
    if (hiddenCores.has(iv.coreId)) continue; // A migrating task loses only the runs on switched-off cores.
    let x0 = offsetPx + (iv.start - t0) * sx;
    let x1 = offsetPx + (iv.end - t0) * sx;
    if (x0 < offsetPx) x0 = offsetPx;
    if (x1 > widthPx) x1 = widthPx;
    if (x1 < x0) continue;
    // Weight occupancy using unexpanded width to prevent sub-pixel intervals from overshadowing long runs.
    const w = x1 - x0;
    if (w < minBarPx) x1 = x0 + minBarPx;

    // Merge into current bar if interval falls within the same pixel column. Begin a new bar when extending into a new column.
    if (cur && Math.floor(x1) <= Math.floor(cur.x1)) {
      if (x1 > cur.x1) cur.x1 = x1;
      cur.count++;
    } else {
      cur = { x0, x1, key: iv.key, isr: iv.isr, eventIndex: iv.eventIndex, count: 1 };
      out.push(cur);
      held.clear();
      bestW = -1;
    }

    let slot = held.get(iv.key);
    if (slot) slot.w += w;
    else held.set(iv.key, (slot = { w, iv }));
    // Maintain earliest interval in case of equal duration.
    if (slot.w > bestW) {
      bestW = slot.w;
      cur.key = slot.iv.key;
      cur.isr = slot.iv.isr;
      cur.eventIndex = slot.iv.eventIndex;
    }
  }
  return out;
}

/**
 * Returns the interval covering timestamp `t` (`start <= t < end`), or `null` if `t` falls in a gap. Uses binary search over non-overlapping sorted intervals.
 */
export function intervalAtTime<T extends TimeSpan>(intervals: readonly T[], t: number): T | null {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const iv = intervals[mid]!;
    if (t < iv.start) hi = mid - 1;
    else if (t >= iv.end) lo = mid + 1;
    else return iv;
  }
  return null;
}
