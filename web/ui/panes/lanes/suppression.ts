/**
 * The set of lanes the timeline leaves out of the drawn layout.
 *
 * Two transient controls suppress lanes without touching the `hidden` flags the Lanes panel owns: the quick
 * filters on the controls bar, which switch whole groups off, and the CPUs menu, which empties any lane whose
 * every core is switched off. Both feed `layoutBands`' suppression set, so the individual choices made in the
 * Lanes panel survive a round trip through either control.
 *
 * The timeline, the status bar's lane count and the Lanes panel's count all read this, so what the counts
 * claim and what the canvas draws stay the same.
 */

import { coreSuppressedLanes } from "../../../core/lanes/core-filter.js";
import type { AppState } from "../../../core/store.js";
import { timelineDataFor } from "./timespan-lane.js";

/** Node identifiers of the lanes and groups the timeline is not drawing. */
export function suppressedLanes(s: AppState): ReadonlySet<string> {
  if (!s.model || s.filters.cores.size === 0) return s.groupsOff;
  const data = timelineDataFor(s.model);
  const off = coreSuppressedLanes(s.laneLayout, s.filters.cores, {
    all: data.cores,
    cores: (key) => data.coresByContext.get(key) ?? [],
  });
  for (const g of s.groupsOff) off.add(g);
  return off;
}
