/**
 * Logs pane displaying target textual log output.
 *
 * This pane displays parsed `svPrint` messages as a virtualized table showing Timestamp, Context, and Message columns. It uses the shared {@link VirtualList} virtualizer. Line projection and filter matching are implemented in {@link ./logs-rows}.
 *
 * Selecting a line dispatches {@link selectEvent} for the underlying event, synchronizing the cursor across all panes. Selecting a log event elsewhere in the application scrolls it into view and highlights it in this pane.
 */

import type { TraceEvent } from "../../../src/trace/index.js";
import { resolveScope } from "../../core/list-scope.js";
import { focusedContext, selectEvent } from "../../core/selection.js";
import { el } from "../../trace-ui-toolkit/ui/dom.js";
import { Pane } from "../../trace-ui-toolkit/ui/pane.js";
import { VirtualList } from "../../trace-ui-toolkit/ui/virtual-list.js";
import { buildLogLines, type LogLine } from "./logs-rows.js";
import type { PaneContext, PaneHandle } from "./types.js";

/** Fixed row height in CSS px — must match `.log-line` height in `styles.css`. */
const ROW_H = 20;

export function createLogsPane(ctx: PaneContext): PaneHandle {
  // The dock header names this list and controls its placement, so the pane carries no chrome of its own.
  const pane = new Pane({ id: "logs", title: "Logs", chrome: false, collapsible: false });
  const { store } = ctx;

  let lines: LogLine[] = [];

  const head = el("div", { class: "logs-line logs-head", role: "row" }, [
    headCell("logs-ts", "Timestamp"),
    headCell("logs-ctx", "Context"),
    headCell("logs-msg", "Message"),
  ]);

  const list = new VirtualList({
    rowHeight: ROW_H,
    wrapperClass: "logs-table",
    scrollClass: "logs-scroll",
    sizerClass: "logs-sizer",
    bodyClass: "logs-body",
    header: head,
    scrollAttrs: {
      "data-testid": "logs-scroll",
      role: "grid",
      "aria-label": "Logs",
      tabindex: 0,
    },
    bodyAttrs: { "data-testid": "logs-body", role: "rowgroup" },
    renderWindow,
  });

  const empty = el("div", {
    class: "logs-empty",
    "data-testid": "logs-empty",
    text: "No log output",
  });

  pane.body.append(list.el, empty);

  /** Render visible lines in the virtual window. */
  function renderWindow(first: number, last: number): void {
    const selected = store.get().selectedEventIndex;
    for (let pos = first; pos < last; pos++) {
      const ln = lines[pos];
      if (!ln) continue;
      const row = el(
        "div",
        {
          class: "logs-line",
          role: "row",
          "data-event-index": ln.eventIndex,
          "data-row": pos,
          "aria-selected": ln.eventIndex === selected ? "true" : "false",
          onclick: () => selectLine(pos),
        },
        [cell("logs-ts", ln.ts), cell("logs-ctx", ln.ctx), cell("logs-msg", ln.msg)],
      );
      if (ln.eventIndex === selected) row.classList.add("is-selected");
      list.body.append(row);
    }
  }

  const selectLine = (pos: number): void => {
    const ln = lines[pos];
    if (!ln) return;
    list.scroll.focus();
    selectEvent(store, ln.eventIndex);
  };

  /**
   * Returns the row position of the line with absolute event index `abs`, or -1 if not visible. Uses binary search because `lines` are ordered by ascending `eventIndex`.
   */
  const positionOf = (abs: number): number => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = lines[mid]!.eventIndex;
      if (v === abs) return mid;
      if (v < abs) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };

  /**
   * Rebuilds the line model from the current model, filters and dock narrowing.
   *
   * `keepScroll` holds the viewport still for rebuilds driven by panning or by a moving selection, where jumping to the top would fight the user.
   */
  const rebuild = (keepScroll = false): void => {
    const s = store.get();
    const events: TraceEvent[] = s.model?.events ?? [];
    lines = buildLogLines(events, s.filters, {
      scope: resolveScope(s, s.listScope),
      context: s.listContextOnly ? focusedContext(s) : null,
    });
    list.setCount(lines.length);
    empty.toggleAttribute("hidden", lines.length > 0);
    if (!keepScroll) list.scrollToTop();
    list.render();
  };

  pane.onResize(() => list.render());

  // Rebuild lines when model or active filters change.
  store.select(["model", "filters", "listScope", "listContextOnly"], () => rebuild());
  store.select(["view", "selectedEventIndex", "selectionAnchorIndex", "selectedContext"], () => {
    const s = store.get();
    if (s.listScope === "visible" || s.listScope === "selection" || s.listContextOnly) rebuild(true);
  });
  store.select(["selectedEventIndex"], () => {
    const sel = store.get().selectedEventIndex;
    if (sel !== null) list.ensureVisible(positionOf(sel));
    list.render();
  });

  rebuild();
  return { pane };
}

function headCell(cls: string, text: string): HTMLElement {
  return el("span", { class: `logs-cell ${cls}`, role: "columnheader", text });
}

function cell(cls: string, text: string): HTMLElement {
  return el("span", { class: `logs-cell ${cls}`, role: "gridcell", text });
}
