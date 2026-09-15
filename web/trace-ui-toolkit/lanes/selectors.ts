/**
 * Read-only queries over a {@link LaneLayout} based on tree structure.
 *
 * A lane is considered hidden when the lane itself or any ancestor group is marked hidden. Group collapse state is ignored. Projections that inspect {@link LaneLeaf.source} are implemented by the application.
 */

import { isGroup, isLane, type LaneLayout, type LaneNode } from "./tree.js";

/** Returns true if any node in the layout tree is marked hidden. */
export function anyHidden(layout: LaneLayout): boolean {
  const walk = (nodes: readonly LaneNode[]): boolean =>
    nodes.some((n) => n.hidden || (isGroup(n) && walk(n.children)));
  return walk(layout.roots);
}

/** Returns the number of leaf lanes hidden directly or via an ancestor group. */
export function hiddenLaneCount(layout: LaneLayout): number {
  let n = 0;
  const walk = (nodes: readonly LaneNode[], ancestorHidden: boolean): void => {
    for (const node of nodes) {
      const hidden = ancestorHidden || !!node.hidden;
      if (isGroup(node)) walk(node.children, hidden);
      else if (isLane(node) && hidden) n++;
    }
  };
  walk(layout.roots, false);
  return n;
}

/** How many leaf lanes are drawn, against how many the layout holds. */
export interface LaneCounts {
  /** Lanes neither hidden nor inside a suppressed group. */
  shown: number;
  /** Every leaf lane in the layout. */
  total: number;
}

/**
 * Count the lanes the timeline is drawing.
 *
 * `suppressed` names group nodes switched off by a transient control such as a quick filter; their lanes count towards the total but not towards what is shown, the same way `layoutBands` treats them.
 */
export function visibleLaneCounts(
  layout: LaneLayout,
  suppressed: ReadonlySet<string> = new Set(),
): LaneCounts {
  let shown = 0;
  let total = 0;
  const walk = (nodes: readonly LaneNode[], off: boolean): void => {
    for (const node of nodes) {
      const nodeOff = off || !!node.hidden || suppressed.has(node.id);
      if (isGroup(node)) walk(node.children, nodeOff);
      else if (isLane(node)) {
        total++;
        if (!nodeOff) shown++;
      }
    }
  };
  walk(layout.roots, false);
  return { shown, total };
}
