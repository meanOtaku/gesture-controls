import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { WatchTransportSection } from "./WatchTransportSection";

afterEach(cleanup);
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ selected: "bluetooth", ble: { state: "idle" } });
});

describe("WatchTransportSection", () => {
  it("shows Bluetooth as the selected transport by default", async () => {
    render(<WatchTransportSection selected="bluetooth" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "Bluetooth" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Wi-Fi" })).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_watch_transport_status"));
  });

  it("reports the awaiting-trust state rather than claiming a working link", async () => {
    invoke.mockResolvedValue({ selected: "bluetooth", ble: { state: "awaitingWatchTrust" } });
    render(<WatchTransportSection selected="bluetooth" onSelect={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/Approve this computer on the Watch/)).toBeInTheDocument(),
    );
  });

  it("surfaces a BLE failure detail verbatim instead of a generic message", async () => {
    invoke.mockResolvedValue({
      selected: "bluetooth",
      ble: { state: "failed", detail: "no Bluetooth adapter available" },
    });
    render(<WatchTransportSection selected="bluetooth" onSelect={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText("no Bluetooth adapter available")).toBeInTheDocument(),
    );
  });

  it("switches the live transport through set_watch_transport, not just the label", async () => {
    const onSelect = vi.fn();
    render(<WatchTransportSection selected="bluetooth" onSelect={onSelect} />);
    screen.getByRole("button", { name: "Wi-Fi" }).click();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_watch_transport", { transport: "wifi" }),
    );
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("wifi"));
  });

  it("hides the Bluetooth scan controls while Wi-Fi is selected", async () => {
    invoke.mockResolvedValue({ selected: "wifi", ble: { state: "idle" } });
    render(<WatchTransportSection selected="wifi" onSelect={() => {}} />);
    expect(screen.queryByRole("button", { name: "Scan again" })).not.toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_watch_transport_status"));
  });

  it("rescans on request while Bluetooth is selected", async () => {
    render(<WatchTransportSection selected="bluetooth" onSelect={() => {}} />);
    screen.getByRole("button", { name: "Scan again" }).click();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("rescan_watch_ble"));
  });
});
