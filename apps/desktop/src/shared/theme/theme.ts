/** The app's look. "neo" is neo-brutalism (cream, thick black outlines, hard shadows) and the default; "electric" is the original deep-blue theme. */
export type AppTheme = "electric" | "neo";

export const THEMES: ReadonlyArray<{ value: AppTheme; label: string; summary: string }> = [
  { value: "neo", label: "Neo-brutalism", summary: "Cream paper, thick black outlines, hard offset shadows and vibrant colours." },
  { value: "electric", label: "Electric", summary: "Deep blue, flat and square, with bright accents." },
];

export const THEME_STORAGE_KEY = "appTheme";
export const DEFAULT_THEME: AppTheme = "neo";

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
  const root = document.documentElement;
  if (new URLSearchParams(window.location.search).get("window") === "overlay") {
    root.removeAttribute("data-theme");
    return false;
  }
  // "electric" is the page's own styling; only the neo theme is a mark on top of it.
  if (theme === "neo") root.setAttribute("data-theme", "neo");
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
