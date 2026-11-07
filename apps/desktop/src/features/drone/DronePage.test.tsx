import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DronePage, parseFrame, type DroneState } from "./DronePage";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const idle: DroneState = {
  phase: "disconnected",
  armed: false,
  failsafeTripped: false,
  steering: false,
  watchStreaming: false,
  framesSent: 0,
  videoFrames: 0,
  videoSkipped: 0,
  videoDamaged: 0,
  sendErrors: 0,
  flow: null,
  driftX: 0,
  driftY: 0,
  holding: false,
  correction: null,
  pageAlive: false,
};

async function show(state: Partial<DroneState>) {
  invoke.mockImplementation(() => Promise.resolve({ ...idle, ...state }));
  render(<DronePage />);
  await act(async () => { await Promise.resolve(); });
}

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  invoke.mockReset();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("parseFrame", () => {
  it("reads the frame number and leaves the JPEG", () => {
    const bytes = new Uint8Array([7, 1, 0, 0, 0xff, 0xd8]).buffer;
    const frame = parseFrame(bytes);
    expect(frame?.number).toBe(263);
    expect(frame?.jpeg.size).toBe(2);
    expect(frame?.jpeg.type).toBe("image/jpeg");
  });

  it("treats an empty reply as no new frame", () => {
    expect(parseFrame(new ArrayBuffer(0))).toBeNull();
  });
});

describe("DronePage", () => {
  it("reports camera tracking and resets its centre", async () => {
    await show({ phase: "open", flow: { frame: 9, dx: 1, dy: 0, zoom: 0.02, confidence: 0.5 }, driftX: 12.34, driftY: -3 });
    expect(screen.getByText(/Agreement 50%/)).toBeTruthy();
    expect(screen.getByText(/Drift 12\.3, -3\.0 px, zoom 2\.0%/)).toBeTruthy();
    fireEvent.click(button("Set centre"));
    expect(invoke).toHaveBeenCalledWith("drone_reset_drift");
  });

  it("offers only connecting while disconnected", async () => {
    await show({});
    expect(button("Connect").disabled).toBe(false);
    for (const name of ["Arm", "Take off", "Land", "Stop"]) expect(button(name).disabled).toBe(true);
  });

  it("will not arm with nothing keeping the link alive", async () => {
    await show({ phase: "open" });
    expect(button("Arm").disabled).toBe(true);
    expect(button("Take off").disabled).toBe(true);
  });

  it("arms from this page alone, without the watch", async () => {
    await show({ phase: "open", pageAlive: true });
    expect(button("Arm").disabled).toBe(false);
  });

  it("keeps the link alive while connected, and not before", async () => {
    await show({});
    expect(invoke).not.toHaveBeenCalledWith("drone_heartbeat");
    cleanup();
    await show({ phase: "open" });
    expect(invoke).toHaveBeenCalledWith("drone_heartbeat");
  });

  it("previews corrections and only allows hold once armed", async () => {
    await show({ phase: "open", correction: { aileron: 5, elevator: -2 } });
    expect(screen.getByText(/Would send aileron \+5, elevator -2/)).toBeTruthy();
    expect(button("Hold position").disabled).toBe(true);
  });

  it("says when the picture cannot be trusted", async () => {
    await show({ phase: "open" });
    expect(screen.getByText(/Would send nothing: the picture cannot be trusted/)).toBeTruthy();
  });

  it("turns hold on and off", async () => {
    await show({ phase: "open", armed: true });
    fireEvent.click(button("Hold position"));
    expect(invoke).toHaveBeenCalledWith("drone_set_hold", { enabled: true });
    cleanup();
    await show({ phase: "open", armed: true, holding: true, correction: { aileron: 1, elevator: 0 } });
    expect(screen.getByText(/Sending aileron \+1, elevator 0/)).toBeTruthy();
    fireEvent.click(button("Stop holding"));
    expect(invoke).toHaveBeenCalledWith("drone_set_hold", { enabled: false });
  });

  it("arms once connected with the watch streaming, and only then allows take off", async () => {
    await show({ phase: "open", watchStreaming: true });
    expect(button("Arm").disabled).toBe(false);
    expect(button("Take off").disabled).toBe(true);
    fireEvent.click(button("Arm"));
    expect(invoke).toHaveBeenCalledWith("drone_arm");
  });

  it("keeps land and stop available after landing has disarmed it", async () => {
    await show({ phase: "open", failsafeTripped: true });
    expect(button("Land").disabled).toBe(false);
    expect(button("Stop").disabled).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("told to land");
  });

  it("sends the commands the buttons name", async () => {
    await show({ phase: "open", armed: true, watchStreaming: true });
    fireEvent.click(button("Take off"));
    fireEvent.click(button("Land"));
    fireEvent.click(button("Stop"));
    expect(invoke).toHaveBeenCalledWith("drone_take_off");
    expect(invoke).toHaveBeenCalledWith("drone_land");
    expect(invoke).toHaveBeenCalledWith("drone_stop");
  });

  it("shows why a command was refused", async () => {
    await show({ phase: "open", armed: true });
    invoke.mockImplementationOnce(() => Promise.reject("another button is still being held"));
    await act(async () => {
      fireEvent.click(button("Take off"));
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toContain("still being held");
  });

  it("does nothing outside the desktop app", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    render(<DronePage />);
    await act(async () => { await Promise.resolve(); });
    expect(invoke).not.toHaveBeenCalled();
    expect(button("Connect").disabled).toBe(true);
  });
});
