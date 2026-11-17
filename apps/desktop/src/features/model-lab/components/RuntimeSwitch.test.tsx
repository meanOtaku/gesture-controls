import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRuntimeModeForTests } from "../runtimeMode";
import { RuntimeSwitch } from "./RuntimeSwitch";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

const baseStatus = { mode: "monitor", loadedLabels: [], loadFailures: [], quarantined: [], registryError: null, activeDetections: [], lastScores: {} };
const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command);

function setup(status: { mode?: string; registryError?: string | null } = {}) {
  let mode = status.mode ?? baseStatus.mode;
  invokeMock.mockImplementation(async (command: string, args?: { mode: string }) => {
    if (command === "set_label_runtime_mode" && args) mode = args.mode;
    if (command === "get_label_runtime_status") return { ...baseStatus, ...status, mode };
    return undefined;
  });
}

describe("RuntimeSwitch", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    cleanup();
    resetRuntimeModeForTests();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("says why when the runtime answers without a mode, or does not answer", async () => {
    setup({ mode: "" });
    render(<RuntimeSwitch variant="page" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The model runtime has not started its models yet");
    cleanup();
    resetRuntimeModeForTests();
    invokeMock.mockReset();
    invokeMock.mockRejectedValue("state unavailable");
    render(<RuntimeSwitch variant="page" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The model runtime did not answer: state unavailable");
  });

  it("asks for confirmation before Live, and switches to Monitor or Off without asking", async () => {
    setup({ mode: "monitor" });
    render(<RuntimeSwitch variant="page" />);
    const group = await screen.findByRole("radiogroup");
    await waitFor(() => expect(within(group).getByRole("radio", { name: "Monitor" })).toBeChecked());
    fireEvent.click(within(group).getByRole("radio", { name: "Live" }));
    expect(await screen.findByText("Let models drive recipes?")).toBeInTheDocument();
    expect(calls("set_label_runtime_mode")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Stay in monitor" }));
    expect(calls("set_label_runtime_mode")).toHaveLength(0);
    fireEvent.click(within(group).getByRole("radio", { name: "Live" }));
    fireEvent.click(await screen.findByRole("button", { name: "Switch to Live" }));
    await waitFor(() => expect(calls("set_label_runtime_mode")).toEqual([["set_label_runtime_mode", { mode: "live" }]]));
    await waitFor(() => expect(within(group).getByRole("radio", { name: "Off" })).not.toBeDisabled());
    fireEvent.click(within(group).getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(calls("set_label_runtime_mode")).toContainEqual(["set_label_runtime_mode", { mode: "off" }]));
  });

  it("keeps two switches in step", async () => {
    setup({ mode: "off" });
    render(<><RuntimeSwitch variant="sidebar" /><RuntimeSwitch variant="page" /></>);
    const [sidebar, page] = await screen.findAllByRole("radiogroup");
    await waitFor(() => expect(within(page).getByRole("radio", { name: "Off" })).toBeChecked());
    fireEvent.click(within(sidebar).getByRole("radio", { name: "Monitor" }));
    await waitFor(() => expect(within(page).getByRole("radio", { name: "Monitor" })).toBeChecked());
  });

  it("cannot change the mode when the registry could not open", async () => {
    setup({ registryError: "corrupt" });
    render(<RuntimeSwitch variant="page" />);
    const group = await screen.findByRole("radiogroup");
    await waitFor(() => expect(within(group).getByRole("radio", { name: "Live" })).toBeDisabled());
  });

  it("shows nothing in the browser preview", () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    render(<RuntimeSwitch variant="sidebar" />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
