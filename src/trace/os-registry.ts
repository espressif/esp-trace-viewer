/**
 * Registry mapping trace operating systems and modules to event format maps.
 *
 * Trace streams specify their RTOS in `svSysDesc` (`O=<name>`, such as
 * `O=FreeRTOS` or `O=Zephyr`) and modules in `svModuleDesc` (`M=<name>[,V=<version>]`).
 * The parser uses these identifiers to select corresponding event ID tables.
 *
 * Built-in OS tables include ESP-IDF FreeRTOS (`tools/esp_app_trace/SYSVIEW_FreeRTOS.txt`)
 * and Zephyr (`subsys/tracing/sysview/SYSVIEW_Zephyr.txt`). Modules define events at runtime
 * offsets keyed by relative ID.
 */

import type { EventFormat, ParamSpec } from "./events.js";
import {
  FUNC_TRACE_MODULE_NAME,
  HEAP_MODULE_DESC,
  FUNC_TRACE_EVENTS,
  HEAP_EVENTS,
} from "./events.js";
import { FREERTOS_OS_EVENTS } from "./os/freertos.js";
import { ZEPHYR_OS_EVENTS } from "./os/zephyr.js";

/** Event format table mapping IDs to definitions (absolute IDs for OS events, relative IDs for modules). */
export type EventMap = Readonly<Record<number, EventFormat>>;

/** Default OS event map used when a stream omits the OS field or specifies an unrecognized OS. */
export const DEFAULT_OS_EVENTS = FREERTOS_OS_EVENTS;

/** Normalizes an OS or module name to alphanumeric lowercase characters. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** OS event maps keyed by normalized `O=` name. */
const OS_EVENTS: Readonly<Record<string, EventMap>> = {
  freertos: FREERTOS_OS_EVENTS,
  zephyr: ZEPHYR_OS_EVENTS,
};

/**
 * Resolves the OS event map from the `O=<name>` field, returning `null` if unrecognized.
 */
export function resolveOsEvents(osName: string): EventMap | null {
  return OS_EVENTS[normalize(osName)] ?? null;
}

/**
 * Resolves a module event map from its `svModuleDesc` text (`M=<name>[,V=<ver>]`), returning `null` if unknown.
 */
export function resolveModuleEvents(desc: string): EventMap | null {
  if (HEAP_MODULE_DESC.test(desc)) return HEAP_EVENTS;

  const m = /^M=([^,]+)/.exec(desc);
  if (!m) return null;
  if (normalize(m[1]!) === normalize(FUNC_TRACE_MODULE_NAME)) return FUNC_TRACE_EVENTS;
  return parseModuleDescEvents(desc);
}

/**
 * Maps a module-descriptor format specifier to a wire {@link ParamSpec} kind.
 * Handle specifiers (`%t`, `%T`, `%I`, `%p`) map to `id`; `%s` maps to `str`;
 * all other specifiers (`%u`, `%d`, `%x`, `%b`) map to `u32`.
 */
function paramKindFor(fmt: string): ParamSpec["kind"] {
  if (fmt === "s") return "str";
  if ("tTIp".includes(fmt)) return "id";
  return "u32";
}

/**
 * Derives a module event map from definitions embedded in its descriptor string
 * following the `sModule` format:
 *
 *   `M=<name>[, S=<desc>][, <id> <event-name> [<param>=%<fmt> ...]]...`
 *
 * Comma-separated entries beginning with a decimal number define an event:
 * relative ID, name, and ordered parameter list. Returns `null` if no event
 * definitions are present.
 */
export function parseModuleDescEvents(desc: string): EventMap | null {
  const events: Record<number, EventFormat> = {};
  let found = false;
  for (const entry of desc.split(",")) {
    const m = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(entry);
    if (!m) continue;
    const id = parseInt(m[1]!, 10);
    const params: ParamSpec[] = [];
    for (const p of m[3]!.matchAll(/(\S+)=%(\w)/g)) {
      params.push({ name: p[1]!, kind: paramKindFor(p[2]!) });
    }
    events[id] = { name: m[2]!, params };
    found = true;
  }
  return found ? events : null;
}
