/**
 * Fixed-row-height virtual list renderer for uniform rows.
 *
 * Uses a full-height sizer element to maintain scrollbar proportions while rendering only visible rows plus overscan. Calculates scroll offsets, row translation, sticky header offsets, and scroll visibility. Row rendering is delegated to {@link VirtualListOptions.renderWindow}.
 */

import { clear, el } from "./dom.js";

/** HTML attributes applied directly to an element. */
type Attrs = Record<string, string | number>;

export interface VirtualListOptions {
  /** Fixed row height in CSS pixels. */
  rowHeight: number;
  /** Number of rows rendered outside the visible viewport to buffer fast scrolling. */
  overscan?: number;
  /** CSS class name for the root wrapper element. */
  wrapperClass: string;
  /** CSS class name for the scrollable container element. */
  scrollClass: string;
  /** CSS class name for the full-height spacer element sizing the scrollbar. */
  sizerClass: string;
  /** CSS class name for the container holding rendered rows. */
  bodyClass: string;
  /** Optional sticky header element positioned above scrolled rows. */
  header?: HTMLElement;
  /** Additional HTML attributes for the scroll container element. */
  scrollAttrs?: Attrs;
  /** Additional HTML attributes for the row container element. */
  bodyAttrs?: Attrs;
  /**
   * Renders rows for visible index range `[first, last)`.
   * The container is cleared and translated before invocation; the callback appends row elements in order.
   */
  renderWindow: (first: number, last: number) => void;
}

export class VirtualList {
  /** Outer wrapper element. */
  readonly el: HTMLElement;
  /** Scrollable container element. */
  readonly scroll: HTMLElement;
  /** Row container element passed to `renderWindow`. */
  readonly body: HTMLElement;

  private readonly sizer: HTMLElement;
  private readonly header?: HTMLElement;
  private readonly rowHeight: number;
  private readonly overscan: number;
  private readonly renderWindow: (first: number, last: number) => void;
  private rowCount = 0;

  constructor(opts: VirtualListOptions) {
    this.rowHeight = opts.rowHeight;
    this.overscan = opts.overscan ?? 8;
    this.renderWindow = opts.renderWindow;
    if (opts.header) this.header = opts.header;

    this.body = el("div", { class: opts.bodyClass, ...(opts.bodyAttrs ?? {}) });
    this.sizer = el("div", { class: opts.sizerClass }, [this.body]);
    this.scroll = el(
      "div",
      { class: opts.scrollClass, ...(opts.scrollAttrs ?? {}) },
      opts.header ? [opts.header, this.sizer] : [this.sizer],
    );
    this.el = el("div", { class: opts.wrapperClass }, [this.scroll]);

    // Re-render synchronously on scroll events. Updating scrollTop triggers this event immediately.
    this.scroll.addEventListener("scroll", () => this.render());
  }

  /** Total number of rows in the list. */
  get count(): number {
    return this.rowCount;
  }

  /** Current vertical scroll offset in CSS pixels. */
  get scrollTop(): number {
    return this.scroll.scrollTop;
  }

  /** Number of rows fitting in one viewport navigation page (viewport height divided by row height, minus one). */
  get pageRows(): number {
    return Math.max(1, Math.floor(this.scroll.clientHeight / this.rowHeight) - 1);
  }

  /** Sets total row count, updates spacer height, and sets the data-total-rows attribute. */
  setCount(n: number): void {
    this.rowCount = n;
    this.sizer.style.height = `${n * this.rowHeight}px`;
    this.scroll.setAttribute("data-total-rows", String(n));
  }

  /** Recomputes visible row range, applies vertical translation, and renders rows. */
  render(): void {
    const scrollTop = this.scroll.scrollTop;
    const viewH = this.scroll.clientHeight || this.el.clientHeight;
    const first = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.overscan);
    const last = Math.min(
      this.rowCount,
      Math.ceil((scrollTop + viewH) / this.rowHeight) + this.overscan,
    );
    this.body.style.transform = `translateY(${first * this.rowHeight}px)`;
    clear(this.body);
    this.renderWindow(first, last);
  }

  /** Scrolls row at index `pos` into the visible viewport, accounting for sticky header height. */
  ensureVisible(pos: number): void {
    if (pos < 0) return;
    const headH = this.header?.offsetHeight || 0;
    const viewH = this.scroll.clientHeight;
    // Account for sticky header height so target row clears upper and lower viewport boundaries.
    const top = headH + pos * this.rowHeight;
    if (top < this.scroll.scrollTop + headH) {
      // Target row is hidden above viewport or obscured by sticky header.
      this.scroll.scrollTop = Math.max(0, top - headH);
    } else if (top + this.rowHeight > this.scroll.scrollTop + viewH) {
      // Target row is hidden below viewport lower boundary.
      this.scroll.scrollTop = Math.max(0, top + this.rowHeight - viewH);
    }
  }

  /** Scrolls to the top of the list. */
  scrollToTop(): void {
    this.scroll.scrollTop = 0;
  }

  /** Scrolls to the bottom of the list. */
  scrollToTail(): void {
    this.scroll.scrollTop = this.rowCount * this.rowHeight;
  }
}
