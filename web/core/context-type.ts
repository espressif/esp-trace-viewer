/**
 * Canonical execution-context classification and timeline priority order.
 *
 * The trace format distinguishes four kinds of execution context: ISR, Scheduler, Task, and Idle. The timeline stacks them in priority order (interrupts at the top, idle at the bottom), with tasks ranked by scheduling priority. This module provides context classification ({@link classifyContext}) and stacking ranks ({@link CONTEXT_TYPE_ORDER}) used across the timeline and Contexts table.
 *
 * Trace events identify contexts directly:
 * - ISR: Contexts marked with `inIrq` or synthetic IRQ names.
 * - Idle: FreeRTOS and embOS idle contexts matching `IDLE0` or `IDLE1`.
 * - Task: Contexts executing application tasks, ordered by priority reported in `svTaskInfo`.
 * - Scheduler: Synthetic per-core `Scheduler<core>` spans representing scheduler execution during context switches between ISR handoff or task blocking and the next task activation.
 *
 * See {@link ../../src/trace/processor}.
 */

/** Execution-context classifications displayed in the Contexts table. */
export type ContextType = "Task" | "ISR" | "Scheduler" | "Idle";

/**
 * Stacking rank for execution-context types on the timeline. Lower numbers sort first.
 *
 * Interrupts sort first, followed by scheduler spans, tasks, and idle contexts.
 */
export const CONTEXT_TYPE_ORDER: Readonly<Record<ContextType, number>> = {
  ISR: 0,
  Scheduler: 1,
  Task: 2,
  Idle: 3,
};

/**
 * Classify an execution context from its name and interrupt flag.
 *
 * Matches `IDLE*` as Idle, synthetic `Scheduler*` spans as Scheduler, IRQ execution as ISR, and remaining contexts as Task.
 */
export function classifyContext(key: string, isr: boolean): ContextType {
  if (/^idle/i.test(key)) return "Idle";
  if (/^scheduler/i.test(key)) return "Scheduler";
  if (isr || /^(irq|isr)/i.test(key)) return "ISR";
  return "Task";
}
