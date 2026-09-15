/**
 * Timeline controls bar: the second toolbar row, shown only in the Timeline workspace.
 *
 * Left to right: the Lanes panel toggle, the lane group quick filters with the CPU filter among them, the Events/Logs and Overview toggles, the zoom controls, the find box, and the Navigate menu. Everything is left-aligned and wraps rather than disappearing when the window is narrow.
 *
 * The quick filters drive {@link ../core/store.AppState.groupsOff}; the CPU menu drives `filters.cores`; the find box drives `filters.text`. Match stepping, timestamp entry and event-number entry live in the find bar that the Navigate menu opens.
 *
 * The Export menu at the end of the bar writes the timeline out: the canvas as a PNG, or the runs it is
 * drawing as a table. Both cover the visible window, so exporting is a way of keeping what is on screen.
 */

import { coreHidden, toggleCore } from "../core/filters.js";
import { quickFilterOn, QUICK_FILTERS, toggleQuickFilter } from "../core/lanes/quick-filters.js";
import type { Store } from "../core/store.js";
import type { TimeScale } from "../trace-ui-toolkit/time-scale.js";
import { zoomIn, zoomOut, zoomToFit, zoomToSpan } from "../core/zoom.js";
import { el } from "../trace-ui-toolkit/ui/dom.js";
import { createDropdown, type MenuItem } from "./menu.js";
import { toggleButton } from "./toggle-button.js";
import type { FindBarHandle } from "./find-bar.js";
import { createGoMenu } from "./go-menu.js";
import { createExportMenu } from "./export-menu.js";
import { downloadCanvasPng, exportFileName } from "../core/export.js";
import { cssVar } from "./canvas-util.js";
import { timelineRunsTable } from "./panes/timeline-export.js";

/**
 * How much finer than the screen the exported timeline image is drawn.
 *
 * A capture viewed at its on-screen size is otherwise soft: a Retina canvas is already two device pixels
 * per CSS pixel, and an image viewer showing it "actual size" maps one image pixel back to one CSS pixel,
 * so the export ends up stretched two-fold over the display it was captured on. Doubling again cancels
 * that out and leaves room to enlarge the picture in a document.
 */
const PNG_EXPORT_SCALE = 2;

/** Named zoom presets for the selector. A null span fits the whole trace. */
const ZOOM_PRESETS: { label: string; span: number | null }[] = [
  { label: "Fit", span: null },
  { label: "1 s", span: 1 },
  { label: "100 ms", span: 0.1 },
  { label: "10 ms", span: 0.01 },
  { label: "1 ms", span: 1e-3 },
  { label: "100 µs", span: 1e-4 },
  { label: "10 µs", span: 1e-5 },
];

export interface TimelineControlsCallbacks {
  /** Invoked after the zoom window changes via the selector or step buttons. */
  onZoomChange: () => void;
  /** Toggle the docked Lanes panel. */
  onToggleLanes: () => void;
  /** True while the Lanes panel is open. */
  isLanesOpen: () => boolean;
  /**
   * Render the timeline into a detached canvas at `scale` times its on-screen resolution, for the image
   * export. Null when the timeline is not laid out.
   */
  timelineSnapshot: (scale: number) => HTMLCanvasElement | null;
}

export interface TimelineControlsHandle {
  /** The controls row to place below the application bar. */
  el: HTMLElement;
  /** Refresh the Lanes toggle after the panel is opened or closed elsewhere. */
  syncLanes(): void;
}

export function createTimelineControls(
  store: Store,
  timeScale: TimeScale,
  findBar: FindBarHandle,
  cb: TimelineControlsCallbacks,
): TimelineControlsHandle {
  const lanes = toggleButton({
    label: "Lanes",
    testid: "toggle-lanes",
    title: "Toggle the lane configuration panel",
    onClick: () => {
      cb.onToggleLanes();
      syncLanes();
    },
  });
  const syncLanes = (): void => lanes.setOn(cb.isLanesOpen());
  syncLanes();

  // One toggle per lane group quick filter.
  const filterBtns = QUICK_FILTERS.map((f) => {
    const { el: btn, setOn } = toggleButton({
      label: f.label,
      testid: `filter-${f.key}`,
      title: `Show or hide the ${f.label} lanes`,
      onClick: () => store.set({ groupsOff: toggleQuickFilter(store.get().groupsOff, f) }),
    });
    btn.setAttribute("data-filter", f.key);
    return { f, btn, setOn };
  });
  const renderFilters = (): void => {
    const { groupsOff } = store.get();
    for (const { f, setOn } of filterBtns) setOn(quickFilterOn(groupsOff, f));
  };

  // CPU visibility. `filters.cores` holds the cores switched off, so every core is shown by default
  // and switching all of them off leaves only the core-neutral lanes.
  const cpuMenu = createDropdown({
    label: "CPUs",
    testid: "menu-cpus",
    items: (): MenuItem[] => {
      const s = store.get();
      const cores = s.model ? s.model.traces.map((t) => t.coreId).sort((a, b) => a - b) : [];
      if (!cores.length) return [{ label: "No trace loaded", disabled: true }];
      return cores.map((c) => ({
        label: `CPU ${c}`,
        checked: !coreHidden(s.filters, c),
        testid: `menu-cpu-${c}`,
        onSelect: () => store.set({ filters: toggleCore(store.get().filters, c) }),
      }));
    },
  });
  const cpuTrigger = cpuMenu.el.querySelector(".menu-trigger")!;
  const renderCpus = (): void => {
    const s = store.get();
    const total = s.model ? s.model.traces.length : 0;
    const shown = Math.max(0, total - s.filters.cores.size);
    const filtered = total > 0 && shown < total;
    cpuTrigger.textContent = filtered ? `CPUs ${shown}/${total}` : "CPUs";
    cpuTrigger.classList.toggle("is-active", filtered);
  };

  const dock = toggleButton({
    label: "Events / Logs",
    testid: "toggle-dock",
    title: "Show or hide the Events and Logs panel",
    onClick: () => {
      const d = store.get().dock;
      store.set({ dock: { ...d, hidden: !d.hidden } });
    },
  });
  const overview = toggleButton({
    label: "Overview",
    testid: "toggle-overview",
    title: "Toggle the capture overview strip",
    onClick: () => store.set({ overview: !store.get().overview }),
  });
  const renderToggles = (): void => {
    const s = store.get();
    dock.setOn(!s.dock.hidden);
    overview.setOn(s.overview);
  };

  const zoomSelect = el("select", {
    class: "tb-zoom",
    title: "Zoom level",
    "aria-label": "Zoom level",
    onchange: (e) => {
      const span = ZOOM_PRESETS[(e.target as HTMLSelectElement).selectedIndex]?.span ?? null;
      if (span === null) zoomToFit(store, timeScale);
      else zoomToSpan(store, timeScale, span);
      cb.onZoomChange();
    },
  }) as HTMLSelectElement;
  for (const p of ZOOM_PRESETS) zoomSelect.append(el("option", { text: p.label }));

  const zoomBtn = (
    testid: string,
    text: string,
    title: string,
    run: () => void,
  ): HTMLElement =>
    el("button", {
      class: "tb-btn tb-zoom-btn",
      type: "button",
      "data-testid": testid,
      title,
      text,
      onclick: () => {
        run();
        cb.onZoomChange();
      },
    });

  // Find box. Text entered here narrows the Events and Logs lists.
  const searchInput = el("input", {
    type: "search",
    class: "tb-search-input",
    "data-testid": "tb-search",
    placeholder: "Find events…",
    "aria-label": "Find events",
    oninput: (e) => {
      const value = (e.target as HTMLInputElement).value;
      store.set({ filters: { ...store.get().filters, text: value } });
    },
  }) as HTMLInputElement;
  const search = el("label", { class: "tb-search" }, [
    el("span", { class: "tb-search-icon", "aria-hidden": "true", text: "⌕" }),
    searchInput,
    el("span", { class: "tb-kbd", text: "⌘F" }),
  ]);
  // Keep the box in step with filter text set from elsewhere, such as a reset.
  store.select(["filters"], (s) => {
    if (searchInput.value !== s.filters.text) searchInput.value = s.filters.text;
    renderCpus();
  });

  const navigateMenu = createGoMenu(store, timeScale, findBar);

  const exportMenu = createExportMenu(store, {
    testid: "menu-export-timeline",
    extra: () => [
      {
        label: "Timeline image (PNG)",
        testid: "export-timeline-png",
        onSelect: () => {
          const canvas = cb.timelineSnapshot(PNG_EXPORT_SCALE);
          if (canvas) {
            const name = exportFileName(store.get().sourceNames, "timeline", "png");
            downloadCanvasPng(canvas, name, cssVar("--panel", "#ffffff"));
          }
        },
      },
    ],
    targets: () => [
      { label: "Visible runs", slug: "runs", table: () => timelineRunsTable(store.get()) },
    ],
  });

  renderFilters();
  renderCpus();
  renderToggles();
  store.select(["groupsOff"], renderFilters);
  store.select(["model"], renderCpus);
  store.select(["dock", "overview"], renderToggles);

  const bar = el("div", { class: "controls", "data-testid": "timeline-controls" }, [
    lanes.el,
    el("span", { class: "tb-sep" }),
    filterBtns[0]!.btn,
    filterBtns[1]!.btn,
    filterBtns[2]!.btn,
    cpuMenu.el,
    filterBtns[3]!.btn,
    filterBtns[4]!.btn,
    el("span", { class: "tb-sep" }),
    dock.el,
    overview.el,
    el("span", { class: "tb-sep" }),
    el("label", { class: "tb-label", text: "Zoom" }),
    zoomSelect,
    zoomBtn("tb-zoom-out", "−", "Zoom out (−)", () => zoomOut(store, timeScale, store.get().cursorTime)),
    zoomBtn("tb-zoom-in", "+", "Zoom in (+)", () => zoomIn(store, timeScale, store.get().cursorTime)),
    zoomBtn("tb-zoom-fit", "⤢", "Zoom to fit (0)", () => zoomToFit(store, timeScale)),
    el("span", { class: "tb-sep" }),
    search,
    navigateMenu.el,
    el("span", { class: "tb-sep" }),
    exportMenu.el,
  ]);

  return { el: bar, syncLanes };
}
