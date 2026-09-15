/**
 * Event classification mapping from a {@link TraceEvent} to its coarse class.
 *
 * The viewer groups events into six classes: APIs (OS and module calls), ISRs (interrupt and timer activity), Messages (formatted print log lines), System Events (metadata such as initialization and descriptors), Tasks (scheduling and lifecycle), and generic Events (user markers).
 *
 * This module defines the mapping table used across event filters, row coloring, and predicate filtering.
 */

import { EVTID, SYSVIEW_PREDEF_MAX } from "../../src/trace/events.js";
import type { TraceEvent } from "../../src/trace/index.js";

/** Event class categories in Event Filter menu order. */
export type EventClass = "api" | "isr" | "message" | "system" | "task" | "event";

/** All event classes in menu order. */
export const ALL_EVENT_CLASSES: readonly EventClass[] = [
  "api",
  "isr",
  "message",
  "system",
  "task",
  "event",
];

/** Display labels for each event class. */
export const EVENT_CLASS_LABELS: Readonly<Record<EventClass, string>> = {
  api: "APIs",
  isr: "ISRs",
  message: "Messages",
  system: "System Events",
  task: "Tasks",
  event: "Events",
};

/** Predefined event identifiers for interrupt and timer (ISR) activity. */
const ISR_EVENT_IDS: ReadonlySet<number> = new Set([
  EVTID.ISR_ENTER,
  EVTID.ISR_EXIT,
  EVTID.ISR_TO_SCHEDULER,
  EVTID.TIMER_ENTER,
  EVTID.TIMER_EXIT,
]);

/** Predefined event identifiers for task scheduling and lifecycle. */
const TASK_EVENT_IDS: ReadonlySet<number> = new Set([
  EVTID.TASK_START_EXEC,
  EVTID.TASK_STOP_EXEC,
  EVTID.TASK_START_READY,
  EVTID.TASK_STOP_READY,
  EVTID.TASK_CREATE,
  EVTID.TASK_INFO,
  EVTID.TASK_TERMINATE,
  EVTID.IDLE,
  EVTID.STACK_INFO,
]);

/** Predefined event identifiers for user markers. */
const MARKER_EVENT_IDS: ReadonlySet<number> = new Set([
  EVTID.MARK_START,
  EVTID.MARK_STOP,
]);

/**
 * Classify an event into one of six {@link EventClass} categories.
 *
 * OS and module events (identifiers above `SYSVIEW_PREDEF_MAX`) map to `api`. So does `svEndCall`, which marks the return from one of them. The predefined range partitions into interrupts (`isr`), formatted print logs (`message`), user markers (`event`), task scheduling (`task`), and metadata events (`system`).
 */
export function classifyEvent(e: TraceEvent): EventClass {
  if (e.id > SYSVIEW_PREDEF_MAX || e.id === EVTID.END_CALL) return "api";
  if (ISR_EVENT_IDS.has(e.id)) return "isr";
  if (e.id === EVTID.PRINT_FORMATTED) return "message";
  if (MARKER_EVENT_IDS.has(e.id)) return "event";
  if (TASK_EVENT_IDS.has(e.id)) return "task";
  return "system";
}
