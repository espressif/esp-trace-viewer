/**
 * Shared {@link LaneRegistry} used across the timeline and configuration panes.
 *
 * The registry provides the central registration point for lane types. The application constructs a single instance and passes it through {@link ../../panes/types.PaneContext} to enable lane rendering and lane configuration.
 */

import { LaneRegistry } from "../../../core/lanes/registry.js";
import { cpuLoadLaneType } from "./cpuload-lane.js";
import { dataPlotLaneType } from "./dataplot-lane.js";
import { funcTraceLaneType } from "./functrace-lane.js";
import { timespanLaneType } from "./timespan-lane.js";

/** Creates the shared registry populated with all built-in lane types. */
export function createLaneRegistry(): LaneRegistry {
  const registry = new LaneRegistry();
  registry.register(timespanLaneType);
  registry.register(cpuLoadLaneType);
  registry.register(dataPlotLaneType);
  registry.register(funcTraceLaneType);
  return registry;
}
