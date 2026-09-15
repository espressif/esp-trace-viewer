/**
 * Layout persistence for splitter positions and pane collapse state in `localStorage`.
 *
 * Persists splitter fractions and pane collapsed flags as a versioned JSON payload. Splitter interaction and collapse toggling are implemented in {@link ./ui/splitter} and {@link ./ui/pane}.
 *
 * Panes and splitters invoke layout persistence functions directly using a shared `localStorage` key. Applications configure this key at startup using {@link configureLayoutStorage} to prevent key collisions between applications sharing an origin.
 */

/** Storage key for layout data, configurable via {@link configureLayoutStorage}. */
let layoutKey = "trace-ui.layout.v1";

/**
 * Configures the `localStorage` key used for layout persistence.
 * Call during application initialization before instantiating panes or splitters.
 * Subsequent calls change the target key for future writes without migrating existing data.
 */
export function configureLayoutStorage(opts: { key: string }): void {
  layoutKey = opts.key;
}

/** Value types a shell preference can hold. */
export type PrefValue = string | number | boolean;

export interface LayoutState {
  /** Map of splitter ID to primary pane size fraction in `[0.05, 0.95]`. */
  sizes: Record<string, number>;
  /** Map of pane ID to collapsed state boolean. */
  collapsed: Record<string, boolean>;
  /**
   * Shell preferences that outlive a reload but are not sizes or collapse flags, such as the dock edge, the active dock tab, or lane density.
   */
  prefs: Record<string, PrefValue>;
}

function emptyLayout(): LayoutState {
  return { sizes: {}, collapsed: {}, prefs: {} };
}

/** Loads persisted layout state, returning empty state if data is absent or invalid. */
export function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(layoutKey);
    if (!raw) return emptyLayout();
    const parsed = JSON.parse(raw) as Partial<LayoutState>;
    return {
      sizes: parsed.sizes && typeof parsed.sizes === "object" ? parsed.sizes : {},
      collapsed: parsed.collapsed && typeof parsed.collapsed === "object" ? parsed.collapsed : {},
      prefs: parsed.prefs && typeof parsed.prefs === "object" ? parsed.prefs : {},
    };
  } catch {
    return emptyLayout();
  }
}

/** Persists the complete layout state to `localStorage`. */
export function saveLayout(layout: LayoutState): void {
  try {
    localStorage.setItem(layoutKey, JSON.stringify(layout));
  } catch {
    /* Ignore write errors when storage is unavailable or quota is exceeded. */
  }
}

/** Updates and persists the size fraction for a splitter ID. */
export function saveSplitterSize(id: string, fraction: number): void {
  const layout = loadLayout();
  layout.sizes[id] = clampFraction(fraction);
  saveLayout(layout);
}

/** Reads a persisted shell preference, returning `fallback` when absent or of another type. */
export function loadPref<T extends PrefValue>(key: string, fallback: T): T {
  const v = loadLayout().prefs[key];
  return typeof v === typeof fallback ? (v as T) : fallback;
}

/** Updates and persists a shell preference. */
export function savePref(key: string, value: PrefValue): void {
  const layout = loadLayout();
  layout.prefs[key] = value;
  saveLayout(layout);
}

/** Updates and persists the collapsed state for a pane ID. */
export function saveCollapsed(id: string, collapsed: boolean): void {
  const layout = loadLayout();
  layout.collapsed[id] = collapsed;
  saveLayout(layout);
}

function clampFraction(f: number): number {
  return f < 0.05 ? 0.05 : f > 0.95 ? 0.95 : f;
}
