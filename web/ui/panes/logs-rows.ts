/**
 * Row model for the Logs list.
 *
 * This module extracts `svPrint` (predefined ID 26) log events from the event stream and projects each into Timestamp, Context, and Message columns. Message strings are preserved directly from the parser. Each line stores the absolute index in `model.events` for store selection.
 */

import { type TraceEvent } from "../../../src/trace/index.js";
import { formatTime } from "../../core/format.js";
import type { Filters } from "../../core/store.js";
import { eventInList, type ListNarrowing } from "./events-rows.js";
import type { ExportColumn, TableData } from "../../core/export.js";

/** Predefined apptrace print event name (`svPrint`, ID 26). */
export const LOG_EVENT_NAME = "svPrint";

/** Display strings and metadata for a single log line. */
export interface LogLine {
  /** Absolute index of the source event in `model.events`. */
  eventIndex: number;
  /** Formatted timestamp. */
  ts: string;
  /** Execution context the line was printed from. */
  ctx: string;
  /** Log message text from the parser. */
  msg: string;
}

/**
 * Returns true if an event represents a log line: a `svPrint` event containing a `msg` parameter.
 */
export function isLogEvent(e: TraceEvent): boolean {
  return e.name === LOG_EVENT_NAME && typeof e.params["msg"] === "string";
}

/**
 * Projects a log event at absolute `index` to a {@link LogLine}.
 */
export function eventToLogLine(e: TraceEvent, index: number): LogLine {
  return {
    eventIndex: index,
    ts: formatTime(e.ts),
    ctx: e.ctxName,
    msg: e.params["msg"] as string,
  };
}

/**
 * Builds log lines from the event stream in chronological order, applying the same filters and dock narrowing as the event list.
 */
export function buildLogLines(
  events: TraceEvent[],
  filters: Filters,
  narrow: ListNarrowing = {},
): LogLine[] {
  const out: LogLine[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (!isLogEvent(e)) continue;
    if (!eventInList(e, filters, narrow)) continue;
    out.push(eventToLogLine(e, i));
  }
  return out;
}

/**
 * Columns of the Logs list, in the order the table draws them. `field` reads the value off a
 * {@link LogLine}, `label` matches the on-screen header, and `key` names the column in exported JSON.
 */
const LOG_COLUMNS: readonly (ExportColumn & { field: keyof LogLine })[] = [
  { key: "time", field: "ts", label: "Timestamp" },
  { key: "context", field: "ctx", label: "Context" },
  { key: "message", field: "msg", label: "Message" },
];

/** Project log lines into the exportable table the Logs list shows. */
export function logsTable(lines: readonly LogLine[]): TableData {
  return {
    columns: LOG_COLUMNS,
    rows: lines.map((l) => LOG_COLUMNS.map((c) => String(l[c.field]))),
  };
}
