/**
 * Theme management and execution context color assignment.
 *
 * The interface sets a `data-theme` attribute on the root element; colours themselves are CSS custom properties in `styles.css`. The user's choice is one of three — light, dark, or `auto`, which follows `prefers-color-scheme` and keeps following it — held apart from the {@link Theme} that choice paints.
 *
 * Context colors are assigned deterministically by hashing context names into a fixed palette, so the same context keeps its colour across panes without any persistent state.
 */

/** A painted theme: what the interface is actually showing. */
export type Theme = "light" | "dark";

/**
 * What the user asked for, which is not the same as what is painted.
 *
 * `auto` follows the operating system and keeps following it as it changes. A button that only flipped
 * between light and dark would be a one-way door: choosing either would leave no way back to `auto` short of
 * clearing site data, so the choice has three states.
 */
export type ThemeChoice = Theme | "auto";

const THEME_KEY = "trace-viewer.theme";

/** The choices in the order the toolbar button cycles through them. */
export const THEME_CHOICES: readonly ThemeChoice[] = ["auto", "light", "dark"];

function isChoice(v: string | null): v is ThemeChoice {
  return v === "auto" || v === "light" || v === "dark";
}

// Subscribers notified on theme updates to trigger canvas redraws.
const listeners = new Set<(theme: Theme) => void>();

/**
 * Subscribe to theme changes. Returns an unsubscribe function.
 *
 * Invokes callback for explicit {@link setTheme} overrides and operating system theme changes.
 */
export function onThemeChange(cb: (theme: Theme) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(theme: Theme): void {
  for (const cb of listeners) cb(theme);
}

/** Determine operating system color scheme preference. */
export function osTheme(): Theme {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

/** The stored choice, defaulting to `auto` when nothing is stored or the stored value is unrecognised. */
export function themeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return isChoice(stored) ? stored : "auto";
  } catch {
    return "auto"; // Storage can be unavailable; following the OS is the right fallback.
  }
}

/** The theme a choice paints: itself, or whatever the operating system currently asks for. */
export function resolveTheme(choice: ThemeChoice = themeChoice()): Theme {
  return choice === "auto" ? osTheme() : choice;
}

/** Paint `theme` and tell the subscribers, so canvas panes repaint with the new palette. */
function apply(theme: Theme, root: HTMLElement): void {
  root.setAttribute("data-theme", theme);
  notify(theme);
}

/**
 * Apply the stored choice and start following the operating system.
 *
 * The system listener stays attached for the life of the page rather than only while the choice is `auto`,
 * so switching back to `auto` starts following again without a reload. It does nothing while an explicit
 * light or dark is chosen. Returns the theme actually painted.
 */
export function initTheme(root: HTMLElement = document.documentElement): Theme {
  const theme = resolveTheme();
  root.setAttribute("data-theme", theme);
  globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", (e) => {
    if (themeChoice() !== "auto") return;
    apply(e.matches ? "dark" : "light", root);
  });
  return theme;
}

/** Persist a theme choice and paint it. Returns the theme actually painted. */
export function setThemeChoice(choice: ThemeChoice, root: HTMLElement = document.documentElement): Theme {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* Ignore write errors when storage is unavailable or quota is exceeded. */
  }
  const theme = resolveTheme(choice);
  apply(theme, root);
  return theme;
}

/** The next choice in the cycle, for the toolbar button. */
export function nextThemeChoice(choice: ThemeChoice): ThemeChoice {
  return THEME_CHOICES[(THEME_CHOICES.indexOf(choice) + 1) % THEME_CHOICES.length]!;
}

/**
 * Categorical palette for execution contexts, from the reference design.
 *
 * Twelve muted hues rather than saturated fills, as `[hue, saturation %, lightness %]` so a lane can ask for
 * the same colour at another alpha or a darker outline without a second table. They read on both the light
 * and the dark surface.
 */
const CONTEXT_COLORS: readonly (readonly [number, number, number])[] = [
  [207, 42, 48],
  [258, 32, 55],
  [172, 45, 41],
  [35, 57, 50],
  [6, 43, 55],
  [80, 32, 40],
  [196, 34, 48],
  [30, 31, 50],
  [241, 35, 58],
  [164, 37, 40],
  [325, 25, 60],
  [207, 15, 48],
];

/** Idle contexts sit behind everything else in a light grey-blue rather than taking a hue of their own. */
const IDLE_COLOR: readonly [number, number, number] = [210, 10, 70];

/** How much darker a run bar's outline is than its fill, in lightness points. */
const BORDER_DARKEN = 18;

/** The palette entry a context name hashes to. */
function colorOf(name: string): readonly [number, number, number] {
  if (/^idle/i.test(name)) return IDLE_COLOR;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CONTEXT_COLORS[h % CONTEXT_COLORS.length]!;
}

/** Derive a deterministic CSS color for an execution context by name. */
export function contextColor(name: string, alpha = 1): string {
  const [h, s, l] = colorOf(name);
  return `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
}

/**
 * Derive border color for context execution rectangles.
 *
 * Produces a darker shade of the same colour as {@link contextColor}.
 */
export function contextBorderColor(name: string, alpha = 1): string {
  const [h, s, l] = colorOf(name);
  return `hsla(${h}, ${s}%, ${Math.max(0, l - BORDER_DARKEN)}%, ${alpha})`;
}
