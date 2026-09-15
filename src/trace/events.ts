/**
 * SVDAT event-format model and parameter definitions.
 *
 * Format definitions adapted from Espressif `tools/esp_app_trace/espytrace/sysview.py`
 * (`sysviewtrace_proc.py` backend). This module has no dependencies on the viewer,
 * allowing reuse across SVDAT decoders.
 *
 * Reference: $IDF_PATH/tools/esp_app_trace/espytrace/sysview.py
 *            (SYSVIEW_EVTID_*, SysViewPredefinedEvent._predef_events_fmt)
 */

/** Length in bytes of the zero-byte synchronization sequence at the start of an event stream. */
export const SYNC_LEN = 10;

/**
 * Event ID threshold for explicit payload-length encoding. Events at or above
 * this ID encode payload length in a leading byte (`_decode_plen`); events below
 * have implicit lengths defined by their format table. Mirrors `SYSVIEW_EVENT_ID_PREDEF_LEN_MAX`.
 */
export const SYSVIEW_PREDEF_LEN_MAX = 24;

/** Maximum predefined event ID. Higher IDs represent OS or module events. */
export const SYSVIEW_PREDEF_MAX = 31;

/** Threshold offset for module and extension events (such as heap tracing). OS events use IDs below this offset. */
export const MODULE_EVENT_OFFSET = 512;

/** Predefined event ids (`SYSVIEW_EVTID_*` on the target side). */
export const EVTID = {
  NOP: 0,
  OVERFLOW: 1,
  ISR_ENTER: 2,
  ISR_EXIT: 3,
  TASK_START_EXEC: 4,
  TASK_STOP_EXEC: 5,
  TASK_START_READY: 6,
  TASK_STOP_READY: 7,
  TASK_CREATE: 8,
  TASK_INFO: 9,
  TRACE_START: 10,
  TRACE_STOP: 11,
  SYSTIME_CYCLES: 12,
  SYSTIME_US: 13,
  SYSDESC: 14,
  MARK_START: 15,
  MARK_STOP: 16,
  IDLE: 17,
  ISR_TO_SCHEDULER: 18,
  TIMER_ENTER: 19,
  TIMER_EXIT: 20,
  STACK_INFO: 21,
  MODULEDESC: 22,
  DATA_SAMPLE: 23,
  INIT: 24,
  NAME_RESOURCE: 25,
  PRINT_FORMATTED: 26,
  NUMMODULES: 27,
  END_CALL: 28,
  TASK_TERMINATE: 29,
  /** Extended event multiplexing sub-IDs in its first `u32` payload field. */
  EX: 31,
} as const;

/**
 * Sub-IDs encoded in the first `u32` payload field of an {@link EVTID.EX} packet.
 * Mirrors `SYSVIEW_EVTID_EX_*` in SEGGER_SYSVIEW.h. Decodes `REGISTER_DATA`
 * (DataPlot series registration); ESP-IDF routes heap tracing through module events.
 */
export const SYSVIEW_EVTID_EX = {
  MARK: 0,
  NAME_MARKER: 1,
  HEAP_DEFINE: 2,
  HEAP_ALLOC: 3,
  HEAP_ALLOC_EX: 4,
  HEAP_FREE: 5,
  REGISTER_DATA: 6,
} as const;

/**
 * DataPlot sample value type (`SEGGER_SYSVIEW_DATA_TYPE`) registered by
 * `SEGGER_SYSVIEW_RegisterData`. `svDataSample` payloads carry raw 32-bit values;
 * this type defines the numeric interpretation: unsigned integer, signed integer,
 * or IEEE-754 float. Defaults to `U32` when unspecified.
 */
export const SYSVIEW_DATA_TYPE = {
  U32: 0,
  I32: 1,
  FLOAT: 2,
} as const;

/**
 * Wire encodings for event parameters:
 * - `u32`  — LEB128 unsigned 32-bit integer (7 bits per byte).
 * - `id`   — Handle or address (task ID, queue/semaphore handle, pointer); encoded identically to `u32`.
 * - `u64`  — Two `u32` LEB128 values (low word followed by high word).
 * - `str`  — Length-prefixed UTF-8 string (1-byte length, or 0xFF followed by 2 big-endian bytes).
 * - `arr_u32` — Sequence of `u32` LEB128 values spanning the remaining payload length.
 */
export type ParamKind = "u32" | "id" | "u64" | "str" | "arr_u32";

/** One named parameter in an event's payload layout. */
export interface ParamSpec {
  readonly name: string;
  readonly kind: ParamKind;
}

/** An event's decoded name and its ordered payload layout. */
export interface EventFormat {
  readonly name: string;
  readonly params: readonly ParamSpec[];
}

const u32 = (name: string): ParamSpec => ({ name, kind: "u32" });
const id = (name: string): ParamSpec => ({ name, kind: "id" });
const str = (name: string): ParamSpec => ({ name, kind: "str" });

/**
 * Payload layouts for predefined events, keyed by event ID.
 * Matches `SysViewPredefinedEvent._predef_events_fmt` in parameter names and order.
 */
export const SYSVIEW_PREDEF_EVENTS: Readonly<Record<number, EventFormat>> = {
  [EVTID.NOP]: { name: "svNop", params: [] },
  [EVTID.OVERFLOW]: { name: "svOverflow", params: [u32("drop_cnt")] },
  [EVTID.ISR_ENTER]: { name: "svIsrEnter", params: [u32("irq_num")] },
  [EVTID.ISR_EXIT]: { name: "svIsrExit", params: [] },
  [EVTID.TASK_START_EXEC]: { name: "svTaskStartExec", params: [id("tid")] },
  [EVTID.TASK_STOP_EXEC]: { name: "svTaskStopExec", params: [] },
  [EVTID.TASK_START_READY]: { name: "svTaskStartReady", params: [id("tid")] },
  [EVTID.TASK_STOP_READY]: { name: "svTaskStopReady", params: [id("tid"), u32("cause")] },
  [EVTID.TASK_CREATE]: { name: "svTaskCreate", params: [id("tid")] },
  [EVTID.TASK_INFO]: {
    name: "svTaskInfo",
    params: [id("tid"), u32("prio"), str("name")],
  },
  [EVTID.TRACE_START]: { name: "svTraceStart", params: [] },
  [EVTID.TRACE_STOP]: { name: "svTraceStop", params: [] },
  [EVTID.SYSTIME_CYCLES]: { name: "svSysTimeCycles", params: [u32("cycles")] },
  [EVTID.SYSTIME_US]: { name: "svSysTimeUs", params: [{ name: "time", kind: "u64" }] },
  [EVTID.SYSDESC]: { name: "svSysDesc", params: [str("desc")] },
  [EVTID.MARK_START]: { name: "svUserStart", params: [u32("user_id")] },
  [EVTID.MARK_STOP]: { name: "svUserStop", params: [u32("user_id")] },
  [EVTID.IDLE]: { name: "svIdle", params: [] },
  [EVTID.ISR_TO_SCHEDULER]: { name: "svExitIsrToScheduler", params: [] },
  [EVTID.TIMER_ENTER]: { name: "svTimerEnter", params: [u32("tim_id")] },
  [EVTID.TIMER_EXIT]: { name: "svTimerExit", params: [] },
  [EVTID.STACK_INFO]: {
    name: "svStackInfo",
    params: [id("tid"), u32("base"), u32("sz"), u32("unused")],
  },
  [EVTID.MODULEDESC]: {
    name: "svModuleDesc",
    params: [u32("mod_id"), u32("evt_off"), str("desc")],
  },
  // DataPlot sample: series ID and raw 32-bit value encoded as LEB128 varints.
  // The interpretation of value bits (unsigned int, signed int, or IEEE-754 float)
  // is specified by the series' svRegisterData registration (see SYSVIEW_DATA_TYPE).
  // Explicit decoding preserves stream framing across sample packets.
  [EVTID.DATA_SAMPLE]: { name: "svDataSample", params: [u32("data_id"), u32("value")] },
  [EVTID.INIT]: {
    name: "svInit",
    params: [u32("sys_freq"), u32("cpu_freq"), u32("ram_base"), u32("id_shift")],
  },
  [EVTID.NAME_RESOURCE]: {
    name: "svNameResource",
    params: [u32("res_id"), str("name")],
  },
  [EVTID.PRINT_FORMATTED]: {
    name: "svPrint",
    params: [str("msg"), u32("lvl"), u32("unused")],
  },
  [EVTID.NUMMODULES]: { name: "svNumModules", params: [u32("mod_cnt")] },
  // The API call that just returned. The payload holds the ID of that call's event and,
  // when the target used `SEGGER_SYSVIEW_RecordEndCallU32`, its return value; the parser
  // decodes it by hand (see `decodeEndCall`) because the second field is optional.
  [EVTID.END_CALL]: { name: "svEndCall", params: [] },
  [EVTID.TASK_TERMINATE]: { name: "svTaskTerminate", params: [id("tid")] },
};

/**
 * Payload layouts for ESP-IDF heap-tracing module events, relative to the
 * module's event offset from `svModuleDesc`.
 * Mirrors `SysViewHeapEvent.events_fmt`: index 0 = alloc, index 1 = free.
 */
export const HEAP_EVENTS: Readonly<Record<number, EventFormat>> = {
  0: {
    name: "esp_sysview_heap_trace_alloc",
    params: [u32("addr"), u32("size"), { name: "callers", kind: "arr_u32" }],
  },
  1: {
    name: "esp_sysview_heap_trace_free",
    params: [u32("addr"), { name: "callers", kind: "arr_u32" }],
  },
};

/**
 * Pattern matching the descriptor string emitted by ESP-IDF heap-tracing modules.
 * Accommodates minor wording differences across ESP-IDF versions.
 */
export const HEAP_MODULE_DESC = /^M=ESP32 .* Heap Tracing Module$/;

/**
 * Payload layouts for ESP-IDF function-instrumentation module events
 * (`-finstrument-functions` backend), relative to the module event offset.
 * Emitted by `__cyg_profile_func_enter` (0, enter) and `__cyg_profile_func_exit` (1, exit) hooks.
 * Each carries the function address and call site for ELF symbol resolution.
 *
 * This static table fixes parameter names and types for symbolization and flame graph
 * construction, independent of descriptor formatting differences in `svModuleDesc`.
 */
export const FUNC_TRACE_ENTER = "function_enter";
export const FUNC_TRACE_EXIT = "function_exit";

export const FUNC_TRACE_EVENTS: Readonly<Record<number, EventFormat>> = {
  0: { name: FUNC_TRACE_ENTER, params: [id("func"), id("call_site")] },
  1: { name: FUNC_TRACE_EXIT, params: [id("func"), id("call_site")] },
};

/** Module name for the ESP-IDF function-instrumentation module (`M=ESP_FunctionTrace`). */
export const FUNC_TRACE_MODULE_NAME = "ESP_FunctionTrace";
