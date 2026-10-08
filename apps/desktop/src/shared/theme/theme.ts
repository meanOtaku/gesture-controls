/** The app's look. "electric" is the original deep-blue theme; "neo" is neo-brutalism: cream, thick black outlines, hard shadows. */
export type AppTheme = "electric" | "neo";

export const THEMES: ReadonlyArray<{ value: AppTheme; label: string; summary: string }> = [
  { value: "electric", label: "Electric", summary: "Deep blue, flat and square, with bright accents." },
  { value: "neo", label: "Neo-brutalism", summary: "Cream paper, thick black outlines, hard offset shadows and vibrant colours." },
];

export const THEME_STORAGE_KEY = "appTheme";
export const DEFAULT_THEME: AppTheme = "electric";

export function isTheme(value: unknown): value is AppTheme {
  return value === "electric" || value === "neo";
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

const BROWSER_BAR_COLOUR: Record<AppTheme, string> = { electric: "#000066", neo: "#fbf3e4" };

/**
 * Puts a theme on the page. The floating volume knob is its own window with its own look and is never themed.
 * Returns whether it was applied.
 */
export function applyTheme(theme: AppTheme): boolean {
  if (new URLSearchParams(window.location.search).get("window") === "overlay") return false;
  const root = document.documentElement;
  if (theme === DEFAULT_THEME) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
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
