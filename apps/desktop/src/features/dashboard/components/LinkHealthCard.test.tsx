import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkDiagnostics } from "../../../shared/protocol/events";
import { LinkHealthPanel } from "./LinkHealthCard";

afterEach(() => cleanup());

const NOW = 1_800_000_000_000;
const diagnostics = (overrides: Partial<LinkDiagnostics> = {}): LinkDiagnostics => ({
  transport: "bluetooth", phase: "streaming", phaseDetail: null, sessions: 3, drops: 2, scanAttempts: 5,
  connectedSinceUnixMs: NOW - 247_000, lastMessageUnixMs: NOW - 400, lastEnd: null, messagesReceived: 1234,
  invalidMessages: 1, outOfOrderMessages: 2, writes: 40, writeFailures: 1, writeLastMs: 30, writeMaxMs: 3190,
  maxGapMs: 2310, mtu: 517, retryInMs: null, events: [], ...overrides,
});

describe("LinkHealthPanel", () => {
  it("says where to find the diagnostics outside the desktop app", () => {
    render(<LinkHealthPanel diagnostics={null} nowUnixMs={NOW} />);
    expect(screen.getByText(/available in the desktop app/i)).toBeInTheDocument();
  });

  it("shows the phase, uptime, latencies and counters", () => {
    render(<LinkHealthPanel diagnostics={diagnostics()} nowUnixMs={NOW} />);
    expect(screen.getByText("Streaming")).toBeInTheDocument();
    expect(screen.getByText("4m 07s")).toBeInTheDocument();
    expect(screen.getByText("just now")).toBeInTheDocument();
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(screen.getByText("30 ms / 3.2 s")).toBeInTheDocument();
    expect(screen.getByText("2.3 s")).toBeInTheDocument();
    expect(screen.getByText("517 bytes")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("explains how the last session ended", () => {
    render(
      <LinkHealthPanel
        nowUnixMs={NOW}
        diagnostics={diagnostics({
          lastEnd: { atUnixMs: NOW - 30_000, reason: "heartbeat_timeout", detail: "the watch went silent", sessionSeconds: 29 },
        })}
      />,
    );
    const note = screen.getByLabelText("Last disconnect");
    expect(note).toHaveTextContent(/30s ago, after 29s/);
    expect(note).toHaveTextContent(/The watch went silent — the watch went silent/);
  });

  it("tells the user what to do when the watch has not been found", () => {
    render(<LinkHealthPanel nowUnixMs={NOW} diagnostics={diagnostics({ phase: "scanning", connectedSinceUnixMs: null })} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Open the Gesture Watch app/);
  });

  it("lists events newest first and collapses a long history", () => {
    const events = Array.from({ length: 12 }, (_, index) => ({
      atUnixMs: NOW - (12 - index) * 1000, level: index === 11 ? ("warn" as const) : ("info" as const), message: `event ${index}`,
    }));
    render(<LinkHealthPanel nowUnixMs={NOW} diagnostics={diagnostics({ events })} />);
    const list = screen.getByLabelText("Link events");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(8);
    expect(items[0]).toHaveTextContent("event 11");
    expect(items[0]).toHaveAttribute("data-level", "warn");
    fireEvent.click(screen.getByRole("button", { name: "Show all 12" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(12);
  });

  it("offers to copy the diagnostics for a bug report", () => {
    const onCopy = vi.fn();
    render(<LinkHealthPanel diagnostics={diagnostics()} nowUnixMs={NOW} onCopy={onCopy} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    expect(onCopy).toHaveBeenCalledOnce();
  });
});
