/** Shared dependencies provided to pane factories. */

import type { LaneRegistry } from "../../core/lanes/registry.js";
import type { RafScheduler } from "../../trace-ui-toolkit/raf-scheduler.js";
import type { Store } from "../../core/store.js";
import type { TimeScale } from "../../trace-ui-toolkit/time-scale.js";
import type { Pane } from "../../trace-ui-toolkit/ui/pane.js";

export interface PaneContext {
  store: Store;
  timeScale: TimeScale;
  scheduler: RafScheduler;
  /** Shared lane-type registry used by the timeline host and the Lanes panel. */
  registry: LaneRegistry;
}

/**
 * Read-only introspection data exposed by canvas panes to test harnesses via `window.__traceViewer.panes[id]()`. Enables assertions directly on data structures (visible windows, layout bins, hit-test results). Panes extend this shape with pane-specific fields.
 */
export interface PaneIntrospection {
  /** Trace-time window currently mapped across the pane in seconds. */
  visibleWindow: { t0: number; t1: number };
  /** Canvas width in CSS pixels. */
  widthPx: number;
  /** Seconds represented by one pixel at current zoom. */
  secondsPerPixel: number;
  /** Maps a canvas x-coordinate in CSS pixels to trace time in seconds. */
  timeAtX(x: number): number;
}

/** Object returned by a pane factory containing the pane and optional drawable or introspection handles. */
export interface PaneHandle {
  pane: Pane;
  drawable?: { draw(): void };
  /** Test introspection provider exposed via `window.__traceViewer.panes`. */
  introspect?: () => PaneIntrospection;
}
