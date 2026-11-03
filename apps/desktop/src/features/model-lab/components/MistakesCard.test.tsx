import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { appNavigation } from "../../../shared/navigation/appNavigation";
import { describeMistake, falseByActivity, MistakesCard, type MistakesReport } from "./MistakesCard";

// The recording of `mistakes::tests` (after the trainer's test): two pinches (in, hold, out) and a fist. Caught 0.9 s after
// the first; again during its hold (a repeat); just after it ended; just before the second; late in the second; during the
// fist; and with nothing held. Four false activations in the 15.41 s with no pinch under way.
const totals = { recordings: 1, starts: 2, caught: 1, repeats: 1, late: 1, falseActivations: 4, negativeSeconds: 15.41, falseActivationsPerHour: (4 * 3600) / 15.41 };
const report: MistakesReport = {
  version: "v1",
  label: "pinch_in",
  threshold: 0.65,
  missing: [],
  budgetPerHour: 30,
  tested: { ...totals, cohort: "all", byLabelTiming: { camera: totals } },
  trained: null,
  recordings: [
    {
      id: "rec1", name: "Monday", role: "test", labelTiming: "camera", minutes: 0.33, ...totals,
      mistakes: [
        { kind: "repeat", atMs: 3500, peak: 0.7, why: null, during: "pinch_hold" },
        { kind: "false", atMs: 5000, peak: 0.8, why: "after", during: "pinch_out" },
        { kind: "false", atMs: 9700, peak: 0.75, why: "early", during: null },
        { kind: "missed", atMs: 10_000, peak: 0.4, why: null, during: "pinch_in" },
        { kind: "late", atMs: 11_500, peak: 0.66, why: null, during: "pinch_hold" },
        { kind: "false", atMs: 15_500, peak: 0.8, why: "elsewhere", during: "fist" },
        { kind: "false", atMs: 18_000, peak: 0.8, why: "elsewhere", during: null },
      ],
    },
  ],
};
const mistakes = report.recordings[0].mistakes;

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("a model's mistakes", () => {
  it("says what each was: a firing during a pinch is a repeat or late, and only one with no gesture under way is false", () => {
    expect(describeMistake(mistakes[3], 0.65)).toBe("Missed: reached only 0.40 of 0.65");
    expect(describeMistake(mistakes[0], 0.65)).toBe("Repeat: fired again during a gesture it had caught, during pinch_hold");
    expect(describeMistake(mistakes[4], 0.65)).toBe("Late: fired during a gesture it had not caught in time, during pinch_hold");
    expect(describeMistake(mistakes[1], 0.65)).toBe("False: fired with no gesture under way, just after a gesture ended, during pinch_out");
    expect(describeMistake(mistakes[5], 0.65)).toBe("False: fired with no gesture under way, with no gesture near, during fist");
    expect(falseByActivity(report)).toEqual([["nothing labelled", 2], ["pinch_out", 1], ["fist", 1]]);
  });

  it("finds them for a model, counts false activations per hour against the budget, and opens one on the Labelling page", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    invoke.mockResolvedValue(report);
    const opened = vi.fn();
    const stop = appNavigation.onOpen(opened);
    render(<MistakesCard desktopAvailable models={[{ id: "v1", label: "pinch_in", state: "active", deployable: true, imported: false, modelSha256: null, createdAt: "", active: true }]} />);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Find mistakes" }));
    await waitFor(() =>
      expect(screen.getByText(/caught 1 of 2 starts \(50%\), 934 false activations an hour with no gesture under way; 1 repeat and 1 late \(over the 30 an hour budget\)/)).toBeTruthy(),
    );
    expect(invoke).toHaveBeenCalledWith("model_mistakes", { versionId: "v1", includeTraining: false });
    expect(screen.getByText(/camera-timed; caught 1 of 2, 4 false, 1 repeat, 1 late/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Repeats and late" }));
    const listed = screen.getAllByRole("listitem");
    expect(listed).toHaveLength(2);
    expect(listed[0]).toHaveTextContent("3.5 sRepeat:");
    expect(listed[1]).toHaveTextContent("11.5 sLate:");
    fireEvent.click(screen.getByRole("button", { name: "False" }));
    expect(screen.queryByText(/Missed: reached only/)).toBeNull();
    expect(screen.queryByText(/Repeat:/)).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]);
    expect(opened).toHaveBeenCalledWith("labelling");
    expect(appNavigation.takeLabellingFocus()).toEqual({ datasetId: "rec1", atMs: 5000, select: { startMs: 4120, endMs: 5120 } });
    stop();
  });
});
