import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../../../app/App";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

describe("ModelLab", () => {
  it("opens from the nav tab and shows every workflow section plus the unavailable-runner reason", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Model Lab" }));

    for (const sectionLabel of ["Dataset", "Label coverage", "Training", "Evaluation", "Export and deploy"]) {
      expect(screen.getByRole("region", { name: sectionLabel })).toBeInTheDocument();
    }

    expect(screen.getAllByText(/managed tauri runner is the next integration slice/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Start training" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export model" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deploy to device" })).toBeDisabled();

    expect(screen.getByText(/no dataset sessions are stored or imported/i)).toBeInTheDocument();
    expect(screen.getByText(/no trained model exists yet/i)).toBeInTheDocument();
  });
});
