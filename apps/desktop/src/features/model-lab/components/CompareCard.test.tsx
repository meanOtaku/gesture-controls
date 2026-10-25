import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import type { LabelModel } from "../labelModels";
import { CompareCard, type Comparison } from "./CompareCard";

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

const model = (id: string, label = "pinch"): LabelModel => ({ id, label, state: "draft", deployable: true, imported: false, modelSha256: null, createdAt: "2026-10-20", active: false });
const sweep = (version: string) => ({ version, label: "pinch", threshold: 0.65, recordings: 1, points: [{ threshold: 0.65, starts: 10, caught: 5, falseActivations: 2, minutes: 2 }] });
const comparison: Comparison = {
  models: [sweep("v1"), sweep("v2")],
  recordings: [{ id: "r4", name: "thursday", minutes: 2, starts: 10, caught: [5, 7], falseActivations: [2, 4] }],
};

describe("comparing models", () => {
  it("compares models of one label on the recordings none trained on", async () => {
    invoke.mockImplementation(async (command: string) => (command === "compare_models" ? comparison : [{ testedAt: "2026-10-22T10:00:00Z", version: "v2", label: "pinch", recordings: ["s"], starts: 20, caught: 9, falseActivations: 3, minutes: 3 }]));
    render(<CompareCard desktopAvailable models={[model("v1"), model("v2"), model("f1", "fist")]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v1" }));
    // Only models of the same label can join.
    expect(screen.getByRole("checkbox", { name: "Compare f1" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v2" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare 2 models" }));
    const result = await screen.findByRole("region", { name: "Comparison" });
    expect(invoke).toHaveBeenCalledWith("compare_models", { versionIds: ["v1", "v2"] });
    const row = within(result).getByRole("row", { name: /thursday/ });
    expect(row).toHaveTextContent("5 (50%) · 2");
    expect(row).toHaveTextContent("7 (70%) · 4");
    await waitFor(() => expect(within(result).getByText(/Final tests: v2 caught 9 of 20 with 1\.0 false a minute/)).toBeInTheDocument());
  });
});
