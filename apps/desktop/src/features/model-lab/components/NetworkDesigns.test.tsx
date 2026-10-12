import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkDesigns } from "./NetworkDesigns";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const builtIn = {
  id: "builtin-mlp", name: "Small network", description: "Two layers", method: "mlp", inputMode: "statistics", sources: ["watchImu"], ppgChannels: null,
  movementOnly: false, features: null, columns: [], readings: 1, spikeMethod: "none", windowMs: 1000, network: null, builtIn: true,
};
const own = { ...builtIn, id: "mine", name: "Mine", builtIn: false };
const preview = { problem: null, available: ["accel_x_std"], inputs: ["accel_x_std"], neurons: 1 };

let saved: unknown[] = [];

beforeEach(() => {
  invokeMock.mockReset();
  saved = [builtIn, own];
  invokeMock.mockImplementation(async (command: string, args?: { id?: string; design?: { name: string } }) => {
    switch (command) {
      case "list_network_designs": return saved;
      case "preview_network_design": return preview;
      case "save_network_design": saved = [...saved, { ...args!.design, id: "new", builtIn: false }]; return saved;
      case "delete_network_design": saved = saved.filter((d) => (d as { id: string }).id !== args?.id); return saved;
      default: return undefined;
    }
  });
});
afterEach(cleanup);

describe("NetworkDesigns", () => {
  it("lists built-in and own designs, built-in ones without edit or delete", async () => {
    render(<NetworkDesigns desktopAvailable />);
    expect(await screen.findByText("Small network")).toBeInTheDocument();
    expect(screen.getByText("Mine")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View Small network" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Small network" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete Mine" })).toBeInTheDocument();
  });

  it("shows a built-in design read-only", async () => {
    render(<NetworkDesigns desktopAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "View Small network" }));
    expect(await screen.findByText(/cannot be changed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save design" })).toBeNull();
  });

  it("duplicates a design and saves the copy", async () => {
    render(<NetworkDesigns desktopAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "Duplicate Small network" }));
    const save = await screen.findByRole("button", { name: "Save design" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("save_network_design", expect.anything()));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save design" })).toBeNull());
  });

  it("asks before deleting", async () => {
    render(<NetworkDesigns desktopAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Mine" }));
    expect(invokeMock).not.toHaveBeenCalledWith("delete_network_design", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Delete Mine for good" }));
    await waitFor(() => expect(screen.queryByText("Mine")).toBeNull());
  });

  it("cannot save a design the desktop rejects", async () => {
    invokeMock.mockImplementation(async (command: string) => (command === "list_network_designs" ? saved : command === "preview_network_design" ? { ...preview, problem: "No data." } : undefined));
    render(<NetworkDesigns desktopAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Mine" }));
    expect(await screen.findByText("No data.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save design" })).toBeDisabled();
  });
});

describe("window length hint", () => {
  it("says the window barely matters for one reading without spike extraction, and stops saying so once it does", async () => {
    const raw = { ...builtIn, id: "mine", name: "Mine", builtIn: false, method: "torch-mlp", inputMode: "raw", columns: ["accel_x", "accel_y"], readings: 1, spikeMethod: "none" };
    saved = [raw];
    render(<NetworkDesigns desktopAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Mine" }));
    expect(await screen.findByText(/window length has almost no effect/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Spike extraction"), { target: { value: "morphological_top_hat" } });
    await waitFor(() => expect(screen.queryByText(/window length has almost no effect/)).toBeNull());
    expect(screen.getByText(/spread evenly across it/)).toBeInTheDocument();
  });
});

describe("comparing the pulse level with the recent past", () => {
  it("is offered whenever the pulse sensor is read, sent with the design, and for columns reads the pulse in units of its past", async () => {
    const pulse = { ...builtIn, id: "mine", name: "Mine", builtIn: false, sources: ["watchPpg"], baselineMs: null };
    saved = [pulse];
    render(<NetworkDesigns desktopAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Mine" }));
    const select = await screen.findByLabelText("Compare the pulse level with the recent past");
    expect(screen.getByText(/includes the session's own level/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "4000" } });
    expect(await screen.findByText(/last 4 seconds/)).toBeInTheDocument();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("preview_network_design", { design: expect.objectContaining({ baselineMs: 4000, features: null }) }));
    fireEvent.change(screen.getByLabelText("What goes into the model"), { target: { value: "raw" } });
    expect(await screen.findByText(/Each pulse channel is read in units of its last 4 seconds/)).toBeInTheDocument();
  });

  it("is not offered without the pulse sensor", async () => {
    saved = [{ ...builtIn, id: "mine", name: "Mine", builtIn: false, sources: ["watchAcceleration"] }];
    render(<NetworkDesigns desktopAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Mine" }));
    await screen.findByLabelText("Method");
    expect(screen.queryByLabelText("Compare the pulse level with the recent past")).toBeNull();
  });
});

describe("starting a convolutional design from a pre-trained encoder", () => {
  const encoder = { id: "motion-encoder", windowMs: 1000, steps: 32, accuracy: 0.55, gestureVsNothingAuc: 0.93, pinchVsOtherGesturesAuc: 0.82, sha256: "ab" };
  const cnn = { ...own, id: "cnn", name: "Conv", method: "cnn1d", inputMode: "raw", sources: ["watchPpg"], columns: ["ppg_green"], readings: 16, windowMs: 500 };

  it("offers the encoders in this checkout and, when one is chosen, makes the design read what it read", async () => {
    saved = [cnn];
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command: string, args?: unknown) => (command === "list_motion_encoders" ? [encoder] : base(command, args as never)));
    render(<NetworkDesigns desktopAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Conv" }));
    const select = await screen.findByLabelText("Start from a pre-trained encoder");
    await waitFor(() => expect(screen.getByRole("option", { name: "motion-encoder (1 s, 32 readings)" })).toBeInTheDocument());
    fireEvent.change(select, { target: { value: "motion-encoder" } });
    expect(await screen.findByText(/pinch from other gestures with 0.82/)).toBeInTheDocument();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("preview_network_design", {
      design: expect.objectContaining({
        pretrained: "motion-encoder", columns: ["accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z"], readings: 32, windowMs: 1000, movementOnly: true,
      }),
    }));
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Keep its layers as they are (only the last layer learns)" })[0]);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("preview_network_design", { design: expect.objectContaining({ pretrainedFreeze: true }) }));
  });

  it("says how to make one when the checkout has none", async () => {
    saved = [cnn];
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command: string, args?: unknown) => (command === "list_motion_encoders" ? [] : base(command, args as never)));
    render(<NetworkDesigns desktopAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Conv" }));
    expect(await screen.findByText(/No pre-trained encoder in this checkout/)).toBeInTheDocument();
  });

  it("is not offered for other methods", async () => {
    render(<NetworkDesigns desktopAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Mine" }));
    await screen.findByLabelText("Method");
    expect(screen.queryByLabelText("Start from a pre-trained encoder")).toBeNull();
  });
});
