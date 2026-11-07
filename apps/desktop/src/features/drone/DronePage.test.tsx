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
  videoRestarts: 0,
  videoRepeats: 0,
  unknownPackets: 0,
  report: null,
  statusMessages: 0,
  unknownPacketsFile: null,
  sendErrors: 0,
  flow: null,
  driftX: 0,
  driftY: 0,
  holding: false,
  holdPhase: "off",
  holdFault: null,
  correction: null,
  heightRate: 0,
  hasHoldCalibration: false,
  manualSteering: false,
  tookOff: false,
  headless: false,
  returning: false,
  flightLog: null,
  pageAlive: false,
  onNetwork: false,
  firmware: null,
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

  it("says it is waiting for the drone's Wi-Fi until it is on it", async () => {
    await show({});
    expect(screen.getByText("Waiting for the drone's Wi-Fi")).toBeTruthy();
    cleanup();
    await show({ onNetwork: true });
    expect(screen.getByText("Not connected")).toBeTruthy();
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
    expect(invoke).toHaveBeenCalledWith("drone_heartbeat", { input: expect.objectContaining({ height: 0, aileron: 0, elevator: 0 }) });
  });

  it("calibrates the gyro only when connected and not armed", async () => {
    await show({});
    expect(button("Calibrate gyro").disabled).toBe(true);
    cleanup();
    await show({ phase: "open" });
    fireEvent.click(button("Calibrate gyro"));
    expect(invoke).toHaveBeenCalledWith("drone_calibrate_gyro");
    cleanup();
    await show({ phase: "open", armed: true });
    expect(button("Calibrate gyro").disabled).toBe(true);
  });

  it("shows the firmware name once the drone gives it", async () => {
    await show({ phase: "open", firmware: "(NOFLOW)FLOW_720P_V1.4.17_20250520" });
    expect(screen.getByText(/Firmware \(NOFLOW\)FLOW_720P_V1\.4\.17_20250520\./)).toBeTruthy();
  });

  it("offers height control only once armed", async () => {
    await show({ phase: "open" });
    expect(button("Climb").disabled).toBe(true);
    expect(button("Descend").disabled).toBe(true);
    cleanup();
    await show({ phase: "open", armed: true });
    expect(button("Climb").disabled).toBe(false);
  });

  it("sends height only while a button is held, and lets go if the pointer leaves", async () => {
    vi.useFakeTimers();
    try {
      await show({ phase: "open", armed: true });
      const heights = () => invoke.mock.calls.filter(([command]) => command === "drone_heartbeat").map(([, args]) => args.input.height);
      fireEvent.pointerDown(button("Climb"));
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(heights().at(-1)).toBe(30);
      fireEvent.pointerLeave(button("Climb"));
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(heights().at(-1)).toBe(0);
      fireEvent.pointerDown(button("Descend"));
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(heights().at(-1)).toBe(-30);
      fireEvent(window, new Event("blur"));
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(heights().at(-1)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows calibration, why hold stopped, and where the flight is recorded", async () => {
    await show({ phase: "open", armed: true, holding: true, holdPhase: "calibrating", flightLog: "/logs/flight.csv" });
    expect(screen.getByText("Armed, measuring the drone")).toBeTruthy();
    expect(screen.getByText(/Recording this flight to \/logs\/flight\.csv/)).toBeTruthy();
    cleanup();
    await show({ phase: "open", armed: true, tookOff: true, holdPhase: "failed", holdFault: "The picture could not be followed." });
    expect(screen.getByRole("alert").textContent).toContain("could not be followed");
    expect(button("Hold position").disabled).toBe(false);
  });

  it("steers with the arrow keys only while armed, and lets go on release", async () => {
    vi.useFakeTimers();
    try {
      await show({ phase: "open" });
      const beats = () => invoke.mock.calls.filter(([command]) => command === "drone_heartbeat").map(([, args]) => ({ height: args.input.height, aileron: args.input.aileron, elevator: args.input.elevator }));
      fireEvent.keyDown(window, { key: "ArrowRight" });
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(beats().at(-1)).toEqual({ height: 0, aileron: 0, elevator: 0 });
      cleanup();
      invoke.mockClear();
      await show({ phase: "open", armed: true });
      fireEvent.keyDown(window, { key: "ArrowRight" });
      fireEvent.keyDown(window, { key: "ArrowUp" });
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(beats().at(-1)).toEqual({ height: 0, aileron: 25, elevator: 25 });
      fireEvent.keyUp(window, { key: "ArrowRight" });
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(beats().at(-1)).toEqual({ height: 0, aileron: 0, elevator: 25 });
      fireEvent(window, new Event("blur"));
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(beats().at(-1)).toEqual({ height: 0, aileron: 0, elevator: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reverses an axis when asked, and remembers it", async () => {
    vi.useFakeTimers();
    try {
      window.localStorage.clear();
      await show({ phase: "open", armed: true });
      const beats = () => invoke.mock.calls.filter(([command]) => command === "drone_heartbeat").map(([, args]) => ({ height: args.input.height, aileron: args.input.aileron, elevator: args.input.elevator }));
      fireEvent.click(screen.getByLabelText("Reverse left and right"));
      fireEvent.pointerDown(button("Left"));
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(beats().at(-1)).toEqual({ height: 0, aileron: 25, elevator: 0 });
      expect(window.localStorage.getItem("droneReverse")).toContain("\"aileron\":true");
    } finally {
      vi.useRealTimers();
      window.localStorage.clear();
    }
  });

  it("refuses a second take off until landed, and hold until flying", async () => {
    await show({ phase: "open", armed: true });
    expect(button("Take off").disabled).toBe(false);
    expect(button("Hold position").disabled).toBe(true);
    cleanup();
    await show({ phase: "open", armed: true, tookOff: true });
    expect(button("Take off").disabled).toBe(true);
    expect(button("Hold position").disabled).toBe(false);
    expect(screen.getByText(/Keep a metre clear all round/)).toBeTruthy();
  });

  it("sends trim with every heartbeat, within its limit, and remembers it", async () => {
    vi.useFakeTimers();
    try {
      window.localStorage.clear();
      await show({ phase: "open" });
      const inputs = () => invoke.mock.calls.filter(([command]) => command === "drone_heartbeat").map(([, args]) => args.input);
      fireEvent.click(screen.getByRole("button", { name: "Trim sideways right" }));
      fireEvent.click(screen.getByRole("button", { name: "Trim sideways right" }));
      fireEvent.click(screen.getByRole("button", { name: "Trim turning left" }));
      for (let step = 0; step < 30; step += 1) fireEvent.click(screen.getByRole("button", { name: "Trim forward back" }));
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(inputs().at(-1)).toMatchObject({ trimAileron: 2, trimRudder: -1, trimElevator: -20 });
      expect(JSON.parse(window.localStorage.getItem("droneTrim") ?? "{}")).toEqual({ aileron: 2, elevator: -20, rudder: -1 });
      fireEvent.click(button("Reset trim"));
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(inputs().at(-1)).toMatchObject({ trimAileron: 0, trimElevator: 0, trimRudder: 0 });
    } finally {
      vi.useRealTimers();
      window.localStorage.clear();
    }
  });

  it("holds after takeoff by default, and says when a measurement is needed first", async () => {
    vi.useFakeTimers();
    try {
      window.localStorage.clear();
      await show({ phase: "open" });
      const inputs = () => invoke.mock.calls.filter(([command]) => command === "drone_heartbeat").map(([, args]) => args.input);
      expect(screen.getByText(/Needs one measurement first/)).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(inputs().at(-1)).toMatchObject({ autoHold: true });
      fireEvent.click(screen.getByLabelText("Hold position after takeoff"));
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(inputs().at(-1)).toMatchObject({ autoHold: false });
      expect(window.localStorage.getItem("droneAutoHold")).toBe("off");
      cleanup();
      await show({ phase: "open", hasHoldCalibration: true });
      expect(screen.getByText(/Three seconds after Take off/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
      window.localStorage.clear();
    }
  });

  it("says where packets the app does not understand are saved, only once there are some", async () => {
    await show({ phase: "open" });
    expect(screen.queryByText(/does not understand/)).toBeNull();
    cleanup();
    await show({ phase: "open", unknownPackets: 3, unknownPacketsFile: "/data/drone-unknown-packets.txt" });
    expect(screen.getByText(/sent 3 packets the app does not understand/)).toBeTruthy();
    expect(screen.getByText(/saved in \/data\/drone-unknown-packets.txt/)).toBeTruthy();
  });

  it("shows the drone's own report only once it has sent one", async () => {
    await show({ phase: "open" });
    expect(screen.queryByLabelText("Drone report")).toBeNull();
    cleanup();
    await show({
      phase: "open",
      statusMessages: 4,
      report: { flyState: 2, battery: 81, speed: 1, remoteControl: false, cameraTilt: false, headless: true, photo: false, video: false, light: false },
    });
    expect(screen.getByLabelText("Drone report").textContent).toMatch(/fly state 2, battery 81 .*speed 1, headless on\. 4 reports/);
  });

  it("turns headless on and off", async () => {
    await show({ phase: "open" });
    fireEvent.click(screen.getByLabelText("Headless mode"));
    expect(invoke).toHaveBeenCalledWith("drone_set_headless", { enabled: true });
    cleanup();
    await show({ phase: "open", headless: true });
    fireEvent.click(screen.getByLabelText("Headless mode"));
    expect(invoke).toHaveBeenCalledWith("drone_set_headless", { enabled: false });
  });

  it("asks before returning, only while flying, and can cancel", async () => {
    await show({ phase: "open", armed: true });
    expect((button("Return home") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    await show({ phase: "open", armed: true, tookOff: true });
    fireEvent.click(button("Return home"));
    expect(invoke).not.toHaveBeenCalledWith("drone_set_return", expect.anything());
    fireEvent.click(button("Keep flying"));
    fireEvent.click(button("Return home"));
    fireEvent.click(button("Confirm return"));
    expect(invoke).toHaveBeenCalledWith("drone_set_return", { enabled: true });
    cleanup();
    await show({ phase: "open", armed: true, tookOff: true, returning: true });
    fireEvent.click(button("Cancel return"));
    expect(invoke).toHaveBeenCalledWith("drone_set_return", { enabled: false });
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
    await show({ phase: "open", armed: true, tookOff: true });
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
