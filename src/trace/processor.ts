/**
 * Multi-core timeline merge and execution-context tracking for parsed traces.
 *
 * Merges per-core event streams into a unified timeline sorted by timestamp
 * (core 0 preceding core 1 on timestamp ties), tracks active task and IRQ execution
 * contexts per core, and tags events with their context name (`ctxName`) and IRQ flag (`inIrq`).
 * Events occurring before context identification are buffered and attributed to the
 * preceding context once identified.
 *
 * Context tracking differences compared to `sysviewtrace_proc.py`:
 * 1. `svIdle` handling: ESP-IDF FreeRTOS signals idle state with an `IDLE` event without
 *    emitting `TASK_START_EXEC` or `TASK_STOP_*`. This implementation transitions to a
 *    synthesized `IDLE<core>` context.
 * 2. Scheduler tracking: When an ISR yields to the scheduler (`ISR_TO_SCHEDULER`) or a
 *    task suspends or blocks (`TASK_STOP_READY`/`TASK_STOP_EXEC`), this implementation
 *    tracks execution under a synthesized `Scheduler<core>` context until the next task
 *    starts or the core enters idle.
 * 3. Overflow handling: an `svOverflow` packet means the target dropped events because
 *    its trace buffer was full, so the context on that core is no longer known. This
 *    implementation resets the core to the "context unknown" state it has at trace
 *    start, records the lost interval as a {@link TraceGap}, and tags the overflow event
 *    itself with no context. The reference script decodes the packet as an ordinary event.
 */

import type { ElfSymbols } from "../elf/index.js";
import { EVTID, FUNC_TRACE_ENTER, FUNC_TRACE_EXIT } from "./events.js";
import { TraceEvent, TraceParseError, CoreTrace } from "./parser.js";

/** Execution context entry representing a task, IRQ, or synthetic state. */
interface Context {
  /** Task ID or IRQ number; `null` for synthetic IDLE or unknown contexts. */
  handle: number | null;
  /** True for IRQ contexts; false for task and synthetic contexts. */
  irq: boolean;
  /** Context name. */
  name: string;
}

/** Options for {@link processTraces}. */
export interface ProcessOptions {
  /**
   * When true, throws {@link TraceParseError} on context switches referencing
   * unknown task or IRQ identifiers. When false (default), synthesizes fallback names.
   */
  strict?: boolean;
  /**
   * ELF symbol and string lookup table for the loaded application image.
   * Stored in {@link TraceModel.elf} for address symbolization and string resolution.
   */
  elf?: ElfSymbols;
}

/**
 * Interval on one core during which the target dropped events because its trace
 * buffer was full, reported by an `svOverflow` packet.
 *
 * The target stamps the overflow packet relative to the last packet it managed to send,
 * so timestamps on either side of the gap stay correct; only the events in between are
 * missing. Nothing is known about what ran on the core during the gap.
 */
export interface TraceGap {
  /** Core the events were lost on. */
  coreId: number;
  /**
   * Start of the lost interval, in seconds on the merged timebase: the timestamp of the
   * last decoded event on the core before the overflow, or `end` when the overflow is
   * the first event on the core.
   */
  start: number;
  /** End of the lost interval, in seconds: the timestamp of the `svOverflow` event. */
  end: number;
  /** Index of the `svOverflow` event in {@link TraceModel.events}. */
  eventIndex: number;
  /**
   * Raw `drop_cnt` value from the packet. The target never resets its drop counter, so
   * this is cumulative over the capture. The ESP-IDF port keeps one counter for all
   * cores, so after a buffer-full episode every core reports an overflow with the same
   * value, and gaps on different cores with equal `dropCount` describe the same loss.
   */
  dropCount: number;
  /**
   * Events lost in the episode this gap belongs to: `dropCount` minus the last
   * different `dropCount` reported by any core, or the raw value for the first overflow
   * in the capture. Gaps sharing a `dropCount` share this value rather than each
   * claiming it. A `dropCount` lower than the previous one is taken as a counter reset
   * and used as is.
   */
  lost: number;
}

/** Unified multi-core trace model with context annotations. */
export interface TraceModel {
  /** Per-core traces included in the merge. */
  traces: CoreTrace[];
  /** Merged events sorted by timestamp and annotated with execution context. */
  events: TraceEvent[];
  /** Intervals where the target dropped events, sorted by `start` and then `coreId`. */
  gaps: TraceGap[];
  /** Symbol and string resolver for the loaded ELF image, when provided. */
  elf?: ElfSymbols;
}

/**
 * Returns the application ELF SHA-256 digest embedded in the trace (`ELF_SHA256=...`),
 * or `null` if omitted by all cores.
 */
export function traceElfSha256(model: TraceModel): string | null {
  return model.traces.find((t) => t.elfSha256)?.elfSha256 ?? null;
}

function idle(coreId: number): Context {
  return { handle: null, irq: false, name: `IDLE${coreId}` };
}

function scheduler(coreId: number): Context {
  return { handle: null, irq: false, name: `Scheduler${coreId}` };
}

class Processor {
  private readonly traces = new Map<number, CoreTrace>();
  private readonly ctxStack = new Map<number, Context[]>();
  private readonly prevCtx = new Map<number, Context | null>();
  /** Tracks whether the scheduler context is currently active per core. */
  private readonly inScheduler = new Map<number, boolean>();
  /**
   * Per core, indices into `out` of events emitted while the core's context was unknown.
   * They are back-filled once the core establishes a context.
   */
  private readonly pending = new Map<number, number[]>();
  /** Timestamp of the last event emitted per core, for the start of a gap. */
  private readonly lastTs = new Map<number, number>();
  /** Cumulative `drop_cnt` of the last overflow packet seen on any core, and the loss it reported. */
  private lastDrop: { count: number; lost: number } | null = null;
  private readonly out: TraceEvent[] = [];
  private readonly gaps: TraceGap[] = [];
  private readonly strict: boolean;

  constructor(traces: CoreTrace[], strict: boolean) {
    this.strict = strict;
    for (const t of traces) {
      this.traces.set(t.coreId, t);
      this.ctxStack.set(t.coreId, []);
      this.prevCtx.set(t.coreId, null);
      this.inScheduler.set(t.coreId, false);
      this.pending.set(t.coreId, []);
    }
  }

  private currContext(coreId: number): Context | null {
    const stack = this.ctxStack.get(coreId)!;
    if (stack.length) return stack[stack.length - 1]!;
    // When the execution stack is empty, return the scheduler or idle context.
    if (this.inScheduler.get(coreId)) return scheduler(coreId);
    if (this.prevCtx.get(coreId)) return idle(coreId);
    return null;
  }

  /**
   * Fallback context when the core execution stack is empty: returns the scheduler
   * context if a transition is in progress, otherwise the idle context.
   */
  private restingCtx(coreId: number): Context {
    return this.inScheduler.get(coreId) ? scheduler(coreId) : idle(coreId);
  }

  /** Updates per-core context state in response to context-switch events. */
  private processEvent(event: TraceEvent): void {
    const core = event.coreId;
    const trace = this.traces.get(core);
    if (!trace) throw new TraceParseError(`event for unknown core ${core}`);
    const stack = this.ctxStack.get(core)!;

    switch (event.id) {
      case EVTID.ISR_ENTER: {
        const num = event.params["irq_num"] as number;
        let name = trace.irqs.get(num);
        if (name === undefined) {
          if (this.strict) throw new TraceParseError(`enter unknown ISR ${num}`);
          name = `IRQ#${num}`;
        }
        this.prevCtx.set(core, stack.length ? stack[stack.length - 1]! : idle(core));
        stack.push({ handle: num, irq: true, name });
        break;
      }
      case EVTID.ISR_EXIT: {
        if (stack.length) {
          this.prevCtx.set(core, stack.pop()!);
        } else {
          // First context switch after trace start was an ISR exit: we were in
          // some IRQ, but its number is unknown (ISR_EXIT carries none).
          this.prevCtx.set(core, { handle: null, irq: true, name: `IRQ_oncore${core}` });
        }
        break;
      }
      case EVTID.ISR_TO_SCHEDULER: {
        // Interrupt triggered a context switch. Clear the interrupt stack and
        // activate the synthetic Scheduler context.
        this.prevCtx.set(
          core,
          stack.length ? stack[stack.length - 1]! : { handle: null, irq: true, name: `IRQ_oncore${core}` },
        );
        this.ctxStack.set(core, []);
        this.inScheduler.set(core, true);
        break;
      }
      case EVTID.TASK_START_EXEC: {
        const tid = event.params["tid"] as number;
        let name = trace.tasks.get(tid);
        if (name === undefined) {
          if (this.strict) throw new TraceParseError(`start exec unknown task 0x${tid.toString(16)}`);
          name = `task0x${tid.toString(16)}`;
        }
        this.prevCtx.set(core, stack.length ? stack[stack.length - 1]! : this.restingCtx(core));
        // Tasks occupy the base of the execution stack beneath preempting ISRs.
        this.ctxStack.set(core, [{ handle: tid, irq: false, name }]);
        // Task started; deactivate the scheduler context.
        this.inScheduler.set(core, false);
        break;
      }
      case EVTID.TASK_STOP_EXEC: {
        const top = stack[stack.length - 1];
        if (top && !top.irq) {
          // The running task terminated; pop it and activate the scheduler context.
          this.prevCtx.set(core, stack.pop()!);
          this.inScheduler.set(core, true);
        }
        // If an ISR is active, retain the stack state.
        break;
      }
      case EVTID.IDLE: {
        // CPU entered the idle loop. Switch to the synthetic IDLE context,
        // record the previous context for back-fill, and clear the execution stack.
        this.prevCtx.set(core, stack.length ? stack[stack.length - 1]! : this.restingCtx(core));
        this.ctxStack.set(core, []);
        // System entered idle; deactivate the scheduler context.
        this.inScheduler.set(core, false);
        break;
      }
      case EVTID.TASK_STOP_READY: {
        const tid = event.params["tid"] as number;
        if (!trace.tasks.has(tid)) {
          if (this.strict) throw new TraceParseError(`stop ready unknown task 0x${tid.toString(16)}`);
        }
        const top = stack[stack.length - 1];
        if (stack.length) {
          if (top && !top.irq && top.handle === tid) {
            // The running task blocked or suspended; pop it and activate the scheduler context.
            this.prevCtx.set(core, stack.pop()!);
            this.inScheduler.set(core, true);
          }
        } else {
          // First context switch after trace start: infer previous execution in `tid` for event back-fill.
          this.prevCtx.set(core, {
            handle: tid,
            irq: false,
            name: trace.tasks.get(tid) ?? `task0x${tid.toString(16)}`,
          });
        }
        break;
      }
      case EVTID.TIMER_ENTER: {
        // Software timer callback begins execution; deactivate the scheduler context.
        this.inScheduler.set(core, false);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Handles an `svOverflow` event: records the gap and resets the core to the
   * "context unknown" state of trace start, so the events that follow are buffered
   * until a context-establishing event arrives and are then back-filled from the
   * context inferred there, never from the stale pre-gap one.
   *
   * The overflow event itself is emitted with no context: it marks the boundary of an
   * interval that belongs to no context. Events on the core still waiting for a context
   * from before the gap are left without one, as the post-gap inference says nothing
   * about them.
   */
  private onOverflow(event: TraceEvent): void {
    const core = event.coreId;
    const dropCount = (event.params["drop_cnt"] as number | undefined) ?? 0;
    // The drop counter is shared by all cores, so a repeat of the last count is the same
    // episode reported by another core, not a further loss.
    const prev = this.lastDrop;
    const lost =
      prev === null || dropCount < prev.count ? dropCount : dropCount === prev.count ? prev.lost : dropCount - prev.count;
    this.lastDrop = { count: dropCount, lost };
    this.gaps.push({
      coreId: core,
      start: this.lastTs.get(core) ?? event.ts,
      end: event.ts,
      eventIndex: this.out.length,
      dropCount,
      lost,
    });

    this.ctxStack.set(core, []);
    this.inScheduler.set(core, false);
    this.prevCtx.set(core, null);
    this.pending.get(core)!.length = 0;
    event.ctxName = "None";
    event.inIrq = false;
    this.out.push(event);
    this.lastTs.set(core, event.ts);
  }

  /** Processes an event, annotates execution context, and back-fills buffered events. */
  private onNewEvent(event: TraceEvent): void {
    const core = event.coreId;
    if (event.id === EVTID.OVERFLOW) {
      this.onOverflow(event);
      return;
    }
    this.processEvent(event);
    const currCtx = this.currContext(core);
    // Events go out in merged order whether or not their context is known yet.
    const index = this.out.length;
    this.out.push(event);
    this.lastTs.set(core, event.ts);
    const pending = this.pending.get(core)!;
    if (!currCtx) {
      // Context unknown; remember the event until a subsequent one on this core establishes context.
      pending.push(index);
      return;
    }
    event.inIrq = currCtx.irq;
    event.ctxName = currCtx.name;

    if (pending.length) {
      // Annotate this core's buffered events with the context inferred to have preceded the switch.
      const prev = this.prevCtx.get(core) ?? currCtx;
      for (const i of pending) {
        const cached = this.out[i]!;
        cached.ctxName = prev.name;
        cached.inIrq = prev.irq;
      }
      pending.length = 0;
    }
  }

  /** Merge events from every core, sort by timestamp, and process them. */
  run(): { events: TraceEvent[]; gaps: TraceGap[] } {
    const all: TraceEvent[] = [];
    alignCoreTimebases([...this.traces.values()]);
    for (const t of this.traces.values()) clampDrainSeam(t.events);
    // Append iteratively to avoid call-stack limits with large event arrays.
    for (const t of this.traces.values()) for (const e of t.events) all.push(e);
    // Sort events by timestamp; preserve core ID order on timestamp ties.
    all.sort((a, b) => a.ts - b.ts);
    for (const event of all) this.onNewEvent(event);
    this.gaps.sort((a, b) => a.start - b.start || a.coreId - b.coreId);
    return { events: this.out, gaps: this.gaps };
  }
}

/**
 * Tracks timebase alignment state per core across incremental merge passes.
 * Records the initial unshifted timestamp (`absStart`), the active offset (`shift`),
 * and the number of previously shifted events (`count`).
 */
const alignState = new WeakMap<TraceEvent[], { absStart: number; shift: number; count: number }>();

/**
 * Aligns event timestamps across all cores onto a single timebase.
 *
 * Timestamps on secondary cores may reference target boot time rather than
 * trace start if those cores omit `svTraceStart`. Shifting each core by
 * `tsOrigin - base` aligns all cores to the earliest event timestamp (`base`).
 * Traces sharing an origin require no shift. Alignment is deferred for a core
 * until its `svInit` event provides the clock frequency.
 */
function alignCoreTimebases(traces: readonly CoreTrace[]): void {
  const state = traces.map((t) => {
    const rec = alignState.get(t.events);
    if (rec) return rec;
    const first = t.events[0];
    if (!first || !t.sysInfo) return null;
    return { absStart: t.tsOrigin + first.ts, shift: 0, count: 0 };
  });

  let base = Infinity;
  for (const s of state) if (s) base = Math.min(base, s.absStart);
  if (!Number.isFinite(base)) return;

  for (let c = 0; c < traces.length; c++) {
    const s = state[c];
    if (!s) continue;
    const t = traces[c]!;
    const shift = t.tsOrigin - base;
    // Late-arriving cores can update base, requiring an adjustment to previously shifted events.
    if (s.shift !== shift) {
      const delta = shift - s.shift;
      for (let i = 0; i < s.count; i++) t.events[i]!.ts += delta;
      s.shift = shift;
    }
    // Shift newly appended events.
    for (let i = s.count; i < t.events.length; i++) t.events[i]!.ts += shift;
    s.count = t.events.length;
    alignState.set(t.events, s);
  }
}

/**
 * Time window (seconds) defining the trailing drain burst: events occurring
 * within this duration of the final `TRACE_STOP` are treated as a single cluster.
 */
const SEAM_BURST_WINDOW_S = 0.005;
/**
 * Minimum idle interval (seconds) preceding the trailing burst required to classify it as a drain seam.
 */
const SEAM_MIN_GAP_S = 0.02;

/**
 * Clamps the trailing drain seam of a capture to the timestamp of the last active event.
 *
 * In JTAG and apptrace captures, buffer draining occurs after the host terminates
 * tracing, writing trailing packets stamped at drain time.
 *
 * Events within {@link SEAM_BURST_WINDOW_S} of the final `TRACE_STOP` that are
 * preceded by an idle gap exceeding {@link SEAM_MIN_GAP_S} are clamped to the
 * timestamp of the last preceding active event. Any remaining trailing `TRACE_STOP`
 * events after active events are also clamped to the last active timestamp.
 * Non-trailing stop events followed by subsequent trace activity remain unchanged.
 * `events` must contain single-core events in ascending timestamp order.
 */
export function clampDrainSeam(events: { id: number; ts: number }[]): void {
  const n = events.length;
  if (n === 0) return;

  // Clamp the trailing burst of events onto the timestamp of the last pre-gap event.
  if (events[n - 1]!.id === EVTID.TRACE_STOP) {
    const endTs = events[n - 1]!.ts;
    let k = n - 1;
    while (k - 1 >= 0 && endTs - events[k - 1]!.ts <= SEAM_BURST_WINDOW_S) k--;
    if (k > 0 && events[k]!.ts - events[k - 1]!.ts > SEAM_MIN_GAP_S) {
      const anchor = events[k - 1]!.ts;
      for (let j = k; j < n; j++) events[j]!.ts = anchor;
    }
  }

  // Clamp remaining trailing stop markers to the last active event timestamp.
  let lastActivity = -Infinity;
  for (const e of events) {
    if (e.id !== EVTID.TRACE_STOP && e.ts > lastActivity) lastActivity = e.ts;
  }
  if (!Number.isFinite(lastActivity)) return; // Stream contains only stop markers
  for (const e of events) {
    if (e.id === EVTID.TRACE_STOP && e.ts > lastActivity) e.ts = lastActivity;
  }
}

/**
 * Looks up each kernel object handle (`id` parameter) in the ELF and records the symbol at its
 * address in `event.handles`. Zephyr records raw object addresses in its OS events and
 * `ram_base`-shrunk ones in the task events, so the expanded value is tried first and the raw
 * value second. A hit on a sizeless label at a non-zero offset is skipped: such a label only
 * marks a boundary.
 */
function nameHandles(events: TraceEvent[], traces: readonly CoreTrace[], elf: ElfSymbols): void {
  const sysInfo = new Map(traces.map((t) => [t.coreId, t.sysInfo]));
  for (const e of events) {
    // Function-trace events hold code addresses, which the viewer resolves with offsets itself.
    if (!e.fmt || e.name === FUNC_TRACE_ENTER || e.name === FUNC_TRACE_EXIT) continue;
    for (const p of e.fmt.params) {
      if (p.kind !== "id") continue;
      const v = e.params[p.name];
      if (typeof v !== "number") continue;
      const info = sysInfo.get(e.coreId);
      const raw = v >>> 0;
      const candidates = info ? [((raw << info.idShift) + info.ramBase) >>> 0, raw] : [raw];
      for (const addr of candidates) {
        const hit = elf.lookup(addr);
        if (!hit || (hit.offset !== 0 && hit.size === 0)) continue;
        const name = hit.offset === 0 ? hit.name : `${hit.name}+0x${hit.offset.toString(16)}`;
        (e.handles ??= {})[p.name] = { addr, name };
        break;
      }
    }
  }
}

/**
 * Merges per-core traces into a unified timeline and annotates events in place with `ctxName` and `inIrq`,
 * and with `handles` when an ELF is given.
 */
export function processTraces(
  traces: CoreTrace[],
  opts: ProcessOptions = {},
): TraceModel {
  const { events, gaps } = new Processor(traces, opts.strict ?? false).run();
  if (opts.elf) nameHandles(events, traces, opts.elf);
  return { traces, events, gaps, ...(opts.elf ? { elf: opts.elf } : {}) };
}
