import { describe, expect, it } from "vitest";
import { endReasonLabel, formatAgo, formatDuration, formatMs, phaseHint, phaseLabel } from "./linkFormat";
import type { LinkDiagnostics } from "../../shared/protocol/events";

const base: LinkDiagnostics = {
  transport: "bluetooth", phase: "idle", phaseDetail: null, sessions: 0, drops: 0, scanAttempts: 0,
  connectedSinceUnixMs: null, lastMessageUnixMs: null, lastEnd: null, messagesReceived: 0, invalidMessages: 0,
  outOfOrderMessages: 0, writes: 0, writeFailures: 0, writeLastMs: null, writeMaxMs: null, maxGapMs: null,
  mtu: null, retryInMs: null, events: [],
};

describe("link formatting", () => {
  it("formats durations at every scale", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(12.9)).toBe("12s");
    expect(formatDuration(247)).toBe("4m 07s");
    expect(formatDuration(3720)).toBe("1h 02m");
    expect(formatDuration(-5)).toBe("0s");
  });

  it("formats ages, with a dash for never and 'just now' under a second", () => {
    expect(formatAgo(null, 10_000)).toBe("—");
    expect(formatAgo(9_500, 10_000)).toBe("just now");
    expect(formatAgo(4_000, 10_000)).toBe("6s ago");
    expect(formatAgo(20_000, 10_000)).toBe("just now"); // a clock skewed into the future is not negative
  });

  it("formats milliseconds, switching to seconds from one second", () => {
    expect(formatMs(null)).toBe("—");
    expect(formatMs(365)).toBe("365 ms");
    expect(formatMs(3190)).toBe("3.2 s");
  });

  it("labels every phase and gives a hint only where the user may be stuck", () => {
    expect(phaseLabel("streaming")).toBe("Streaming");
    expect(phaseLabel("awaiting_trust")).toBe("Waiting for approval");
    expect(phaseHint({ ...base, phase: "streaming" })).toBeNull();
    expect(phaseHint({ ...base, phase: "awaiting_trust" })).toMatch(/Trust this computer/);
    expect(phaseHint({ ...base, phase: "scanning" })).toMatch(/Gesture Watch app/);
    expect(phaseHint({ ...base, phase: "failed", phaseDetail: "no watch found" })).toBe("no watch found");
    expect(phaseHint({ ...base, phase: "listening", transport: "wifi" })).toMatch(/same Wi-Fi/);
  });

  it("explains each way a session can end, and passes an unknown reason through", () => {
    const end = (reason: string) => ({ atUnixMs: 0, reason, detail: "", sessionSeconds: 0 });
    expect(endReasonLabel(end("heartbeat_timeout"))).toBe("The watch went silent");
    expect(endReasonLabel(end("write_failed"))).toBe("A command write failed");
    expect(endReasonLabel(end("mystery"))).toBe("mystery");
  });
});
