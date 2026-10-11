import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telemetryStore } from "../../telemetry/store/telemetryStore";
import type { CameraSnapshot } from "../cameraController";

const holder = vi.hoisted(() => ({ snapshot: null as unknown, listeners: new Set<() => void>(), enable: vi.fn(), disable: vi.fn() }));
vi.mock("../cameraService", () => ({
  getCameraController: () => ({
    subscribe: (listener: () => void) => { holder.listeners.add(listener); return () => holder.listeners.delete(listener); },
    getSnapshot: () => holder.snapshot,
    enable: holder.enable,
    disable: holder.disable,
    video: document.createElement("video"),
    subscribeFrames: () => () => undefined,
  }),
}));
vi.mock("../drawHands", () => ({ drawHands: vi.fn() }));

import { CameraQuickControl } from "./CameraQuickControl";

const snap = (over: Partial<CameraSnapshot>): CameraSnapshot => ({ status: "off", error: null, devices: [], deviceId: null, fps: 0, detectMs: 0, engine: null, frame: null, recordLandmarks: true, collecting: false, collectedFrames: 0, truncated: false, ...over });
const set = (next: CameraSnapshot) => act(() => { holder.snapshot = next; holder.listeners.forEach((l) => l()); });

beforeEach(() => {
  holder.snapshot = snap({});
  holder.enable.mockReset();
  holder.disable.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as unknown as CanvasRenderingContext2D);
  telemetryStore.discardDatasetRecording();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); telemetryStore.discardDatasetRecording(); });

describe("CameraQuickControl", () => {
  it("turns the camera on from off, and offers nothing else while it is off", () => {
    render(<CameraQuickControl />);
    expect(screen.queryByRole("button", { name: "Show preview" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Turn camera on" }));
    expect(holder.enable).toHaveBeenCalled();
  });

  it("says it is starting, then shows it is on with its speed, a preview that opens and closes, and a way to turn it off", () => {
    holder.snapshot = snap({ status: "starting" });
    render(<CameraQuickControl />);
    expect(screen.getByText("Camera starting…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    set(snap({ status: "on", fps: 29.6, detectMs: 12 }));
    expect(screen.getByText(/Camera on · 30 frames\/s/)).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Show preview" });
    fireEvent.click(toggle);
    expect(document.querySelector(".camera-stage")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }));
    expect(document.querySelector(".camera-stage")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Turn camera off" }));
    expect(holder.disable).toHaveBeenCalled();
  });

  it("does not offer a preview when the page already has one", () => {
    holder.snapshot = snap({ status: "on", fps: 30 });
    render(<CameraQuickControl preview={false} />);
    expect(screen.queryByRole("button", { name: "Show preview" })).toBeNull();
    expect(screen.getByRole("button", { name: "Turn camera off" })).toBeEnabled();
  });

  it("will not turn the camera off in the middle of a recording, and says why", () => {
    holder.snapshot = snap({ status: "on", fps: 30 });
    telemetryStore.startDatasetRecording();
    render(<CameraQuickControl />);
    expect(screen.getByRole("button", { name: "Turn camera off" })).toBeDisabled();
    expect(screen.getByText(/A recording is in progress, so the camera stays on/)).toBeInTheDocument();
  });

  it("shows why the camera could not start", () => {
    holder.snapshot = snap({ status: "error", error: "The camera is in use by another app." });
    render(<CameraQuickControl />);
    expect(screen.getByRole("alert")).toHaveTextContent("in use by another app");
    expect(screen.getByRole("button", { name: "Turn camera on" })).toBeEnabled();
  });
});
