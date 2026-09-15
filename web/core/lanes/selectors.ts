/**
 * Read-only projections over a {@link LaneLayout} for context lane consumers.
 *
 * Derives context lane ordering and effective visibility for the CPU load histogram and Contexts table from the timeline lane tree. A lane is hidden if the lane itself or any ancestor group is hidden. Group collapse state is ignored.
 *
 * This projection reads application-specific {@link TimespanSource} configurations. Structure-only layout queries (`anyHidden` and `hiddenLaneCount`) are re-exported from {@link ../../trace-ui-toolkit/lanes/selectors}.
 */

import { isGroup, type LaneLayout, type LaneNode } from "../../trace-ui-toolkit/lanes/tree.js";
import { TIMESPAN_LANE, type TimespanSource } from "./types.js";

export { anyHidden, hiddenLaneCount, visibleLaneCounts, type LaneCounts } from "../../trace-ui-toolkit/lanes/selectors.js";

/** Context lane projection for CPU load and Contexts panes. */
export interface ContextLaneView {
  /** Node identifier for driving controller edits such as visibility toggles. */
  id: string;
  /** Execution-context identifier displayed by the lane. */
  key: string;
  /** Display label for the lane. */
  label: string;
  /** Effective visibility: true if the lane or any ancestor group is hidden. */
  hidden: boolean;
}

/** Collect `timespan` context lanes in tree order with effective visibility. */
export function contextLanes(layout: LaneLayout): ContextLaneView[] {
  const out: ContextLaneView[] = [];
  const walk = (nodes: readonly LaneNode[], ancestorHidden: boolean): void => {
    for (const n of nodes) {
      const hidden = ancestorHidden || !!n.hidden;
      if (isGroup(n)) {
        walk(n.children, hidden);
      } else if (n.type === TIMESPAN_LANE) {
        const s = n.source as TimespanSource;
        if (s?.kind === "context") out.push({ id: n.id, key: s.key, label: n.label ?? s.key, hidden });
      }
    }
  };
  walk(layout.roots, false);
  return out;
}
