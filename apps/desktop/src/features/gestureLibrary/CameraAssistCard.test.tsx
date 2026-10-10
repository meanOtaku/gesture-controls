import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraController } from "../camera/cameraController";
import type { HandDetector, TrackedHand } from "../camera/handTypes";
import { blankDefinition, type GestureDefinition } from "./definition";
import { makeHand } from "./testHands";

const holder = vi.hoisted(() => ({ controller: null as unknown }));
vi.mock("../camera/cameraService", () => ({ getCameraController: () => holder.controller }));
const library = vi.hoisted(() => ({ listGestureDefinitions: vi.fn() }));
vi.mock("./gestureLibraryApi", () => library);

import { CameraAssistCard } from "./CameraAssistCard";
import { cameraAssist } from "./cameraAssist";

const pinch: GestureDefinition = { ...blankDefinition(), id: "g1", name: "Pinch", labelId: "pinch", conditions: [{ measure: "pinch.index", direction: "below", enter: 0.3, exit: 0.5 }] };
let hands: TrackedHand[] = [];
let next: (() => void) | null = null;
let clock = 1000;

function makeController() {
  const video = document.createElement("video");
  Object.defineProperty(video, "play", { value: vi.fn(async () => undefined) });
  Object.defineProperty(video, "requestVideoFrameCallback", { value: (cb: (n: number, m?: { captureTime?: number }) => void) => { next = () => { clock += 33; cb(clock, { captureTime: clock }); }; return 1; } });
  const detector: HandDetector = { detect: () => hands, close: () => undefined };
  return new CameraController({
    getUserMedia: vi.fn(async () => ({ getTracks: () => [], getVideoTracks: () => [{ getSettings: () => ({ width: 640, height: 480 }) }] }) as unknown as MediaStream),
    enumerateDevices: vi.fn(async () => []), createDetector: vi.fn(async () => detector), createVideo: () => video, now: () => 0, syncPairs: () => [],
  });
}

beforeEach(() => { hands = []; next = null; holder.controller = makeController(); library.listGestureDefinitions.mockResolvedValue([pinch]); cameraAssist.setEnabled(false); });
afterEach(() => cleanup());

describe("CameraAssistCard", () => {
  it("says what is missing before it can work, then shows live whether the camera sees the gesture", async () => {
    render(<CameraAssistCard selectedLabel={null} recording={false} desktopAvailable />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Let the camera mark the gesture" }));
    expect(cameraAssist.isEnabled()).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/Choose a label above first/);
    cleanup();

    render(<CameraAssistCard selectedLabel="pinch" recording={false} desktopAvailable />);
    expect(await screen.findByText(/Turn the camera on \(below\)/)).toBeInTheDocument();
    hands = [makeHand({ pinch: 0.1 })];
    fireEvent.click(screen.getByRole("button", { name: "Turn camera on" }));
    await vi.waitFor(() => expect(next).not.toBeNull());
    for (let i = 0; i < 8; i++) await act(async () => { next?.(); });
    expect(await screen.findByText("Camera sees it")).toBeInTheDocument();
  });

  it("cannot be switched while recording", () => {
    render(<CameraAssistCard selectedLabel="pinch" recording desktopAvailable />);
    expect(screen.getByRole("checkbox", { name: "Let the camera mark the gesture" })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("CameraAssistCard readiness", () => {
  it("tells the Recorder a recording will be marked only when the camera is on and the label has a gesture", async () => {
    cameraAssist.setEnabled(true);
    const { rerender } = render(<CameraAssistCard selectedLabel="pinch" recording={false} desktopAvailable />);
    expect(await screen.findByText(/Turn the camera on \(below\)/)).toBeInTheDocument();
    expect(cameraAssist.willMark("pinch")).toBe(false); // camera off
    expect(screen.getByText(/Until then, recordings are made as usual with no camera marks/)).toBeInTheDocument();

    hands = [makeHand({ pinch: 0.1 })];
    fireEvent.click(screen.getByRole("button", { name: "Turn camera on" }));
    await vi.waitFor(() => expect(next).not.toBeNull());
    await act(async () => { next?.(); });
    await vi.waitFor(() => expect(cameraAssist.willMark("pinch")).toBe(true));

    rerender(<CameraAssistCard selectedLabel="other" recording={false} desktopAvailable />); // no gesture for this label
    await vi.waitFor(() => expect(cameraAssist.willMark("other")).toBe(false));
    expect(cameraAssist.willMark("pinch")).toBe(false);
  });
});
