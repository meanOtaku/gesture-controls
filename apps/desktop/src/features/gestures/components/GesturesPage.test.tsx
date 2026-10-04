import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationState, CalibrationState, Recipe } from "../../../shared/protocol/events";
import { GesturesPage } from "./GesturesPage";

const invokeMock = vi.fn();
const handlers = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (event: { payload: unknown }) => void) => {
    handlers.set(name, fn);
    return Promise.resolve(() => undefined);
  },
}));

const calibration: CalibrationState = {
  targets: [
    { id: "center", name: "Screen center", calibrated: true, builtin: true },
    { id: "topRight", name: "Top right", calibrated: true, builtin: false },
    { id: "leftEdge", name: "Left edge", calibrated: false, builtin: false },
  ],
  requiresRecalibration: false, activationThresholdDegrees: 12, dwellMs: 400, activeTarget: "topRight",
};
const recipe: Recipe = { id: "r", name: "Swipe next", enabled: true, action: "nextTrack", stages: [{ kind: "hold", hold: "swipeRight" }], device: { kind: "rotationKnob" } };
const automation: AutomationState = { recipes: [recipe], blocked: [], conflicts: [], unavailable: [], loadedLabels: [] };
const status = (over = {}) => ({ mode: "monitor", loadedLabels: ["snap"], loadFailures: [], quarantined: [], registryError: null, activeDetections: [], lastScores: { snap: 0.42 }, ...over });

function setup(over: Partial<React.ComponentProps<typeof GesturesPage>> = {}, runtime = status()) {
  invokeMock.mockImplementation(async (command: string) => (command === "get_label_runtime_status" ? runtime : []));
  const props: React.ComponentProps<typeof GesturesPage> = {
    heuristics: { shake: true, swipe: true, tap: false, roll: true, pitch: true }, watchConnected: true, stemDown: false, shakeCount: 0,
    lastSwipe: null, lastTap: null, lastRoll: null, lastPitch: null, calibration, automation, onOpenModelLab: vi.fn(), onOpenSettings: vi.fn(), ...over,
  };
  const view = render(<GesturesPage {...props} />);
  return { props, view };
}

beforeEach(() => {
  invokeMock.mockReset();
  handlers.clear();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

const card = (name: string) => within(screen.getByRole("listitem", { name }));

describe("GesturesPage", () => {
  it("lists every built-in watch gesture with how to perform it and whether it is on", () => {
    setup();
    for (const name of ["STEM button", "Shake", "Swipe", "Tap", "Roll", "Pitch"]) expect(screen.getByRole("listitem", { name })).toBeInTheDocument();
    expect(card("Tap").getByText("Off in Settings")).toBeInTheDocument();
    expect(card("Tap").getByText(/Switch it on under Settings/)).toBeInTheDocument();
    expect(card("Shake").getByText("On")).toBeInTheDocument();
    expect(card("Swipe").getByText(/Flick your hand/)).toBeInTheDocument();
    expect(card("Swipe").getByText(/Used by: Swipe next\./)).toBeInTheDocument();
    expect(card("Swipe").getByText(/Not recognised yet/)).toBeInTheDocument();
  });

  it("lights the variant that was just recognised, and only that one, then fades", () => {
    vi.useFakeTimers();
    const { props, view } = setup();
    view.rerender(<GesturesPage {...props} lastSwipe={{ direction: "left", count: 1 }} />);
    const swipe = screen.getByRole("listitem", { name: "Swipe" });
    expect(within(swipe).getByLabelText("Left, recognised just now")).toHaveAttribute("data-lit", "true");
    expect(within(swipe).getByLabelText("Right")).toHaveAttribute("data-lit", "false");
    expect(within(swipe).getByText(/Recognised 1 time this session\./)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(within(swipe).getByLabelText("Left")).toHaveAttribute("data-lit", "false");
    vi.useRealTimers();
  });

  it("shows the STEM button held, and a shake count", () => {
    setup({ stemDown: true, shakeCount: 3 });
    expect(card("STEM button").getByText("Held")).toBeInTheDocument();
    expect(card("Shake").getByText(/Recognised 3 times this session\./)).toBeInTheDocument();
  });

  it("warns when the watch is not connected", () => {
    setup({ watchConnected: false });
    expect(screen.getByText(/watch is not connected/)).toBeInTheDocument();
  });

  it("lights the location being looked at and lists only calibrated ones", () => {
    setup();
    const locations = within(screen.getByRole("list", { name: "Calibrated locations" }));
    expect(locations.getByLabelText("Top right, recognised just now")).toBeInTheDocument();
    expect(locations.getByLabelText("Screen center")).toHaveAttribute("data-lit", "false");
    expect(locations.queryByText("Left edge")).not.toBeInTheDocument();
  });

  it("shows a loaded model's score and lights it when it is detected, in Monitor too", async () => {
    setup();
    const model = await screen.findByRole("listitem", { name: "snap" });
    expect(within(model).getByText("Not detected")).toBeInTheDocument();
    expect(within(model).getByText(/Score 42%/)).toBeInTheDocument();
    await vi.waitFor(() => expect(handlers.has("label-detections")).toBe(true));
    act(() => handlers.get("label-detections")?.({ payload: { events: [{ kind: "rising", label: "snap", confidence: 0.9, timestampNs: 1 }], conflicts: [], rejections: [] } }));
    expect(within(model).getByText("Detected")).toBeInTheDocument();
    expect(within(model).getByText(/Detected 1 time this session/)).toBeInTheDocument();
    act(() => handlers.get("label-detections")?.({ payload: { events: [{ kind: "falling", label: "snap", timestampNs: 2, reason: "scoreBelowRelease" }], conflicts: [], rejections: [] } }));
    expect(within(model).getByText("Not detected")).toBeInTheDocument();
  });

  it("says when no model is loaded or the runtime is off, and opens Model Lab and Settings", async () => {
    const { props } = setup({}, status({ loadedLabels: [] }));
    expect(await screen.findByText(/No model is loaded/)).toBeInTheDocument();
    screen.getByRole("button", { name: "Open Model Lab" }).click();
    screen.getByRole("button", { name: "Open Settings" }).click();
    expect(props.onOpenModelLab).toHaveBeenCalled();
    expect(props.onOpenSettings).toHaveBeenCalled();
    cleanup();
    setup({}, status({ mode: "off" }));
    expect(await screen.findByText(/model runtime is Off/)).toBeInTheDocument();
  });
});
