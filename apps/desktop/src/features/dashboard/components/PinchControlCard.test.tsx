import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRuntimeModeForTests } from "../../model-lab/runtimeMode";
import { PinchControlCard } from "./PinchControlCard";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

const status = { mode: "monitor", loadedLabels: ["pinch_in"], loadFailures: [], quarantined: [], registryError: null, activeDetections: [], lastScores: {} };
const models = [
  { id: "pinch-1", label: "pinch_in", name: "CNN v2", state: "active", deployable: true, imported: false, modelSha256: "x", createdAt: "2026-11-15", active: true },
  { id: "pinch-0", label: "pinch_in", state: "approved", deployable: true, imported: false, modelSha256: "y", createdAt: "2026-11-14", active: false },
];

beforeEach(() => {
  invokeMock.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invokeMock.mockImplementation(async (command: string) => (command === "list_label_models" ? models : command === "get_label_runtime_status" ? status : undefined));
});
afterEach(() => {
  cleanup();
  resetRuntimeModeForTests();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("the trained models card on Overview", () => {
  it("names the active models and switches the runtime from the home page", async () => {
    render(<PinchControlCard />);
    const card = within(screen.getByRole("region", { name: "Trained models" }));
    expect(await card.findByText("Active: pinch_in (CNN v2).")).toBeInTheDocument();
    await waitFor(() => expect(card.getByRole("radio", { name: "Monitor" })).toBeChecked());
  });

  it("shows nothing in the browser preview", () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    render(<PinchControlCard />);
    expect(screen.queryByRole("region", { name: "Trained models" })).toBeNull();
  });
});
