/**
 * Lane type definitions, source configurations, and default heights.
 *
 * Tree structures and serialization logic reside in {@link ../../trace-ui-toolkit/lanes/tree}. This module defines application-specific type identifiers, {@link LaneLeaf.source} types, and auto-population rules.
 *
 * The layout serializes into `.svdat` file headers via {@link LaneLayout}. Built-in lane types include `timespan` (execution activity per context or unified core view), `cpuload` (CPU utilization histograms), `dataplot` (numeric data series), and `functrace` (flame-graph function traces).
 */

export {
  cloneLayout,
  FALLBACK_LANE_HEIGHT,
  isGroup,
  isLane,
  isLaneLayout,
  LANE_LAYOUT_VERSION,
  parseLayout,
  serializeLayout,
  type LaneGroup,
  type LaneLayout,
  type LaneLeaf,
  type LaneNode,
  type LaneNodeId,
} from "../../trace-ui-toolkit/lanes/tree.js";

/** Type identifier for context and unified activity lanes. */
export const TIMESPAN_LANE = "timespan";

/** Type identifier for CPU utilization histogram lanes. */
export const CPULOAD_LANE = "cpuload";

/** Type identifier for numeric DataPlot series lanes. */
export const DATAPLOT_LANE = "dataplot";

/** Type identifier for function trace flame-graph lanes. */
export const FUNCTRACE_LANE = "functrace";

/**
 * Source specification for a {@link TIMESPAN_LANE}: either a unified per-core execution track or an individual execution context.
 */
export type TimespanSource =
  | { readonly kind: "unified"; readonly coreId: number }
  | { readonly kind: "context"; readonly key: string; readonly funcTrace?: FuncTraceInline };

/**
 * Configuration for displaying inline function traces within a context's {@link TIMESPAN_LANE}.
 *
 * Modes:
 * - `peek`: Renders coarse call-stack indicators within normal run rectangles.
 * - `expanded`: Expands the lane to display full depth-stacked flame graphs above the activity strip.
 * - `off`: Resolved state for uninstrumented contexts or unified tracks.
 */
export type FuncTraceInline = "off" | "peek" | "expanded";

/**
 * Source specification for a {@link CPULOAD_LANE}: total CPU utilization across all cores, or stacked utilization for an individual core.
 */
export type CpuLoadSource =
  | { readonly kind: "total" }
  | { readonly kind: "core"; readonly coreId: number };

/**
 * Source specification for a {@link DATAPLOT_LANE}: one or more numeric series identifiers (`data_id`).
 */
export interface DataPlotSource {
  readonly series: readonly number[];
}

/**
 * Source specification for a {@link FUNCTRACE_LANE}: execution context identifier for nested function call frames. Traces are organized per context.
 */
export interface FuncTraceSource {
  readonly key: string;
}

/**
 * Auto-population rules for dynamically adding lanes to a {@link LaneGroup} during trace capture.
 *
 * - `context-per-core`: Maintains one {@link TIMESPAN_LANE} per discovered execution context whose lane group role is in optional `roles` (see {@link ./context-role}).
 * - `series-per-lane`: Maintains one {@link DATAPLOT_LANE} per discovered DataPlot series.
 * - `functrace-per-context`: Maintains one {@link FUNCTRACE_LANE} per execution context with function instrumentation.
 */
export type AutoPopulateRule =
  | { readonly rule: "context-per-core"; readonly roles?: readonly string[] }
  | { readonly rule: "series-per-lane" }
  | { readonly rule: "functrace-per-context" };

/**
 * Default band height in CSS pixels per lane type. The layout engine falls back to {@link FALLBACK_LANE_HEIGHT} when unlisted.
 */
export const DEFAULT_LANE_HEIGHTS: Readonly<Record<string, number>> = {
  [TIMESPAN_LANE]: 22,
  [CPULOAD_LANE]: 64,
  [DATAPLOT_LANE]: 80,
  [FUNCTRACE_LANE]: 96,
};
