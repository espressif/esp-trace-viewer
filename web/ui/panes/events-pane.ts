/**
 * Events pane displaying the primary event table.
 *
 * This pane uses the shared fixed-row-height virtualizer ({@link VirtualList}). A tall spacer sets the scrollbar to the full event count while only the rows in and near the viewport exist in the DOM. Row strings, color classes, and filter ordering are provided by {@link ./events-rows}. This file coordinates row-to-event mapping, header cells, selection, and keyboard navigation.
 *
 * Selection delegates to {@link selectEvent}, which records the absolute event index (`selectedEventIndex`, an index into `model.events`) and cursor time in the central store to update all panes in lockstep. This pane scrolls the store selection into its virtualized viewport. Filtering logic is maintained in the store; this pane displays rows matching store filters.
 *
 * In addition to single selection, the pane supports range selection: Shift-click or Shift with navigation keys (Arrow, Home, End, Page) extends a highlight from an anchor row (`selectionAnchorIndex`, managed by {@link selectEvent}) to the focus row. Ctrl-C/Cmd-C copies the spanned rows to the clipboard as a Markdown table. The anchor is stored in the central store to allow zooming to selection, while the rest of the application follows the focused event.
 */

import type { ElfSymbols } from "../../../src/elf/index.js";
import type { TraceEvent } from "../../../src/trace/index.js";
import { buildDataSampleRegistry, type DataSampleMeta } from "../../core/data-samples.js";
import { resolveScope } from "../../core/list-scope.js";
import { focusedContext, selectEvent } from "../../core/selection.js";
import { el } from "../../trace-ui-toolkit/ui/dom.js";
import { Pane } from "../../trace-ui-toolkit/ui/pane.js";
import { VirtualList } from "../../trace-ui-toolkit/ui/virtual-list.js";
import { buildVisibleIndices, eventToRow, rowsToMarkdown } from "./events-rows.js";
import type { PaneContext, PaneHandle } from "./types.js";

/** Fixed row height in CSS px — must match `.ev-row` height in `styles.css`. */
const ROW_H = 20;

/**
 * Visible-row order: maps row position to absolute event index.
 * When no filter is active, the mapping is identity with null indices.
 * When filters are active, indices holds filtered ascending event indices.
 */
class VisibleRows {
  constructor(
    private readonly indices: Int32Array | null,
    readonly count: number,
  ) {}

  /** Absolute event index for visible row position `pos`. */
  at(pos: number): number {
    return this.indices ? this.indices[pos]! : pos;
  }

  /** Visible row position of absolute event index `abs`, or -1 if filtered out. */
  positionOf(abs: number): number {
    if (!this.indices) return abs >= 0 && abs < this.count ? abs : -1;
    let lo = 0;
    let hi = this.indices.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.indices[mid]!;
      if (v === abs) return mid;
      if (v < abs) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
}

export function createEventsPane(ctx: PaneContext): PaneHandle {
  // The dock header names this list and controls its placement, so the pane carries no chrome of its own.
  const pane = new Pane({ id: "events", title: "Events", chrome: false, collapsible: false });
  const { store } = ctx;

  const head = el("div", { class: "ev-row ev-head", role: "row" }, [
    headCell("ev-idx", "#"),
    headCell("ev-ts", "Time"),
    headCell("ev-core", "Core"),
    headCell("ev-ctx", "Context"),
    headCell("ev-name", "Event"),
    headCell("ev-detail", "Detail"),
  ]);

  let visible = new VisibleRows(null, 0);
  let events: TraceEvent[] = [];
  // Maps data_id to series registration for decoding svDataSample events in the Detail column.
  let dataSamples: Map<number, DataSampleMeta> = new Map();
  // Loaded ELF symbol view for address symbolization in the Detail column.
  let symbols: ElfSymbols | undefined;

  const list = new VirtualList({
    rowHeight: ROW_H,
    wrapperClass: "ev-table",
    scrollClass: "ev-scroll",
    sizerClass: "ev-sizer",
    bodyClass: "ev-body",
    header: head,
    scrollAttrs: {
      "data-testid": "events-scroll",
      role: "grid",
      "aria-label": "Events",
      tabindex: 0,
    },
    bodyAttrs: { "data-testid": "events-body", role: "rowgroup" },
    renderWindow,
  });
  pane.body.append(list.el);

  /** Render only the rows intersecting the current scroll window. */
  function renderWindow(first: number, last: number): void {
    const focusAbs = store.get().selectedEventIndex;
    const range = selectedRange();
    for (let pos = first; pos < last; pos++) {
      const abs = visible.at(pos);
      const e = events[abs];
      if (!e) continue;
      const inRange = range !== null && pos >= range.lo && pos <= range.hi;
      const r = eventToRow(e, abs, dataSamples, symbols);
      const row = el(
        "div",
        {
          class: `ev-row ev-cls-${r.cls}`,
          role: "row",
          "data-event-index": abs,
          "data-row": pos,
          "aria-selected": inRange ? "true" : "false",
          onclick: (e) => selectRow(pos, (e as MouseEvent).shiftKey),
        },
        [
          cell("ev-idx", r.num),
          cell("ev-ts", r.ts),
          cell("ev-core", r.core),
          cell("ev-ctx", r.ctx),
          cell("ev-name", r.name),
          cell("ev-detail", r.detail),
        ],
      );
      if (inRange) row.classList.add("is-selected");
      if (abs === focusAbs && range !== null && range.lo !== range.hi) {
        row.classList.add("is-focus");
      }
      list.body.append(row);
    }
  }

  /** Rebuild the visible-row order from the current model + filters. */
  const rebuild = (): void => {
    const s = store.get();
    events = s.model?.events ?? [];
    symbols = s.model?.elf;
    dataSamples = buildDataSampleRegistry(events);
    const idx = buildVisibleIndices(events, s.filters, {
      scope: resolveScope(s, s.listScope),
      context: s.listContextOnly ? focusedContext(s) : null,
    });
    visible = new VisibleRows(idx, idx ? idx.length : events.length);
    list.setCount(visible.count);
  };

  /**
   * Selects the event at visible position `pos` and moves focus there. When `extend` is true, the range anchor remains fixed so the selection spans from the anchor to `pos`. When false, the anchor moves to `pos` and collapses the selection to a single row (managed by {@link selectEvent}).
   */
  const select = (pos: number, extend: boolean): void => {
    selectEvent(store, visible.at(pos), extend);
  };

  /** Select the event at visible position `pos` and reveal it. */
  const moveTo = (pos: number, extend = false): void => {
    if (visible.count === 0) return;
    const clamped = Math.max(0, Math.min(visible.count - 1, pos));
    list.ensureVisible(clamped);
    select(clamped, extend);
  };

  const selectRow = (pos: number, extend = false): void => {
    list.scroll.focus();
    select(pos, extend);
  };

  /** Current selected row position, or -1 if nothing (visible) is selected. */
  const selectedPos = (): number => {
    const abs = store.get().selectedEventIndex;
    return abs === null ? -1 : visible.positionOf(abs);
  };

  /**
   * Returns the selected visible-row span `[lo, hi]` (inclusive), or `null` when nothing is selected. Single selections yield `lo === hi`. Shift-selection spans from the anchor (clamped to focus if filtered out) to the focus.
   */
  const selectedRange = (): { lo: number; hi: number } | null => {
    const focus = selectedPos();
    if (focus < 0) return null;
    const anchorAbs = store.get().selectionAnchorIndex;
    const aPos = anchorAbs === null ? focus : visible.positionOf(anchorAbs);
    const anchor = aPos < 0 ? focus : aPos;
    return { lo: Math.min(anchor, focus), hi: Math.max(anchor, focus) };
  };

  /** Copies the selected range to the clipboard as a Markdown table. */
  const copySelection = (ev: ClipboardEvent): void => {
    const range = selectedRange();
    if (range === null) return;
    const rows = [];
    for (let pos = range.lo; pos <= range.hi; pos++) {
      const abs = visible.at(pos);
      const e = events[abs];
      if (e) rows.push(eventToRow(e, abs, dataSamples, symbols));
    }
    const md = rowsToMarkdown(rows);
    if (md === "") return;
    ev.clipboardData?.setData("text/plain", md);
    ev.preventDefault();
  };

  list.scroll.addEventListener("keydown", (ev) => {
    if (visible.count === 0) return;
    const page = list.pageRows;
    const cur = selectedPos();
    const ext = ev.shiftKey;
    switch (ev.key) {
      case "ArrowDown": moveTo(cur < 0 ? 0 : cur + 1, ext); break;
      case "ArrowUp": moveTo(cur < 0 ? 0 : cur - 1, ext); break;
      case "PageDown": moveTo(cur < 0 ? page : cur + page, ext); break;
      case "PageUp": moveTo(cur < 0 ? 0 : cur - page, ext); break;
      case "Home": moveTo(0, ext); break;
      case "End": moveTo(visible.count - 1, ext); break;
      default: return;
    }
    ev.preventDefault();
  });

  // Native copy event handler.
  list.scroll.addEventListener("copy", copySelection);

  pane.onResize(() => list.render());

  // Model and filter updates rebuild row ordering and scroll to the top. Selection changes update styling and scroll the selected row into view.
  store.select(["model", "filters", "listScope", "listContextOnly"], () => {
    rebuild();
    list.scrollToTop();
    list.render();
  });
  // The visible-window scope follows the timeline, and the selection scope follows the selection, so both have to rebuild in place without throwing away the scroll position.
  store.select(["view", "selectedEventIndex", "selectionAnchorIndex", "selectedContext"], () => {
    const s = store.get();
    if (s.listScope === "visible" || s.listScope === "selection" || s.listContextOnly) {
      rebuild();
      list.render();
    }
  });
  store.select(["selectedEventIndex", "selectionAnchorIndex"], () => {
    list.ensureVisible(selectedPos());
    list.render();
  });

  rebuild();
  list.render();
  return { pane };
}

function headCell(cls: string, text: string): HTMLElement {
  return el("span", { class: `ev-cell ${cls}`, role: "columnheader", text });
}

function cell(cls: string, text: string): HTMLElement {
  return el("span", { class: `ev-cell ${cls}`, role: "gridcell", text });
}
