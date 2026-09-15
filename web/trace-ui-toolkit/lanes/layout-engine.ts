/**
 * Lane layout engine.
 *
 * Flattens a {@link LaneLayout} tree into vertically stacked drawing bands and calculates vertical scroll bounds and hit tests.
 *
 * Each band represents either a group header or a lane in content pixel space. The layout excludes hidden subtrees and children of collapsed groups. Lane heights use explicit overrides or type defaults clamped to minimum height bounds.
 *
 * A group can announce itself in one of two ways. With a non-zero {@link LaneMetrics.groupHeaderHeight} it takes a header band of its own. With a height of zero it takes no row at all: its label rides along on the first lane band underneath it, which spends the vertical space on data instead of on a caption.
 */

import { isGroup, type LaneLayout, type LaneLeaf, type LaneNode, type LaneNodeId } from "./tree.js";

/** Layout band positioned in content pixel space before ruler offset and vertical scroll are applied. */
export interface LaneBand {
  /** Identifier of the layout node corresponding to this band. */
  readonly id: LaneNodeId;
  /** Reference to the layout node in the tree. */
  readonly node: LaneNode;
  /** Distinguishes group headers from drawable lane bands. */
  readonly kind: "group-header" | "lane";
  /** Tree hierarchy depth (0 for root nodes), used for gutter indentation. */
  readonly depth: number;
  /** Vertical start offset in content pixels (0 at top of lane content). */
  readonly top: number;
  /** Band height in CSS pixels. */
  readonly height: number;
  /**
   * Label of the group this band opens, when group labels ride on their first lane rather than taking a header row. Absent on every other band.
   */
  readonly groupLabel?: string;
  /** Identifier of the group {@link groupLabel} belongs to. */
  readonly groupId?: LaneNodeId;
}

/** Sizing parameters for lane layout calculations: header height, minimum lane height, and default height resolver. */
export interface LaneMetrics {
  /** Height of a group header row in CSS pixels. Zero puts each group's label on its first lane instead. */
  readonly groupHeaderHeight: number;
  /** Minimum allowed lane height in CSS pixels. */
  readonly minLaneHeight: number;
  /** Function returning the default height for lanes without an explicit height override. */
  readonly defaultHeight: (node: LaneLeaf) => number;
}

/** Default sizing parameters used for fallback layout and tests. */
export const DEFAULT_LANE_METRICS: LaneMetrics = {
  groupHeaderHeight: 18,
  minLaneHeight: 14,
  defaultHeight: () => 22,
};

/** Computes the height of a lane using explicit overrides or type defaults, bounded below by minLaneHeight. */
export function laneHeight(node: LaneLeaf, m: LaneMetrics = DEFAULT_LANE_METRICS): number {
  return Math.max(m.minLaneHeight, node.height ?? m.defaultHeight(node));
}

/** Clamps and rounds a requested lane height to the minimum allowed height. */
export function clampLaneHeight(height: number, m: LaneMetrics = DEFAULT_LANE_METRICS): number {
  return Math.max(m.minLaneHeight, Math.round(height));
}

/** Layout result containing stacked bands and total content height. */
export interface BandLayout {
  /** Ordered visible bands with hidden subtrees and collapsed group children excluded. */
  readonly bands: readonly LaneBand[];
  /** Total height of all stacked bands in CSS pixels. */
  readonly contentHeight: number;
}

/**
 * Flattens a {@link LaneLayout} into vertically stacked {@link LaneBand} items.
 *
 * Node order matches tree hierarchy. Hidden nodes and their subtrees are excluded.
 * Collapsed groups include headers but exclude children.
 * Heights are determined by {@link laneHeight} and {@link LaneMetrics.groupHeaderHeight}.
 *
 * `suppressed` excludes further subtrees by node id without touching their `hidden` flags, which lets a transient control such as a quick filter switch a whole group off and back on while the per-lane choices underneath it survive.
 */
export function layoutBands(
  layout: LaneLayout,
  m: LaneMetrics = DEFAULT_LANE_METRICS,
  suppressed: ReadonlySet<LaneNodeId> = new Set(),
): BandLayout {
  const bands: LaneBand[] = [];
  let top = 0;

  const inlineLabels = m.groupHeaderHeight === 0;
  // Label the next lane band emitted, when a group has just opened and takes no header row of its own.
  let pending: { id: LaneNodeId; label: string } | null = null;

  const walk = (nodes: readonly LaneNode[], depth: number): void => {
    for (const node of nodes) {
      if (node.hidden || suppressed.has(node.id)) continue;
      if (isGroup(node)) {
        if (inlineLabels) {
          // An empty or collapsed group has no lane to carry its label, so it goes unannounced rather than claiming a row.
          if (!node.collapsed) {
            pending = { id: node.id, label: node.label };
            walk(node.children, depth + 1);
            pending = null;
          }
          continue;
        }
        bands.push({ id: node.id, node, kind: "group-header", depth, top, height: m.groupHeaderHeight });
        top += m.groupHeaderHeight;
        if (!node.collapsed) walk(node.children, depth + 1);
      } else {
        const height = laneHeight(node, m);
        bands.push({
          id: node.id,
          node,
          kind: "lane",
          depth,
          top,
          height,
          ...(pending ? { groupLabel: pending.label, groupId: pending.id } : {}),
        });
        pending = null;
        top += height;
      }
    }
  };

  walk(layout.roots, 0);
  return { bands, contentHeight: top };
}

/**
 * Clamps a vertical scroll offset to valid bounds `[0, max]`, preventing overscroll beyond content boundaries.
 */
export function clampScrollTop(scrollTop: number, contentHeight: number, viewportHeight: number): number {
  return Math.max(0, Math.min(scrollTop, Math.max(0, contentHeight - viewportHeight)));
}

/**
 * Finds the band containing the specified content-space y-coordinate (top inclusive, bottom exclusive).
 * Returns null if the coordinate lies outside all bands.
 */
export function bandAtContentY(bands: readonly LaneBand[], cy: number): LaneBand | null {
  for (const b of bands) {
    if (cy >= b.top && cy < b.top + b.height) return b;
  }
  return null;
}
