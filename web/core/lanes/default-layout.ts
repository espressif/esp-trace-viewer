/**
 * Programmatic default lane layouts derived from trace data and auto-population reconciliation.
 *
 * {@link buildDefaultLayout} derives an initial lane layout from the model: a per-core Unified track, a Sys group (scheduler spans plus the tick and inter-core interrupts), an IRQ group (the remaining ISRs), a Task group (application tasks), an Idle group, a Load group (CPU histogram lanes per core), and a Data group (DataPlot lanes per series when samples are present).
 *
 * The group names are four characters or fewer on purpose: the timeline gutter shows a group's name as its category code, upper-cased and cut to four, so a name that survives the cut reads the same in both places.
 *
 * Each auto-populated group specifies an {@link ../../core/lanes/types.AutoPopulateRule}. During live capture, {@link reconcileAuto} processes model updates and appends lanes for newly discovered contexts or data series not yet present in the layout tree.
 */

import { FUNC_TRACE_ENTER, type TraceModel } from "../../../src/trace/index.js";
import { listDataSeries, type DataSeriesId } from "../data-samples.js";
import { deriveLanes } from "../open-files.js";
import {
  CPULOAD_LANE,
  DATAPLOT_LANE,
  FUNCTRACE_LANE,
  LANE_LAYOUT_VERSION,
  TIMESPAN_LANE,
  type AutoPopulateRule,
  type CpuLoadSource,
  type DataPlotSource,
  type FuncTraceSource,
  type LaneGroup,
  type LaneLayout,
  type LaneLeaf,
  type LaneNode,
  type TimespanSource,
} from "./types.js";

/** Stable identifiers for auto-populated default groups. */
export const SYSTEM_GROUP_ID = "g:system";
export const INTERRUPTS_GROUP_ID = "g:interrupts";
export const TASKS_GROUP_ID = "g:tasks";
/** Stable identifier for the idle group, which sits after the tasks but belongs to the System quick filter. */
export const IDLE_GROUP_ID = "g:idle";
/** Stable identifier for the default CPU load group. */
export const CPULOAD_GROUP_ID = "g:cpuload";
/** Stable identifier for the auto-populated Data group. */
export const DATA_GROUP_ID = "g:data";
/** Stable identifier for the auto-populated Function Trace group. */
export const FUNCTRACE_GROUP_ID = "g:functrace";

/** Lane group roles claimed by default groups (see {@link ./context-role}). */
const SYSTEM_ROLES: readonly string[] = ["system"];
const INTERRUPT_ROLES: readonly string[] = ["interrupt"];
const TASK_ROLES: readonly string[] = ["task"];
const IDLE_ROLES: readonly string[] = ["idle"];

/** Generate deterministic identifiers for layout reconciliation. */
function unifiedLaneId(coreId: number): string {
  return `u:${coreId}`;
}
function contextLaneId(key: string): string {
  return `c:${key}`;
}
function dataPlotLaneId(seriesId: number): string {
  return `d:${seriesId}`;
}
function cpuLoadLaneId(coreId: number): string {
  return `cpu:${coreId}`;
}
function funcTraceLaneId(key: string): string {
  return `ft:${key}`;
}

/** Create a {@link CPULOAD_LANE} leaf for a specific core. */
function cpuLoadLane(coreId: number, multi: boolean): LaneLeaf {
  const source: CpuLoadSource = { kind: "core", coreId };
  return {
    kind: "lane",
    id: cpuLoadLaneId(coreId),
    type: CPULOAD_LANE,
    source,
    label: multi ? `CPU Load (core ${coreId})` : "CPU Load",
  };
}

/** Create a CPU Load group with one {@link CPULOAD_LANE} per core. */
function cpuLoadGroup(cores: readonly number[]): LaneGroup {
  const multi = cores.length > 1;
  return {
    kind: "group",
    id: CPULOAD_GROUP_ID,
    label: "Load",
    children: cores.map((c) => cpuLoadLane(c, multi)),
  };
}

/** Create a {@link DATAPLOT_LANE} leaf for a single data series. */
function dataPlotLane(s: DataSeriesId): LaneLeaf {
  const source: DataPlotSource = { series: [s.id] };
  const label = s.unit ? `${s.name} (${s.unit})` : s.name;
  return { kind: "lane", id: dataPlotLaneId(s.id), type: DATAPLOT_LANE, source, label };
}

/** Create a Data group containing one {@link DATAPLOT_LANE} per series, or return `null` if empty. */
function dataGroup(series: readonly DataSeriesId[]): LaneGroup | null {
  if (!series.length) return null;
  return {
    kind: "group",
    id: DATA_GROUP_ID,
    label: "Data",
    children: series.map(dataPlotLane),
    auto: { rule: "series-per-lane" },
  };
}

/** Create a {@link FUNCTRACE_LANE} leaf for an execution context flame graph. */
function funcTraceLane(key: string): LaneLeaf {
  const source: FuncTraceSource = { key };
  return {
    kind: "lane",
    id: funcTraceLaneId(key),
    type: FUNCTRACE_LANE,
    source,
    label: key,
  };
}

/**
 * Group containing one flame-graph lane per execution context with recorded `function_enter` events. Traces are organized per context. Returns `null` when no function traces exist.
 */
function funcTraceGroup(keys: readonly string[]): LaneGroup | null {
  if (!keys.length) return null;
  return {
    kind: "group",
    id: FUNCTRACE_GROUP_ID,
    label: "Func",
    children: keys.map(funcTraceLane),
    // Task lanes show inline function traces; the dedicated flame-graph group defaults to collapsed.
    collapsed: true,
    auto: { rule: "functrace-per-context" },
  };
}

/** Return execution contexts that recorded `function_enter` events in order of appearance. */
function funcTraceContextsOf(model: TraceModel): string[] {
  const keys = new Set<string>();
  for (const e of model.events) if (e.name === FUNC_TRACE_ENTER) keys.add(e.ctxName);
  return [...keys];
}

/** Return distinct core identifiers present in the trace in ascending order. */
function coresOf(model: TraceModel): number[] {
  const cores = new Set<number>();
  for (const e of model.events) cores.add(e.coreId);
  return [...cores].sort((a, b) => a - b);
}

/** Create a {@link TIMESPAN_LANE} leaf for an execution context with visibility setting preserved. */
function contextLane(key: string, label: string, visible: boolean): LaneLeaf {
  const source: TimespanSource = { kind: "context", key };
  const leaf: LaneLeaf = { kind: "lane", id: contextLaneId(key), type: TIMESPAN_LANE, source, label };
  return visible ? leaf : { ...leaf, hidden: true };
}

/**
 * Build the default lane layout for a model.
 *
 * Constructs a per-core Unified track, then Sys (scheduler spans and the OS's own interrupts), IRQ (the remaining ISRs), Task, and Idle groups arranged in priority order. Group membership follows {@link ./context-role.contextRole}. Auto-populate rules allow appending newly discovered contexts via {@link reconcileAuto}.
 */
export function buildDefaultLayout(model: TraceModel): LaneLayout {
  const cores = coresOf(model);
  const multi = cores.length > 1;

  const roots: LaneNode[] = cores.map((coreId) => {
    const source: TimespanSource = { kind: "unified", coreId };
    return {
      kind: "lane",
      id: unifiedLaneId(coreId),
      type: TIMESPAN_LANE,
      source,
      label: multi ? `Unified (core ${coreId})` : "Unified",
    } satisfies LaneLeaf;
  });

  const lanes = deriveLanes(model); // already in ISR→Scheduler→Task→Idle order
  const groupOf = (id: string, label: string, roles: readonly string[]): LaneGroup => ({
    kind: "group",
    id,
    label,
    children: lanes.filter((l) => roles.includes(l.role)).map((l) => contextLane(l.key, l.label, l.visible)),
    auto: { rule: "context-per-core", roles },
  });
  roots.push(groupOf(SYSTEM_GROUP_ID, "Sys", SYSTEM_ROLES));
  roots.push(groupOf(INTERRUPTS_GROUP_ID, "IRQ", INTERRUPT_ROLES));
  roots.push(groupOf(TASKS_GROUP_ID, "Task", TASK_ROLES));
  // Idle contexts read best directly below the tasks they displace, so they form their own group there rather than sitting with the scheduler spans.
  roots.push(groupOf(IDLE_GROUP_ID, "Idle", IDLE_ROLES));

  // Append CPU Load group for per-core utilization and Data group when samples exist.
  roots.push(cpuLoadGroup(cores));
  const data = dataGroup(listDataSeries(model.events));
  if (data) roots.push(data);
  // Function Trace flame-graph group for traces with function-instrumentation events.
  const funcTrace = funcTraceGroup(funcTraceContextsOf(model));
  if (funcTrace) roots.push(funcTrace);

  return { version: LANE_LAYOUT_VERSION, roots };
}

/**
 * Append lanes for newly discovered contexts, DataPlot series, and function traces to auto-populated groups.
 *
 * Missing series append to existing `series-per-lane` groups or instantiate a root Data group. Missing function traces append to `functrace-per-context` groups or create a root Function Trace group. Preserves existing node order and references when layout remains unchanged.
 */
export function reconcileAuto(layout: LaneLayout, model: TraceModel): LaneLayout {
  const wanted = deriveLanes(model);
  const wantedSeries = listDataSeries(model.events);
  const wantedFtContexts = funcTraceContextsOf(model);

  // Deduplicate contexts and series IDs across existing lanes to prevent duplicate additions.
  const present = new Set<string>();
  const presentSeries = new Set<number>();
  const presentFtContexts = new Set<string>();
  const collect = (nodes: readonly LaneNode[]): void => {
    for (const n of nodes) {
      if (n.kind === "group") collect(n.children);
      else {
        present.add(n.id);
        if (n.type === DATAPLOT_LANE) for (const id of (n.source as DataPlotSource).series) presentSeries.add(id);
        if (n.type === FUNCTRACE_LANE) presentFtContexts.add((n.source as FuncTraceSource).key);
      }
    }
  };
  collect(layout.roots);

  // Assign unassigned series to the first visited `series-per-lane` group, or create a root group.
  let pendingSeries = wantedSeries.filter((s) => !presentSeries.has(s.id));
  // Assign unassigned function trace contexts to the first `functrace-per-context` group, or create a root group.
  let pendingFtContexts = wantedFtContexts.filter((k) => !presentFtContexts.has(k));

  // Return original node references when subtree contents do not change.
  const visit = (node: LaneNode): LaneNode => {
    if (node.kind !== "group") return node;

    let childrenChanged = false;
    const visited = node.children.map((c) => {
      const v = visit(c);
      if (v !== c) childrenChanged = true;
      return v;
    });
    let next: readonly LaneNode[] = childrenChanged ? visited : node.children;

    // Cast `auto` to {@link AutoPopulateRule} to access rule configuration parameters.
    const auto = node.auto as AutoPopulateRule | undefined;
    if (auto?.rule === "context-per-core") {
      const roles = auto.roles;
      const additions = wanted
        .filter((l) => !present.has(contextLaneId(l.key)) && (!roles || roles.includes(l.role)))
        .map((l) => contextLane(l.key, l.label, l.visible));
      if (additions.length) next = [...next, ...additions];
    } else if (auto?.rule === "series-per-lane" && pendingSeries.length) {
      next = [...next, ...pendingSeries.map(dataPlotLane)];
      pendingSeries = [];
    } else if (auto?.rule === "functrace-per-context" && pendingFtContexts.length) {
      next = [...next, ...pendingFtContexts.map(funcTraceLane)];
      pendingFtContexts = [];
    }

    return next === node.children ? node : { ...node, children: next };
  };

  let changed = false;
  let roots = layout.roots.map((n) => {
    const v = visit(n);
    if (v !== n) changed = true;
    return v;
  });

  // Create a root Data group when no group exists for pending series.
  if (pendingSeries.length) {
    const grown = dataGroup(pendingSeries);
    if (grown) {
      roots = [...roots, grown];
      changed = true;
    }
  }

  // Create a root Function Trace group when no group exists for pending function traces.
  if (pendingFtContexts.length) {
    const grown = funcTraceGroup(pendingFtContexts);
    if (grown) {
      roots = [...roots, grown];
      changed = true;
    }
  }

  return changed ? { ...layout, roots } : layout;
}
