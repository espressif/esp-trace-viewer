/**
 * Welcome and launch modal dialog for onboarding routes.
 *
 * Appears when starting with no trace loaded, offering two onboarding routes: open a bundled demo trace, or open a trace file from the user's machine. Both routes dispatch to caller callbacks.
 *
 * The demo route displays a picker view of bundled traces ({@link ../core/fixtures.DEMOS}). Selecting a demo closes the modal and invokes {@link WelcomeRoutes.onOpenDemo}.
 *
 * Modal dismisses via Escape, backdrop click, or close button. A startup checkbox persists display preferences to `localStorage`, read via {@link welcomeHiddenOnStartup}.
 */

import { DEMOS, type FixtureName } from "../core/fixtures.js";
import { el } from "../trace-ui-toolkit/ui/dom.js";

/** `localStorage` key for the "don't show the welcome modal on startup" flag. */
const HIDE_KEY = "trace-viewer.welcome.hideOnStartup.v1";

/** Whether the user opted out of the startup welcome modal (persisted). */
export function welcomeHiddenOnStartup(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
}

function setWelcomeHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(HIDE_KEY, "1");
    else localStorage.removeItem(HIDE_KEY);
  } catch {
    /* Ignore storage write errors. */
  }
}

export interface WelcomeRoutes {
  /** Open a bundled demo trace by fixture name. */
  onOpenDemo: (name: FixtureName) => void;
  /** Open a trace from the user's machine (the toolbar's file picker). */
  onOpenFromPc: () => void;
}

/** A mounted welcome modal: the overlay element plus open/close control. */
export interface WelcomeModalHandle {
  /** The overlay (backdrop + dialog) to place at the app root. */
  el: HTMLElement;
  /** Show the modal and focus it. */
  open(): void;
  /** Hide the modal and restore focus to the previously-focused element. */
  close(): void;
  /** Whether the modal is currently shown. */
  readonly isOpen: boolean;
}

interface TileSpec {
  testid: string;
  icon: string;
  title: string;
  desc: string;
  /** Action when chosen. */
  onSelect: () => void;
  /** Keep the modal open after {@link onSelect} (e.g. to display a sub-view). */
  keepOpen?: boolean;
}

export function createWelcomeModal(routes: WelcomeRoutes): WelcomeModalHandle {
  const tiles: TileSpec[] = [
    {
      testid: "welcome-demo",
      icon: "▶",
      title: "Open a demo trace",
      desc: "Explore a bundled sample capture — no hardware needed.",
      // Display the in-modal demo picker.
      onSelect: () => showDemoPicker(),
      keepOpen: true,
    },
    {
      testid: "welcome-open",
      icon: "📂",
      title: "Open a trace from this PC",
      desc: "Load a .svdat file you already have.",
      onSelect: routes.onOpenFromPc,
    },
  ];

  const closeBtn = el("button", {
    class: "welcome-close",
    type: "button",
    title: "Close",
    "aria-label": "Close",
    "data-testid": "welcome-close",
    text: "✕",
    onclick: () => close(),
  });

  const grid = el(
    "div",
    { class: "welcome-grid" },
    tiles.map((t) => buildTile(t, () => close())),
  );

  const hideCheckbox = el("input", {
    type: "checkbox",
    class: "welcome-hide-cb",
    "data-testid": "welcome-hide",
    checked: welcomeHiddenOnStartup(),
    onchange: (e) => setWelcomeHidden((e.target as HTMLInputElement).checked),
  }) as HTMLInputElement;

  // Route tile grid and startup display preference checkbox.
  const mainView = el(
    "div",
    { class: "welcome-view", "data-testid": "welcome-view-main" },
    [
      el("h2", { class: "welcome-title", id: "welcome-title", text: "Get started" }),
      el("p", {
        class: "welcome-sub",
        text: "Pick a way to get a trace into the viewer.",
      }),
      grid,
      el("label", { class: "welcome-hide" }, [
        hideCheckbox,
        el("span", {
          text: "Don't show this on startup (you can always reopen it with the Welcome button in the toolbar)",
        }),
      ]),
    ],
  );

  // Demo trace picker view listing bundled DEMOS.
  const backBtn = el("button", {
    class: "welcome-back",
    type: "button",
    "data-testid": "welcome-demo-back",
    text: "← Back",
    onclick: () => showMain(),
  });
  const demoList = el(
    "div",
    { class: "welcome-demo-list" },
    DEMOS.map((d) =>
      el(
        "button",
        {
          class: "welcome-demo-entry",
          type: "button",
          "data-testid": `welcome-demo-${d.name}`,
          onclick: () => {
            close();
            routes.onOpenDemo(d.name);
          },
        },
        [
          el("span", { class: "welcome-demo-entry-title", text: d.title }),
          el("span", { class: "welcome-demo-entry-desc", text: d.description }),
        ],
      ),
    ),
  );
  const demoView = el(
    "div",
    { class: "welcome-view", "data-testid": "welcome-view-demos" },
    [
      backBtn,
      el("h2", { class: "welcome-title", text: "Open a demo trace" }),
      el("p", { class: "welcome-sub", text: "Bundled sample captures — pick one to explore." }),
      demoList,
    ],
  );
  demoView.hidden = true;

  const dialog = el(
    "div",
    {
      class: "welcome-dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "welcome-title",
      tabindex: -1,
    },
    [closeBtn, mainView, demoView],
  );

  /** Switch to demo trace picker view. */
  function showDemoPicker(): void {
    mainView.hidden = true;
    demoView.hidden = false;
    backBtn.focus();
  }

  /** Return to initial route selection grid. */
  function showMain(): void {
    demoView.hidden = true;
    mainView.hidden = false;
    dialog.focus();
  }

  const overlay = el(
    "div",
    { class: "welcome-overlay", "data-testid": "welcome-modal" },
    [dialog],
  );
  overlay.hidden = true;

  // Dismiss modal on backdrop clicks.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  let open = false;
  let lastFocused: HTMLElement | null = null;

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  function openModal(): void {
    if (open) return;
    open = true;
    lastFocused = document.activeElement as HTMLElement | null;
    // Synchronize the checkbox with stored preference.
    hideCheckbox.checked = welcomeHiddenOnStartup();
    overlay.hidden = false;
    document.addEventListener("keydown", onKey, true);
    // Reset to route selection grid on open.
    showMain();
  }

  function close(): void {
    if (!open) return;
    open = false;
    overlay.hidden = true;
    document.removeEventListener("keydown", onKey, true);
    lastFocused?.focus?.();
  }

  return {
    el: overlay,
    open: openModal,
    close,
    get isOpen() {
      return open;
    },
  };
}

/**
 * Construct route tile button. Triggers onSelect and closes modal unless keepOpen is true.
 */
function buildTile(t: TileSpec, close: () => void): HTMLElement {
  return el("button", {
    class: "welcome-tile",
    type: "button",
    "data-testid": t.testid,
    onclick: () => {
      if (!t.keepOpen) close();
      t.onSelect();
    },
  }, [
    el("span", { class: "welcome-tile-icon", "aria-hidden": "true", text: t.icon }),
    el("span", { class: "welcome-tile-title", text: t.title }),
    el("span", { class: "welcome-tile-desc", text: t.desc }),
  ]);
}
