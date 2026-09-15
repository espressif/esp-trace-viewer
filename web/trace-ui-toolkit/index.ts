/**
 * Public entry point for the trace UI toolkit.
 *
 * Re-exports public API components so applications can import from a single module. Modules may also be imported directly by relative path.
 */

export { followTail, type Window } from "./auto-scroll.js";
export {
  configureLayoutStorage,
  loadLayout,
  saveCollapsed,
  saveLayout,
  saveSplitterSize,
  type LayoutState,
} from "./layout-store.js";
export { RafScheduler, type Drawable } from "./raf-scheduler.js";
export { TimeScale, type TimeScaleInit } from "./time-scale.js";

export {
  bandAtContentY,
  clampLaneHeight,
  clampScrollTop,
  DEFAULT_LANE_METRICS,
  laneHeight,
  layoutBands,
  type BandLayout,
  type LaneBand,
  type LaneMetrics,
} from "./lanes/layout-engine.js";
export {
  addNode,
  allNodes,
  findNode,
  groupNodes,
  moveBefore,
  moveNode,
  removeNode,
  resetHeight,
  setCollapsed,
  setHeight,
  setLabel,
  setSource,
  showAll,
  toggleHidden,
  ungroup,
  uniqueId,
  type NodeLocation,
} from "./lanes/controller.js";
export { anyHidden, hiddenLaneCount } from "./lanes/selectors.js";
export {
  cloneLayout,
  FALLBACK_LANE_HEIGHT,
  isGroup,
  isLane,
  isLaneLayout,
  LANE_LAYOUT_VERSION,
  parseLayout,
  serializeLayout,
  type AutoPopulateRule,
  type LaneGroup,
  type LaneLayout,
  type LaneLeaf,
  type LaneNode,
  type LaneNodeId,
} from "./lanes/tree.js";

export { clear, el } from "./ui/dom.js";
export { Pane, PANE_LAYOUT_EVENT, type PaneOptions } from "./ui/pane.js";
export { split, type Orientation, type SplitOptions } from "./ui/splitter.js";
export { VirtualList, type VirtualListOptions } from "./ui/virtual-list.js";
