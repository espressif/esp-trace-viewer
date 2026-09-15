/**
 * Find and Go-to toolbar component, hidden until triggered by shortcut or menu.
 *
 * Provides three navigation mechanisms mapped to store selection:
 * - Content query across filtered events (see {@link ../core/find}).
 * - Timestamp lookup via human time parsing ({@link ../core/format.parseTime}) routed to {@link ../core/navigate.goToTimestamp}.
 * - 1-based event index lookup via {@link ../core/navigate.goToEventNumber}.
 *
 * Matches recompute when model or filter states update. The bar synchronizes its match readout with store selection.
 */

import { findMatches, firstMatchPos, nextMatchPos, prevMatchPos } from "../core/find.js";
import { parseTime } from "../core/format.js";
import { goToEventNumber, goToTimestamp } from "../core/navigate.js";
import { selectEvent } from "../core/selection.js";
import type { Store } from "../core/store.js";
import { buildVisibleIndices } from "./panes/events-rows.js";
import { el } from "../trace-ui-toolkit/ui/dom.js";

/** Where to place the caret when the bar is opened. */
export type FindFocus = "find" | "time" | "event";

export interface FindBarHandle {
  /** The topbar row element to insert. */
  el: HTMLElement;
  /** Reveal the bar and focus the given field (default `find`). */
  open(focus?: FindFocus): void;
  /** Hide the bar. */
  close(): void;
  /** Remove global listeners. */
  dispose(): void;
}

export function createFindBar(store: Store): FindBarHandle {
  let query = "";
  let matches: number[] = [];

  const input = el("input", {
    type: "text",
    class: "find-input",
    "data-testid": "find-input",
    placeholder: "Find event / context / param…",
    "aria-label": "Find events",
  }) as HTMLInputElement;

  const count = el("span", { class: "find-count", "data-testid": "find-count", text: "" });

  const prevBtn = el("button", {
    class: "find-nav",
    type: "button",
    "data-testid": "find-prev",
    title: "Previous match (Shift-Enter)",
    text: "◂",
    onclick: () => step(-1),
  });
  const nextBtn = el("button", {
    class: "find-nav",
    type: "button",
    "data-testid": "find-next",
    title: "Next match (Enter)",
    text: "▸",
    onclick: () => step(1),
  });

  const timeInput = el("input", {
    type: "text",
    class: "find-goto",
    "data-testid": "goto-time",
    placeholder: "e.g. 1.5 ms",
    "aria-label": "Go to timestamp",
  }) as HTMLInputElement;
  const eventInput = el("input", {
    type: "text",
    class: "find-goto",
    "data-testid": "goto-event",
    placeholder: "#",
    inputmode: "numeric",
    "aria-label": "Go to event number",
  }) as HTMLInputElement;

  const row = el("div", { class: "findbar", "data-testid": "findbar" }, [
    el("span", { class: "find-label", text: "Find" }),
    input,
    count,
    prevBtn,
    nextBtn,
    el("span", { class: "tb-sep" }),
    el("span", { class: "find-label", text: "Go to" }),
    timeInput,
    el("span", { class: "find-label", text: "Event" }),
    eventInput,
  ]);
  row.hidden = true;

  /** Recompute matching event indices for the current query over the filtered event set. */
  const recompute = (): void => {
    const s = store.get();
    const events = s.model?.events ?? [];
    matches = findMatches(events, query, buildVisibleIndices(events, s.filters));
  };

  /** Select the match at index `pos` in the match list. */
  const land = (pos: number): void => {
    if (pos >= 0) selectEvent(store, matches[pos]!);
  };

  /** Render the match counter from the current selection position in the match list. */
  const renderCount = (sel = store.get().selectedEventIndex): void => {
    if (query.trim() === "") {
      count.textContent = "";
      return;
    }
    if (matches.length === 0) {
      count.textContent = "No matches";
      return;
    }
    const pos = sel === null ? -1 : matches.indexOf(sel);
    count.textContent = pos >= 0 ? `${pos + 1} of ${matches.length}` : `${matches.length} matches`;
  };

  /** Step to the next or previous match with index wrapping. */
  const step = (dir: 1 | -1): void => {
    if (matches.length === 0) return;
    const sel = store.get().selectedEventIndex;
    land(dir === 1 ? nextMatchPos(matches, sel) : prevMatchPos(matches, sel));
    renderCount();
  };

  input.addEventListener("input", () => {
    query = input.value;
    recompute();
    land(firstMatchPos(matches, store.get().selectedEventIndex));
    renderCount();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  const onGotoTime = (): void => {
    const t = parseTime(timeInput.value);
    if (t !== null) goToTimestamp(store, t);
  };
  const onGotoEvent = (): void => {
    const n = Number.parseInt(eventInput.value, 10);
    if (Number.isFinite(n)) goToEventNumber(store, n);
  };
  for (const [field, go] of [
    [timeInput, onGotoTime],
    [eventInput, onGotoEvent],
  ] as const) {
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        go();
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
  }

  // Recompute matches and update match counter on model or filter change.
  const unsubFilters = store.select(["model", "filters"], () => {
    recompute();
    renderCount();
  });
  // Update match counter when selection changes in the store.
  const unsubSel = store.select(["selectedEventIndex"], (s) => renderCount(s.selectedEventIndex));

  const open = (focus: FindFocus = "find"): void => {
    row.hidden = false;
    const field = focus === "time" ? timeInput : focus === "event" ? eventInput : input;
    field.focus();
    field.select();
  };
  const close = (): void => {
    row.hidden = true;
  };

  const onGlobalKey = (e: KeyboardEvent): void => {
    // Intercept Cmd-F and Ctrl-F globally to open the find bar.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      open("find");
    }
  };
  document.addEventListener("keydown", onGlobalKey);

  return {
    el: row,
    open,
    close,
    dispose: () => {
      document.removeEventListener("keydown", onGlobalKey);
      unsubFilters();
      unsubSel();
    },
  };
}
