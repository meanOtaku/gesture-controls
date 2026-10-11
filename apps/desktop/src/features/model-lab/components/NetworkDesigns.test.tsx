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
