/**
 * Standalone `.svdat` trace parser.
 *
 * Parses `.svdat` binary streams into structured trace models containing system
 * descriptions, task and IRQ tables, and merged context-tagged event timelines.
 * Combined multi-core captures are split automatically.
 *
 * Typical use:
 * ```ts
 * const model = parseTraceFiles([core0Bytes, core1Bytes]);
 * for (const e of model.events) console.log(e.ts, e.coreId, e.name, e.ctxName);
 * ```
 */

export * from "./events.js";
export {
  type EventSpan,
  indexCoreStream,
  parseCoreStream,
  StreamingCoreParser,
  TraceParseError,
  type ParamValue,
  type TraceEvent,
  type TraceSystemInfo,
  type CoreTrace,
} from "./parser.js";
export {
  processTraces,
  type ProcessOptions,
  type TraceGap,
  type TraceModel,
  traceElfSha256,
} from "./processor.js";
export { isSeggerMulticore, splitSeggerMulticore } from "./multicore.js";
export {
  DEFAULT_OS_EVENTS,
  type EventMap,
  parseModuleDescEvents,
  resolveModuleEvents,
  resolveOsEvents,
} from "./os-registry.js";

import { parseCoreStream, type CoreTrace } from "./parser.js";
import { processTraces, type ProcessOptions, type TraceModel } from "./processor.js";
import { splitSeggerMulticore } from "./multicore.js";

/**
 * Parses one or more SVDAT buffers into a merged, context-tagged trace model.
 *
 * - A single buffer containing combined multi-core data is split per core automatically.
 * - Multiple buffers are processed as individual cores assigned by array index (`[core0, core1, ...]`).
 */
export function parseTraceFiles(
  buffers: Uint8Array[],
  opts: ProcessOptions = {},
): TraceModel {
  let traces: CoreTrace[];
  if (buffers.length === 1) {
    const split = splitSeggerMulticore(buffers[0]!);
    traces = split
      ? split.map((buf, i) => parseCoreStream(buf, i))
      : [parseCoreStream(buffers[0]!, 0)];
  } else {
    traces = buffers.map((buf, i) => parseCoreStream(buf, i));
  }
  return processTraces(traces, opts);
}
