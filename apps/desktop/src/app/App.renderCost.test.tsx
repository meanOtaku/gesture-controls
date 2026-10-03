import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { telemetryStore, EMPTY_WATCH_STATUS } from "../features/telemetry/store/telemetryStore";

const { invoke, listen, renders } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(() => Promise.resolve(() => undefined)),
  renders: { modelLab: 0, liveTelemetry: 0 },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
// Counting stand-ins: they do not subscribe to the telemetry store themselves, so any
// render here is one the parent forced.
vi.mock("../features/model-lab/components/ModelLab", () => ({
  ModelLab: () => {
    renders.modelLab += 1;
    return <div>model lab body</div>;
  },
}));
vi.mock("../features/telemetry/components/LiveTelemetry", () => ({
  LiveTelemetry: () => {
    renders.liveTelemetry += 1;
    return <div>live telemetry body</div>;
  },
}));

beforeEach(() => {
  telemetryStore.reset();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  renders.modelLab = 0;
  renders.liveTelemetry = 0;
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

/** Drives `count` telemetry publishes (the store notifies subscribers on a ~66 ms timer). */
async function publish(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      telemetryStore.ingestWatchStatus({ ...EMPTY_WATCH_STATUS, connected: true, clockOffsetNs: i });
      await new Promise((resolve) => setTimeout(resolve, 90));
    });
  }
}

describe("idle tabs are not re-rendered by telemetry publishes", () => {
  // Telemetry publishes ~15x a second while a watch streams. The tab components that take
  // no props must not be re-rendered by the parent each time: Model Lab alone is a large
  // tree (dataset list, registry table, lifecycle controls, readiness panel).
  it("Model Lab renders once, not once per publish", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Model Lab" }));
    await waitFor(() => expect(screen.getByText("model lab body")).toBeInTheDocument());
    const afterMount = renders.modelLab;

    await publish(5);

    expect(renders.modelLab).toBe(afterMount);
  });

  it("Live data renders once from the parent's side too (it subscribes to the store itself)", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Live data" }));
    await waitFor(() => expect(screen.getByText("live telemetry body")).toBeInTheDocument());
    const afterMount = renders.liveTelemetry;

    await publish(5);

    expect(renders.liveTelemetry).toBe(afterMount);
  });
});
