import type { LinkDiagnostics, LinkEnd, LinkPhase } from "../../shared/protocol/events";

const PHASE_LABELS: Record<LinkPhase, string> = {
  idle: "Idle",
  scanning: "Searching for the watch",
  connecting: "Connecting",
  awaiting_trust: "Waiting for approval",
  streaming: "Streaming",
  failed: "Retrying",
  listening: "Waiting for the watch",
};

export function phaseLabel(phase: LinkPhase): string {
  return PHASE_LABELS[phase] ?? phase;
}

/** What to do about a phase the user may be stuck in; null when nothing is needed. */
export function phaseHint(diagnostics: LinkDiagnostics): string | null {
  switch (diagnostics.phase) {
    case "scanning":
      return "Open the Gesture Watch app and keep its screen on; it must say Waiting.";
    case "awaiting_trust":
      return "Tap Trust this computer on the watch.";
    case "failed":
      return diagnostics.phaseDetail ?? "The last attempt failed; retrying.";
    case "listening":
      return diagnostics.transport === "wifi"
        ? "Open the Gesture Watch app on the same Wi-Fi network; it finds this computer automatically."
        : null;
    default:
      return null;
  }
}

const END_REASONS: Record<string, string> = {
  heartbeat_timeout: "The watch went silent",
  stream_closed: "The link closed",
  write_failed: "A command write failed",
  cancelled: "Stopped by this app",
};

export function endReasonLabel(end: LinkEnd): string {
  return END_REASONS[end.reason] ?? end.reason;
}

/** `1h 02m`, `4m 07s` or `12s`. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${rest}s`;
}

export function formatAgo(thenUnixMs: number | null, nowUnixMs: number): string {
  if (thenUnixMs == null) return "—";
  const delta = Math.max(0, nowUnixMs - thenUnixMs);
  return delta < 1000 ? "just now" : `${formatDuration(delta / 1000)} ago`;
}

export function formatMs(value: number | null): string {
  if (value == null) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;
}

export function formatClock(unixMs: number): string {
  return new Date(unixMs).toLocaleTimeString([], { hour12: false });
}
