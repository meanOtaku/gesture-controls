import { useSyncExternalStore } from "react";
import type { AppTheme } from "./theme";

const subscribe = (listener: () => void): (() => void) => {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
};

/** The theme on the page now, following changes made in Settings at once. */
const current = (): AppTheme => (document.documentElement.getAttribute("data-theme") === "nerv" ? "nerv" : "neo");

/** Whether the page is showing `theme`, for parts of the interface that exist in one theme only. */
export function useThemeIs(theme: AppTheme): boolean {
  return useSyncExternalStore(subscribe, () => current() === theme, () => false);
}
