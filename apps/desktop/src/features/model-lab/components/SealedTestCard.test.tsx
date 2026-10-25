import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { SealedTestCard } from "./SealedTestCard";
import { recordingDay, type DatasetSummary } from "../types";
import type { LabelModel } from "../labelModels";

const dataset = (id: string, name: string, sealed: boolean): DatasetSummary => ({ id, originalFilename: name, importedAt: "2026-10-24T10:00:00Z", label: "pinch", rowCount: 10, sealed });
const model = { id: "pinch-v3", label: "pinch", state: "approved" } as unknown as LabelModel;

beforeEach(() => {
  invoke.mockImplementation(async (command: string) => {
    if (command === "list_sealed_tests") return [{ testedAt: "2026-10-23T10:00:00Z", version: "pinch-v2", label: "pinch", recordings: ["s1"], starts: 20, caught: 5, falseActivations: 3, minutes: 2 }];
    if (command === "test_model_on_sealed")
      return { version: "pinch-v3", label: "pinch", threshold: 0.9, testedAt: "2026-10-24T10:00:00Z", recordings: [{ id: "s1", name: "day five", starts: 20, caught: 9, falseActivations: 4, minutes: 2, medianLatencyMs: 905 }], starts: 20, caught: 9, falseActivations: 4, minutes: 2, earlierTests: 1 };
    return null;
  });
});
afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("SealedTestCard", () => {
  it("says when nothing is sealed", () => {
    render(<SealedTestCard desktopAvailable models={[model]} datasets={[dataset("a", "x", false)]} />);
    expect(screen.getByText(/No recording is sealed/)).toBeInTheDocument();
  });

  it("tests a model on the sealed recordings, says how often they were tested, and logs it", async () => {
    render(<SealedTestCard desktopAvailable models={[model]} datasets={[dataset("s1", "day five", true), dataset("t1", "training", false)]} />);
    expect(await screen.findByText(/1 sealed recording\. Tested 1 time before\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox", { name: "Model to test" }));
    fireEvent.click(await screen.findByRole("option", { name: /pinch-v3/ }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Run the final test" })));
    expect(invoke).toHaveBeenCalledWith("test_model_on_sealed", { versionId: "pinch-v3" });
    const result = screen.getByRole("region", { name: "Final test result" });
    expect(result).toHaveTextContent("caught 9 of 20 starts (45%), with 4 false activations, 2.0 a minute");
    expect(result).toHaveTextContent("tested 1 time before this");
    expect(result).toHaveTextContent("905 ms");
  });
});

describe("recordingDay", () => {
  it("reads the day from a Recorder export's name, else the day it was imported", () => {
    expect(recordingDay({ originalFilename: "gesture-dataset-pinch-2026-10-17T12-23-03.399Z.csv", importedAt: "2026-10-20T00:00:00Z" })).toBe("2026-10-17");
    expect(recordingDay({ originalFilename: "session.csv", importedAt: "2026-10-20T08:00:00Z" })).toBe("2026-10-20");
  });
});
