import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import { appNavigation } from "../../../shared/navigation/appNavigation";
import { lastRecording } from "../recording/lastRecording";
import { JustRecordedCard } from "./JustRecordedCard";

afterEach(() => {
  cleanup();
  invoke.mockReset();
  lastRecording.set(null);
  appNavigation.takeLabellingFocus();
});

describe("reviewing a recording just made", () => {
  it("adds it to Model Lab and opens it on the Labelling page", async () => {
    invoke.mockResolvedValue({ id: "d9" });
    render(<JustRecordedCard recording={false} />);
    expect(screen.queryByRole("region", { name: "Just recorded" })).toBeNull();
    act(() => lastRecording.set({ recordingId: "r1", rowCount: 1200, intervalCount: 20, savedAt: 0 }));
    expect(screen.getByText(/1,200 rows, 20 labelled stretches/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review it in Labelling" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Just recorded" })).toBeNull());
    expect(invoke).toHaveBeenCalledWith("add_recording_to_training_data", { recordingId: "r1", filter: "notExcluded", restLabel: null });
    expect(appNavigation.takeLabellingFocus()).toEqual({ datasetId: "d9", atMs: 0 });
  });

  it("opens the copy Model Lab already has when it was added before", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "add_recording_to_training_data") throw new Error("already added");
      return [{ id: "d3", sourceRecordingId: "r1" }];
    });
    lastRecording.set({ recordingId: "r1", rowCount: 10, intervalCount: 1, savedAt: 0 });
    render(<JustRecordedCard recording={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review it in Labelling" }));
    await waitFor(() => expect(appNavigation.takeLabellingFocus()).toEqual({ datasetId: "d3", atMs: 0 }));
  });
});
