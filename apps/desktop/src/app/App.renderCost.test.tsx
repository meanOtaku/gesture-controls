import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { telemetryStore, EMPTY_WATCH_STATUS } from "../features/telemetry/store/telemetryStore";

const { invoke, listen, renders } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(() => Promise.resolve(() => undefined)),
  renders: { modelLab: 0, liveTelemetry: 0, recipes: 0, devices: 0, gestures: 0 },
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

vi.mock("../features/recipes/components/RecipesPage", () => ({
  RecipesPage: () => {
    renders.recipes += 1;
    return <div>recipes body</div>;
  },
}));
vi.mock("../features/devices/components/VirtualDevicesPage", () => ({
  VirtualDevicesPage: () => {
    renders.devices += 1;
    return <div>devices body</div>;
  },
}));
vi.mock("../features/gestures/components/GesturesPage", () => ({
  GesturesPage: () => {
    renders.gestures += 1;
    return <div>gestures body</div>;
  },
}));

beforeEach(() => {
  telemetryStore.reset();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  renders.modelLab = 0;
  renders.liveTelemetry = 0;
  renders.recipes = 0;
  renders.devices = 0;
  renders.gestures = 0;
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

  // These three take props from the parent, so they are only skipped while every prop keeps its identity: a new inline
  // function per render would make the memo useless and put them back at ~15 renders a second.
  it.each([
    ["Recipes", "recipes body", "recipes"],
    ["Virtual devices", "devices body", "devices"],
    ["Gestures", "gestures body", "gestures"],
  ] as const)("%s is not re-rendered by telemetry publishes", async (tab, body, counter) => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: tab }));
    await waitFor(() => expect(screen.getByText(body)).toBeInTheDocument());
    // Let the first renders (settings, calibration and automation arriving) settle before counting.
    await publish(2);
    const afterMount = renders[counter];

    await publish(5);

    expect(renders[counter]).toBe(afterMount);
  });
});
