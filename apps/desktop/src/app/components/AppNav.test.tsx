import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "../../components/ui/sidebar";
import { AppNav, NAV_ORDER, navStatuses, shortcutFor, type NavStatusInput } from "./AppNav";

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

  it("flags the Recorder while a recording is arming or running, and only then", () => {
    expect(navStatuses({ ...idle, recordingState: "recording" }).recorder).toEqual({ tone: "live", label: "recording" });
    expect(navStatuses({ ...idle, recordingState: "arming" }).recorder?.tone).toBe("live");
    for (const state of ["idle", "saved", "discarded"] as const) {
      expect(navStatuses({ ...idle, recordingState: state }).recorder).toBeUndefined();
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
    renderNav({ activeTab: "recorder" });
    for (const name of ["Main", "Headphones", "Watch", "Live signals", "Recorder", "Recordings", "Model Lab", "Settings"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Live data" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recorder" })).toHaveAttribute("aria-current", "page");
    for (const group of ["Devices", "Automation", "Capture", "Models"]) expect(screen.getByText(group)).toBeInTheDocument();
  });

  it("says each device's state to screen readers as well as by colour, without changing the button's name", () => {
    renderNav({
      statuses: navStatuses({ ...idle, headphonesConnected: true, watchConnected: true, watchWorn: false, recordingState: "recording" }),
    });
    expect(screen.getByRole("button", { name: "Headphones" })).toHaveAccessibleDescription("connected");
    expect(screen.getByRole("button", { name: "Watch" })).toHaveAccessibleDescription("connected, off wrist");
    expect(screen.getByRole("button", { name: "Recorder" })).toHaveAccessibleDescription("recording");
    expect(screen.getByRole("button", { name: "Main" })).not.toHaveAccessibleDescription();
  });

  it("selects a tab on click", () => {
    const onSelect = renderNav();
    fireEvent.click(screen.getByRole("button", { name: "Model Lab" }));
    expect(onSelect).toHaveBeenCalledWith("modelLab");
  });

  it("jumps to the first nine tabs with Ctrl+digit in display order, including from inside a text field", () => {
    const onSelect = renderNav();
    NAV_ORDER.slice(0, 9).forEach((tab, index) => {
      fireEvent.keyDown(window, { key: String(index + 1), ctrlKey: true });
      expect(onSelect).toHaveBeenLastCalledWith(tab);
    });
    expect(NAV_ORDER).toEqual(["main", "headphone", "watch", "recipes", "devices", "gestures", "signals", "recorder", "recordings", "modelLab", "settings"]);
  });

  it("opens Settings with Ctrl+comma, since the tenth and later tabs have no number", () => {
    const onSelect = renderNav();
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    expect(onSelect).toHaveBeenLastCalledWith("settings");
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("names a tab's shortcut only when it has one", () => {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    const prefix = isMac ? "⌘" : "Ctrl+";
    expect(shortcutFor("main")).toBe(`${prefix}1`);
    expect(shortcutFor("recordings")).toBe(`${prefix}9`);
    expect(shortcutFor("modelLab")).toBeNull();
    expect(shortcutFor("settings")).toBe(`${prefix},`);
  });

  it("ignores a bare digit, other modifiers, and out-of-range digits", () => {
    const onSelect = renderNav();
    fireEvent.keyDown(window, { key: "2" });
    fireEvent.keyDown(window, { key: "2", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "2", ctrlKey: true, altKey: true });
    fireEvent.keyDown(window, { key: "0", ctrlKey: true });
    fireEvent.keyDown(window, { key: ",", ctrlKey: true, shiftKey: true });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
