/**
 * What to show for a failed call to the desktop backend. In the browser preview there is no backend, and the failure is a
 * programming error's text ("Cannot read properties of undefined"); say what it means instead. A real backend error is
 * already written in words and is shown as it is.
 */
export function errorText(error: unknown): string {
  const inDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  return inDesktop ? String(error) : "This needs the desktop app, so it is unavailable in browser preview.";
}
