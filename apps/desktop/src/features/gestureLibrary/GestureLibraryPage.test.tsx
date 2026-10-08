import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraController } from "../camera/cameraController";
import type { HandDetector, TrackedHand } from "../camera/handTypes";
import { makeHand } from "./testHands";
import type { GestureDefinition } from "./definition";

const holder = vi.hoisted(() => ({ controller: null as unknown }));
vi.mock("../camera/cameraService", () => ({ getCameraController: () => holder.controller }));
vi.mock("../camera/drawHands", () => ({ drawHands: vi.fn() }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { GestureLibraryPage } from "./GestureLibraryPage";

let hands: TrackedHand[] = [];
let next: (() => void) | null = null;
let clock = 1000;
let saved: GestureDefinition[] = [];

function makeController() {
  const video = document.createElement("video");
  Object.defineProperty(video, "play", { value: vi.fn(async () => undefined) });
  Object.defineProperty(video, "requestVideoFrameCallback", {
    value: (cb: (now: number, m?: { captureTime?: number }) => void) => { next = () => { clock += 33; cb(clock, { captureTime: clock }); }; return 1; },
  });
  const detector: HandDetector = { detect: () => hands, close: () => undefined };
  return new CameraController({
    getUserMedia: vi.fn(async () => ({ getTracks: () => [], getVideoTracks: () => [{ getSettings: () => ({ width: 640, height: 480 }) }] }) as unknown as MediaStream),
    enumerateDevices: vi.fn(async () => []),
    createDetector: vi.fn(async () => detector),
    createVideo: () => video,
    now: () => 0,
    syncPairs: () => [],
  });
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as unknown as CanvasRenderingContext2D);
  hands = [];
  next = null;
  saved = [];
  holder.controller = makeController();
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args?: { definition?: GestureDefinition; id?: string }) => {
    if (command === "list_gesture_definitions") return saved;
    if (command === "list_model_labels") return [{ id: "pinch", displayName: "Pinch", description: "", color: "", role: "positiveGesture", archivedAt: null }];
    if (command === "save_gesture_definition") { saved = [{ ...args!.definition!, id: "gesture-1" }]; return saved; }
    if (command === "delete_gesture_definition") { saved = saved.filter((d) => d.id !== args!.id); return saved; }
    throw new Error(`unexpected ${command}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("GestureLibraryPage", () => {
  it("starts empty, saves a hand-made rule, then shows the gesture detected live from the camera", async () => {
    render(<GestureLibraryPage />);
    expect(await screen.findByText(/No gestures yet/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New gesture" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pinch" } });
    expect(screen.getByRole("button", { name: "Save gesture" })).toHaveProperty("disabled", true); // no rule yet
    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    fireEvent.change(screen.getByLabelText("Start threshold 1"), { target: { value: "0.3" } });
    fireEvent.change(screen.getByLabelText("End threshold 1"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save gesture" }));

    expect(await screen.findByLabelText("Pinch")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("save_gesture_definition", expect.objectContaining({ definition: expect.objectContaining({ name: "Pinch", minHoldMs: 100 }) }));
    expect(screen.getByText(/thumb to index tip below 0.3 hand sizes/i)).toBeTruthy();

    // Camera on, a pinching hand held for a few frames.
    hands = [makeHand({ pinch: 0.1 })];
    fireEvent.click(screen.getByRole("button", { name: "Turn camera on" }));
    await waitFor(() => expect(next).not.toBeNull());
    for (let i = 0; i < 8; i++) await act(async () => { next?.(); });
    expect(await screen.findByText("Detected")).toBeTruthy();
    expect(screen.getByText(/Recognised 1 time since/)).toBeTruthy();

    hands = [];
    for (let i = 0; i < 8; i++) await act(async () => { next?.(); });
    expect(await screen.findByText("Not detected")).toBeTruthy();
  });

  it("refuses a rule whose end threshold is not looser, and says why", async () => {
    render(<GestureLibraryPage />);
    fireEvent.click(await screen.findByRole("button", { name: "New gesture" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Odd" } });
    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    fireEvent.change(screen.getByLabelText("Start threshold 1"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText("End threshold 1"), { target: { value: "0.2" } });
    expect(screen.getByRole("alert").textContent).toMatch(/looser/);
    expect(screen.getByRole("button", { name: "Save gesture" })).toHaveProperty("disabled", true);
  });
});
