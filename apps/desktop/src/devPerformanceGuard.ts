/**
 * Development builds only. React 19.2's development build records every component render as a `performance.measure`
 * entry for Chrome's Performance panel ("Performance Tracks"), whenever the browser has `console.timeStamp`. WebKit has
 * it, so the app's page gained thousands of entries a second that nothing ever cleared, and WebKit keeps each one in
 * native memory: the page grew by about 2 MB a second until macOS killed it for memory, which reloads the app. Those
 * entries (they carry a `detail.devtools` payload) are dropped here; any other measure still goes through. Production
 * builds of React record none, so this is never installed there.
 */
type MeasureOptions = PerformanceMeasureOptions & { detail?: { devtools?: unknown } };

const isReactTrack = (options: unknown): boolean =>
  typeof options === "object" && options !== null && typeof (options as MeasureOptions).detail?.devtools === "object";

export function installDevPerformanceGuard(target: Performance | undefined = globalThis.performance): void {
  if (!target || typeof target.measure !== "function") return;
  const measure = target.measure.bind(target);
  target.measure = ((name: string, startOrOptions?: string | MeasureOptions, endMark?: string) =>
    isReactTrack(startOrOptions) ? undefined : measure(name, startOrOptions, endMark)) as Performance["measure"];
}

if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) installDevPerformanceGuard();
