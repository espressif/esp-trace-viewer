/**
 * Event class filtering: the menu rows shown in the Events/Logs dock header, and the global accelerators that go with them.
 *
 * {@link classFilterItems} reflects live store filter state: visibility toggles for each {@link EventClass}, solo selection options with `⌥⌘<key>` shortcuts, `Reset All Filters` (`⌥Space`), and `Show All Hidden Lanes`. Filter mutations dispatch through {@link ../core/filters}.
 *
 * {@link installFilterAccelerators} registers the solo and reset shortcuts on the document. They are ignored while focus sits in a text input.
 */

import {
  ALL_EVENT_CLASSES,
  EVENT_CLASS_LABELS,
  type EventClass,
} from "../core/event-class.js";
import { classHidden, resetFilters, soloClass, toggleClass } from "../core/filters.js";
import { showAll } from "../trace-ui-toolkit/lanes/controller.js";
import { hiddenLaneCount } from "../core/lanes/selectors.js";
import type { Store } from "../core/store.js";
import type { MenuItem } from "./menu.js";

/** Accelerator hint shown next to each `Show … only` row. */
const SOLO_ACCEL: Readonly<Record<EventClass, string>> = {
  api: "⌥⌘A",
  isr: "⌥⌘I",
  message: "⌥⌘M",
  system: "⌥⌘S",
  task: "⌥⌘T",
  event: "⌥⌘E",
};

/** Physical key code that triggers each class's solo (layout-independent). */
const SOLO_CODE: Readonly<Record<EventClass, string>> = {
  api: "KeyA",
  isr: "KeyI",
  message: "KeyM",
  system: "KeyS",
  task: "KeyT",
  event: "KeyE",
};

/** Build the class filter rows for the dock header menu. */
export function classFilterItems(store: Store): MenuItem[] {
  const items = (): MenuItem[] => {
    const { filters, laneLayout } = store.get();
    const out: MenuItem[] = [];

    // Per-class show/hide.
    for (const c of ALL_EVENT_CLASSES) {
      out.push({
        label: `Show ${EVENT_CLASS_LABELS[c]}`,
        checked: !classHidden(filters, c),
        testid: `menu-show-${c}`,
        onSelect: () => store.set({ filters: toggleClass(store.get().filters, c) }),
      });
    }
    out.push({ separator: true });

    // Solo class filter.
    for (const c of ALL_EVENT_CLASSES) {
      out.push({
        label: `Show ${EVENT_CLASS_LABELS[c]} only`,
        accel: SOLO_ACCEL[c],
        testid: `menu-only-${c}`,
        onSelect: () => store.set({ filters: soloClass(store.get().filters, c) }),
      });
    }
    out.push({ separator: true });

    out.push({
      label: "Reset All Filters",
      accel: "⌥Space",
      testid: "menu-reset",
      onSelect: () => store.set({ filters: resetFilters() }),
    });
    // Restore timeline lanes marked hidden in the lane layout.
    const hiddenLanes = hiddenLaneCount(laneLayout);
    out.push({
      label: hiddenLanes > 0 ? `Show All Hidden Lanes (${hiddenLanes})` : "Show All Hidden Lanes",
      disabled: hiddenLanes === 0,
      testid: "menu-show-all-lanes",
      onSelect: () => store.set({ laneLayout: showAll(store.get().laneLayout) }),
    });
    return out;
  };
  return items();
}

/**
 * Register the filter accelerators. Returns a function that removes them.
 */
export function installFilterAccelerators(store: Store): () => void {
  // Global accelerator shortcuts: Option-Space resets filters, Option-Cmd-<key> solos an event class. Ignored when focus is inside text inputs.
  const onAccel = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    if (e.altKey && e.code === "Space") {
      e.preventDefault();
      store.set({ filters: resetFilters() });
      return;
    }
    if (e.altKey && e.metaKey) {
      for (const c of ALL_EVENT_CLASSES) {
        if (e.code === SOLO_CODE[c]) {
          e.preventDefault();
          store.set({ filters: soloClass(store.get().filters, c) });
          return;
        }
      }
    }
  };
  document.addEventListener("keydown", onAccel);
  return () => document.removeEventListener("keydown", onAccel);
}
