/**
 * Resizable split container holding two elements separated by a draggable divider handle.
 *
 * `split(opts)` constructs a flex container containing child `a`, a divider handle, and child `b`. Dragging adjusts flex proportions between children, and a focused divider accepts arrow keys. Proportion values persist by `id` through {@link ../layout-store.saveSplitterSize} and restore during initialization. Nested split containers compose multi-pane layouts.
 *
 * A container's orientation can change after construction through {@link SplitHandle.setOrientation}, which the shell uses to move the Events/Logs dock between the right edge and the bottom edge.
 */

import { loadLayout, saveSplitterSize } from "../layout-store.js";
import { el } from "./dom.js";
import { PANE_LAYOUT_EVENT } from "./pane.js";

export type Orientation = "row" | "column";

/** Fraction of the container a single arrow-key press moves the divider. */
const KEY_STEP = 0.02;

export interface SplitOptions {
  /** Layout orientation: `row` (horizontal layout with vertical divider) or `column` (vertical layout with horizontal divider). */
  orientation: Orientation;
  /** First child element (left or top). */
  a: HTMLElement;
  /** Second child element (right or bottom). */
  b: HTMLElement;
  /** Unique identifier used to persist divider proportions. */
  id: string;
  /** Default fraction allocated to child `a` in `[0.05, 0.95]` when no stored value exists. */
  defaultFraction?: number;
  /** Accessible name for the divider. */
  label?: string;
}

/** A mounted split container. */
export interface SplitHandle {
  /** The container element to insert into the layout. */
  el: HTMLElement;
  /** Switch the container between row and column layout, keeping the stored fraction. */
  setOrientation(orientation: Orientation): void;
  /** Current fraction allocated to child `a`. */
  readonly fraction: number;
}

export function split(opts: SplitOptions): SplitHandle {
  const persisted = loadLayout().sizes[opts.id];
  let fraction = clamp(persisted ?? opts.defaultFraction ?? 0.5);
  let orientation = opts.orientation;

  const handle = el("div", {
    class: `splitter splitter-${orientation}`,
    role: "separator",
    tabindex: 0,
    "data-splitter": opts.id,
    "aria-orientation": orientation === "row" ? "vertical" : "horizontal",
    ...(opts.label ? { "aria-label": opts.label } : {}),
  });

  const container = el("div", { class: `split split-${orientation}`, "data-split": opts.id }, [
    opts.a,
    handle,
    opts.b,
  ]);

  // Child is inactive when collapsed or hidden.
  const inactive = (c: HTMLElement): boolean =>
    c.classList.contains("is-collapsed") || c.style.display === "none";

  // Updates flex styling. When one child is inactive, the active child expands to fill available space.
  const apply = (): void => {
    const aOff = inactive(opts.a);
    const bOff = inactive(opts.b);
    if (aOff && bOff) {
      opts.a.style.flex = "0 0 auto";
      opts.b.style.flex = "0 0 auto";
    } else if (aOff) {
      opts.a.style.flex = "0 0 auto";
      opts.b.style.flex = "1 1 0";
    } else if (bOff) {
      opts.a.style.flex = "1 1 0";
      opts.b.style.flex = "0 0 auto";
    } else {
      opts.a.style.flex = `${fraction} 1 0`;
      opts.b.style.flex = `${1 - fraction} 1 0`;
    }
    // Hide divider handle when either child is inactive.
    handle.style.display = aOff || bOff ? "none" : "";
    handle.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
    // Mark container collapsed when both children are inactive, allowing enclosing split containers to collapse.
    container.classList.toggle("is-collapsed", aOff && bOff);
  };
  apply();

  // Recalculate flex allocation when child pane layout events bubble up.
  container.addEventListener(PANE_LAYOUT_EVENT, () => apply());

  let dragging = false;
  const onMove = (clientX: number, clientY: number): void => {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const f =
      orientation === "row"
        ? (clientX - rect.left) / rect.width
        : (clientY - rect.top) / rect.height;
    fraction = clamp(f);
    apply();
  };

  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add(orientation === "row" ? "resizing-col" : "resizing-row");
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => onMove(e.clientX, e.clientY));
  const end = (): void => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing-col", "resizing-row");
    saveSplitterSize(opts.id, fraction);
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);

  // A focused divider resizes with the arrow keys along its own axis, and snaps to the extremes with Home and End.
  handle.addEventListener("keydown", (e) => {
    const back = orientation === "row" ? "ArrowLeft" : "ArrowUp";
    const forward = orientation === "row" ? "ArrowRight" : "ArrowDown";
    let next = fraction;
    if (e.key === back) next = fraction - KEY_STEP;
    else if (e.key === forward) next = fraction + KEY_STEP;
    else if (e.key === "Home") next = 0.05;
    else if (e.key === "End") next = 0.95;
    else return;
    e.preventDefault();
    fraction = clamp(next);
    apply();
    saveSplitterSize(opts.id, fraction);
  });

  return {
    el: container,
    get fraction() {
      return fraction;
    },
    setOrientation(next: Orientation): void {
      if (next === orientation) return;
      orientation = next;
      container.classList.remove("split-row", "split-column");
      container.classList.add(`split-${next}`);
      handle.classList.remove("splitter-row", "splitter-column");
      handle.classList.add(`splitter-${next}`);
      handle.setAttribute("aria-orientation", next === "row" ? "vertical" : "horizontal");
      apply();
    },
  };
}

function clamp(f: number): number {
  return f < 0.05 ? 0.05 : f > 0.95 ? 0.95 : f;
}
