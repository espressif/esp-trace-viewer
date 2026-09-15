/**
 * Generate test/fixtures/traces/overflow.svdat: a small synthetic dual-core capture
 * that contains SystemView overflow packets (svOverflow, event id 1). It lets the
 * unit and e2e suites exercise overflow handling without hardware.
 *
 * The file uses the combined multi-core layout: one textual header with
 * `; Offset Core0` / `; Offset Core1` byte offsets relative to the first sync
 * sequence, followed by each core's stream, each starting with its own 10-byte sync.
 * The timestamp clock runs at 1 MHz, so one cycle is one microsecond and the
 * timestamps below read directly as milliseconds when divided by 1000. Both cores
 * begin with svTraceStart at the same cycle count, so they share a timebase.
 *
 * Each core runs about 100 ms of FreeRTOS-like scheduling: two tasks trading the
 * CPU, a SysTick ISR (I#33) firing periodically, and an idle stretch. Core 0 runs
 * `main` and `worker0`; core 1 runs `worker1` and `worker2`. Both cores list all four
 * tasks in svTaskInfo, as the target does.
 *
 * Each core contains two overflow packets, each preceded by a 10 ms gap with no
 * events. Before each gap one task (A) is running; the first events after the
 * overflow are svTaskStopReady for another task (B) and svTaskStartExec for A,
 * meaning B ran during the gap, so a viewer that ignores overflows misattributes
 * the gap to A. The drop counts are cumulative like the target's: 40 for the first
 * overflow and 100 for the second.
 *
 * Gap positions (previous event -> overflow packet):
 *   core 0: 30 ms -> 40 ms (drop_cnt 40), 79 ms -> 89 ms (drop_cnt 100)
 *   core 1: 30 ms -> 40 ms (drop_cnt 40), 60 ms -> 70 ms (drop_cnt 100)
 * The first gap has identical timestamps on both cores; the second gaps do not
 * overlap, so tests can cover both overlapping and non-overlapping gaps.
 *
 * At 30 ms both cores emit svTaskStartReady for task B, so a ready interval is open
 * when the first gap starts; it closes at the svTaskStopReady that follows the
 * overflow. Both overflows of an episode carry the same drop count, as they do on a
 * real target, where one counter serves every core.
 *
 * Every core ends with svTraceStop at 100 ms. The output is deterministic.
 *
 *   npx tsx scripts/gen-overflow-fixture.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EVTID, SYNC_LEN } from "../src/trace/events.js";
import { parseTraceFiles } from "../src/trace/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "test/fixtures/traces/overflow.svdat");

/** Timestamp clock frequency in Hz: one cycle per microsecond. */
const SYS_FREQ = 1_000_000;
const CPU_FREQ = 160_000_000;

/** Task handles, shared by both cores' svTaskInfo tables. */
const MAIN = 1;
const WORKER0 = 2;
const WORKER1 = 3;
const WORKER2 = 4;
const TASKS: [number, number, string][] = [
  [MAIN, 5, "main"],
  [WORKER0, 4, "worker0"],
  [WORKER1, 4, "worker1"],
  [WORKER2, 4, "worker2"],
];

/** SysTick interrupt number, named in svSysDesc. */
const SYSTICK = 33;

/** Cumulative dropped-packet counts reported by the two overflow packets on each core. */
const DROP_FIRST = 40;
const DROP_SECOND = 100;

/** svTaskStopReady cause values (SEGGER's "blocked" and "yield"). */
const CAUSE_BLOCKED = 4;
const CAUSE_YIELD = 0;

// ---- SVDAT framing helpers -----------------------------------------------

const u32 = (v: number): number[] => {
  const out: number[] = [];
  let n = v >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
};
const eventId = (id: number): number[] => (id < 0x80 ? [id] : [(id & 0x7f) | 0x80, id >> 7]);
const plen = (v: number): number[] => (v < 0x80 ? [v] : [(v & 0x7f) | 0x80, v >> 7]);
const str = (s: string): number[] => {
  const b = [...Buffer.from(s, "utf8")];
  return [b.length, ...b];
};
const packet = (id: number, payload: number[], delta: number): number[] => [
  ...eventId(id),
  ...(id >= 24 ? plen(payload.length) : []),
  ...payload,
  ...u32(delta),
];

/** One event at an absolute time in microseconds since svTraceStart. */
interface Ev {
  us: number;
  id: number;
  payload: number[];
}

/** Encodes a list of absolute-time events as packets with timestamp deltas. */
function encode(events: Ev[]): number[] {
  const out: number[] = [];
  let prev = 0;
  for (const e of events) {
    if (e.us < prev) throw new Error(`events out of order at ${e.us} us`);
    out.push(...packet(e.id, e.payload, e.us - prev));
    prev = e.us;
  }
  return out;
}

// ---- Event builders ------------------------------------------------------

const ev = (us: number, id: number, payload: number[] = []): Ev => ({ us, id, payload });
const startExec = (us: number, tid: number): Ev => ev(us, EVTID.TASK_START_EXEC, u32(tid));
const startReady = (us: number, tid: number): Ev => ev(us, EVTID.TASK_START_READY, u32(tid));
const stopReady = (us: number, tid: number, cause: number): Ev =>
  ev(us, EVTID.TASK_STOP_READY, [...u32(tid), ...u32(cause)]);
const isrEnter = (us: number): Ev => ev(us, EVTID.ISR_ENTER, u32(SYSTICK));
const isrExit = (us: number): Ev => ev(us, EVTID.ISR_EXIT);
const idle = (us: number): Ev => ev(us, EVTID.IDLE);
const overflow = (us: number, dropCnt: number): Ev => ev(us, EVTID.OVERFLOW, u32(dropCnt));

/** A SysTick interrupt lasting 40 us. */
const tick = (us: number): Ev[] => [isrEnter(us), isrExit(us + 40)];

/** Context switch from `from` to `to`: `to` becomes ready, `from` blocks, `to` runs. */
const switchTo = (us: number, from: number, to: number): Ev[] => [
  startReady(us, to),
  stopReady(us + 10, from, CAUSE_BLOCKED),
  startExec(us + 20, to),
];

/** Task `tid` blocks and the core goes idle. */
const blockToIdle = (us: number, tid: number): Ev[] => [
  stopReady(us, tid, CAUSE_BLOCKED),
  idle(us + 10),
];

/** A SysTick interrupt wakes task `tid`, which runs after the ISR returns. */
const wakeFromIsr = (us: number, tid: number): Ev[] => [
  isrEnter(us),
  startReady(us + 30, tid),
  isrExit(us + 40),
  startExec(us + 50, tid),
];

/**
 * A 10 ms silence ending in an overflow packet, then the events revealing that
 * `hidden` ran during the gap: it yields and `resumed` gets the CPU back.
 */
const gapThenOverflow = (us: number, dropCnt: number, hidden: number, resumed: number): Ev[] => [
  overflow(us + 10_000, dropCnt),
  stopReady(us + 10_010, hidden, CAUSE_YIELD),
  startExec(us + 10_020, resumed),
];

/** Stream prologue shared by both cores: trace start, svInit, descriptors, task table. */
function prologue(core: number): Ev[] {
  return [
    ev(0, EVTID.TRACE_START),
    ev(0, EVTID.INIT, [...u32(SYS_FREQ), ...u32(CPU_FREQ), ...u32(0), ...u32(0)]),
    ev(0, EVTID.SYSDESC, str(`N=FreeRTOS Application,D=esp32,C=core${core},O=FreeRTOS`)),
    ev(0, EVTID.SYSDESC, str(`I#${SYSTICK}=SysTick`)),
    ...TASKS.map(([tid, prio, name]) => ev(0, EVTID.TASK_INFO, [...u32(tid), ...u32(prio), ...str(name)])),
  ];
}

/** Core 0: `main` (A) and `worker0` (B). */
function core0(): Ev[] {
  return [
    ...prologue(0),
    startExec(1_000, MAIN),
    ...tick(2_000),
    ...switchTo(5_000, MAIN, WORKER0),
    ...switchTo(10_000, WORKER0, MAIN),
    ...tick(15_000),
    ...blockToIdle(20_000, MAIN),
    ...wakeFromIsr(25_000, MAIN),
    // worker0 becomes ready; its ready interval is still open when the gap starts.
    startReady(30_000, WORKER0),
    ...gapThenOverflow(30_000, DROP_FIRST, WORKER0, MAIN),
    ...tick(45_000),
    ...switchTo(50_000, MAIN, WORKER0),
    ...switchTo(60_000, WORKER0, MAIN),
    ...tick(65_000),
    ...blockToIdle(70_000, MAIN),
    ...wakeFromIsr(75_000, MAIN),
    // worker1 (pinned to core 1) is made ready from here and never stops ready on this core.
    startReady(79_000, WORKER1),
    ...gapThenOverflow(79_000, DROP_SECOND, WORKER0, MAIN),
    ...tick(95_000),
    ev(100_000, EVTID.TRACE_STOP),
  ];
}

/** Core 1: `worker1` (A) and `worker2` (B). */
function core1(): Ev[] {
  return [
    ...prologue(1),
    startExec(1_500, WORKER1),
    ...tick(2_500),
    ...switchTo(6_000, WORKER1, WORKER2),
    ...switchTo(12_000, WORKER2, WORKER1),
    ...tick(16_000),
    ...blockToIdle(22_000, WORKER1),
    ...wakeFromIsr(27_000, WORKER1),
    // worker2 becomes ready; its ready interval is still open when the gap starts.
    startReady(30_000, WORKER2),
    ...gapThenOverflow(30_000, DROP_FIRST, WORKER2, WORKER1),
    ...tick(46_000),
    ...switchTo(52_000, WORKER1, WORKER2),
    ...switchTo(59_980, WORKER2, WORKER1),
    ...gapThenOverflow(60_000, DROP_SECOND, WORKER2, WORKER1),
    ...tick(76_000),
    ...blockToIdle(82_000, WORKER1),
    ...wakeFromIsr(88_000, WORKER1),
    ...tick(94_000),
    ev(100_000, EVTID.TRACE_STOP),
  ];
}

// ---- Assembly ------------------------------------------------------------

function buildSvdat(): { bytes: Uint8Array; eventCount: number } {
  const c0 = core0();
  const c1 = core1();
  const sync = new Array(SYNC_LEN).fill(0);
  const slice0 = [...sync, ...encode(c0)];
  const slice1 = [...sync, ...encode(c1)];
  const header =
    ";\n; Version     SEGGER SystemViewer V2.42\n; Author      Espressif Inc\n" +
    `; Offset Core0 0\n; Offset Core1 ${slice0.length}\n;\n`;
  return {
    bytes: Uint8Array.from([...Buffer.from(header, "utf8"), ...slice0, ...slice1]),
    eventCount: c0.length + c1.length,
  };
}

function main(): void {
  const { bytes, eventCount } = buildSvdat();
  writeFileSync(OUT, bytes);

  // Verify the fixture parses back as intended.
  const model = parseTraceFiles([bytes]);
  const fail = (msg: string): never => {
    throw new Error(`overflow.svdat verification failed: ${msg}`);
  };
  if (model.traces.length !== 2) fail(`expected 2 cores, got ${model.traces.length}`);
  if (model.events.length !== eventCount) {
    fail(`expected ${eventCount} events, got ${model.events.length}`);
  }
  const overflows = model.events.filter((e) => e.name === "svOverflow");
  if (overflows.length !== 4) fail(`expected 4 svOverflow events, got ${overflows.length}`);
  const drops = overflows.map((e) => e.params["drop_cnt"]);
  for (const t of model.traces) {
    const names = TASKS.map(([, , name]) => name);
    const got = [...t.tasks.values()];
    if (got.length !== names.length || names.some((n) => !got.includes(n))) {
      fail(`core ${t.coreId} tasks ${got.join(",")} != ${names.join(",")}`);
    }
    if (t.irqs.get(SYSTICK) !== "SysTick") fail(`core ${t.coreId} missing SysTick IRQ`);
    if (t.sysInfo?.sysFreq !== SYS_FREQ) fail(`core ${t.coreId} sysFreq mismatch`);
  }

  const gaps = overflows.map((o) => {
    const prev = model.events
      .filter((e) => e.coreId === o.coreId && e.ts < o.ts)
      .reduce((a, b) => (b.ts > a.ts ? b : a));
    return `core${o.coreId} ${prev.ts.toFixed(3)}s->${o.ts.toFixed(3)}s drop=${o.params["drop_cnt"]}`;
  });
  console.log(
    `wrote ${OUT} (${bytes.byteLength} B, 2 cores, ${model.events.length} events, ` +
      `drop_cnt=[${drops.join(",")}]; gaps: ${gaps.join(", ")})`,
  );
}

main();
