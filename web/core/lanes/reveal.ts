/**
 * Bringing one context's lane back on screen.
 *
 * The Statistics table never hides a row because the timeline is hiding the matching lane, so a click on a
 * Max run figure — which sends the reader to that run — has to undo whatever is currently keeping that lane
 * off the canvas: the lane's own `hidden` flag, a hidden group above it, the quick filter covering that
 * group, or the CPUs menu having switched off every core the context ran on.
 */

import { isGroup, type LaneLayout, type LaneNode, type LaneNodeId } from "../../trace-ui-toolkit/lanes/tree.js";
import type { Filters } from "../store.js";
import { TIMESPAN_LANE, type TimespanSource } from "./types.js";

/** The parts of the state a reveal rewrites. */
export interface RevealResult {
  laneLayout: LaneLayout;
  groupsOff: Set<string>;
  filters: Filters;
}

/** The nodes from a root down to `id` inclusive, or `null` when the tree has no such node. */
function pathTo(layout: LaneLayout, id: LaneNodeId): LaneNode[] | null {
  const walk = (nodes: readonly LaneNode[], trail: LaneNode[]): LaneNode[] | null => {
    for (const n of nodes) {
      const next = [...trail, n];
      if (n.id === id) return next;
      if (isGroup(n)) {
        const hit = walk(n.children, next);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(layout.roots, []);
}

/** Clears the hidden flag on every node in `ids`, reusing the layout when nothing was hidden. */
function unhide(layout: LaneLayout, ids: ReadonlySet<LaneNodeId>): LaneLayout {
  let changed = false;
  const clear = (n: LaneNode): LaneNode => {
    let next = n;
    if (isGroup(n)) {
      const children = n.children.map(clear);
      if (children.some((c, i) => c !== n.children[i])) next = { ...n, children };
    }
    if (ids.has(n.id) && next.hidden) {
      next = { ...next, hidden: false };
      changed = true;
    }
    return next;
  };
  const roots = layout.roots.map(clear);
  return changed ? { ...layout, roots } : layout;
}

/**
 * Everything that has to change for the lane showing `key` to be drawn, or `null` when the layout holds no
 * lane for that context. `cores` are the cores the context was recorded on; switching them back on is what
 * rescues a lane the CPUs menu emptied.
 */
export function revealContextLane(
  layout: LaneLayout,
  groupsOff: ReadonlySet<string>,
  filters: Filters,
  key: string,
  cores: readonly number[],
): RevealResult | null {
  const lane = findContextLane(layout, key);
  if (!lane) return null;
  const path = pathTo(layout, lane)!;

  const groups = new Set(groupsOff);
  for (const n of path) groups.delete(n.id);

  // A lane whose every core is switched off has nothing to draw, so switch its cores back on.
  const cs = new Set(filters.cores);
  if (cores.length && cores.every((c) => cs.has(c))) for (const c of cores) cs.delete(c);

  return {
    laneLayout: unhide(layout, new Set(path.map((n) => n.id))),
    groupsOff: groups,
    filters: cs.size === filters.cores.size ? filters : { ...filters, cores: cs },
  };
}

/** Identifier of the timespan lane showing context `key`, or `null` when the layout holds none. */
export function findContextLane(layout: LaneLayout, key: string): LaneNodeId | null {
  const walk = (nodes: readonly LaneNode[]): LaneNodeId | null => {
    for (const n of nodes) {
      if (isGroup(n)) {
        const hit = walk(n.children);
        if (hit) return hit;
      } else if (n.type === TIMESPAN_LANE) {
        const src = n.source as TimespanSource;
        if (src?.kind === "context" && src.key === key) return n.id;
      }
    }
    return null;
  };
  return walk(layout.roots);
}
