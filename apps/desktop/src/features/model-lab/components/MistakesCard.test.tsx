import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { appNavigation } from "../../../shared/navigation/appNavigation";
import { describeMistake, falseByActivity, MistakesCard, type MistakesReport } from "./MistakesCard";

const report: MistakesReport = {
  version: "v1",
  label: "pinch",
  threshold: 0.65,
  missing: [],
  recordings: [
    {
      id: "rec1", name: "Monday", role: "test", minutes: 2, starts: 3, caught: 1,
      mistakes: [
        { kind: "missed", atMs: 10_000, peak: 0.41, why: null, during: "pinch" },
        { kind: "false", atMs: 30_000, peak: 0.8, why: "elsewhere", during: "typing" },
        { kind: "false", atMs: 40_000, peak: 0.7, why: "elsewhere", during: "typing" },
        { kind: "false", atMs: 50_000, peak: 0.7, why: "early", during: null },
      ],
    },
  ],
};

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("a model's mistakes", () => {
  it("says what each was and what was going on", () => {
    expect(describeMistake(report.recordings[0].mistakes[0], 0.65)).toBe("Missed: reached only 0.41 of 0.65");
    expect(describeMistake(report.recordings[0].mistakes[1], 0.65)).toBe("False: fired nowhere near a start, during typing");
    expect(falseByActivity(report)).toEqual([["typing", 2], ["nothing labelled", 1]]);
  });

  it("finds them for a model and opens one on the Labelling page, its stretch selected", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    invoke.mockResolvedValue(report);
    const opened = vi.fn();
    const stop = appNavigation.onOpen(opened);
    render(<MistakesCard desktopAvailable models={[{ id: "v1", label: "pinch", state: "active", deployable: true, imported: false, modelSha256: null, createdAt: "", active: true }]} />);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Find mistakes" }));
    await waitFor(() => expect(screen.getByText(/caught 1 of 3 starts; 1 missed and 3 false/)).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("model_mistakes", { versionId: "v1", includeTraining: false });
    expect(screen.getByText(/typing \(2\), nothing labelled \(1\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "False" }));
    expect(screen.queryByText(/Missed: reached only/)).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]);
    expect(opened).toHaveBeenCalledWith("labelling");
    expect(appNavigation.takeLabellingFocus()).toEqual({ datasetId: "rec1", atMs: 30_000, select: { startMs: 29_120, endMs: 30_120 } });
    stop();
  });
});
