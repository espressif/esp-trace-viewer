/**
 * Committed `.svdat` fixtures and loading helpers.
 *
 * The application opens fixtures deterministically by name via `?fixture=`, the demo trace picker in the welcome modal, or the test API (`window.__traceViewer.loadFixture`).
 *
 * Fixtures resolve through Vite's base path for compatibility with subpaths:
 * - Bundled demos ({@link DEMOS}): Imported as URL assets and bundled into production builds.
 * - Development fixtures: Served dynamically by the `serveFixtures` Vite plugin in dev and CI environments.
 */

import type { App } from "../app.js";

// Curated demo samples bundled into the production build via Vite asset URL imports (`?url`).
// Single- and dual-core ESP-IDF captures exercise activity lanes, float DataPlot lanes, heap
// tracking, and function traces. The Zephyr capture exercises the Zephyr OS event table and
// kernel-object handle symbolization. Each includes a debug-stripped application ELF.
import unicoreUrl from "../../test/fixtures/traces/unicore.svdat?url";
import unicoreElfUrl from "../../test/fixtures/traces/unicore.elf?url";
import dualcoreUrl from "../../test/fixtures/traces/dualcore.svdat?url";
import dualcoreElfUrl from "../../test/fixtures/traces/dualcore.elf?url";
import zephyrUrl from "../../test/fixtures/traces/zephyr.svdat?url";
import zephyrElfUrl from "../../test/fixtures/traces/zephyr.elf?url";

/** Committed fixture definition specifying asset URLs and display filenames. */
interface Fixture {
  /** URLs to fetch `.svdat` files in core order. */
  urls: string[];
  /** Display filenames for the status bar and trace export. */
  files: string[];
  /**
   * Application ELF file for address symbolization. `sha256` contains the digest of the original unstripped ELF binary.
   */
  elf?: { url: string; file: string; sha256: string };
}

/** Create a fixture definition served at `/fixtures/traces/<file>` by the development server plugin. */
function dev(...files: string[]): Fixture {
  return { urls: files.map((f) => `/fixtures/traces/${f}`), files };
}

/** Mapping from fixture names to fixture configurations in core order. */
export const FIXTURES: Record<string, Fixture> = {
  "p4-mcore": dev("p4-mcore.svdat"),
  // Single-core trace containing ELF_SHA256 and heap events for symbol verification.
  "elf-id": dev("elf-id.svdat"),
  // Synthetic dual-core trace with svOverflow packets and 10 ms gaps around them.
  overflow: dev("overflow.svdat"),
  // Bundled demo traces imported as static assets for production builds.
  unicore: {
    urls: [unicoreUrl],
    files: ["unicore.svdat"],
    elf: {
      url: unicoreElfUrl,
      file: "unicore.elf",
      sha256: "030457852038e5f514bc96a48b0f6a55d90d92eec52ef20d301cfa37d8cbcafc",
    },
  },
  dualcore: {
    urls: [dualcoreUrl],
    files: ["dualcore.svdat"],
    elf: {
      url: dualcoreElfUrl,
      file: "dualcore.elf",
      sha256: "b180906957d60df8e0113823b826d140c577417e6b150416d65f1fcf02607e47",
    },
  },
  zephyr: {
    urls: [zephyrUrl],
    files: ["zephyr.svdat"],
    elf: {
      url: zephyrElfUrl,
      file: "zephyr.elf",
      sha256: "349fcf5cf938806afc7324311d78d96524e017a29f5125a1473a029f38630eea",
    },
  },
};

/** Valid fixture identifiers accepted by {@link loadFixture} and the `?fixture=` query parameter. */
export type FixtureName = keyof typeof FIXTURES;

/**
 * Demo trace descriptor for the welcome modal picker.
 */
export interface DemoTrace {
  /** Key into {@link FIXTURES}. */
  name: FixtureName;
  /** Title displayed in the demo picker. */
  title: string;
  /** Summary description of the demo trace contents. */
  description: string;
}

/**
 * Curated demo traces offered by the welcome modal picker.
 */
export const DEMOS: DemoTrace[] = [
  {
    name: "unicore",
    title: "Single core demo",
    description:
      "Single-core FreeRTOS capture — tasks, interrupts, data plots and symbolized function traces.",
  },
  {
    name: "dualcore",
    title: "Dual core demo",
    description:
      "The same workload on two cores — scheduling, IPC and interrupts across both, with symbols.",
  },
  {
    name: "zephyr",
    title: "Zephyr demo",
    description:
      "Zephyr's tracing sample — threads, semaphores, a mutex, a timer and the work queue, with kernel objects named from the ELF.",
  },
];

/**
 * Fetch byte buffers from the specified URLs, reporting aggregate download progress to `onProgress`.
 *
 * When responses use gzip encoding, `Content-Length` reflects compressed bytes while streamed chunks contain decompressed bytes; if received bytes exceed `total`, `total` expands to maintain a monotonic progress ratio.
 */
export async function fetchBuffers(
  urls: string[],
  onProgress?: (received: number, total: number) => void,
): Promise<Uint8Array[]> {
  const received = urls.map(() => 0);
  const totals = urls.map(() => 0);
  const report = (): void =>
    onProgress?.(
      received.reduce((a, b) => a + b, 0),
      totals.reduce((a, b) => a + b, 0),
    );
  return Promise.all(
    urls.map(async (u, i) => {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`fetch ${u}: ${res.status}`);
      if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer());
      let got = 0;
      let total = Number(res.headers.get("content-length") ?? 0);
      const chunks: Uint8Array[] = [];
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (got > total) total = got;
        received[i] = got;
        totals[i] = total;
        report();
      }
      const out = new Uint8Array(got);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out;
    }),
  );
}

/**
 * Fetch a named fixture and load it into the application.
 *
 * Network and parse failures update `loadError` in the store rather than rejecting. If a bundled ELF is specified, the application loads it after the trace; ELF loading failures log a warning and continue without symbols.
 */
export async function loadFixture(app: App, name: string): Promise<void> {
  const fx = FIXTURES[name];
  if (!fx) {
    app.store.set({ loadError: `unknown fixture: ${name}` });
    return;
  }
  try {
    await app.showLoading("Downloading demo trace…");
    try {
      const buffers = await fetchBuffers(fx.urls, app.setLoadingProgress);
      await app.showLoading("Processing trace…");
      app.loadBuffers(buffers, fx.files);
    } catch (e) {
      app.store.set({ loadError: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (fx.elf && app.store.get().model !== null) {
      await app.showLoading("Downloading debug symbols…");
      try {
        const [bytes] = await fetchBuffers([fx.elf.url], app.setLoadingProgress);
        await app.showLoading("Loading debug symbols…");
        await app.loadElfBytes(fx.elf.file, bytes!, fx.elf.sha256);
      } catch (e) {
        console.warn("demo ELF load failed:", e); // Continue without symbols on failure.
      }
    }
  } finally {
    app.hideLoading();
  }
}
