import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const camera = vi.hoisted(() => ({ status: "off", listeners: new Set<() => void>() }));
vi.mock("../../features/camera/cameraService", () => ({
  getCameraController: () => ({
    subscribe: (listener: () => void) => { camera.listeners.add(listener); return () => camera.listeners.delete(listener); },
    getSnapshot: () => ({ status: camera.status }),
  }),
}));

import { NervBars, sectionIdentifier } from "./NervBars";

const base = { activeTab: "main" as const, headphonesConnected: false, watchConnected: false, watchWorn: null, recordingState: "idle" as const };

beforeEach(() => {
  camera.status = "off";
  document.documentElement.setAttribute("data-theme", "nerv");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.removeAttribute("data-theme");
});

describe("NervBars", () => {
  it("names a page by its place in the navigation and its name", () => {
    expect(sectionIdentifier("main")).toBe("01 // MAIN");
    expect(sectionIdentifier("gestureLibrary")).toBe("05 // GESTURE LIBRARY");
    expect(sectionIdentifier("settings")).toMatch(/^\d\d \/\/ SETTINGS$/);
  });

  it("is only there under the NERV theme", () => {
    document.documentElement.removeAttribute("data-theme");
    render(<NervBars {...base} />);
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("contentinfo")).toBeNull();
  });

  it("shows the system name and the open page in the top bar", () => {
    const { rerender } = render(<NervBars {...base} activeTab="recorder" />);
    const header = within(screen.getByRole("banner"));
    expect(header.getByText("SPATIAL GESTURE CONTROL")).toBeInTheDocument();
    expect(header.getByText("07 // RECORDER")).toBeInTheDocument();
    rerender(<NervBars {...base} activeTab="settings" />);
    expect(header.getByText(/\/\/ SETTINGS$/)).toBeInTheDocument();
  });

  it("shows every device offline, with symbols as well as words, when nothing is connected", () => {
    render(<NervBars {...base} />);
    const footer = within(screen.getByRole("contentinfo"));
    for (const label of ["HEADPHONES", "WATCH", "CAMERA"]) {
      expect(footer.getByText(label).nextElementSibling?.textContent).toMatch(/^○ (OFFLINE|OFF)$/);
    }
    expect(footer.getByText("RECORDER").nextElementSibling?.textContent).toBe("○ IDLE");
  });

  it("shows what is connected, what is off the wrist, what is recording and what the camera is doing", () => {
    const { rerender } = render(<NervBars {...base} headphonesConnected watchConnected watchWorn recordingState="recording" />);
    const footer = within(screen.getByRole("contentinfo"));
    const value = (label: string) => footer.getByText(label).nextElementSibling?.textContent;
    expect(value("HEADPHONES")).toBe("● ONLINE");
    expect(value("WATCH")).toBe("● ONLINE");
    expect(value("RECORDER")).toBe("▲ RECORDING");
    rerender(<NervBars {...base} watchConnected watchWorn={false} recordingState="arming" />);
    expect(value("WATCH")).toBe("▲ OFF WRIST");
    expect(value("RECORDER")).toBe("▲ ARMING");
    act(() => { camera.status = "on"; camera.listeners.forEach((listener) => listener()); });
    expect(value("CAMERA")).toBe("● ON");
  });

  it("gives each device a triangle in the top bar that names its real state", () => {
    const { rerender } = render(<NervBars {...base} headphonesConnected />);
    const units = within(screen.getByRole("list", { name: "Devices" }));
    expect(units.getByLabelText("HEAD: ONLINE")).toHaveAttribute("data-tone", "active");
    expect(units.getByLabelText("WATCH: OFFLINE")).toHaveAttribute("data-tone", "offline");
    expect(units.getByLabelText("CAM: OFF")).toHaveAttribute("data-tone", "offline");
    rerender(<NervBars {...base} watchConnected watchWorn={false} />);
    expect(units.getByLabelText("WATCH: OFF WRIST")).toHaveAttribute("data-tone", "caution");
    act(() => { camera.status = "on"; camera.listeners.forEach((listener) => listener()); });
    expect(units.getByLabelText("CAM: ON")).toHaveAttribute("data-tone", "active");
  });

  it("keeps a real clock that moves on each second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 19, 42, 8));
    render(<NervBars {...base} />);
    const clock = () => document.querySelector(".nerv-footer-clock")?.textContent;
    expect(clock()).toBe("19:42:08");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(clock()).toBe("19:42:09");
  });

  it("shows the same time in the top bar on a seven-segment display, lighting the segments of each digit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 19, 42, 8));
    render(<NervBars {...base} />);
    const header = within(screen.getByRole("banner"));
    expect(header.getByText("19:42:08")).toBeInTheDocument();
    const digits = document.querySelectorAll(".nerv-7seg-digit");
    expect(digits).toHaveLength(6);
    const lit = (digit: Element) => digit.querySelectorAll("polygon[data-on]").length;
    expect([...digits].map(lit)).toEqual([2, 6, 4, 5, 6, 7]);
    expect(document.querySelectorAll(".nerv-7seg-colon")).toHaveLength(2);
  });
});
