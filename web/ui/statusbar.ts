/**
 * Bottom status bar: the shell's passive readouts, shared by both workspaces.
 *
 * Left to right: source file, the loaded ELF, event count, capture length, the visible time range, the A and B reference markers with their delta, and how many lanes the timeline is showing. Load errors take over the right-hand end.
 *
 * Capture and ELF state live here rather than in the application bar, which keeps the bar itself to actions and navigation. Each readout subscribes only to the state slices it reads.
 */

import { formatDuration, formatTime, groupThousands } from "../core/format.js";
import { visibleLaneCounts } from "../core/lanes/selectors.js";
import { suppressedLanes } from "./panes/lanes/suppression.js";
import { sortedByTime } from "../core/references.js";
import type { Store } from "../core/store.js";
import { clear, el } from "../trace-ui-toolkit/ui/dom.js";

export function createStatusBar(store: Store): HTMLElement {
  const source = el("span", { class: "sb-item sb-source", "data-testid": "sb-source" });
  // Loaded application ELF, by filename. Hidden until one is loaded.
  const elf = el("span", { class: "sb-item sb-elf", "data-testid": "sb-elf", hidden: true });
  const events = el("span", { class: "sb-item sb-events", "data-testid": "sb-events", text: "No trace loaded" });
  const duration = el("span", { class: "sb-item sb-duration", "data-testid": "sb-duration" });
  const range = el("span", { class: "sb-item sb-range", "data-testid": "sb-range" });
  const refs = el("span", { class: "sb-item sb-refs", "data-testid": "sb-refs" });
  const lanes = el("span", { class: "sb-item sb-lanes", "data-testid": "sb-lanes" });
  const error = el("span", { class: "sb-item sb-error", "data-testid": "sb-error" });

  const bar = el("footer", { class: "statusbar", "data-testid": "statusbar" }, [
    source,
    elf,
    events,
    duration,
    range,
    refs,
    lanes,
    el("span", { class: "sb-spacer" }),
    error,
  ]);

  const render = (): void => {
    const s = store.get();
    if (s.model) {
      events.textContent = `${groupThousands(s.model.events.length)} events`;
      duration.textContent = `${formatDuration(s.domain.end - s.domain.start)} capture`;
      source.textContent = s.sourceNames.length ? s.sourceNames.join(", ") : "";
    } else {
      events.textContent = "No trace loaded";
      duration.textContent = "";
      source.textContent = "";
    }
    error.textContent = s.loadError ? `⚠ ${s.loadError}` : "";
    error.classList.toggle("has-error", !!s.loadError);
  };

  // Visible time range, reported as its two endpoints at the trace's timer resolution.
  const renderRange = (): void => {
    const s = store.get();
    const { t0, t1 } = s.view;
    range.textContent = `${formatTime(t0, s.timeResolution)}–${formatTime(t1, s.timeResolution)}`;
  };

  /**
   * The first two reference markers in time order, labelled A and B, with the interval between them.
   */
  const renderRefs = (): void => {
    const ordered = sortedByTime(store.get().references);
    const res = store.get().timeResolution;
    const a = ordered[0];
    const b = ordered[1];
    const at = a ? formatTime(a.time, res) : "—";
    const bt = b ? formatTime(b.time, res) : "—";
    const delta = a && b ? formatDuration(Math.abs(b.time - a.time)) : "—";
    refs.textContent = `A ${at}  B ${bt}  Δ ${delta}`;
    refs.classList.toggle("is-measuring", !!(a && b));
  };

  // Lanes the timeline is drawing, against everything the layout holds.
  const renderLanes = (): void => {
    const s = store.get();
    const { shown, total } = visibleLaneCounts(s.laneLayout, suppressedLanes(s));
    lanes.textContent = total ? `${shown}/${total} lanes` : "";
  };

  // Render the loaded ELF by name. An ELF that does not belong to the capture is refused at load rather
  // than kept with a warning beside it, so anything named here is one the capture vouched for.
  const renderElf = (): void => {
    const e = store.get().elf;
    elf.hidden = e === null;
    clear(elf);
    if (!e) {
      elf.title = "";
      return;
    }
    elf.append(el("span", { class: "sb-elf-name", text: e.name }));
    elf.title = `${e.name} — SHA-256 ${e.sha256}`;
  };

  render();
  renderRange();
  renderRefs();
  renderLanes();
  renderElf();
  store.select(["model", "domain", "sourceNames", "loadError"], render);
  store.select(["view", "timeResolution"], renderRange);
  store.select(["references", "timeResolution"], renderRefs);
  store.select(["laneLayout", "groupsOff", "filters", "model"], renderLanes);
  store.select(["elf"], renderElf);
  return bar;
}
