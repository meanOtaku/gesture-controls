import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import { CoverageCard } from "./CoverageCard";

afterEach(cleanup);

describe("the coverage card", () => {
  it("shows the holds of the most recorded label by arm and wrist, with the empty conditions marked", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    invoke.mockResolvedValue([
      { id: "a", originalFilename: "a", importedAt: "", label: "pinch", rowCount: 1, quality: { poorContactShare: 0, holds: { pinch: 25 }, shortHolds: 0 }, context: { arm: "resting", wrist: "left" } },
    ]);
    render(<CoverageCard />);
    const grid = await screen.findByRole("table", { name: "Holds of pinch by arm and wrist" });
    const resting = within(grid).getByRole("row", { name: /Resting on a surface/ });
    expect(within(resting).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["25", "none", "none"]);
    expect(screen.getByText("25 holds in 1 recording.")).toBeInTheDocument();
  });
});
