/**
 * Transforms raw `.svdat` buffers into store state.
 *
 * This module parses input buffers via {@link ../../src/trace/index.parseTraceFiles}, calculates the trace time domain, determines execution-context lanes, and extracts timestamp resolution, returning a {@link LoadResult}. File selection, drag-and-drop handling, and fixture fetching are handled in the UI layer, passing byte buffers to this module.
 *
 * Supported buffer configurations:
 * - A single `.svdat` buffer for single-core traces.
 * - A pair of per-core buffers (`core0`, `core1`) in core order.
 * - A single buffer containing a combined SEGGER multi-core file, split during parsing.
 *
 * The parser skips unrecognized payloads to recover usable data. Severe framing or sync errors raise {@link TraceParseError} for caller handling.
 */

import { EVTID } from "../../src/trace/events.js";
import { parseTraceFiles, type ProcessOptions, type TraceModel } from "../../src/trace/index.js";
import { classifyContext, CONTEXT_TYPE_ORDER } from "./context-type.js";
import { contextRole } from "./lanes/context-role.js";
import type { LaneState } from "./store.js";

/** Load result returned by {@link buildLoad}. */
export interface LoadResult {
  /** Merged and context-tagged trace model. */
  model: TraceModel;
  /** Full trace time domain in seconds. */
  domain: { start: number; end: number };
  /** Timestamp resolution in seconds (`1 / sysFreq`), or 0 if uninitialized. */
  timeResolution: number;
  /** Source filenames for UI display. */
  sourceNames: string[];
}

/**
 * Parse trace byte buffers and derive a {@link LoadResult}.
 *
 * `names` specifies display filenames. `opts` provides optional parser configuration, such as ELF symbols.
 */
export function buildLoad(buffers: Uint8Array[], names: string[] = [], opts: ProcessOptions = {}): LoadResult {
  const model = parseTraceFiles(buffers, opts);
  return {
    model,
    domain: deriveDomain(model),
    timeResolution: deriveResolution(model),
    sourceNames: names,
  };
}

/** Compute the time domain `[start, end]` in seconds from event timestamps. Defaults to `[0, 1]` when empty. */
export function deriveDomain(model: TraceModel): { start: number; end: number } {
  let start = Infinity;
  let end = -Infinity;
  for (const e of model.events) {
    if (e.ts < start) start = e.ts;
    if (e.ts > end) end = e.ts;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { start: 0, end: Number.isFinite(end) && end > 0 ? end : 1 };
  }
  return { start, end };
}

/**
 * Derive initial timeline lanes ordered by execution-context hierarchy.
 *
 * Interrupts sort first, followed by tasks in descending scheduling priority order, and idle contexts last (see {@link ./context-type.CONTEXT_TYPE_ORDER}). Contexts of equal rank preserve order of first appearance.
 */
export function deriveLanes(model: TraceModel): LaneState[] {
  // Track first-seen order and interrupt execution history for classification.
  const ranIsr = new Map<string, boolean>();
  const order: string[] = [];
  for (const e of model.events) {
    if (e.ctxName === "None") continue;
    if (!ranIsr.has(e.ctxName)) order.push(e.ctxName);
    ranIsr.set(e.ctxName, (ranIsr.get(e.ctxName) ?? false) || e.inIrq);
  }

  const prio = contextPriorities(model);
  const ranked = order.map((key, seen) => ({
    key,
    type: classifyContext(key, ranIsr.get(key)!),
    prio: prio.get(key),
    seen,
  }));
  ranked.sort((a, b) => {
    const byType = CONTEXT_TYPE_ORDER[a.type] - CONTEXT_TYPE_ORDER[b.type];
    if (byType !== 0) return byType;
    // Rank tasks by scheduling priority in descending order; tasks with known priority precede tasks without.
    if (a.type === "Task" && a.prio !== b.prio) {
      return (b.prio ?? -Infinity) - (a.prio ?? -Infinity);
    }
    return a.seen - b.seen;
  });
  return ranked.map((r) => ({
    key: r.key,
    label: r.key,
    visible: true,
    type: r.type,
    role: contextRole(r.key, r.type),
  }));
}

/** Extract mapping of context names to scheduling priorities from `svTaskInfo` events. */
function contextPriorities(model: TraceModel): Map<string, number> {
  const nameOf = new Map<number, string>();
  for (const t of model.traces) for (const [tid, name] of t.tasks) nameOf.set(tid, name);

  const prio = new Map<string, number>();
  for (const e of model.events) {
    if (e.id !== EVTID.TASK_INFO) continue;
    const tid = e.params["tid"] as number;
    const name = nameOf.get(tid) ?? (e.params["name"] as string | undefined);
    if (name !== undefined && typeof e.params["prio"] === "number") prio.set(name, e.params["prio"]);
  }
  return prio;
}

/** Compute seconds per timestamp tick from the first trace `svInit` event (`1 / sysFreq`). */
export function deriveResolution(model: TraceModel): number {
  for (const t of model.traces) {
    if (t.sysInfo && t.sysInfo.sysFreq > 0) return 1 / t.sysInfo.sysFreq;
  }
  return 0;
}
