import { useSyncExternalStore } from "react";
import type { AppTheme } from "./theme";

const subscribe = (listener: () => void): (() => void) => {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
};

/** The theme on the page now ("electric" has no mark), following changes made in Settings at once. */
const current = (): AppTheme => {
  const mark = document.documentElement.getAttribute("data-theme");
  return mark === "neo" || mark === "halftone" || mark === "nerv" ? mark : "electric";
};

/** Whether the page is showing `theme`, for parts of the interface that exist in one theme only. */
export function useThemeIs(theme: AppTheme): boolean {
  return useSyncExternalStore(subscribe, () => current() === theme, () => false);
}
