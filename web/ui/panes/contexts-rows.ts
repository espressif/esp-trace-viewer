/**
 * Data processing layer for the Contexts pane.
 *
 * Converts {@link RunInterval} arrays into per-context runtime statistics (the cores it ran on, run count, frequency, last/min/max/average/total run times, and the share of one core it occupied), classifies context types (Task, ISR, Idle), and extracts priority, stack, and handle attributes from `svTaskInfo` and `svStackInfo` events. Operates over arbitrary `[t0, t1]` time ranges for full-trace and viewport-bounded metrics. Intervals crossing range boundaries are clipped to the evaluation range. Times are represented in seconds on the {@link ../../core/time-scale.TimeScale} scale.
 */

import { EVTID } from "../../../src/trace/events.js";
import type { TraceModel } from "../../../src/trace/index.js";
import { classifyContext, type ContextType } from "../../core/context-type.js";
import { groupThousands } from "../../core/format.js";
import { visibleRange, type RunInterval } from "./timeline-rows.js";

export type { ContextType };

/** Static per-context detail from the parser. */
export interface ContextInfo {
  /** Task handle (FreeRTOS tid / embOS task id), if known. */
  handle?: number;
  /** Scheduling priority, from `svTaskInfo`. */
  priority?: number;
  /** Stack base address, from `svStackInfo`. */
  stackBase?: number;
  /** Stack size in bytes, from `svStackInfo`. */
  stackSize?: number;
}

/** One row of the Contexts table: a context's run-time statistics over a range. */
export interface ContextStats {
  /** Context key (the `lanes[].key` / `ctxName`). */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Task / ISR / Idle classification. */
  type: ContextType;
  /**
   * Every core the context was recorded on, ascending. A task pinned to one core lists one; a task that
   * migrated lists each core it ran on, over the whole capture rather than the range in view.
   */
  cores: readonly number[];
  /** Priority, stack, and handle attributes from the parser. */
  info: ContextInfo;
  /** Number of (clipped, non-empty) runs in the range. */
  runCount: number;
  /** Runs per second over the range, in Hz. */
  frequency: number;
  /** Duration of the most recent run in the range, in seconds. */
  lastRunTime: number;
  /** Shortest run in the range, in seconds (0 when there are no runs). */
  minRunTime: number;
  /** Longest run in the range, in seconds. */
  maxRunTime: number;
  /** Where the longest run starts, in seconds, so the table can navigate to it. 0 when there are no runs. */
  maxRunStart: number;
  /** Mean run in the range, in seconds (0 when there are no runs). */
  avgRunTime: number;
  /** Sum of run durations in the range, in seconds. */
  totalRunTime: number;
  /**
   * Total run time as a percentage of the range span: the share of one core the context occupied. A context
   * runs on one core at a time, so this stays within 100 % however many cores it migrated between.
   */
  pctTotal: number;
}

/**
 * Classify context type from key and execution intervals. Contexts containing interrupt runs are classified as ISR.
 */
export function classifyContextType(key: string, intervals: readonly RunInterval[]): ContextType {
  return classifyContext(key, intervals.some((iv) => iv.isr));
}

/**
 * Extract per-context metadata (`svTaskInfo` and `svStackInfo`) from the event stream, keyed by context name.
 */
export function collectContextInfo(model: TraceModel): Map<string, ContextInfo> {
  const nameOf = new Map<number, string>();
  for (const t of model.traces) for (const [tid, name] of t.tasks) nameOf.set(tid, name);

  const info = new Map<string, ContextInfo>();
  const entry = (name: string): ContextInfo => {
    let e = info.get(name);
    if (!e) info.set(name, (e = {}));
    return e;
  };

  for (const e of model.events) {
    if (e.id === EVTID.TASK_INFO) {
      const tid = e.params["tid"] as number;
      const name = nameOf.get(tid) ?? (e.params["name"] as string | undefined);
      if (name === undefined) continue;
      const ci = entry(name);
      ci.handle = tid;
      if (typeof e.params["prio"] === "number") ci.priority = e.params["prio"];
    } else if (e.id === EVTID.STACK_INFO) {
      const tid = e.params["tid"] as number;
      const name = nameOf.get(tid);
      if (name === undefined) continue;
      const ci = entry(name);
      ci.handle = tid;
      if (typeof e.params["base"] === "number") ci.stackBase = e.params["base"];
      if (typeof e.params["sz"] === "number") ci.stackSize = e.params["sz"];
    }
  }
  return info;
}

/**
 * Calculate run count, total duration, min duration, max duration, and last duration over intervals clipped
 * to [t0, t1], along with where the longest run starts so the table can navigate to it.
 */
export function aggregateIntervals(
  intervals: readonly RunInterval[],
  t0: number,
  t1: number,
): { runCount: number; total: number; min: number; max: number; maxStart: number; last: number } {
  const { lo, hi } = visibleRange(intervals, t0, t1);
  let runCount = 0;
  let total = 0;
  let min = Infinity;
  let max = 0;
  let maxStart = 0;
  let last = 0;
  for (let i = lo; i < hi; i++) {
    const iv = intervals[i]!;
    const s = iv.start < t0 ? t0 : iv.start;
    const e = iv.end > t1 ? t1 : iv.end;
    const d = e - s;
    if (d <= 0) continue;
    runCount++;
    total += d;
    if (d < min) min = d;
    if (d > max) {
      max = d;
      maxStart = s;
    }
    last = d; // Intervals are sorted in ascending time order.
  }
  return { runCount, total, min: runCount ? min : 0, max, maxStart, last };
}

/**
 * Aggregate per-context run intervals into {@link ContextStats} records over `[range.t0, range.t1]`. Accepts trace domain bounds or current view bounds.
 */
export function aggregateContexts(
  byContext: Map<string, RunInterval[]>,
  labels: Map<string, string>,
  range: { t0: number; t1: number },
  info: Map<string, ContextInfo> = new Map(),
): ContextStats[] {
  const span = Math.max(0, range.t1 - range.t0);
  const out: ContextStats[] = [];
  for (const [key, intervals] of byContext) {
    const a = aggregateIntervals(intervals, range.t0, range.t1);
    out.push({
      key,
      label: labels.get(key) ?? key,
      type: classifyContextType(key, intervals),
      cores: recordedCores(intervals),
      info: info.get(key) ?? {},
      runCount: a.runCount,
      frequency: span > 0 ? a.runCount / span : 0,
      lastRunTime: a.last,
      minRunTime: a.min,
      maxRunTime: a.max,
      maxRunStart: a.maxStart,
      avgRunTime: a.runCount ? a.total / a.runCount : 0,
      totalRunTime: a.total,
      pctTotal: span > 0 ? (a.total / span) * 100 : 0,
    });
  }
  return out;
}

/** The cores a context's runs were recorded on, ascending. */
function recordedCores(intervals: readonly RunInterval[]): number[] {
  return [...new Set(intervals.map((iv) => iv.coreId))].sort((a, b) => a - b);
}

/** Sortable column field names in {@link ContextStats}. */
export type SortColumn =
  | "label"
  | "type"
  | "cores"
  | "priority"
  | "stackSize"
  | "runCount"
  | "frequency"
  | "lastRunTime"
  | "minRunTime"
  | "maxRunTime"
  | "avgRunTime"
  | "totalRunTime"
  | "pctTotal";

/**
 * Sort context statistics records by specified column and direction (1 ascending, -1 descending).
 *
 * A row missing the value a column reports — a priority or a stack size the capture never announced — sorts
 * below every row that has one, whichever way round the column is pointing.
 */
export function sortStats(stats: readonly ContextStats[], col: SortColumn, dir: 1 | -1): ContextStats[] {
  const missing = (s: ContextStats): boolean =>
    (col === "priority" && s.info.priority === undefined) ||
    (col === "stackSize" && s.info.stackSize === undefined) ||
    (col === "cores" && s.cores.length === 0);
  const cmp = (a: ContextStats, b: ContextStats): number => {
    if (col === "label") return a.label.localeCompare(b.label);
    if (col === "type") return a.type.localeCompare(b.type) || a.label.localeCompare(b.label);
    if (col === "cores") return (a.cores[0] ?? 0) - (b.cores[0] ?? 0) || a.cores.length - b.cores.length;
    if (col === "priority") return (a.info.priority ?? 0) - (b.info.priority ?? 0);
    if (col === "stackSize") return (a.info.stackSize ?? 0) - (b.info.stackSize ?? 0);
    return (a[col] as number) - (b[col] as number);
  };
  return [...stats].sort((a, b) => {
    if (missing(a) !== missing(b)) return missing(a) ? 1 : -1;
    return dir * cmp(a, b);
  });
}

/** Format a frequency in Hz with an SI suffix (`0 Hz`, `1.234 kHz`, `2.000 MHz`). */
export function formatFrequency(hz: number): string {
  if (!Number.isFinite(hz) || hz === 0) return "0 Hz";
  const units: [number, string][] = [
    [1e6, "MHz"],
    [1e3, "kHz"],
    [1, "Hz"],
  ];
  for (const [scale, suffix] of units) {
    if (Math.abs(hz) >= scale * (1 - 1e-9)) return `${(hz / scale).toFixed(3)} ${suffix}`;
  }
  return `${(hz * 1e3).toFixed(3)} mHz`;
}

/** Format a run-time percentage with two decimals (`12.34 %`). */
export function formatPercent(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  return `${pct.toFixed(2)} %`;
}

/** Format a scheduling priority, or an em dash when the capture never announced one. */
export function formatPriority(info: ContextInfo): string {
  return info.priority === undefined ? "—" : String(info.priority);
}

/**
 * Largest stack size worth believing, in bytes.
 *
 * `svStackInfo`'s `sz` decodes as a `u32`, and captures report values just under 2^32 for most tasks —
 * small negative numbers read as unsigned. No embedded task has a two-gigabyte stack, so anything at or
 * above this reads as an em dash rather than as a number nobody can act on. See the note in `TODO.md`
 * about finding out what the field actually carries.
 */
const MAX_PLAUSIBLE_STACK = 2 ** 31;

/** Format a stack size in bytes, or an em dash when the capture reported none or reported nonsense. */
export function formatStackSize(info: ContextInfo): string {
  const sz = info.stackSize;
  if (sz === undefined || sz >= MAX_PLAUSIBLE_STACK) return "—";
  return `${groupThousands(sz)} B`;
}

/**
 * Format the cores a context ran on: `0`, `0/1` for a task that migrated, or an em dash when it never ran.
 */
export function formatCores(cores: readonly number[]): string {
  return cores.length ? cores.join("/") : "—";
}
