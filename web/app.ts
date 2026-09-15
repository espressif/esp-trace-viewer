/**
 * Application shell: constructs the multi-pane layout and connects shared state infrastructure (store, {@link TimeScale}, rAF scheduler) to each pane.
 *
 * Layout arrangement: an application bar over a Timeline controls bar, then one workspace at a time. The Timeline workspace holds the Lanes panel, the timeline itself (hosting activity, CPU load, and DataPlot lanes), and the Events/Logs dock; the Statistics workspace fills the same area with the per-context table. A status bar reports capture, reference and lane state under both.
 *
 * The shell manages file loading: parses buffers via {@link ../core/open-files.buildLoad}, fits the TimeScale to the trace domain, and updates the store. Panes update reactively. Parse failures are reported non-fatally in the status bar.
 */

import { buildLoad } from "./core/open-files.js";
import { loadElf as decodeElf, verifyElfHash } from "../src/elf/index.js";
import { traceElfSha256 } from "../src/trace/index.js";
import type { ElfState } from "./core/store.js";
import { buildDefaultLayout, reconcileAuto } from "./core/lanes/default-layout.js";
import { LANE_LAYOUT_VERSION } from "./core/lanes/types.js";
import { embedLayoutInHeader, extractLayoutFromHeader } from "./core/lanes/svdat-embed.js";
import { createLaneRegistry } from "./ui/panes/lanes/registry-instance.js";
import { downloadTrace } from "./core/save-trace.js";
import { loadFixture } from "./core/fixtures.js";
import { loadLayout, loadPref, savePref } from "./trace-ui-toolkit/layout-store.js";
import { RafScheduler } from "./trace-ui-toolkit/raf-scheduler.js";
import { initialState, Store, type DockTab } from "./core/store.js";
import { installTestApi } from "./core/test-api.js";
import { initTheme, onThemeChange } from "./core/theme.js";
import { TimeScale } from "./trace-ui-toolkit/time-scale.js";
import { createAppBar } from "./ui/appbar.js";
import { createTimelineControls } from "./ui/timeline-controls.js";
import { createDock } from "./ui/dock.js";
import { createFindBar } from "./ui/find-bar.js";
import { installFilterAccelerators } from "./ui/class-filter.js";
import { createStatusBar } from "./ui/statusbar.js";
import {
  createWelcomeModal,
  welcomeHiddenOnStartup,
  type WelcomeModalHandle,
} from "./ui/welcome-modal.js";
import { installZoomKeys } from "./ui/zoom-keys.js";
import { createLoadingOverlay } from "./ui/loading-overlay.js";
import { el } from "./trace-ui-toolkit/ui/dom.js";
import { split } from "./trace-ui-toolkit/ui/splitter.js";
import { PANE_LAYOUT_EVENT } from "./trace-ui-toolkit/ui/pane.js";
import { createEventsPane } from "./ui/panes/events-pane.js";
import { createLogsPane } from "./ui/panes/logs-pane.js";
import { createTimelinePane } from "./ui/panes/timeline-pane.js";
import { createLaneConfigPanel } from "./ui/panes/lane-config-panel.js";
import { createStatisticsPane } from "./ui/panes/statistics-pane.js";
import type { PaneContext, PaneHandle, PaneIntrospection } from "./ui/panes/types.js";

/** Application handle used by the entry layer to load traces and control application state. */
export interface App {
  store: Store;
  timeScale: TimeScale;
  /** Load pre-fetched trace byte buffers. */
  loadBuffers(buffers: Uint8Array[], names: string[]): void;
  /** Load trace files selected through a file picker or drop event. */
  loadFiles(files: FileList | File[]): Promise<void>;
  /**
   * Load an application ELF file: parse symbols, check its SHA-256 digest against the trace, and reprocess the model with the symbolizer. An ELF the capture disowns is refused, leaving any previously loaded one in place.
   */
  loadElf(file: File): Promise<void>;
  /**
   * Load pre-fetched ELF byte buffers. `declaredSha256` overrides the byte hash when using stripped binaries matching the target build digest. Throws on malformed ELF input; an ELF whose digest the capture disowns is refused and reported through `loadError`.
   */
  loadElfBytes(name: string, bytes: Uint8Array, declaredSha256?: string): Promise<void>;
  /** Save the loaded trace back to `.svdat` files. No-op before any load. */
  saveTrace(): void;
  /** Discard the loaded trace, restoring an empty workspace. */
  clearTrace(): void;
  /**
   * Display or update the loading overlay with a stage label. Resolves after the label paints to allow DOM updates before synchronous processing.
   */
  showLoading(label: string): Promise<void>;
  /**
   * Update download progress in the loading overlay with received and total bytes.
   */
  setLoadingProgress(received: number, total: number): void;
  /** Hide the loading overlay. */
  hideLoading(): void;
  /** Open the welcome modal. */
  openWelcome(): void;
  /** Open the welcome modal on startup when no trace is loaded, unless disabled by user preference. */
  maybeShowWelcome(): void;
}

export function mountApp(root: HTMLElement): App {
  // Paints the stored choice and starts following the OS; the app bar owns the choice from here.
  initTheme();
  const store = new Store(initialState());
  const timeScale = new TimeScale({ domainStart: 0, domainEnd: 1 });
  const scheduler = new RafScheduler();
  const registry = createLaneRegistry();
  const ctx: PaneContext = { store, timeScale, scheduler, registry };

  // Request a canvas redraw across all panes when the active theme changes.
  onThemeChange(() => scheduler.requestDraw());

  // Retain source byte buffers to enable direct export without re-encoding.
  let loaded: { buffers: Uint8Array[]; names: string[] } | null = null;

  const loadBuffers = (buffers: Uint8Array[], names: string[]): void => {
    try {
      // A retained ELF carries across trace loads, but only while it belongs to the capture being opened.
      // The digest to check it against only exists once the trace is parsed, so the model is built with the
      // symbols and then built again without them in the rare case the capture disowns the file.
      const elfState = store.get().elf;
      let res = buildLoad(buffers, names, elfState ? { elf: elfState.symbols } : {});
      const staleElf =
        elfState !== null && verifyElfHash(traceElfSha256(res.model), elfState.sha256) === "mismatch";
      if (staleElf) res = buildLoad(buffers, names, {});
      timeScale.setDomain(res.domain.start, res.domain.end);
      timeScale.zoomToFit();
      // Restore any lane layout embedded in the file header. Reconcile against the model to update auto-populated groups, or fall back to the default layout.
      const embedded = buffers.map(extractLayoutFromHeader).find((l) => l !== null);
      const laneLayout = embedded
        ? reconcileAuto(embedded, res.model)
        : buildDefaultLayout(res.model);
      store.set({
        model: res.model,
        sourceNames: res.sourceNames,
        domain: res.domain,
        laneLayout,
        timeResolution: res.timeResolution,
        view: { t0: timeScale.t0, t1: timeScale.t1 },
        selectedEventIndex: null,
        selectionAnchorIndex: null,
        selectedContext: null,
        cursorTime: null,
        loadError: staleElf ? `${elfState!.name} was not built from this capture, and has been unloaded.` : null,
        ...(staleElf ? { elf: null } : {}),
      });
      loaded = { buffers, names: res.sourceNames };
      scheduler.requestDraw();
    } catch (e) {
      store.set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  };

  const saveTrace = (): void => {
    if (!loaded) return;
    // Embed the current lane layout into the file header, preserving binary event payloads.
    const layout = store.get().laneLayout;
    const buffers = loaded.buffers.map((b) => embedLayoutInHeader(b, layout));
    downloadTrace(buffers, loaded.names);
  };

  // Discard the active trace, restoring model, layout, and view state to defaults.
  const clearTrace = (): void => {
    if (store.get().model === null) return;
    timeScale.setDomain(0, 1);
    timeScale.zoomToFit();
    store.set({
      model: null,
      elf: null,
      sourceNames: [],
      domain: { start: 0, end: 1 },
      laneLayout: { version: LANE_LAYOUT_VERSION, roots: [] },
      references: [],
      timeResolution: 0,
      view: { t0: timeScale.t0, t1: timeScale.t1 },
      selectedEventIndex: null,
      selectionAnchorIndex: null,
      selectedContext: null,
      cursorTime: null,
      loadError: null,
    });
    loaded = null;
    scheduler.requestDraw();
  };

  // Render the loading overlay before starting synchronous parsing on the main thread.
  const loading = createLoadingOverlay();

  const loadFiles = async (files: FileList | File[]): Promise<void> => {
    // Sort input files lexicographically to preserve core ordering for multi-core traces.
    const list = Array.from(files).sort((a, b) => a.name.localeCompare(b.name));
    if (list.length === 0) return;
    await loading.show(`Loading ${list.map((f) => f.name).join(", ")}…`);
    try {
      const buffers = await Promise.all(
        list.map((f) => f.arrayBuffer().then((b) => new Uint8Array(b))),
      );
      loadBuffers(buffers, list.map((f) => f.name));
    } finally {
      loading.hide();
    }
  };

  // Reprocess retained buffers with current ELF symbols while preserving viewport, lane layout, and selection.
  const reprocessWithElf = (): void => {
    const symbols = store.get().elf?.symbols;
    if (!loaded || store.get().model === null) return;
    try {
      const res = buildLoad(loaded.buffers, loaded.names, symbols ? { elf: symbols } : {});
      store.set({ model: res.model });
      scheduler.requestDraw();
    } catch (e) {
      setLoadError(e);
    }
  };

  /**
   * Decode ELF bytes, check them against the capture's embedded hash, and re-symbolize the model.
   * `declaredSha256` overrides the byte digest for stripped binaries carrying the target build's hash.
   * Throws on malformed ELF input.
   *
   * A file the capture disowns is refused outright rather than loaded with a warning beside it: symbols
   * from the wrong build are worse than no symbols, because every address still resolves to a name. With
   * no trace open, or with a capture that recorded no hash, there is nothing to check and the file loads.
   */
  const applyElfBytes = async (
    name: string,
    bytes: Uint8Array,
    declaredSha256?: string,
  ): Promise<void> => {
    const elf = await decodeElf(bytes);
    const sha256 = declaredSha256 ?? elf.sha256;
    const model = store.get().model;
    if (verifyElfHash(model ? traceElfSha256(model) : null, sha256) === "mismatch") {
      // Any ELF already loaded stays: it was checked against this same capture on the way in.
      store.set({ loadError: `${name} was not built from this capture, so it was not loaded.` });
      return;
    }
    const elfState: ElfState = { name, sha256, symbols: elf.symbols };
    store.set({ elf: elfState, loadError: null });
    reprocessWithElf();
  };

  const loadElf = async (file: File): Promise<void> => {
    await loading.show(`Loading ${file.name}…`);
    try {
      await applyElfBytes(file.name, new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      setLoadError(e);
    } finally {
      loading.hide();
    }
  };

  // Connect welcome modal actions to toolbar file selection and modal open handlers.
  let welcome: WelcomeModalHandle;

  const app: App = {
    store,
    timeScale,
    loadBuffers,
    loadFiles,
    loadElf,
    loadElfBytes: applyElfBytes,
    saveTrace,
    clearTrace,
    showLoading: (label) => loading.show(label),
    setLoadingProgress: (received, total) => loading.setProgress(received, total),
    hideLoading: () => loading.hide(),
    openWelcome: () => welcome.open(),
    maybeShowWelcome: () => {
      if (store.get().model === null && !welcomeHiddenOnStartup()) welcome.open();
    },
  };

  const layout = loadLayout();

  const events = createEventsPane(ctx);
  const logs = createLogsPane(ctx);
  const timeline = createTimelinePane(ctx);
  // The Lanes configuration panel docks to the left of the timeline and starts closed.
  const lanesOpen = !(layout.collapsed["lanes"] ?? true);
  const lanesPanel = createLaneConfigPanel(ctx, !lanesOpen);
  const statistics = createStatisticsPane(ctx);

  const setLoadError = (e: unknown): void => {
    store.set({ loadError: e instanceof Error ? e.message : String(e) });
  };

  // Restore the dock placement chosen in an earlier session. Right docking is the default at every width.
  store.set({
    dock: {
      side: loadPref<string>("dock.side", "right") === "bottom" ? "bottom" : "right",
      tab: loadPref("dock.tab", "events") as DockTab,
      hidden: loadPref("dock.hidden", false),
    },
    overview: loadPref("overview", true),
    laneDensity: loadPref("laneDensity", 20),
  });

  const dock = createDock(store, { events: events.pane.el, logs: logs.pane.el });

  // Timeline workspace: the Lanes panel, then the timeline with the Events/Logs dock beside or below it.
  const analysis = split({
    orientation: "row",
    id: "dock",
    a: timeline.pane.el,
    b: dock.el,
    defaultFraction: 0.66,
    label: "Resize the Events and Logs panel",
  });
  const timelineWorkspace = split({
    orientation: "row",
    id: "lanes",
    a: lanesPanel.pane.el,
    b: analysis.el,
    defaultFraction: 0.18,
    label: "Resize the lane configuration panel",
  });
  timelineWorkspace.el.classList.add("workspace", "workspace-timeline");
  statistics.pane.el.classList.add("workspace", "workspace-statistics");

  const body = el("div", { class: "workspace-body" }, [timelineWorkspace.el, statistics.pane.el]);

  // Dock placement. Hiding the dock takes it out of the split so the timeline claims the full width.
  const applyDock = (): void => {
    const { side, hidden } = store.get().dock;
    analysis.setOrientation(side === "bottom" ? "column" : "row");
    dock.el.style.display = hidden ? "none" : "";
    dock.el.dispatchEvent(new CustomEvent(PANE_LAYOUT_EVENT, { bubbles: true }));
    savePref("dock.side", side);
    savePref("dock.hidden", hidden);
    savePref("dock.tab", store.get().dock.tab);
    scheduler.requestDraw();
  };
  applyDock();
  store.select(["dock"], applyDock);

  // Workspace switch. Exactly one analysis surface is in the layout at a time.
  const applyWorkspace = (): void => {
    const timelineOn = store.get().workspace === "timeline";
    timelineWorkspace.el.style.display = timelineOn ? "" : "none";
    statistics.pane.el.style.display = timelineOn ? "none" : "";
    controls.el.style.display = timelineOn ? "" : "none";
    scheduler.requestDraw();
  };

  const appbar = createAppBar(store, {
    onOpenFiles: (files) => void loadFiles(files),
    onLoadElf: (file) => void loadElf(file),
    onSaveTrace: saveTrace,
    onClearTrace: clearTrace,
    onShowWelcome: () => welcome.open(),
  });

  const findBar = createFindBar(store);
  const controls = createTimelineControls(store, timeScale, findBar, {
    onZoomChange: () => scheduler.requestDraw(),
    onToggleLanes: () => lanesPanel.pane.setCollapsed(!lanesPanel.pane.isCollapsed),
    isLanesOpen: () => !lanesPanel.pane.isCollapsed,
    timelineSnapshot: (scale) => timeline.snapshot(scale),
  });

  applyWorkspace();
  store.select(["workspace"], applyWorkspace);
  store.select(["overview"], (s) => savePref("overview", s.overview));
  store.select(["laneDensity"], (s) => savePref("laneDensity", s.laneDensity));

  const statusbar = createStatusBar(store);

  // Welcome modal actions: open bundled demo traces or launch the file picker.
  welcome = createWelcomeModal({
    onOpenDemo: (name) => void loadFixture(app, name),
    onOpenFromPc: () => appbar.openFilePicker(),
  });
  // Dismiss the welcome modal when a trace model is loaded.
  store.select(["model"], (s) => {
    if (s.model !== null) welcome.close();
  });

  const dropOverlay = el("div", { class: "drop-overlay", "data-testid": "drop-overlay" }, [
    el("div", { class: "drop-hint", text: "Drop a .svdat trace or an .elf to open" }),
  ]);

  root.append(
    el("div", { class: "app" }, [
      appbar.el,
      controls.el,
      findBar.el,
      body,
      statusbar,
      dropOverlay,
      welcome.el,
      loading.el,
    ]),
  );

  // Route dropped files by file extension, loading traces before ELFs to verify hashes against the loaded model.
  const openDropped = async (files: FileList): Promise<void> => {
    const all = Array.from(files);
    const isElf = (f: File): boolean => f.name.toLowerCase().endsWith(".elf");
    const traces = all.filter((f) => !isElf(f));
    if (traces.length) await loadFiles(traces);
    for (const f of all.filter(isElf)) await loadElf(f);
  };
  wireDragAndDrop(root, dropOverlay, (files) => void openDropped(files));

  // Register global keyboard shortcuts for zoom and pan operations, and the event-class filter accelerators.
  installZoomKeys(store, timeScale);
  installFilterAccelerators(store);

  exposeTestApi(app, scheduler, [events, logs, timeline, lanesPanel, statistics]);

  // Schedule canvas redraw on window resize.
  window.addEventListener("resize", () => scheduler.requestDraw());
  scheduler.requestDraw();
  return app;
}

/**
 * Attach the test introspection interface (`window.__traceViewer`) in test and development builds.
 */
function exposeTestApi(app: App, scheduler: RafScheduler, handles: PaneHandle[]): void {
  if (!(import.meta.env.DEV || import.meta.env.MODE === "test")) return;
  const panes = new Map<string, () => PaneIntrospection>();
  for (const h of handles) {
    if (h.introspect) panes.set(h.pane.id, h.introspect);
  }
  installTestApi({ app, scheduler, panes });
}

/** Configure window-level drag-and-drop event handlers for trace and ELF files. */
function wireDragAndDrop(root: HTMLElement, overlay: HTMLElement, onFiles: (f: FileList) => void): void {
  let depth = 0;
  const show = (on: boolean): void => {
    overlay.classList.toggle("is-active", on);
  };
  root.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (++depth === 1) show(true);
  });
  root.addEventListener("dragover", (e) => e.preventDefault());
  root.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (--depth <= 0) {
      depth = 0;
      show(false);
    }
  });
  root.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    show(false);
    if (e.dataTransfer?.files?.length) onFiles(e.dataTransfer.files);
  });
}
