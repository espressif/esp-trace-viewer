/**
 * Filter state transitions for the Event Filter menu.
 *
 * The store maintains {@link Filters} containing hidden event classes and hidden cores alongside the text constraint. These helpers provide immutable transitions to toggle classes and cores, isolate single classes, and reset all filter constraints.
 */

import { ALL_EVENT_CLASSES, type EventClass } from "./event-class.js";
import type { Filters } from "./store.js";

/** Return true if the specified event class is hidden by active filters. */
export function classHidden(filters: Filters, cls: EventClass): boolean {
  return filters.classes.has(cls);
}

/** Return true if the specified core is switched off in the CPU filter. */
export function coreHidden(filters: Filters, coreId: number): boolean {
  return filters.cores.has(coreId);
}

/** Switch a core off or back on, returning updated filter state. */
export function toggleCore(filters: Filters, coreId: number): Filters {
  const cores = new Set(filters.cores);
  if (cores.has(coreId)) cores.delete(coreId);
  else cores.add(coreId);
  return { ...filters, cores };
}

/** Return true if only the specified event class is visible. */
export function isSolo(filters: Filters, cls: EventClass): boolean {
  return filters.classes.size === ALL_EVENT_CLASSES.length - 1 && !filters.classes.has(cls);
}

/** Toggle visibility of an event class, returning updated filter state. */
export function toggleClass(filters: Filters, cls: EventClass): Filters {
  const classes = new Set(filters.classes);
  if (classes.has(cls)) classes.delete(cls);
  else classes.add(cls);
  return { ...filters, classes };
}

/**
 * Isolate visibility to `cls` by hiding all other classes.
 *
 * Calling this function on an already-isolated class restores visibility for all classes.
 */
export function soloClass(filters: Filters, cls: EventClass): Filters {
  if (isSolo(filters, cls)) return { ...filters, classes: new Set() };
  const classes = new Set(ALL_EVENT_CLASSES.filter((c) => c !== cls));
  return { ...filters, classes };
}

/** Reset all filter constraints (classes, text, and cores) to empty defaults, which constrain nothing. */
export function resetFilters(): Filters {
  return { text: "", cores: new Set(), classes: new Set() };
}
