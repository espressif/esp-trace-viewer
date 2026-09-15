/**
 * Which lane group an execution context belongs to.
 *
 * {@link ../context-type.ContextType} says what a context *is* — a task, an ISR, the scheduler, the idle loop. The role says where its lane belongs on the timeline, which is not the same question: the tick interrupt and the inter-core doorbells are ISRs, but they are the OS ticking over rather than the application's own work, so they read better grouped with the scheduler spans than in among the peripheral interrupts a user is looking for.
 *
 * The name patterns below are the ESP-IDF FreeRTOS ones. They are a heuristic, not a contract: Zephyr names these differently, and a chip without a SYSTIMER has no `SYSTIMER_TARGET*` at all. Anything unmatched falls back to its {@link ContextType}, so an unrecognised name lands in Interrupts and stays visible either way. See the note in `TODO.md` about giving the OS registry a say in this.
 */

import type { ContextType } from "../context-type.js";

/** Lane group an execution context's lane belongs to. */
export type ContextRole = "system" | "interrupt" | "task" | "idle";

/**
 * Interrupt names that belong to the OS rather than to the application.
 *
 * - `SysTick`: the FreeRTOS tick.
 * - `SYSTIMER_TARGET<n>`: the systimer alarms IDF drives the tick and esp_timer from.
 * - `CPU_FROM_CPU_<n>`: the inter-core doorbells behind IPC and cross-core scheduling.
 */
const SYSTEM_ISR_PATTERNS: readonly RegExp[] = [
  /^SysTick$/i,
  /^SYSTIMER_TARGET\d+$/i,
  /^CPU_FROM_CPU_\d+$/i,
];

/** True when an interrupt is part of the OS's own machinery. */
export function isSystemIsr(key: string): boolean {
  return SYSTEM_ISR_PATTERNS.some((re) => re.test(key));
}

/** Resolve the lane group a context belongs to from its name and classification. */
export function contextRole(key: string, type: ContextType): ContextRole {
  if (type === "Scheduler") return "system";
  if (type === "Idle") return "idle";
  if (type === "ISR") return isSystemIsr(key) ? "system" : "interrupt";
  return "task";
}
