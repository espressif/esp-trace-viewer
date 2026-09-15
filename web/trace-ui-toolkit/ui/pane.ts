/**
 * Collapsible pane container for UI components.
 *
 * Each shell section renders inside a {@link Pane}. The pane creates a header with a title and optional collapse toggle, and a content body container. Canvas panes maintain an internal `<canvas>` sized to body dimensions via `ResizeObserver`. Collapse state persists through {@link ../layout-store.saveCollapsed}.
 */

import { saveCollapsed } from "../layout-store.js";
import { el } from "./dom.js";

/**
 * Event dispatched when pane collapse or visibility state changes. Enclosing {@link ./splitter.split} containers listen for this event to recalculate flex distribution across remaining visible panes.
 */
export const PANE_LAYOUT_EVENT = "pane-layout-change";

export interface PaneOptions {
  /** Unique pane identifier used for layout persistence and DOM selection (`data-pane`). */
  id: string;
  /** Title text displayed in the pane header. */
  title: string;
  /** When true, renders a button to toggle collapsed state. Defaults to true. */
  collapsible?: boolean;
  /**
   * When false, the pane renders without its own header. Use it where the enclosing container already names the content, such as a tab in the Events/Logs dock or a workspace that fills the window.
   */
  chrome?: boolean;
  /** When true, creates an internal canvas filling the body and sized to body dimensions. */
  canvas?: boolean;
  /** Initial collapsed state restored from layout storage. */
  collapsed?: boolean;
}

export class Pane {
  readonly id: string;
  /** Root container element (`.pane`). */
  readonly el: HTMLElement;
  /** Content container element (`.pane-body`). */
  readonly body: HTMLElement;
  /** Canvas element, present when canvas option is enabled. */
  readonly canvas?: HTMLCanvasElement;

  private collapsed = false;
  private readonly resizeCbs = new Set<(w: number, h: number) => void>();

  constructor(opts: PaneOptions) {
    this.id = opts.id;
    const collapsible = opts.collapsible ?? true;

    this.body = el("div", { class: "pane-body" });
    if (opts.canvas) {
      this.canvas = el("canvas", { class: "pane-canvas" });
      this.body.append(this.canvas);
    }

    const toggle = el("button", {
      class: "pane-toggle",
      type: "button",
      title: "Collapse",
      "aria-label": "Collapse pane",
      onclick: () => this.setCollapsed(!this.collapsed),
    });

    const chrome = opts.chrome ?? true;
    const header = el("div", { class: "pane-header" }, [
      el("span", { class: "pane-title", text: opts.title }),
      ...(collapsible ? [toggle] : []),
    ]);

    this.el = el(
      "div",
      { class: `pane${chrome ? "" : " pane-bare"}`, "data-pane": opts.id },
      chrome ? [header, this.body] : [this.body],
    );

    // Observe body dimensions to resize canvas backing store and notify subscribers.
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      if (this.canvas) this.fitCanvas(r.width, r.height);
      for (const cb of this.resizeCbs) cb(r.width, r.height);
    });
    ro.observe(this.body);

    if (opts.collapsed) this.setCollapsed(true, /*persist*/ false);
  }

  /** Subscribes to body dimension changes, reporting width and height in CSS pixels. */
  onResize(cb: (w: number, h: number) => void): void {
    this.resizeCbs.add(cb);
  }

  /** Returns true if the pane is collapsed. */
  get isCollapsed(): boolean {
    return this.collapsed;
  }

  /** Sets collapsed state and optionally persists the value to layout storage. */
  setCollapsed(collapsed: boolean, persist = true): void {
    this.collapsed = collapsed;
    this.el.classList.toggle("is-collapsed", collapsed);
    if (persist) saveCollapsed(this.id, collapsed);
    this.notifyLayout();
  }

  /**
   * Sets pane visibility and dispatches a layout event to recalculate enclosing flex containers.
   */
  setHidden(hidden: boolean): void {
    this.el.style.display = hidden ? "none" : "";
    this.notifyLayout();
  }

  /** Dispatches a layout change event to enclosing split containers. */
  private notifyLayout(): void {
    this.el.dispatchEvent(new CustomEvent(PANE_LAYOUT_EVENT, { bubbles: true }));
  }

  /** Resizes canvas backing store to match CSS dimensions scaled by device pixel ratio. */
  private fitCanvas(cssW: number, cssH: number): void {
    const c = this.canvas!;
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }
}
