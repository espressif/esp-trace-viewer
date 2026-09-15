/**
 * Row model for the Events list.
 *
 * This module converts a {@link TraceEvent} into display strings for table columns (`#`, Timestamp, Core, Context, Event, Detail), classifies it into a visual class (ISR, task, system, API) for color cues, and applies store filters to generate visible-row indices. It contains no DOM dependencies and can be unit-tested directly.
 */

import type { ElfSymbols } from "../../../src/elf/index.js";
import {
  FUNC_TRACE_ENTER,
  FUNC_TRACE_EXIT,
  EVTID,
  type ParamValue,
  type TraceEvent,
} from "../../../src/trace/index.js";
import { classifyEvent, type EventClass } from "../../core/event-class.js";
import { toMarkdown, type ExportColumn, type TableData } from "../../core/export.js";
import { type DataSampleMeta, formatDataSample } from "../../core/data-samples.js";
import { inScope, type ScopeWindow } from "../../core/list-scope.js";
import type { Filters } from "../../core/store.js";
import { formatTime } from "../../core/format.js";

// Event-to-class mapping is defined in `web/core/event-class.ts` and re-exported here for the events pane and tests.
export { classifyEvent };
export type { EventClass };

/** Formats one decoded parameter value for display in the Detail column. */
export function formatParamValue(v: ParamValue, symbols?: ElfSymbols): string {
  // `arr_u32` arrays represent return-address stacks where each element is a code address. When an ELF is loaded, addresses resolve to symbols; otherwise hexadecimal strings are returned. Scalar parameters remain untouched to avoid misinterpreting identifier counts as code addresses.
  if (Array.isArray(v)) return `[${v.map((n) => formatAddr(n >>> 0, symbols)).join(", ")}]`;
  if (typeof v === "bigint") return v.toString();
  return String(v);
}

/** Formats a code address as hexadecimal, suffixed with a symbol name when resolved. */
function formatAddr(addr: number, symbols?: ElfSymbols): string {
  const hex = `0x${addr.toString(16)}`;
  const hit = symbols?.lookup(addr);
  if (!hit) return hex;
  const name = hit.offset === 0 ? hit.name : `${hit.name}+0x${hit.offset.toString(16)}`;
  return `${hex} (${name})`;
}

/**
 * Function instrumentation module event names. Scalar parameters for these events (`func`, `call_site`) represent code addresses and resolve against the loaded ELF.
 */
const FUNC_TRACE_EVENT_NAMES: ReadonlySet<string> = new Set([FUNC_TRACE_ENTER, FUNC_TRACE_EXIT]);

/**
 * Formats typed event parameters into a Detail string formatted as `name=value` pairs in payload order. Events without parameters return an empty string.
 *
 * `svDataSample` events decode to formatted readings (such as `bus_voltage = 4.800000 V`) when a matching series exists in the {@link DataSampleMeta} registry. If no registration matches, formatting falls back to generic `name=value` pairs.
 */
export function formatDetail(
  e: TraceEvent,
  registry?: Map<number, DataSampleMeta>,
  symbols?: ElfSymbols,
): string {
  if (e.id === EVTID.DATA_SAMPLE && registry) {
    const dataId = e.params["data_id"] as number | undefined;
    const bits = e.params["value"] as number | undefined;
    if (dataId !== undefined && bits !== undefined) {
      const meta = registry.get(dataId);
      if (meta) return formatDataSample(meta, dataId, bits);
    }
  }
  const isFuncTrace = FUNC_TRACE_EVENT_NAMES.has(e.name);
  const parts: string[] = [];
  for (const k of Object.keys(e.params)) {
    const v = e.params[k]!;
    const handle = e.handles?.[k];
    let s: string;
    if (isFuncTrace && typeof v === "number") s = formatAddr(v >>> 0, symbols);
    else if (handle) s = `0x${handle.addr.toString(16)} (${handle.name})`;
    else s = formatParamValue(v, symbols);
    parts.push(`${k}=${s}`);
  }
  return parts.join(", ");
}

/** Display strings and styling class for a single table row. */
export interface DisplayRow {
  /** 1-based event sequence number (absolute index in `model.events` + 1). */
  num: string;
  /** Formatted timestamp. */
  ts: string;
  /** Source core ID. */
  core: string;
  /** Execution-context name. */
  ctx: string;
  /** Symbolic event name. */
  name: string;
  /** Formatted decoded parameters. */
  detail: string;
  /** Visual class for color cues. */
  cls: EventClass;
}

/**
 * Projects an event at absolute `index` to a display row. An optional data-sample `registry` decodes `svDataSample` events into registered readings, and optional `symbols` resolve code addresses into symbol names. Kernel object handles are shown with the names the processor found for them in the ELF.
 */
export function eventToRow(
  e: TraceEvent,
  index: number,
  registry?: Map<number, DataSampleMeta>,
  symbols?: ElfSymbols,
): DisplayRow {
  return {
    num: String(index + 1),
    ts: formatTime(e.ts),
    core: String(e.coreId),
    ctx: e.ctxName,
    name: e.name,
    detail: formatDetail(e, registry, symbols),
    cls: classifyEvent(e),
  };
}

/**
 * Columns of the Events list, in the order the table draws them.
 *
 * `field` reads the value off a {@link DisplayRow}, `label` matches the on-screen header, and `key` names
 * the column in an exported JSON object. The table, the clipboard copy and the file export all read this
 * one list, so the three never drift apart.
 */
const EVENT_COLUMNS: readonly (ExportColumn & { field: keyof DisplayRow })[] = [
  { key: "index", field: "num", label: "#" },
  { key: "time", field: "ts", label: "Time" },
  { key: "core", field: "core", label: "Core" },
  { key: "context", field: "ctx", label: "Context" },
  { key: "event", field: "name", label: "Event" },
  { key: "detail", field: "detail", label: "Detail" },
];

/** Project display rows into the exportable table the Events list shows. */
export function eventsTable(rows: readonly DisplayRow[]): TableData {
  return {
    columns: EVENT_COLUMNS,
    rows: rows.map((r) => EVENT_COLUMNS.map((c) => r[c.field])),
  };
}

/**
 * Formats display rows as a GitHub-flavored Markdown table for clipboard copy operations. Column headers match the on-screen table (`#`, Time, Core, Context, Event, Detail). Cell pipes and newlines are escaped. Returns an empty string if no rows are provided.
 */
export function rowsToMarkdown(rows: DisplayRow[]): string {
  return rows.length === 0 ? "" : toMarkdown(eventsTable(rows));
}

/** Returns true if any filter criteria (text, core, or event class) are set. */
export function filtersActive(filters: Filters): boolean {
  return filters.text.trim() !== "" || filters.cores.size > 0 || filters.classes.size > 0;
}

/**
 * Narrowing applied on top of {@link Filters} by the Events/Logs dock header.
 *
 * Omitting `scope` leaves the time range open, which is what content search wants. Passing `scope: null` means the chosen scope resolved to nothing — an empty selection — and no row qualifies.
 */
export interface ListNarrowing {
  /** Time range rows must fall inside, or `null` for an empty scope. Omit for no time narrowing. */
  scope?: ScopeWindow | null;
  /** Context rows must belong to, or `null`/omitted for all contexts. */
  context?: string | null;
}

/** Returns true if `narrow` restricts the rows at all. */
export function narrowingActive(narrow: ListNarrowing): boolean {
  return narrow.scope !== undefined || (narrow.context ?? null) !== null;
}

/**
 * Returns true if an event satisfies active filter criteria. The event must not come from a core switched off in the CPU filter, must not be filtered out by {@link EventClass}, and must contain active filter text within its name or context name.
 */
export function eventMatchesFilters(e: TraceEvent, filters: Filters): boolean {
  if (filters.cores.has(e.coreId)) return false;
  if (filters.classes.size > 0 && filters.classes.has(classifyEvent(e))) return false;
  const text = filters.text.trim().toLowerCase();
  if (text === "") return true;
  return e.name.toLowerCase().includes(text) || e.ctxName.toLowerCase().includes(text);
}

/** Returns true if an event satisfies both the filters and the dock's scope and context narrowing. */
export function eventInList(e: TraceEvent, filters: Filters, narrow: ListNarrowing = {}): boolean {
  if (!eventMatchesFilters(e, filters)) return false;
  if (narrow.scope !== undefined && !inScope(narrow.scope, e.ts)) return false;
  const context = narrow.context ?? null;
  return context === null || e.ctxName === context;
}

/**
 * First index in the ascending event stream at or after time `t`.
 */
function lowerBound(events: TraceEvent[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.ts < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Builds visible-row ordering as an array of absolute event indices in chronological order.
 *
 * Returns `null` when nothing is filtered or narrowed. Callers treat `null` as an identity mapping (row `i` maps to event `i`), avoiding array allocation when all events are visible.
 *
 * A scope window bounds the scan by binary search on the ascending timestamps, so panning a zoomed-in window costs work proportional to what the window holds rather than to the whole capture.
 */
export function buildVisibleIndices(
  events: TraceEvent[],
  filters: Filters,
  narrow: ListNarrowing = {},
): Int32Array | null {
  if (!filtersActive(filters) && !narrowingActive(narrow)) return null;
  const out = new Int32Array(events.length);
  let n = 0;
  let lo = 0;
  let hi = events.length;
  if (narrow.scope !== undefined) {
    if (narrow.scope === null) return out.subarray(0, 0);
    lo = lowerBound(events, narrow.scope.t0);
    hi = lowerBound(events, narrow.scope.t1);
    // lowerBound stops before events landing exactly on the upper edge, which the scope includes.
    while (hi < events.length && events[hi]!.ts <= narrow.scope.t1) hi++;
  }
  for (let i = lo; i < hi; i++) {
    if (eventInList(events[i]!, filters, narrow)) out[n++] = i;
  }
  return out.subarray(0, n);
}
