/**
 * Lane configuration panel for editing {@link LaneLayout}.
 *
 * This panel provides editing operations for the lane tree, including adding, removing, reordering, hiding, and grouping lanes. Mutations dispatch pure {@link ../../core/lanes/controller} reducers to synchronize state across the timeline, CPU-load, and Contexts panes.
 *
 * Each lane or group node renders as an indented row containing a drag handle, a visibility checkbox, a label (double-click to rename groups; a lane's source summary rides on its tooltip), up and down buttons that move the node one slot among its siblings, a remove button, and group controls (collapse caret and ungroup action). Dragging a handle also moves a node between groups, which the up and down buttons deliberately do not do. Add affordances render as inline rows at the end of each group and at the root. Selecting `＋ New lane` opens a menu populated from {@link ../../core/lanes/registry.LaneTypeDef.sourceOptions}. Duplicate lanes for the same source are permitted and assigned unique identifiers via {@link uniqueId}.
 *
 * Layout persistence is session-scoped. The panel is implemented as a DOM {@link Pane} docked alongside the timeline.
 */

import {
  addNode,
  findNode,
  moveBefore,
  moveNode,
  removeNode,
  resetHeight,
  setCollapsed,
  setLabel,
  setSource,
  toggleHidden,
  ungroup,
  uniqueId,
} from "../../trace-ui-toolkit/lanes/controller.js";
import {
  isGroup,
  TIMESPAN_LANE,
  type LaneGroup,
  type LaneLayout,
  type LaneLeaf,
  type LaneNode,
  type TimespanSource,
} from "../../core/lanes/types.js";
import { glyphSvg } from "./lanes/functrace-glyph.js";
import { inlineFuncTraceMode } from "./lanes/timespan-lane.js";
import { clear, el } from "../../trace-ui-toolkit/ui/dom.js";
import { Pane } from "../../trace-ui-toolkit/ui/pane.js";
import { suppressedLanes } from "./lanes/suppression.js";
import { visibleLaneCounts } from "../../core/lanes/selectors.js";
import { LANE_DENSITIES } from "../../core/store.js";
import type { PaneContext, PaneHandle } from "./types.js";

/** Per-depth indentation of a row, in CSS px. */
const INDENT = 14;

/** Formats an identifier slug from a label. */
function slug(label: string): string {
  return label.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "lane";
}

export function createLaneConfigPanel(ctx: PaneContext, collapsed = false): PaneHandle {
  const pane = new Pane({ id: "lanes", title: "Lane configuration", collapsed });
  const { store, registry } = ctx;

  const layout = (): LaneLayout => store.get().laneLayout;
  const model = () => store.get().model;

  // Row height for activity lanes, applied by the timeline's layout metrics.
  const density = el("select", {
    class: "lanes-density",
    "data-testid": "lanes-density",
    "aria-label": "Lane row height",
    onchange: (e) => store.set({ laneDensity: Number((e.target as HTMLSelectElement).value) }),
  }) as HTMLSelectElement;
  for (const px of LANE_DENSITIES) density.append(el("option", { value: String(px), text: `${px} px rows` }));

  const counts = el("span", { class: "lanes-count", "data-testid": "lanes-count" });

  const settings = el("div", { class: "lanes-settings" }, [
    el("span", { class: "lanes-settings-label", text: "Density" }),
    density,
    el("span", { class: "lanes-spacer" }),
    counts,
  ]);

  const list = el("div", { class: "lanes-list", "data-testid": "lanes-list", role: "tree" });
  pane.body.append(settings, list);

  const renderSettings = (): void => {
    const s = store.get();
    density.value = String(s.laneDensity);
    const { shown, total } = visibleLaneCounts(s.laneLayout, suppressedLanes(s));
    counts.textContent = total ? `${shown}/${total}` : "";
  };
  renderSettings();
  store.select(["laneDensity", "laneLayout", "groupsOff", "filters", "model"], renderSettings);

  const apply = (next: LaneLayout): void => {
    if (next !== layout()) store.set({ laneLayout: next });
  };

  // ── Mutations ─────────────────────────────────────────────────────────────

  /** Adds a lane of `type` and `source` to the end of `parentId` (or root if `null`). */
  const addLaneInto = (parentId: string | null, type: string, source: unknown, label: string): void => {
    const id = uniqueId(layout(), `${type}:${slug(label)}`);
    const leaf: LaneLeaf = { kind: "lane", id, type, source, label };
    store.set({ laneLayout: addNode(layout(), parentId, leaf, Infinity) });
  };

  const addGroup = (): void => {
    const group: LaneGroup = { kind: "group", id: uniqueId(layout(), "group"), label: "New group", children: [] };
    store.set({ laneLayout: addNode(layout(), null, group, Infinity) });
  };

  // ── Source Menu Popup ──────────────────────────────────────────────────────
  let closeMenu: (() => void) | null = null;
  const dismissMenu = (): void => {
    closeMenu?.();
    closeMenu = null;
  };

  /** Opens the source selection menu for `parentId`, anchored to `anchor`. */
  const openAddMenu = (anchor: HTMLElement, parentId: string | null): void => {
    dismissMenu();
    const m = model();
    if (!m) return;
    const menu = el("div", { class: "lanes-menu", role: "menu" });
    const defs = registry.all();
    for (const def of defs) {
      const opts = def.sourceOptions?.(m) ?? [];
      if (!opts.length) continue;
      if (defs.length > 1) menu.append(el("div", { class: "lanes-menu-head", text: def.displayName }));
      for (const o of opts) {
        menu.append(
          el("button", {
            class: "lanes-menu-item",
            type: "button",
            "data-testid": `lane-add-opt-${slug(o.label)}`,
            text: o.label,
            onclick: () => {
              dismissMenu();
              addLaneInto(parentId, def.type, o.source, o.label);
            },
          }),
        );
      }
    }
    if (!menu.childElementCount) menu.append(el("div", { class: "lanes-menu-empty", text: "No sources" }));

    document.body.append(menu);
    // Anchor below the trigger button, flipping above if viewport height is exceeded.
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.round(r.left)}px`;
    const mh = menu.offsetHeight;
    const below = r.bottom + 2;
    menu.style.top = `${Math.round(below + mh > window.innerHeight && r.top - mh > 0 ? r.top - mh - 2 : below)}px`;

    const onDown = (e: Event): void => {
      if (!menu.contains(e.target as Node) && e.target !== anchor) dismissMenu();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") dismissMenu();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    closeMenu = () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      menu.remove();
    };
  };

  // ── Drag and Drop Reordering ───────────────────────────────────────────────
  let draggingId: string | null = null;
  const dropLine = el("div", { class: "lanes-drop-line" });

  /** Returns the row element under coordinates `(x, y)`, or `null` if none exists. */
  const rowAtPoint = (x: number, y: number): HTMLElement | null => {
    const row = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest("[data-lane-row]");
    return row instanceof HTMLElement ? row : null;
  };

  /** Renders a visual drop target: an insertion line above a lane row, or highlight over a group row. */
  const showDropTarget = (x: number, y: number): void => {
    list.querySelectorAll(".is-drop-into").forEach((e) => e.classList.remove("is-drop-into"));
    const row = rowAtPoint(x, y);
    if (!row || row.dataset["laneRow"] === draggingId) {
      dropLine.remove();
      return;
    }
    if (row.classList.contains("lanes-row-group")) {
      row.classList.add("is-drop-into"); // Target is inside the group.
      dropLine.remove();
    } else {
      dropLine.style.top = `${row.offsetTop}px`;
      list.append(dropLine);
    }
  };

  const clearDropTarget = (): void => {
    dropLine.remove();
    list.querySelectorAll(".is-drop-into").forEach((e) => e.classList.remove("is-drop-into"));
    list.querySelectorAll(".is-drag-src").forEach((e) => e.classList.remove("is-drag-src"));
    list.classList.remove("is-dragging");
  };

  /** Inserts the dragged node at coordinates `(x, y)`: inside a group or preceding a lane. */
  const dropAt = (id: string, x: number, y: number): void => {
    const row = rowAtPoint(x, y);
    const targetId = row?.dataset["laneRow"];
    if (!targetId) {
      apply(moveNode(layout(), id, null, Infinity)); // Released outside rows: append to root.
      return;
    }
    if (targetId === id) return;
    const target = findNode(layout(), targetId);
    if (target && isGroup(target.node)) apply(moveNode(layout(), id, targetId, Infinity));
    else apply(moveBefore(layout(), id, targetId));
  };

  /** Creates a pointer-captured drag handle for node `id`. */
  const dragHandle = (id: string): HTMLElement => {
    const handle = el("span", {
      class: "lanes-handle",
      "data-testid": `lane-handle-${id}`,
      title: "Drag to reorder",
      text: "⋮⋮",
    });
    handle.addEventListener("pointerdown", (e) => {
      draggingId = id;
      handle.setPointerCapture(e.pointerId);
      list.classList.add("is-dragging");
      handle.closest("[data-lane-row]")?.classList.add("is-drag-src");
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (draggingId) showDropTarget(e.clientX, e.clientY);
    });
    const end = (e: PointerEvent): void => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      clearDropTarget();
      if (draggingId) dropAt(draggingId, e.clientX, e.clientY);
      draggingId = null;
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    return handle;
  };

  // ── Rendering ──────────────────────────────────────────────────────────────

  /** Moves `id` one slot up (`-1`) or down (`+1`) among its siblings. */
  const moveBy = (id: string, delta: -1 | 1): void => {
    const loc = findNode(layout(), id);
    if (!loc) return;
    const to = loc.index + delta;
    if (to < 0 || to >= loc.siblings.length) return;
    apply(moveNode(layout(), id, loc.parent?.id ?? null, to));
  };

  /** Returns the visibility checkbox that leads a row. */
  const visibleBox = (node: LaneNode): HTMLElement => {
    const label = node.label ?? node.id;
    const box = el("input", {
      class: "lanes-visible",
      type: "checkbox",
      "aria-label": `Show ${label}`,
      title: node.hidden ? "Show" : "Hide",
      "data-testid": `lane-hide-${node.id}`,
      onchange: () => apply(toggleHidden(layout(), node.id)),
    }) as HTMLInputElement;
    box.checked = !node.hidden;
    return box;
  };

  /** Returns the up, down and remove buttons that close a row. */
  const rowActions = (node: LaneNode, index: number, count: number): HTMLElement[] => [
    el("button", {
      class: "lanes-icon lanes-move",
      type: "button",
      title: "Move up",
      "data-testid": `lane-up-${node.id}`,
      text: "↑",
      disabled: index === 0,
      onclick: () => moveBy(node.id, -1),
    }),
    el("button", {
      class: "lanes-icon lanes-move",
      type: "button",
      title: "Move down",
      "data-testid": `lane-down-${node.id}`,
      text: "↓",
      disabled: index === count - 1,
      onclick: () => moveBy(node.id, 1),
    }),
    el("button", {
      class: "lanes-icon lanes-remove",
      type: "button",
      title: "Remove",
      "data-testid": `lane-remove-${node.id}`,
      text: "✕",
      onclick: () => apply(removeNode(layout(), node.id)),
    }),
  ];

  /** Creates an editable label element that switches to an input field on double-click. */
  const groupLabel = (group: LaneGroup): HTMLElement => {
    const label = el("span", {
      class: "lanes-label lanes-group-label",
      "data-testid": `lane-label-${group.id}`,
      title: "Double-click to rename",
      text: group.label,
    });
    label.addEventListener("dblclick", () => {
      const input = el("input", {
        class: "lanes-rename",
        "data-testid": `lane-rename-${group.id}`,
        value: group.label,
      }) as HTMLInputElement;
      const commit = (): void => {
        const name = input.value.trim();
        if (name && name !== group.label) apply(setLabel(layout(), group.id, name));
        else render();
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur();
        else if (e.key === "Escape") render();
      });
      label.replaceWith(input);
      input.focus();
      input.select();
    });
    return label;
  };

  const renderGroupRow = (group: LaneGroup, depth: number, index: number, count: number): HTMLElement => {
    const caret = el("button", {
      class: "lanes-caret",
      type: "button",
      title: group.collapsed ? "Expand" : "Collapse",
      "aria-expanded": group.collapsed ? "false" : "true",
      "data-testid": `lane-caret-${group.id}`,
      text: group.collapsed ? "▸" : "▾",
      onclick: () => apply(setCollapsed(layout(), group.id)),
    });
    return el(
      "div",
      {
        class: `lanes-row lanes-row-group${group.hidden ? " is-hidden" : ""}`,
        role: "treeitem",
        "data-lane-row": group.id,
        "data-testid": `lane-row-${group.id}`,
        style: `padding-left:${depth * INDENT}px`,
      },
      [
        caret,
        dragHandle(group.id),
        visibleBox(group),
        groupLabel(group),
        el("span", { class: "lanes-spacer" }),
        el("button", {
          class: "lanes-icon lanes-ungroup",
          type: "button",
          title: "Ungroup (keep its lanes)",
          "data-testid": `lane-ungroup-${group.id}`,
          text: "⤢",
          onclick: () => apply(ungroup(layout(), group.id)),
        }),
        ...rowActions(group, index, count),
      ],
    );
  };

  /**
   * Creates the function trace disclosure toggle for a context lane with instrumented function calls.
   */
  const funcTraceControl = (lane: LaneLeaf): HTMLElement[] => {
    if (lane.type !== TIMESPAN_LANE) return [];
    const src = lane.source as TimespanSource;
    if (src.kind !== "context") return [];
    const mode = inlineFuncTraceMode(model(), src);
    if (mode === "off") return [];
    const expanded = mode === "expanded";
    return [
      el(
        "button",
        {
          class: `lanes-icon lanes-functrace${expanded ? " is-expanded" : ""}`,
          type: "button",
          title: expanded ? "Collapse the flame graph" : "Expand the flame graph",
          "aria-pressed": expanded ? "true" : "false",
          "data-testid": `lane-functrace-${lane.id}`,
          "data-mode": expanded ? "expanded" : "peek",
          onclick: () => {
            const source: TimespanSource = { ...src, funcTrace: expanded ? "peek" : "expanded" };
            apply(resetHeight(setSource(layout(), lane.id, source), lane.id));
          },
        },
        [glyphSvg()],
      ),
    ];
  };

  const renderLaneRow = (lane: LaneLeaf, depth: number, index: number, count: number): HTMLElement => {
    const def = registry.get(lane.type);
    const accent = def?.accentColor?.(lane.source) ?? "var(--lane-text, #b4b4b4)";
    const summary = def ? def.describe(lane.source, model()) : lane.type;
    const label = lane.label ?? summary;
    return el(
      "div",
      {
        class: `lanes-row lanes-row-lane${lane.hidden ? " is-hidden" : ""}`,
        role: "treeitem",
        "data-lane-row": lane.id,
        "data-testid": `lane-row-${lane.id}`,
        style: `padding-left:${depth * INDENT + INDENT}px`, // Align with group caret.
      },
      [
        dragHandle(lane.id),
        visibleBox(lane),
        el("span", { class: "lanes-swatch", style: `background:${accent}` }),
        el("span", {
          class: "lanes-label",
          "data-testid": `lane-label-${lane.id}`,
          // The row has no space for the source summary beside the name; it rides on the tooltip instead.
          title: summary && summary !== label ? `${label} — ${summary}` : label,
          text: label,
        }),
        el("span", { class: "lanes-spacer" }),
        ...funcTraceControl(lane),
        ...rowActions(lane, index, count),
      ],
    );
  };

  /** Creates a `＋ New lane` button row for `parentId`. */
  const addLaneRow = (parentId: string | null, depth: number): HTMLElement => {
    const btn = el("button", {
      class: "lanes-add-trigger",
      type: "button",
      "aria-haspopup": "menu",
      "data-testid": parentId === null ? "lane-add" : `lane-add-${parentId}`,
      text: "＋ New lane",
      onclick: () => openAddMenu(btn, parentId),
    });
    return el(
      "div",
      { class: "lanes-row lanes-row-add", style: `padding-left:${depth * INDENT + INDENT}px` },
      [btn],
    );
  };

  /** Creates a root-level `＋ New group` button row. */
  const addGroupRow = (): HTMLElement =>
    el("div", { class: "lanes-row lanes-row-add" }, [
      el("button", {
        class: "lanes-add-trigger",
        type: "button",
        "data-testid": "lane-new-group",
        text: "＋ New group",
        onclick: () => addGroup(),
      }),
    ]);

  /** Recursively renders tree nodes as indented rows. */
  const renderNodes = (nodes: readonly LaneNode[], depth: number): void => {
    for (const [i, n] of nodes.entries()) {
      if (isGroup(n)) {
        list.append(renderGroupRow(n, depth, i, nodes.length));
        if (!n.collapsed) {
          renderNodes(n.children, depth + 1);
          list.append(addLaneRow(n.id, depth + 1)); // Add lane button inside this group.
        }
      } else {
        list.append(renderLaneRow(n, depth, i, nodes.length));
      }
    }
  };

  const render = (): void => {
    dismissMenu();
    clear(list);
    if (!model()) {
      list.append(el("div", { class: "lanes-empty", text: "Open a trace to configure lanes." }));
      return;
    }
    renderNodes(layout().roots, 0);
    list.append(addLaneRow(null, 0)); // Add lane button at root.
    list.append(addGroupRow()); // Add group button at root.
  };

  render();
  store.select(["laneLayout", "model"], render);

  return { pane };
}
