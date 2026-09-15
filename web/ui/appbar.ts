/**
 * Application bar: the top row of the shell, present in every workspace.
 *
 * Holds the product mark, the File menu (open, ELF, save, clear), the workspace switch between Timeline and Statistics, the light/dark toggle, and the help button. Its rows are named for what they do and nothing else — which file is loaded is the status bar's job, and every row opens a file dialog, so none of them carries an ellipsis to distinguish itself. Controls that only make sense for one workspace live in that workspace's own bar — see {@link ./timeline-controls}.
 *
 * Capture and ELF state are reported in the status bar rather than here.
 */

import type { Store, Workspace } from "../core/store.js";
import { nextThemeChoice, setThemeChoice, themeChoice, type ThemeChoice } from "../core/theme.js";
import { el } from "../trace-ui-toolkit/ui/dom.js";
import { createDropdown, type MenuItem } from "./menu.js";

export interface AppBarCallbacks {
  /** Invoked when the user picks trace files to open. */
  onOpenFiles: (files: FileList) => void;
  /** Invoked when the user picks an ELF to load for symbolization. */
  onLoadElf: (file: File) => void;
  /** Invoked when the user asks to write the loaded trace to disk. */
  onSaveTrace: () => void;
  /** Invoked when the user asks to discard the loaded trace. */
  onClearTrace: () => void;
  /** Open the welcome and help modal. */
  onShowWelcome: () => void;
}

/** A mounted application bar: the header element plus imperative hooks. */
export interface AppBarHandle {
  /** The `<header>` to place at the top of the app. */
  el: HTMLElement;
  /** Pop the native file chooser using the hidden trace file input. */
  openFilePicker(): void;
}

/** The workspaces offered by the switch, in display order. */
const WORKSPACES: { id: Workspace; label: string }[] = [
  { id: "timeline", label: "Timeline" },
  { id: "statistics", label: "Statistics" },
];

export function createAppBar(store: Store, cb: AppBarCallbacks): AppBarHandle {
  const fileInput = el("input", {
    type: "file",
    accept: ".svdat",
    multiple: true,
    class: "visually-hidden",
    onchange: (e) => {
      const input = e.target as HTMLInputElement;
      if (input.files && input.files.length) cb.onOpenFiles(input.files);
      input.value = "";
    },
  }) as HTMLInputElement;

  // Application ELF for symbol resolution and trace verification. Can be loaded before or after trace data.
  const elfInput = el("input", {
    type: "file",
    accept: ".elf",
    class: "visually-hidden",
    onchange: (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (file) cb.onLoadElf(file);
      input.value = "";
    },
  }) as HTMLInputElement;

  const fileMenu = createDropdown({
    label: "File",
    testid: "menu-file",
    items: (): MenuItem[] => {
      const hasModel = store.get().model !== null;
      return [
        { label: "Open Trace", testid: "menu-open", onSelect: () => fileInput.click() },
        { label: "Load ELF", testid: "menu-elf", onSelect: () => elfInput.click() },
        { separator: true },
        {
          label: "Save Trace",
          testid: "menu-save",
          disabled: !hasModel,
          onSelect: () => cb.onSaveTrace(),
        },
        {
          label: "Clear Trace",
          testid: "menu-clear",
          disabled: !hasModel,
          onSelect: () => cb.onClearTrace(),
        },
      ];
    },
  });

  // Workspace switch. Only one analysis surface is on screen at a time.
  const tabs = WORKSPACES.map(({ id, label }) =>
    el("button", {
      class: "workspace-tab",
      type: "button",
      role: "tab",
      "data-workspace": id,
      "data-testid": `workspace-${id}`,
      text: label,
      onclick: () => store.set({ workspace: id }),
    }),
  );
  const renderTabs = (): void => {
    const active = store.get().workspace;
    tabs.forEach((tab, i) => {
      const on = WORKSPACES[i]!.id === active;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    });
  };
  renderTabs();
  store.select(["workspace"], renderTabs);

  /** How each theme choice presents itself on the button. */
  const THEME_FACE: Readonly<Record<ThemeChoice, { glyph: string; name: string }>> = {
    auto: { glyph: "◐", name: "following the system" },
    light: { glyph: "☀", name: "light" },
    dark: { glyph: "☾", name: "dark" },
  };

  // The button cycles auto → light → dark → auto, so an explicit choice is never a one-way door.
  let choice = themeChoice();
  const themeBtn = el("button", { class: "tb-btn tb-theme", type: "button", "data-testid": "tb-theme" });
  const renderTheme = (): void => {
    const face = THEME_FACE[choice];
    const next = THEME_FACE[nextThemeChoice(choice)].name;
    themeBtn.textContent = face.glyph;
    themeBtn.title = `Theme: ${face.name} — switch to ${next}`;
    themeBtn.setAttribute("aria-label", `Theme: ${face.name}. Switch to ${next}.`);
    themeBtn.dataset["themeChoice"] = choice;
  };
  themeBtn.addEventListener("click", () => {
    choice = nextThemeChoice(choice);
    setThemeChoice(choice);
    renderTheme();
  });
  renderTheme();

  const helpBtn = el("button", {
    class: "tb-btn tb-help",
    type: "button",
    "data-testid": "tb-welcome",
    text: "?",
    title: "Show the welcome screen",
    "aria-label": "Help",
    onclick: () => cb.onShowWelcome(),
  });

  const brand = el("span", { class: "brand" }, [
    el("span", { class: "brand-mark", "aria-hidden": "true" }, [
      el("i"),
      el("i"),
      el("i"),
    ]),
    el("span", { class: "brand-name", text: "ESP Trace Viewer" }),
  ]);

  return {
    el: el("header", { class: "appbar", "data-testid": "appbar" }, [
      brand,
      fileInput,
      elfInput,
      fileMenu.el,
      el("span", { class: "tb-sep" }),
      el("nav", { class: "workspace-tabs", role: "tablist", "aria-label": "Workspace" }, tabs),
      el("span", { class: "tb-sep" }),
      themeBtn,
      helpBtn,
    ]),
    openFilePicker: () => fileInput.click(),
  };
}
