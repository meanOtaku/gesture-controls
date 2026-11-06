import { createContext } from "react";

/** App-owned slot below the telemetry event log; null keeps the preview inline. */
export const HandPreviewTarget = createContext<HTMLElement | null>(null);
