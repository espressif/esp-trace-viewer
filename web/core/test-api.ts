/**
 * Test introspection API exposed on `window.__traceViewer` for browser-based automated testing.
 *
 * Exposes data-layer state (visible time window, canvas layout arrays, hit-test results, and model structure) and provides settled rendering signals prior to visual comparisons.
 *
 * Guarded: {@link installTestApi} executes only when `import.meta.env.DEV` or `MODE === "test"` is true; production builds eliminate this code.
 */

import type { TraceGap } from "../../src/trace/index.js";
import type { App } from "../app.js";
import { loadFixture } from "./fixtures.js";
import { zoomToRange } from "./zoom.js";
import type { RafScheduler } from "../trace-ui-toolkit/raf-scheduler.js";
import type { EventClass } from "./event-class.js";
import type { AppState, ReferenceMarker } from "./store.js";
import type { LaneLayout } from "./lanes/types.js";
import type { TimeScale } from "../trace-ui-toolkit/time-scale.js";
import type { PaneIntrospection } from "../ui/panes/types.js";

/** JSON-serializable representation of store state with sets converted to arrays. */
export interface StateSnapshot {
  /** Number of events in the loaded model. 0 if no model is loaded. */
  eventCount: number;
  sourceNames: string[];
  loadError: string | null;
  view: { t0: number; t1: number };
  domain: { start: number; end: number };
  cursorTime: number | null;
  selectedEventIndex: number | null;
  selectedContext: string | null;
  filters: { text: string; cores: number[]; classes: EventClass[] };
  references: ReferenceMarker[];
  /** Loaded ELF metadata and verification status, or `null`. */
  elf: { name: string; sha256: string } | null;
  /** Hierarchical lane layout configuration. */
  laneLayout: LaneLayout;
  timeResolution: number;
  /** Intervals where the target dropped events, as the model reports them. Empty if no model is loaded. */
  gaps: TraceGap[];
}

/** JSON-serializable representation of the active {@link TimeScale}. */
export interface ViewSnapshot {
  t0: number;
  t1: number;
  span: number;
  domainStart: number;
  domainEnd: number;
  domainSpan: number;
  widthPx: number;
  secondsPerPixel: number;
  isFullyZoomedOut: boolean;
}

/** Test and introspection interface attached to `window.__traceViewer`. */
export interface TraceViewerTestApi {
  /** Incremented when the interface schema changes. */
  readonly version: number;
  /** Return a serializable snapshot of the shared store. */
  state(): StateSnapshot;
  /** Return a serializable snapshot of the time scale. */
  view(): ViewSnapshot;
  /**
   * Resolve after fonts load and all scheduled animation frames complete.
   */
  whenSettled(): Promise<void>;
  /** Load a fixture trace by name (see `fixtures.ts`). */
  loadFixture(name: string): Promise<void>;
  /**
   * Set the visible time window to span events between `fromIndex` and `toIndex`.
   *
   * Clamps indices to available events. Performs no operation if no model is loaded.
   */
  zoomToEventRange(fromIndex: number, toIndex: number): void;
  /** Per-pane introspection providers keyed by pane identifier. */
  panes: Record<string, () => PaneIntrospection>;
}

declare global {
  interface Window {
    /** Test API instance, present only in test and development builds. */
    __traceViewer?: TraceViewerTestApi;
  }
}

function snapshotState(s: AppState): StateSnapshot {
  return {
    eventCount: s.model?.events.length ?? 0,
    sourceNames: s.sourceNames,
    loadError: s.loadError,
    view: { t0: s.view.t0, t1: s.view.t1 },
    domain: { start: s.domain.start, end: s.domain.end },
    cursorTime: s.cursorTime,
    selectedEventIndex: s.selectedEventIndex,
    selectedContext: s.selectedContext,
    filters: { text: s.filters.text, cores: [...s.filters.cores], classes: [...s.filters.classes] },
    references: s.references,
    elf: s.elf ? { name: s.elf.name, sha256: s.elf.sha256 } : null,
    laneLayout: s.laneLayout,
    timeResolution: s.timeResolution,
    gaps: s.model?.gaps ?? [],
  };
}

function snapshotView(ts: TimeScale): ViewSnapshot {
  return {
    t0: ts.t0,
    t1: ts.t1,
    span: ts.spanSeconds,
    domainStart: ts.domainStart,
    domainEnd: ts.domainEnd,
    domainSpan: ts.domainSpan,
    widthPx: ts.widthPx,
    secondsPerPixel: ts.secondsPerPixel,
    isFullyZoomedOut: ts.isFullyZoomedOut,
  };
}

/** Attach the test introspection interface to `window.__traceViewer` in test and development builds. */
export function installTestApi(opts: {
  app: App;
  scheduler: RafScheduler;
  panes: Map<string, () => PaneIntrospection>;
}): void {
  const { app, scheduler, panes } = opts;
  const panesObj: Record<string, () => PaneIntrospection> = {};
  for (const [id, fn] of panes) panesObj[id] = fn;

  const settled = async (): Promise<void> => {
    if (document.fonts?.ready) await document.fonts.ready;
    await scheduler.whenIdle();
  };

  window.__traceViewer = {
    version: 5,
    state: () => snapshotState(app.store.get()),
    view: () => snapshotView(app.timeScale),
    whenSettled: settled,
    loadFixture: (name) => loadFixture(app, name),
    zoomToEventRange: (fromIndex, toIndex) => {
      const evs = app.store.get().model?.events;
      if (!evs || !evs.length) return;
      const clamp = (i: number): number => Math.max(0, Math.min(i, evs.length - 1));
      zoomToRange(app.store, app.timeScale, evs[clamp(fromIndex)]!.ts, evs[clamp(toIndex)]!.ts);
    },
    panes: panesObj,
  };
}
