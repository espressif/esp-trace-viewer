/**
 * Lane suppression driven by the CPUs menu.
 *
 * The menu records the cores switched off in `filters.cores`. A lane that draws only from those cores has
 * nothing left to show, so it is dropped from the drawn layout the same way a quick filter drops a group:
 * through `layoutBands`' suppression set, leaving each lane's own `hidden` flag alone so the choices made in
 * the Lanes panel survive.
 *
 * Lanes that do not belong to a core — data plots, and contexts the reconstruction never saw run — are never
 * suppressed. That is what keeps a heap or jitter plot on screen when every CPU is switched off.
 *
 * A task that migrates between cores keeps its lane as long as one of the cores it ran on is still shown; the
 * runs on the other cores are dropped inside the lane instead, by {@link ../../ui/panes/lanes/timespan-lane}.
 */

import { isGroup, type LaneLayout, type LaneNode, type LaneNodeId } from "../../trace-ui-toolkit/lanes/tree.js";
import {
  CPULOAD_LANE,
  FUNCTRACE_LANE,
  TIMESPAN_LANE,
  type CpuLoadSource,
  type FuncTraceSource,
  type TimespanSource,
} from "./types.js";

/** What a layout needs to know about the trace to resolve which cores a lane draws from. */
export interface CoreLookup {
  /** Every core in the trace, so a total-CPU-load lane knows what it aggregates. */
  readonly all: readonly number[];
  /** Cores a context was seen running on, or an empty list when it never ran. */
  cores(key: string): readonly number[];
}

/**
 * Cores a lane draws from, or `null` when the lane belongs to no core.
 *
 * An empty list means the lane belongs to cores in principle but has no runs to place on any of them; it is
 * treated as core-neutral so an empty lane does not blink in and out with the CPU filter.
 */
function coresOfLane(node: LaneNode, look: CoreLookup): readonly number[] | null {
  if (isGroup(node)) return null;
  switch (node.type) {
    case TIMESPAN_LANE: {
      const src = node.source as TimespanSource;
      if (src.kind === "unified") return [src.coreId];
      const cores = look.cores(src.key);
      return cores.length ? cores : null;
    }
    case CPULOAD_LANE: {
      const src = node.source as CpuLoadSource;
      return src.kind === "core" ? [src.coreId] : look.all;
    }
    case FUNCTRACE_LANE: {
      const cores = look.cores((node.source as FuncTraceSource).key);
      return cores.length ? cores : null;
    }
    default:
      return null; // Data plots and any other core-neutral lane type.
  }
}

/**
 * Node identifiers of the lanes every one of whose cores is switched off.
 *
 * Returns an empty set when no core is switched off, which is the common case.
 */
export function coreSuppressedLanes(
  layout: LaneLayout,
  hiddenCores: ReadonlySet<number>,
  look: CoreLookup,
): Set<LaneNodeId> {
  const out = new Set<LaneNodeId>();
  if (hiddenCores.size === 0) return out;
  const walk = (nodes: readonly LaneNode[]): void => {
    for (const n of nodes) {
      if (isGroup(n)) {
        walk(n.children);
        continue;
      }
      const cores = coresOfLane(n, look);
      if (cores && cores.every((c) => hiddenCores.has(c))) out.add(n.id);
    }
  };
  walk(layout.roots);
  return out;
}
