/**
 * Application state store coordinating state distribution across viewer panes.
 *
 * This synchronous pub/sub container wraps an {@link AppState} object. Panes query slices and register listeners via {@link Store.select} for specific property changes. State updates occur via shallow merge through {@link Store.set}, notifying subscribers only when watched properties change by `Object.is` equality.
 *
 * Per-frame rendering calculations are managed outside this store in {@link ../core/time-scale.TimeScale}; window bounds are mirrored in store state for toolbar and status bar display.
 */

import type { ElfSymbols } from "../../src/elf/index.js";
import type { TraceModel } from "../../src/trace/index.js";
import type { ContextType } from "./context-type.js";
import type { ContextRole } from "./lanes/context-role.js";
import type { EventClass } from "./event-class.js";
import { LANE_LAYOUT_VERSION, type LaneLayout } from "./lanes/types.js";

/** Symbol metadata for a loaded application ELF. An ELF is only held while it matches the capture. */
export interface ElfState {
  /** ELF filename for status bar display. */
  name: string;
  /** Lowercase hex SHA-256 digest of the ELF bytes. */
  sha256: string;
  /** Address-to-symbol lookup table. */
  symbols: ElfSymbols;
}

/** Reference marker on the timeline. */
export interface ReferenceMarker {
  /** Stable identifier for selection and removal. */
  id: number;
  /** Marker timestamp in seconds. */
  time: number;
  /** Optional display label. */
  label?: string;
}

/** Context lane configuration derived from a trace. */
export interface LaneState {
  /** Context identifier (e.g. `IDLE0`). */
  key: string;
  /** Display label for the lane. */
  label: string;
  /** Initial lane visibility. */
  visible: boolean;
  /** Execution-context classification. */
  type: ContextType;
  /** Lane group this context's lane belongs to. */
  role: ContextRole;
}

/** Analysis surface shown in the shell. One workspace is visible at a time. */
export type Workspace = "timeline" | "statistics";

/** Edge the Events/Logs dock is attached to. */
export type DockSide = "right" | "bottom";

/** List shown in the Events/Logs dock. `both` shows the two side by side. */
export type DockTab = "events" | "logs" | "both";

/**
 * Time range a list or table aggregates over.
 *
 * - `visible`: the timeline's visible window.
 * - `selection`: the interval spanned by the current event selection.
 * - `full`: the whole trace.
 */
export type Scope = "visible" | "selection" | "full";

/** Context types the Statistics table reports on. `all` reports every context. */
export type StatsType = "all" | ContextType;

/** Placement and contents of the Events/Logs dock. */
export interface DockState {
  side: DockSide;
  tab: DockTab;
  /** When true the dock is closed and the timeline uses the full width. */
  hidden: boolean;
}

/** Lane row heights offered by the Lanes panel's density control, in CSS px. */
export const LANE_DENSITIES = [16, 20, 24] as const;

/** Active event filter constraints. Empty fields apply no constraint. */
export interface Filters {
  /** Case-insensitive query substring matched against event and context names. */
  text: string;
  /**
   * Core identifiers switched off in the CPUs menu. When empty, every core is shown; when it holds
   * every core in the trace, nothing that belongs to a core is shown and only core-neutral lanes
   * such as data plots remain.
   */
  cores: Set<number>;
  /**
   * Set of hidden {@link EventClass} categories. When empty, all classes are visible.
   */
  classes: Set<EventClass>;
}

/** Shared application state object. */
export interface AppState {
  /** Currently loaded trace model, or `null` if no file is open. */
  model: TraceModel | null;
  /**
   * Loaded application ELF state, or `null` if absent. Carries across trace loads, until the trace is
   * cleared or a newly opened capture turns out not to be the build the ELF came from.
   */
  elf: ElfState | null;
  /** Source filenames of the loaded model. */
  sourceNames: string[];
  /** Non-fatal load or parse error message, or `null`. */
  loadError: string | null;
  /** Visible time window `[t0, t1]` in seconds, mirroring active {@link TimeScale} bounds. */
  view: { t0: number; t1: number };
  /** Full trace time domain `[start, end]` in seconds. */
  domain: { start: number; end: number };
  /** Cursor position in seconds, or `null` when unset. */
  cursorTime: number | null;
  /** Absolute index of the selected event, or `null`. */
  selectedEventIndex: number | null;
  /**
   * Anchor index for shift-extended event selections. When selecting a single event, equals {@link selectedEventIndex} or `null`.
   */
  selectionAnchorIndex: number | null;
  /** Context identifier of the focused execution context, or `null`. */
  selectedContext: string | null;
  /** Active event filters. */
  filters: Filters;
  /** Visible analysis surface. */
  workspace: Workspace;
  /** Events/Logs dock placement and contents. */
  dock: DockState;
  /** Range the Events and Logs lists cover. */
  listScope: Scope;
  /** When true the Events and Logs lists show only the selected context. */
  listContextOnly: boolean;
  /** Range the Statistics table aggregates over, independent of {@link listScope}. */
  statsScope: Scope;
  /** Context type the Statistics table is narrowed to, or `all`. */
  statsType: StatsType;
  /** Lane row height in CSS px, one of {@link LANE_DENSITIES}. */
  laneDensity: number;
  /** When true the capture overview strip is shown above the time ruler. */
  overview: boolean;
  /**
   * Lane group identifiers switched off by the toolbar's quick filters.
   *
   * Held apart from each lane's own `hidden` flag so that switching a group off and back on restores the individual choices made in the Lanes panel.
   */
  groupsOff: Set<string>;
  /** Reference markers in creation order. */
  references: ReferenceMarker[];
  /** Hierarchical lane layout configuration defining grouping, ordering, and visibility. */
  laneLayout: LaneLayout;
  /**
   * Timestamp resolution in seconds (`1 / sysFreq`), or 0 if uninitialized.
   */
  timeResolution: number;
}

/** Return the initial application state before file loading. */
export function initialState(): AppState {
  return {
    model: null,
    elf: null,
    sourceNames: [],
    loadError: null,
    view: { t0: 0, t1: 1 },
    domain: { start: 0, end: 1 },
    cursorTime: null,
    selectedEventIndex: null,
    selectionAnchorIndex: null,
    selectedContext: null,
    filters: { text: "", cores: new Set(), classes: new Set() },
    workspace: "timeline",
    dock: { side: "right", tab: "events", hidden: false },
    listScope: "visible",
    listContextOnly: false,
    statsScope: "visible",
    statsType: "all",
    laneDensity: 20,
    overview: true,
    groupsOff: new Set(),
    references: [],
    laneLayout: { version: LANE_LAYOUT_VERSION, roots: [] },
    timeResolution: 0,
  };
}

type Listener = (state: AppState, prev: AppState) => void;
type Patch = Partial<AppState> | ((s: AppState) => Partial<AppState>);

export class Store {
  private state: AppState;
  private readonly listeners = new Set<Listener>();

  constructor(initial: AppState = initialState()) {
    this.state = initial;
  }

  /** Return the current state object. Mutate via {@link set}. */
  get(): AppState {
    return this.state;
  }

  /**
   * Apply a shallow update to state and notify subscribers if any property changes under `Object.is`.
   */
  set(patch: Patch): void {
    const delta = typeof patch === "function" ? patch(this.state) : patch;
    let changed = false;
    for (const k of Object.keys(delta) as (keyof AppState)[]) {
      if (!Object.is(this.state[k], delta[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const prev = this.state;
    this.state = { ...this.state, ...delta };
    for (const fn of [...this.listeners]) fn(this.state, prev);
  }

  /** Subscribe to all state changes. Returns an unsubscribe function. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Subscribe to changes in the specified keys. Returns an unsubscribe function.
   */
  select<K extends keyof AppState>(keys: readonly K[], fn: (state: AppState) => void): () => void {
    return this.subscribe((state, prev) => {
      for (const k of keys) {
        if (!Object.is(state[k], prev[k])) {
          fn(state);
          return;
        }
      }
    });
  }
}
