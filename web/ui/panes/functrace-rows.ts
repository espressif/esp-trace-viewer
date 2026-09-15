/**
 * Function-trace flame-graph data model.
 *
 * This module reconstructs nested call frames from function instrumentation `function_enter` and `function_exit` events. Each enter event pushes a frame and corresponding exit events close it, producing a `[start, end)` interval at a specific nesting depth.
 *
 * Call stacks are maintained per execution context (task or IRQ name) across context switches and SMP core migrations. Open frames in a preempted task span the preemption interval in that context's lane.
 *
 * The model handles trace truncation: exit events without a matching open frame are discarded, and frames remaining open when the trace ends are closed at the domain boundary. When an exit function address differs from the top of the stack, all frames above and including the matching function are closed; unmatched exits are discarded.
 */

import {
  FUNC_TRACE_ENTER,
  FUNC_TRACE_EXIT,
  type TraceEvent,
} from "../../../src/trace/index.js";

/** One closed call frame: a flame-graph rectangle. */
export interface FuncFrame {
  /** Frame interval in seconds (trace time). */
  start: number;
  end: number;
  /** Nesting depth (0 = outermost instrumented call). */
  depth: number;
  /** Instrumented function's address (the `func` param). */
  func: number;
  /** Call-site address of the enter (the `call_site` param). */
  callSite: number;
  /** Absolute index of the `function_enter` event in `model.events`. */
  eventIndex: number;
}

/** Per-context flame-graph frames for a loaded model. */
export interface FuncTraceData {
  /** Closed frames grouped by execution context name, sorted by start time. */
  framesByContext: Map<string, FuncFrame[]>;
  /** Maximum nesting depth observed per context (0-based). */
  maxDepthByContext: Map<string, number>;
}

/** Returns context names containing function frames, ordered by first occurrence. */
export function funcTraceContexts(data: FuncTraceData): string[] {
  return [...data.framesByContext.keys()];
}

/** Returns true if an event is a function instrumentation enter or exit event. */
export function isFuncTraceEvent(e: TraceEvent): boolean {
  return e.name === FUNC_TRACE_ENTER || e.name === FUNC_TRACE_EXIT;
}

/** Open call frame awaiting an exit event. */
interface OpenFrame {
  start: number;
  func: number;
  callSite: number;
  eventIndex: number;
}

/**
 * Builds per-context call frames from the chronological event stream. Frames open at the end of the trace close at `domainEnd`.
 */
export function buildFuncTraceData(
  events: readonly TraceEvent[],
  domainEnd: number,
): FuncTraceData {
  const stacks = new Map<string, OpenFrame[]>();
  const framesByContext = new Map<string, FuncFrame[]>();
  const maxDepthByContext = new Map<string, number>();

  const close = (ctx: string, stack: OpenFrame[], depth: number, end: number): void => {
    const open = stack[depth]!;
    let frames = framesByContext.get(ctx);
    if (!frames) {
      frames = [];
      framesByContext.set(ctx, frames);
    }
    frames.push({
      start: open.start,
      end,
      depth,
      func: open.func,
      callSite: open.callSite,
      eventIndex: open.eventIndex,
    });
    if (depth > (maxDepthByContext.get(ctx) ?? -1)) maxDepthByContext.set(ctx, depth);
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.name === FUNC_TRACE_ENTER) {
      const func = e.params["func"];
      if (typeof func !== "number") continue;
      let stack = stacks.get(e.ctxName);
      if (!stack) {
        stack = [];
        stacks.set(e.ctxName, stack);
        // Register context on first enter to preserve map ordering.
        if (!framesByContext.has(e.ctxName)) framesByContext.set(e.ctxName, []);
      }
      stack.push({
        start: e.ts,
        func: func >>> 0,
        callSite: typeof e.params["call_site"] === "number" ? (e.params["call_site"] as number) >>> 0 : 0,
        eventIndex: i,
      });
    } else if (e.name === FUNC_TRACE_EXIT) {
      const func = e.params["func"];
      if (typeof func !== "number") continue;
      const stack = stacks.get(e.ctxName);
      if (!stack?.length) continue; // Exit predates capture start.
      // Find matching frame from the top of the stack. An address mismatch closes all intermediate frames.
      let at = -1;
      for (let d = stack.length - 1; d >= 0; d--) {
        if (stack[d]!.func === (func >>> 0)) {
          at = d;
          break;
        }
      }
      if (at < 0) continue; // Unmatched exit event.
      for (let d = stack.length - 1; d >= at; d--) close(e.ctxName, stack, d, e.ts);
      stack.length = at;
    }
  }

  // Close remaining open frames at the trace domain boundary.
  for (const [ctx, stack] of stacks) {
    for (let d = stack.length - 1; d >= 0; d--) close(ctx, stack, d, domainEnd);
  }

  // Sort frames chronologically by start time and depth.
  for (const frames of framesByContext.values()) {
    frames.sort((a, b) => a.start - b.start || a.depth - b.depth);
  }

  return { framesByContext, maxDepthByContext };
}

/**
 * Returns the frame covering time `t` at nesting `depth` in `frames`, or `null` if none match.
 */
export function frameAt(frames: readonly FuncFrame[], t: number, depth: number): FuncFrame | null {
  for (const f of frames) {
    if (f.start > t) break;
    if (f.depth === depth && t < f.end) return f;
  }
  return null;
}

/**
 * Returns the open call stack at time `t`, ordered from outermost to innermost frame.
 */
export function stackAtTime(frames: readonly FuncFrame[], t: number): FuncFrame[] {
  const out: FuncFrame[] = [];
  for (const f of frames) {
    if (f.start > t) break;
    if (t < f.end) out[f.depth] = f;
  }
  return out.filter((f) => f !== undefined);
}
