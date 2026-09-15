/**
 * Lane type registry for pluggable timeline lane types.
 *
 * Each lane type registers a {@link LaneTypeDef} specifying its default height, configuration summary, and rendering/hit-testing hooks. The timeline host looks up lane definitions per band and delegates rendering and hit-testing operations.
 *
 * The underlying data model in {@link ./types} remains decoupled from the registry as pure JSON data.
 */

import type { TraceModel } from "../../../src/trace/index.js";
import type { EventClass } from "../event-class.js";
import type { TimeScale } from "../../trace-ui-toolkit/time-scale.js";
import { DEFAULT_LANE_HEIGHTS, FALLBACK_LANE_HEIGHT, type LaneLeaf } from "./types.js";
import type { LaneMetrics } from "../../trace-ui-toolkit/lanes/layout-engine.js";

/**
 * Canvas rendering context for a lane band along the shared time axis.
 *
 * The host clips rendering to `[top, top + height)` and applies the shared time-to-pixel scale. The plot area occupies `[gutterWidth, widthPx]`.
 */
export interface LaneRenderContext {
  readonly ctx: CanvasRenderingContext2D;
  /** Top offset of the band in CSS pixels within canvas coordinates. */
  readonly top: number;
  /** Band height in CSS pixels. */
  readonly height: number;
  /** Left gutter width reserved for lane labels and controls. */
  readonly gutterWidth: number;
  /** Canvas width in CSS pixels. */
  readonly widthPx: number;
  /** Shared time scale defining visible window and time-to-pixel coordinate mapping. */
  readonly timeScale: TimeScale;
  /** Event classes hidden by active filters. */
  readonly hiddenClasses: ReadonlySet<EventClass>;
  /**
   * Cores switched off in the CPUs menu. A lane left with no visible core at all is dropped from the layout
   * before it reaches this point; what remains here is a lane that still has runs on a visible core and has
   * to leave out the runs that belong to a switched-off one.
   */
  readonly hiddenCores: ReadonlySet<number>;
  /**
   * Cursor timestamp in seconds, or `null` when unset. The host renders the cursor line; lanes render type-specific cursor indicators.
   */
  readonly cursorTime: number | null;
}

/**
 * Element under the pointer inside a lane band for hit-testing and selection.
 *
 * {@link kind} indicates the element category defined by the lane (`mark`, `span`, or `ready`). Optional {@link title} and {@link lines} supply custom tooltip content; omitting them falls back to default host tooltips built from {@link eventIndex} and time range.
 */
export interface LaneTarget {
  /** Element category defined by the lane. */
  readonly kind: string;
  /** Event index in `model.events`. Selection navigates to this index. */
  readonly eventIndex: number;
  /** Span start timestamp in seconds, or undefined for point events. */
  readonly start?: number;
  readonly end?: number;
  /** Execution-context key for elements associated with a context. */
  readonly key?: string;
  /** True if the element executed within an interrupt service routine. */
  readonly isr?: boolean;
  /** Tooltip title heading supplied by the lane. */
  readonly title?: string;
  /** Detailed tooltip lines displayed below {@link title}. */
  readonly lines?: readonly string[];
}

/**
 * Definition interface for a timeline lane type.
 *
 * `S` represents the lane source configuration type; `B` represents cached per-model data passed to render and hit-test hooks.
 */
export interface LaneTypeDef<S = unknown, B = unknown> {
  /** Registry type identifier matched against {@link LaneLeaf.type}. */
  readonly type: string;
  /** Display name for the lane type in configuration menus. */
  readonly displayName: string;
  /** Default band height in CSS pixels when no explicit height is set. */
  readonly defaultHeight: number;
  /**
   * Compute default band height for a specific lane source and trace model.
   *
   * Accommodates dynamic sizing such as call stack depth. Falls back to {@link defaultHeight} when undefined or when no model exists.
   */
  defaultHeightFor?(source: S, model: TraceModel): number | null;
  /** Summarize lane source configuration for the configuration panel. */
  describe(source: S, model: TraceModel | null): string;
  /**
   * Enumerate available sources for creating new lanes of this type from the active model.
   */
  sourceOptions?(model: TraceModel): { source: S; label: string }[];
  /**
   * Accent color for the gutter swatch, or `null` to use host default styling.
   */
  accentColor?(source: S): string | null;
  /** Derive cached per-model data for a lane from shared trace structures. */
  build?(model: TraceModel, source: S): B;
  /** Render lane content within its band. */
  draw?(rc: LaneRenderContext, built: B, source: S): void;
  /** Render lane left-gutter labels and controls. */
  drawGutter?(rc: LaneRenderContext, built: B, source: S): void;
  /** Map band coordinates `(x, y)` to the element under the pointer, or return `null`. */
  hitTest?(x: number, y: number, rc: LaneRenderContext, built: B, source: S): LaneTarget | null;
  /**
   * Tooltip lines displayed near the cursor in this band, such as series values at {@link LaneRenderContext.cursorTime}. Returns `null` if unavailable.
   */
  cursorReadout?(rc: LaneRenderContext, built: B, source: S): readonly string[] | null;
  /**
   * Candidate timestamps in ascending order for snapping cursor clicks in this lane, or `null` to use all trace events.
   */
  snapTimes?(built: B, source: S): readonly number[] | null;
}

/** Registry of {@link LaneTypeDef} definitions keyed by type identifier. */
export class LaneRegistry {
  private readonly defs = new Map<string, LaneTypeDef>();

  /** Register a lane type definition. Replaces existing registration with the same type identifier. */
  register<S, B>(def: LaneTypeDef<S, B>): void {
    this.defs.set(def.type, def as unknown as LaneTypeDef);
  }

  /** Retrieve definition for a type identifier, or `undefined` if unregistered. */
  get(type: string): LaneTypeDef | undefined {
    return this.defs.get(type);
  }

  /** Return true if a type identifier is registered. */
  has(type: string): boolean {
    return this.defs.has(type);
  }

  /** Return all registered definitions in registration order. */
  all(): LaneTypeDef[] {
    return [...this.defs.values()];
  }

  /** Return default height for a lane type. */
  defaultHeight(type: string): number {
    return this.get(type)?.defaultHeight ?? DEFAULT_LANE_HEIGHTS[type] ?? FALLBACK_LANE_HEIGHT;
  }

  /**
   * Return the height a lane node's own source asks for, or `null` when it has no opinion and the type default applies.
   *
   * An expanded function-trace lane sizes itself from its call depth, for instance, which no per-type setting can stand in for.
   */
  sourceHeightForNode(node: LaneLeaf, model: TraceModel | null): number | null {
    return (model ? this.get(node.type)?.defaultHeightFor?.(node.source, model) : null) ?? null;
  }

  /** Return default height for a specific lane node based on source and trace content. */
  defaultHeightForNode(node: LaneLeaf, model: TraceModel | null): number {
    return this.sourceHeightForNode(node, model) ?? this.defaultHeight(node.type);
  }
}

/**
 * Build {@link LaneMetrics} for the layout engine, resolving default lane heights from `registry`.
 *
 * `overrides` configures group header and minimum lane heights. `model` evaluates dynamically on each layout pass to reflect the active trace model.
 */
export function laneMetrics(
  registry: LaneRegistry,
  overrides: Partial<Omit<LaneMetrics, "defaultHeight">> = {},
  model: () => TraceModel | null = () => null,
): LaneMetrics {
  return {
    groupHeaderHeight: overrides.groupHeaderHeight ?? 18,
    minLaneHeight: overrides.minLaneHeight ?? 14,
    defaultHeight: (node: LaneLeaf) => registry.defaultHeightForNode(node, model()),
  };
}
