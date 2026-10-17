/**
 * The app's look. "neo" is neo-brutalism (cream, thick black outlines, hard shadows) and the default; "electric" is the
 * original deep-blue theme; "nerv" is a command terminal after the Evangelion interfaces. A saved theme that no longer
 * exists (such as the removed "halftone") reads as the default.
 */
export type AppTheme = "electric" | "neo" | "nerv";

export const THEMES: ReadonlyArray<{ value: AppTheme; label: string; summary: string }> = [
  { value: "neo", label: "Neo-brutalism", summary: "Cream paper, thick black outlines, hard offset shadows and vibrant colours." },
  { value: "electric", label: "Electric", summary: "Deep blue, flat and square, with bright accents." },
  { value: "nerv", label: "NERV", summary: "A command terminal after the Evangelion interfaces: black panels in orange frames with corner brackets, hazard stripes, device hexagons, white Mincho title cards, green for normal state, cyan data, monospace numbers, and optional CRT scanlines." },
];

export const THEME_STORAGE_KEY = "appTheme";
export const DEFAULT_THEME: AppTheme = "neo";

export function isTheme(value: unknown): value is AppTheme {
  return value === "electric" || value === "neo" || value === "nerv";
}

/** The saved theme, or the default when nothing valid is saved or the browser will not say. */
export function readTheme(): AppTheme {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(saved) ? saved : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

const BROWSER_BAR_COLOUR: Record<AppTheme, string> = { electric: "#000066", neo: "#fbf3e4", nerv: "#000000" };

/**
 * Puts a theme on the page. The floating volume knob is its own window with its own look and is never themed.
 * Returns whether it was applied.
 */
export function applyTheme(theme: AppTheme): boolean {
  const root = document.documentElement;
  if (new URLSearchParams(window.location.search).get("window") === "overlay") {
    root.removeAttribute("data-theme");
    return false;
  }
  // "electric" is the page's own styling; the other themes are a mark on top of it.
  if (theme === "neo" || theme === "nerv") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BROWSER_BAR_COLOUR[theme]);
  return true;
}

/** Applies and remembers a theme. Remembering is a convenience: the theme still applies if it cannot be saved. */
export function saveTheme(theme: AppTheme): void {
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Not remembered; it will be back to the default next time.
  }
}

export const CRT_STORAGE_KEY = "appCrt";

/** Whether the NERV theme's CRT effects (scanlines, edge shading, glow on numbers) are wanted. On unless switched off. */
export function readCrt(): boolean {
  try {
    return window.localStorage.getItem(CRT_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Puts the CRT choice on the page. The effects only exist under the NERV theme, which reads this mark. */
export function applyCrt(on: boolean): void {
  if (on) document.documentElement.removeAttribute("data-crt");
  else document.documentElement.setAttribute("data-crt", "off");
}

/** Applies and remembers the CRT choice. Remembering is a convenience: it still applies if it cannot be saved. */
export function saveCrt(on: boolean): void {
  applyCrt(on);
  try {
    window.localStorage.setItem(CRT_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Not remembered; the effects come back next time.
  }
}
