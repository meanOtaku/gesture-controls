import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "../../components/ui/sidebar";
import { AppNav, NAV_ORDER, navStatuses, type NavStatusInput } from "./AppNav";

afterEach(cleanup);

const idle: NavStatusInput = { headphonesConnected: false, watchConnected: false, watchWorn: null, recordingState: "idle" };

describe("navStatuses", () => {
  it("reports nothing connected and nothing recording by default", () => {
    expect(navStatuses(idle)).toEqual({
      headphone: { tone: "idle", label: "not connected" },
      watch: { tone: "idle", label: "not connected" },
    });
  });

  it("marks connected devices, and a watch that is off the wrist as a warning", () => {
    const connected = navStatuses({ ...idle, headphonesConnected: true, watchConnected: true, watchWorn: true });
    expect(connected.headphone?.tone).toBe("ok");
    expect(connected.watch).toEqual({ tone: "ok", label: "connected" });
    expect(navStatuses({ ...idle, watchConnected: true, watchWorn: false }).watch).toEqual({ tone: "warn", label: "connected, off wrist" });
    // A watch that has not said either way is treated as fine, not as a problem.
    expect(navStatuses({ ...idle, watchConnected: true, watchWorn: null }).watch?.tone).toBe("ok");
  });

  it("does not claim a disconnected watch is off the wrist", () => {
    expect(navStatuses({ ...idle, watchConnected: false, watchWorn: false }).watch?.tone).toBe("idle");
  });

  it("flags Live data while a recording is arming or running, and only then", () => {
    expect(navStatuses({ ...idle, recordingState: "recording" }).telemetry).toEqual({ tone: "live", label: "recording" });
    expect(navStatuses({ ...idle, recordingState: "arming" }).telemetry?.tone).toBe("live");
    for (const state of ["idle", "saved", "discarded"] as const) {
      expect(navStatuses({ ...idle, recordingState: state }).telemetry).toBeUndefined();
    }
  });
});

const renderNav = (props: Partial<Parameters<typeof AppNav>[0]> = {}) => {
  const onSelect = vi.fn();
  render(
    <SidebarProvider>
      <AppNav activeTab="main" onSelect={onSelect} {...props} />
    </SidebarProvider>,
  );
  return onSelect;
};

describe("AppNav", () => {
  it("lists every destination, grouped, with the current page marked", () => {
    renderNav({ activeTab: "telemetry" });
    for (const name of ["Main", "Headphones", "Watch", "Live data", "Model Lab", "Settings"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Live data" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Devices")).toBeInTheDocument();
    expect(screen.getByText("Data")).toBeInTheDocument();
  });

  it("says each device's state to screen readers as well as by colour, without changing the button's name", () => {
    renderNav({
      statuses: navStatuses({ ...idle, headphonesConnected: true, watchConnected: true, watchWorn: false, recordingState: "recording" }),
    });
    expect(screen.getByRole("button", { name: "Headphones" })).toHaveAccessibleDescription("connected");
    expect(screen.getByRole("button", { name: "Watch" })).toHaveAccessibleDescription("connected, off wrist");
    expect(screen.getByRole("button", { name: "Live data" })).toHaveAccessibleDescription("recording");
    expect(screen.getByRole("button", { name: "Main" })).not.toHaveAccessibleDescription();
  });

  it("selects a tab on click", () => {
    const onSelect = renderNav();
    fireEvent.click(screen.getByRole("button", { name: "Model Lab" }));
    expect(onSelect).toHaveBeenCalledWith("modelLab");
  });

  it("jumps to a tab with Ctrl+digit in display order, including from inside a text field", () => {
    const onSelect = renderNav();
    NAV_ORDER.forEach((tab, index) => {
      fireEvent.keyDown(window, { key: String(index + 1), ctrlKey: true });
      expect(onSelect).toHaveBeenLastCalledWith(tab);
    });
    expect(NAV_ORDER).toEqual(["main", "headphone", "watch", "recipes", "telemetry", "modelLab", "settings"]);
  });

  it("ignores a bare digit, other modifiers, and out-of-range digits", () => {
    const onSelect = renderNav();
    fireEvent.keyDown(window, { key: "2" });
    fireEvent.keyDown(window, { key: "2", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "2", ctrlKey: true, altKey: true });
    fireEvent.keyDown(window, { key: "8", ctrlKey: true });
    fireEvent.keyDown(window, { key: "0", ctrlKey: true });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
