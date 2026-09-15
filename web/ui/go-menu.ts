/**
 * Navigate dropdown menu component for event navigation, selection zoom, and reference markers.
 *
 * Menu item states reflect store conditions (stepping requires loaded events, context stepping requires a selected context, zoom requires a selection, reference actions require a cursor or existing markers). Actions dispatch through {@link ../core/navigate}, zoom, and reference handlers to update shared store state. Navigation accelerators (`[`, `]`, `{`, `}`) and reference accelerators (`R`, `Shift-R`) are registered globally and ignored when text inputs have focus.
 */

import { focusedContext } from "../core/selection.js";
import {
  goToEnd,
  goToStart,
  stepEvent,
  stepEventInContext,
} from "../core/navigate.js";
import { clearReferences, toggleReference } from "../core/references.js";
import type { Store } from "../core/store.js";
import type { TimeScale } from "../trace-ui-toolkit/time-scale.js";
import { zoomToSelectedEvent } from "../core/zoom.js";
import type { FindBarHandle } from "./find-bar.js";
import { createDropdown, type DropdownHandle, type MenuItem } from "./menu.js";

export interface GoMenuHandle {
  /** The dropdown element to place in the toolbar. */
  el: HTMLElement;
  /** Remove the global accelerator listener. */
  dispose(): void;
}

export function createGoMenu(store: Store, timeScale: TimeScale, findBar: FindBarHandle): GoMenuHandle {
  const items = (): MenuItem[] => {
    const s = store.get();
    const hasEvents = (s.model?.events.length ?? 0) > 0;
    const hasContext = focusedContext(s) !== null;
    return [
      {
        label: "Go to Start",
        disabled: !hasEvents,
        testid: "go-start",
        onSelect: () => goToStart(store),
      },
      {
        label: "Go to End",
        disabled: !hasEvents,
        testid: "go-end",
        onSelect: () => goToEnd(store),
      },
      { separator: true },
      {
        label: "Next Event",
        accel: "]",
        disabled: !hasEvents,
        testid: "go-next",
        onSelect: () => stepEvent(store, 1),
      },
      {
        label: "Previous Event",
        accel: "[",
        disabled: !hasEvents,
        testid: "go-prev",
        onSelect: () => stepEvent(store, -1),
      },
      { separator: true },
      {
        label: "Next Event in Context",
        accel: "}",
        disabled: !hasContext,
        testid: "go-next-ctx",
        onSelect: () => stepEventInContext(store, 1),
      },
      {
        label: "Previous Event in Context",
        accel: "{",
        disabled: !hasContext,
        testid: "go-prev-ctx",
        onSelect: () => stepEventInContext(store, -1),
      },
      { separator: true },
      {
        label: "Zoom to Selection",
        // Requires a selected event.
        disabled: s.selectedEventIndex === null,
        testid: "menu-zoom-selection",
        onSelect: () => zoomToSelectedEvent(store, timeScale),
      },
      { separator: true },
      // Reference markers and delta measurement. Adds or removes a mark at cursor time.
      {
        label: "Toggle Reference",
        accel: "R",
        disabled: s.cursorTime === null,
        testid: "menu-toggle-reference",
        onSelect: () => {
          const t = store.get().cursorTime;
          if (t !== null) store.set({ references: toggleReference(store.get().references, t) });
        },
      },
      {
        label: "Clear All References",
        accel: "⇧R",
        disabled: s.references.length === 0,
        testid: "menu-clear-references",
        onSelect: () => store.set({ references: clearReferences() }),
      },
      { separator: true },
      {
        label: "Find…",
        accel: "⌘F",
        testid: "go-find",
        onSelect: () => findBar.open("find"),
      },
      {
        label: "Go to Timestamp…",
        disabled: !hasEvents,
        testid: "go-timestamp",
        onSelect: () => findBar.open("time"),
      },
      {
        label: "Go to Event #…",
        disabled: !hasEvents,
        testid: "go-number",
        onSelect: () => findBar.open("event"),
      },
    ];
  };

  const dropdown: DropdownHandle = createDropdown({ label: "Navigate", testid: "menu-navigate", items });

  // Global accelerator keybindings.
  const onAccel = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    if (e.metaKey || e.altKey || e.ctrlKey) return;
    if (e.code === "KeyR") {
      if (e.shiftKey) {
        if (store.get().references.length) {
          e.preventDefault();
          store.set({ references: clearReferences() });
        }
        return;
      }
      const t = store.get().cursorTime;
      if (t !== null) {
        e.preventDefault();
        store.set({ references: toggleReference(store.get().references, t) });
      }
      return;
    }
    switch (e.key) {
      case "]": stepEvent(store, 1); break;
      case "[": stepEvent(store, -1); break;
      case "}": stepEventInContext(store, 1); break;
      case "{": stepEventInContext(store, -1); break;
      default: return;
    }
    e.preventDefault();
  };
  document.addEventListener("keydown", onAccel);

  return { el: dropdown.el, dispose: () => document.removeEventListener("keydown", onAccel) };
}
