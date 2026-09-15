/**
 * Statistics workspace: per-context runtime statistics over the whole window.
 *
 * Renders execution statistics for each context: the cores it ran on, its priority and stack size, run count, frequency, last/min/max/average/total run times, and the share of one core it occupied. Columns support sorting; a scope selector chooses the range the figures cover and a context-type selector narrows the table to tasks, interrupts, scheduler spans or idle.
 *
 * The scope is the workspace's own, held apart from the Events/Logs dock's so that neither surface silently changes the other. Timeline lane visibility never filters this table either: a context hidden from the timeline still has a row here.
 *
 * The Export menu writes the table as it stands: the same scope, the same context-type narrowing and the same sort order.
 *
 * Core aggregation logic is implemented in {@link ./contexts-rows}. Selecting a row updates store `selectedContext`, highlighting the corresponding lane across timeline and CPU-load views; focused context from event selection also synchronizes row highlighting. Lane visibility is not editable here — it belongs to the Lanes panel — but a click on a Max run figure returns to the timeline, zooms to that run, and undoes whatever was keeping the context's lane off the canvas.
 */

import { formatDuration } from "../../core/format.js";
import { contextLanes } from "../../core/lanes/selectors.js";
import { revealContextLane } from "../../core/lanes/reveal.js";
import { focusedContext } from "../../core/selection.js";
import { contextColor } from "../../core/theme.js";
import { clear, el } from "../../trace-ui-toolkit/ui/dom.js";
import { Pane } from "../../trace-ui-toolkit/ui/pane.js";
import {
  aggregateContexts,
  collectContextInfo,
  formatCores,
  formatFrequency,
  formatPercent,
  formatPriority,
  formatStackSize,
  sortStats,
  type ContextInfo,
  type ContextStats,
  type SortColumn,
} from "./contexts-rows.js";
import { reconstructTimeline, type RunInterval } from "./timeline-rows.js";
import { resolveScope } from "../../core/list-scope.js";
import { zoomToRange } from "../../core/zoom.js";
import { SCOPE_OPTIONS } from "../dock.js";
import type { TableData } from "../../core/export.js";
import { createExportMenu } from "../export-menu.js";
import type { Scope, StatsType } from "../../core/store.js";
import type { PaneContext, PaneHandle } from "./types.js";

/** Context-type choices offered beside the scope selector. */
const STATS_TYPE_OPTIONS: readonly { value: StatsType; label: string }[] = [
  { value: "all", label: "All context types" },
  { value: "Task", label: "Tasks" },
  { value: "ISR", label: "Interrupts" },
  { value: "Scheduler", label: "Scheduler" },
  { value: "Idle", label: "Idle" },
];

/** Table column specification: identifier, header text, sort configuration, and cell formatter. */
interface Column {
  /** Stable identifier for the cell's CSS class (`ctx-c-<key>`) and test hooks. */
  key: string;
  label: string;
  /** Sort field, or `undefined` for a non-sortable column (e.g. stack info). */
  col?: SortColumn;
  /** Numeric columns default to a descending first click (busiest first). */
  numeric?: boolean;
  /** Cell text for a row. */
  cell: (s: ContextStats) => string;
  /** Percentage to draw as an inline bar beside the text, for columns that have one. */
  bar?: (s: ContextStats) => number;
  /** True when the cell's text is a link to the run it reports. */
  locate?: boolean;
}

const COLUMNS: Column[] = [
  { key: "label", label: "Context", col: "label", cell: (s) => s.label },
  { key: "type", label: "Type", col: "type", cell: (s) => s.type },
  { key: "cores", label: "Core", col: "cores", numeric: true, cell: (s) => formatCores(s.cores) },
  { key: "priority", label: "Priority", col: "priority", numeric: true, cell: (s) => formatPriority(s.info) },
  { key: "stackSize", label: "Stack size", col: "stackSize", numeric: true, cell: (s) => formatStackSize(s.info) },
  { key: "runCount", label: "Run count", col: "runCount", numeric: true, cell: (s) => String(s.runCount) },
  { key: "frequency", label: "Frequency", col: "frequency", numeric: true, cell: (s) => formatFrequency(s.frequency) },
  { key: "lastRunTime", label: "Last run", col: "lastRunTime", numeric: true, cell: (s) => formatDuration(s.lastRunTime) },
  { key: "minRunTime", label: "Min run", col: "minRunTime", numeric: true, cell: (s) => formatDuration(s.minRunTime) },
  {
    key: "maxRunTime",
    label: "Max run",
    col: "maxRunTime",
    numeric: true,
    cell: (s) => formatDuration(s.maxRunTime),
    // The one figure in the row that names a place in the trace, so it doubles as the way to get there.
    locate: true,
  },
  { key: "avgRunTime", label: "Avg run", col: "avgRunTime", numeric: true, cell: (s) => formatDuration(s.avgRunTime) },
  { key: "totalRunTime", label: "Total run", col: "totalRunTime", numeric: true, cell: (s) => formatDuration(s.totalRunTime) },
  {
    key: "pctTotal",
    label: "CPU time / core",
    col: "pctTotal",
    numeric: true,
    cell: (s) => formatPercent(s.pctTotal),
    // The share of one core, drawn as a bar behind the number.
    bar: (s) => s.pctTotal,
  },
];

export function createStatisticsPane(ctx: PaneContext): PaneHandle {
  // The workspace fills the window and the app bar names it, so the pane carries no chrome of its own.
  const pane = new Pane({ id: "statistics", title: "Statistics", chrome: false, collapsible: false });
  const { store } = ctx;

  // Cached across model changes; aggregation runs on demand.
  let byContext = new Map<string, RunInterval[]>();
  let info = new Map<string, ContextInfo>();
  /** Active sort column and direction. */
  let sortCol: SortColumn = "totalRunTime";
  let sortDir: 1 | -1 = -1;

  const scopeSelect = el("select", {
    class: "ctx-scope",
    "data-testid": "stats-scope",
    "aria-label": "Statistics scope",
    onchange: (e) => store.set({ statsScope: (e.target as HTMLSelectElement).value as Scope }),
  }) as HTMLSelectElement;
  for (const o of SCOPE_OPTIONS) scopeSelect.append(el("option", { value: o.value, text: o.label }));

  const typeSelect = el("select", {
    class: "ctx-type",
    "data-testid": "stats-type",
    "aria-label": "Statistics context type",
    onchange: (e) => store.set({ statsType: (e.target as HTMLSelectElement).value as StatsType }),
  }) as HTMLSelectElement;
  for (const o of STATS_TYPE_OPTIONS) typeSelect.append(el("option", { value: o.value, text: o.label }));

  const exportMenu = createExportMenu(store, {
    testid: "menu-export-stats",
    targets: () => [{ label: "Statistics", slug: "statistics", table: statisticsTable }],
  });

  const controls = el("div", { class: "ctx-controls" }, [
    el("b", { class: "ctx-title", text: "Context statistics" }),
    el("label", { class: "tb-label", text: "Scope" }),
    scopeSelect,
    typeSelect,
    exportMenu.el,
  ]);

  const head = el("div", { class: "ctx-row ctx-head", role: "row" });
  const body = el("div", { class: "ctx-body", "data-testid": "ctx-body", role: "rowgroup" });
  const table = el("div", { class: "ctx-table", "data-testid": "ctx-table", role: "grid" }, [head, body]);
  pane.body.append(controls, table);

  /** Render table header cells with active sort direction indicators. */
  const renderHead = (): void => {
    clear(head);
    head.append(el("span", { class: "ctx-cell ctx-swatch-h", role: "columnheader" }));
    for (const c of COLUMNS) {
      const active = c.col !== undefined && c.col === sortCol;
      const arrow = active ? (sortDir === 1 ? " ▲" : " ▼") : "";
      head.append(
        el("span", {
          class: `ctx-cell ctx-c-${c.key}${c.col ? " is-sortable" : ""}${active ? " is-sorted" : ""}`,
          role: "columnheader",
          text: c.label + arrow,
          ...(c.col ? { onclick: () => sortBy(c) } : {}),
        }),
      );
    }
  };

  /** Apply sorting by column, reversing order when clicking the currently active sort column. */
  const sortBy = (c: Column): void => {
    if (c.col === undefined) return;
    if (c.col === sortCol) sortDir = sortDir === 1 ? -1 : 1;
    else {
      sortCol = c.col;
      sortDir = c.numeric ? -1 : 1; // Descending for numbers, ascending for text.
    }
    render();
  };

  /** The rows the table is showing, narrowed and sorted the way it is showing them. */
  const currentStats = (): ContextStats[] => {
    const state = store.get();
    const labels = new Map(contextLanes(state.laneLayout).map((l) => [l.key, l.label]));
    // An empty selection leaves no elapsed time to accumulate, so the table reports nothing rather than falling back to a wider range.
    const range = resolveScope(state, state.statsScope) ?? { t0: 0, t1: 0 };
    const all = aggregateContexts(byContext, labels, range, info);
    const rows = state.statsType === "all" ? all : all.filter((r) => r.type === state.statsType);
    return sortStats(rows, sortCol, sortDir);
  };

  /** The table as it stands, for the Export menu. The swatch column carries no value, so it is left out. */
  const statisticsTable = (): TableData => ({
    columns: COLUMNS.map((c) => ({ key: c.key, label: c.label })),
    rows: currentStats().map((s) => COLUMNS.map((c) => c.cell(s))),
  });

  const render = (): void => {
    renderHead();
    clear(body);
    if (!byContext.size) {
      body.append(el("div", { class: "ctx-empty", text: "No contexts" }));
      return;
    }
    const state = store.get();
    scopeSelect.value = state.statsScope;
    typeSelect.value = state.statsType;
    const stats = currentStats();
    // Row selection toggles explicit context selection. Row highlighting follows focusedContext.
    const selected = store.get().selectedContext;
    const focused = focusedContext(store.get());

    for (const s of stats) {
      const row = el(
        "div",
        {
          class: `ctx-row${s.key === focused ? " is-selected" : ""}`,
          role: "row",
          "data-context-key": s.key,
          "aria-selected": s.key === focused ? "true" : "false",
          onclick: () => store.set({ selectedContext: s.key === selected ? null : s.key }),
        },
        [
          el("span", { class: "ctx-cell ctx-swatch-h", role: "gridcell" }, [
            el("span", { class: "ctx-swatch", style: `background:${contextColor(s.key)}` }),
          ]),
          ...COLUMNS.map((c) => cellFor(c, s)),
        ],
      );
      body.append(row);
    }
  };

  /** One table cell, with the inline bar behind it for the columns that carry one. */
  const cellFor = (c: Column, s: ContextStats): HTMLElement => {
    const cell = el("span", { class: `ctx-cell ctx-c-${c.key}`, role: "gridcell" });
    const pct = c.bar?.(s);
    if (pct !== undefined) {
      const bar = el("span", { class: "ctx-bar" });
      bar.append(el("i", { style: `width:${Math.max(0, Math.min(100, pct))}%` }));
      cell.append(bar);
    }
    const text = c.cell(s);
    if (c.locate && s.runCount > 0) {
      cell.append(
        el("button", {
          class: "ctx-locate",
          type: "button",
          title: `Show this run of ${s.label} in the timeline`,
          "data-testid": `stats-locate-${s.key}`,
          text,
          onclick: (e: Event) => {
            e.stopPropagation(); // Locating is not the same as selecting the row.
            locate(s);
          },
        }),
      );
    } else {
      cell.append(el("span", { class: "ctx-cell-text", text }));
    }
    return cell;
  };

  /** The cores a context's runs were recorded on, for the reveal. */
  const coresOf = (key: string): number[] => [...new Set((byContext.get(key) ?? []).map((iv) => iv.coreId))];

  /** Switch to the Timeline with `s`'s longest run in view, bringing its lane back if it was off. */
  const locate = (s: ContextStats): void => {
    const st = store.get();
    const next = revealContextLane(st.laneLayout, st.groupsOff, st.filters, s.key, coresOf(s.key));
    store.set({ ...(next ?? {}), selectedContext: s.key, workspace: "timeline" });
    zoomToRange(store, ctx.timeScale, s.maxRunStart, s.maxRunStart + s.maxRunTime);
  };

  /** Reconstruct context execution intervals and metadata from the loaded model. */
  const rebuild = (): void => {
    const s = store.get();
    const events = s.model?.events ?? [];
    byContext = reconstructTimeline(events, s.domain.end).byContext;
    info = s.model ? collectContextInfo(s.model) : new Map();
    render();
  };

  rebuild();
  store.select(["model", "domain"], rebuild);
  // Re-render highlight when selected context or selected event index changes.
  store.select(["laneLayout", "selectedContext", "selectedEventIndex", "statsScope", "statsType"], render);
  // The visible-window and selection scopes track the timeline and the selection respectively.
  store.select(["view", "selectionAnchorIndex"], () => {
    const scope = store.get().statsScope;
    if (scope === "visible" || scope === "selection") render();
  });

  return { pane };
}


