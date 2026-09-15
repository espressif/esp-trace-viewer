/**
 * The timeline's data export.
 *
 * The other export surfaces are tables already, so their export is the rows they drew. The timeline draws
 * runs on a canvas instead, so this projects what the canvas is showing into the same shape: one row per
 * context run, covering the lanes that are on, the cores that are on, and the visible window.
 *
 * Runs are listed in time order across lanes rather than lane by lane, which is how the canvas reads left
 * to right and how a reader following a context switch wants them.
 */

import { formatDuration, formatTime } from "../../core/format.js";
import type { ExportColumn, TableData } from "../../core/export.js";
import { contextLanes } from "../../core/lanes/selectors.js";
import type { AppState } from "../../core/store.js";
import { reconstructTimeline, visibleRange, type RunInterval } from "./timeline-rows.js";

/** Columns of the timeline runs export. */
const RUN_COLUMNS: readonly ExportColumn[] = [
  { key: "context", label: "Context" },
  { key: "core", label: "Core" },
  { key: "kind", label: "Kind" },
  { key: "start", label: "Start" },
  { key: "end", label: "End" },
  { key: "duration", label: "Duration" },
];

/** The runs the timeline is drawing, in time order. */
export function timelineRunsTable(s: AppState): TableData {
  const events = s.model?.events ?? [];
  if (events.length === 0) return { columns: RUN_COLUMNS, rows: [] };

  // A lane hidden in the Lanes panel is not on the canvas, so its runs are not in the export either.
  const labels = new Map(
    contextLanes(s.laneLayout).filter((l) => !l.hidden).map((l) => [l.key, l.label] as const),
  );
  const { byContext } = reconstructTimeline(events, s.domain.end);

  const runs: RunInterval[] = [];
  for (const [key, intervals] of byContext) {
    if (!labels.has(key)) continue;
    const { lo, hi } = visibleRange(intervals, s.view.t0, s.view.t1);
    for (let i = lo; i < hi; i++) {
      const run = intervals[i]!;
      if (!s.filters.cores.has(run.coreId)) runs.push(run);
    }
  }
  runs.sort((a, b) => a.start - b.start || a.coreId - b.coreId);

  const rows = runs.map((r) => [
    labels.get(r.key) ?? r.key,
    String(r.coreId),
    r.isr ? "ISR" : "Task",
    formatTime(r.start, s.timeResolution),
    formatTime(r.end, s.timeResolution),
    formatDuration(r.end - r.start),
  ]);
  return { columns: RUN_COLUMNS, rows };
}
