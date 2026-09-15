/**
 * Events and Logs dock.
 *
 * Holds the two event lists next to the timeline: docked to the right edge by default, movable to the bottom, and closable. Its header carries the Events / Logs / Both tabs, the scope selector, the event-class filter menu, the Context filter, and the dock placement buttons.
 *
 * The dock owns placement and which lists are on screen. The lists themselves are built by {@link ./panes/events-pane} and {@link ./panes/logs-pane}; scope and context narrowing are applied inside those, from store state this header writes.
 *
 * The header's Export menu offers whichever lists the tabs have on screen. It rebuilds the rows from the
 * same store state and the same pure projections the lists render from, rather than reading them back out
 * of the virtualized DOM, which only ever holds the rows near the viewport.
 */

import { classFilterItems } from "./class-filter.js";
import { buildDataSampleRegistry } from "../core/data-samples.js";
import type { TableData } from "../core/export.js";
import { resolveScope } from "../core/list-scope.js";
import { focusedContext } from "../core/selection.js";
import type { DockTab, Scope, Store } from "../core/store.js";
import { el } from "../trace-ui-toolkit/ui/dom.js";
import { createDropdown } from "./menu.js";
import { createExportMenu, type ExportTarget } from "./export-menu.js";
import {
  buildVisibleIndices,
  eventsTable,
  eventToRow,
  type ListNarrowing,
} from "./panes/events-rows.js";
import { buildLogLines, logsTable } from "./panes/logs-rows.js";
import { toggleButton } from "./toggle-button.js";

/** Scope choices, worded the same here and in the Statistics workspace. */
export const SCOPE_OPTIONS: { value: Scope; label: string }[] = [
  { value: "visible", label: "Visible window" },
  { value: "selection", label: "Selection" },
  { value: "full", label: "Full range" },
];

/** Tabs in display order. `both` shows the two lists at once. */
const TABS: { id: DockTab; label: string }[] = [
  { id: "events", label: "Events" },
  { id: "logs", label: "Logs" },
];

export interface DockOptions {
  /** The Events list body. */
  events: HTMLElement;
  /** The Logs list body. */
  logs: HTMLElement;
}

export interface DockHandle {
  /** The dock element. */
  el: HTMLElement;
}

export function createDock(store: Store, opts: DockOptions): DockHandle {
  const tabs = TABS.map(({ id, label }) => {
    const btn = el("button", {
      class: "docktab",
      type: "button",
      role: "tab",
      "data-tab": id,
      "data-testid": `dock-tab-${id}`,
      text: label,
      onclick: () => store.set({ dock: { ...store.get().dock, tab: id } }),
    });
    return { id, btn };
  });

  const bothBtn = el("button", {
    class: "docktab dock-both",
    type: "button",
    "data-tab": "both",
    "data-testid": "dock-tab-both",
    text: "Both",
    title: "Show Events and Logs together",
    onclick: () => store.set({ dock: { ...store.get().dock, tab: "both" } }),
  });

  const scopeSelect = el("select", {
    class: "dock-scope",
    "data-testid": "dock-scope",
    "aria-label": "Events and Logs scope",
    onchange: (e) => {
      const value = (e.target as HTMLSelectElement).value as Scope;
      store.set({ listScope: value });
    },
  }) as HTMLSelectElement;
  for (const o of SCOPE_OPTIONS) scopeSelect.append(el("option", { value: o.value, text: o.label }));

  // Event-class visibility. The solo accelerators are registered separately, once, by the shell.
  const classMenu = createDropdown({
    label: "Classes",
    testid: "menu-classes",
    items: () => classFilterItems(store),
  });

  const context = toggleButton({
    label: "Context",
    testid: "dock-context",
    onClick: () => store.set({ listContextOnly: !store.get().listContextOnly }),
  });

  /** The scope and context narrowing both lists are showing through right now. */
  const narrowing = (): ListNarrowing => {
    const s = store.get();
    return {
      scope: resolveScope(s, s.listScope),
      context: s.listContextOnly ? focusedContext(s) : null,
    };
  };

  /** Every event row the Events list is showing, in its order. */
  const eventsSnapshot = (): TableData => {
    const s = store.get();
    const events = s.model?.events ?? [];
    const indices = buildVisibleIndices(events, s.filters, narrowing());
    const samples = buildDataSampleRegistry(events);
    const count = indices ? indices.length : events.length;
    const rows = [];
    for (let pos = 0; pos < count; pos++) {
      const abs = indices ? indices[pos]! : pos;
      const e = events[abs];
      if (e) rows.push(eventToRow(e, abs, samples, s.model?.elf));
    }
    return eventsTable(rows);
  };

  /** Every log line the Logs list is showing, in its order. */
  const logsSnapshot = (): TableData => {
    const s = store.get();
    return logsTable(buildLogLines(s.model?.events ?? [], s.filters, narrowing()));
  };

  // The menu offers whichever lists the tabs have on screen, so Both offers two.
  const exportMenu = createExportMenu(store, {
    testid: "menu-export-lists",
    targets: (): ExportTarget[] => {
      const { tab } = store.get().dock;
      const targets: ExportTarget[] = [];
      if (tab !== "logs") targets.push({ label: "Events", slug: "events", table: eventsSnapshot });
      if (tab !== "events") targets.push({ label: "Logs", slug: "logs", table: logsSnapshot });
      return targets;
    },
  });

  const placeBtn = (
    testid: string,
    text: string,
    title: string,
    run: () => void,
  ): HTMLElement =>
    el("button", {
      class: "tb-btn dock-icon",
      type: "button",
      "data-testid": testid,
      title,
      "aria-label": title,
      text,
      onclick: run,
    });

  const bottomBtn = placeBtn("dock-bottom", "⊟", "Dock panel at bottom", () =>
    store.set({ dock: { ...store.get().dock, side: "bottom", hidden: false } }),
  );
  const rightBtn = placeBtn("dock-right", "◧", "Dock panel at right", () =>
    store.set({ dock: { ...store.get().dock, side: "right", hidden: false } }),
  );
  const closeBtn = placeBtn("dock-close", "×", "Hide panel", () =>
    store.set({ dock: { ...store.get().dock, hidden: true } }),
  );

  const head = el("div", { class: "dock-head", role: "tablist", "aria-label": "Events and Logs" }, [
    tabs[0]!.btn,
    tabs[1]!.btn,
    bothBtn,
    el("span", { class: "dock-spacer" }),
    scopeSelect,
    classMenu.el,
    context.el,
    exportMenu.el,
    bottomBtn,
    rightBtn,
    closeBtn,
  ]);

  // Each list keeps its own section so the Both layout can show them side by side.
  const eventsSection = el("section", { class: "dock-section", "data-section": "events" }, [
    el("div", { class: "dock-subhead", text: "Events" }),
    opts.events,
  ]);
  const logsSection = el("section", { class: "dock-section", "data-section": "logs" }, [
    el("div", { class: "dock-subhead", text: "Logs" }),
    opts.logs,
  ]);
  const content = el("div", { class: "dock-content" }, [eventsSection, logsSection]);

  const dock = el("aside", { class: "dock", "data-testid": "dock" }, [head, content]);

  const render = (): void => {
    const s = store.get();
    const { tab } = s.dock;
    for (const t of tabs) {
      const on = t.id === tab;
      t.btn.classList.toggle("is-active", on);
      t.btn.setAttribute("aria-selected", on ? "true" : "false");
    }
    bothBtn.classList.toggle("is-active", tab === "both");
    content.classList.toggle("is-both", tab === "both");
    eventsSection.hidden = tab === "logs";
    logsSection.hidden = tab === "events";
    // The per-list caption only earns its space when both lists are on screen.
    for (const section of [eventsSection, logsSection]) {
      (section.firstElementChild as HTMLElement).hidden = tab !== "both";
    }
    dock.classList.toggle("dock-side-right", s.dock.side === "right");
    dock.classList.toggle("dock-side-bottom", s.dock.side === "bottom");
    rightBtn.classList.toggle("is-active", s.dock.side === "right");
    bottomBtn.classList.toggle("is-active", s.dock.side === "bottom");
    scopeSelect.value = s.listScope;
    context.setOn(s.listContextOnly);
    context.setTitle(
      s.selectedContext
        ? `Filter to the selected context: ${s.selectedContext}`
        : "Filter to the selected context",
    );
  };

  render();
  store.select(["dock", "listScope", "listContextOnly", "selectedContext"], render);

  return { el: dock };
}
