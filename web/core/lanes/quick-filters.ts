/**
 * Lane group quick filters shown on the Timeline controls bar.
 *
 * Each quick filter switches one or more default lane groups on or off at once. The groups it covers are excluded from the drawn layout through `layoutBands`' suppression set rather than by setting each lane's `hidden` flag, so a filter switched off and back on leaves the individual choices made in the Lanes panel intact.
 *
 * A quick filter can cover more than one group: System covers both the scheduler spans near the top of the timeline and the idle lanes that sit below the tasks.
 */

import {
  CPULOAD_GROUP_ID,
  DATA_GROUP_ID,
  IDLE_GROUP_ID,
  INTERRUPTS_GROUP_ID,
  SYSTEM_GROUP_ID,
  TASKS_GROUP_ID,
} from "./default-layout.js";

/** A labelled control covering one or more lane groups. */
export interface QuickFilter {
  /** Stable key for test hooks and the control's `data-filter` attribute. */
  readonly key: string;
  /** Control text. */
  readonly label: string;
  /** Lane group node identifiers this control covers. */
  readonly groups: readonly string[];
}

/** Quick filters in the order they appear on the controls bar. */
export const QUICK_FILTERS: readonly QuickFilter[] = [
  { key: "system", label: "System", groups: [SYSTEM_GROUP_ID, IDLE_GROUP_ID] },
  { key: "interrupts", label: "Interrupts", groups: [INTERRUPTS_GROUP_ID] },
  { key: "tasks", label: "Tasks", groups: [TASKS_GROUP_ID] },
  { key: "cpuload", label: "CPU load", groups: [CPULOAD_GROUP_ID] },
  { key: "dataplots", label: "Data plots", groups: [DATA_GROUP_ID] },
];

/** True when none of a quick filter's groups are switched off. */
export function quickFilterOn(groupsOff: ReadonlySet<string>, f: QuickFilter): boolean {
  return !f.groups.some((g) => groupsOff.has(g));
}

/**
 * Switch a quick filter's groups off or back on, returning the updated suppression set.
 *
 * A filter that is partly off switches fully on, so one click always reaches a definite state.
 */
export function toggleQuickFilter(groupsOff: ReadonlySet<string>, f: QuickFilter): Set<string> {
  const next = new Set(groupsOff);
  if (quickFilterOn(groupsOff, f)) for (const g of f.groups) next.add(g);
  else for (const g of f.groups) next.delete(g);
  return next;
}
