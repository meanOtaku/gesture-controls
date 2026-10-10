import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetLabel } from "../types";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { TrainingHistory, deleteBlocker, type TrainingHistoryProject } from "./TrainingHistory";

const project = (label: string, over: Partial<TrainingHistoryProject> = {}): TrainingHistoryProject => ({
  id: `p-${label}`, label, name: label, createdAt: "2026-10-01T00:00:00Z",
  runs: [{ id: "r1", status: "finished", outcome: "deployable", queuedAt: "2026-10-02T10:00:00Z", finishedAt: "2026-10-02T10:05:00Z", failure: null }],
  snapshots: 1, models: 0, mentions: [], mentionedBy: [], ...over,
});
const labels: DatasetLabel[] = [{ id: "pinch", displayName: "Pinch", description: "", color: "#65e6ff", role: "positiveGesture", archivedAt: null }];

let list: TrainingHistoryProject[] = [];
beforeEach(() => {
  list = [project("pinch", { mentions: ["fist"] }), project("fist", { mentionedBy: ["pinch"] }), project("snap", { models: 2 })];
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args?: { label?: string }) => {
    if (command === "list_training_history") return list;
    if (command === "delete_label_history") { list = list.filter((p) => p.label !== args!.label); return 3; }
    throw new Error(command);
  });
});
afterEach(() => cleanup());

describe("deleteBlocker", () => {
  it("names what stops a history being deleted, or says nothing", () => {
    expect(deleteBlocker({ label: "a", models: 0, mentionedBy: [] })).toBeNull();
    expect(deleteBlocker({ label: "a", models: 1, mentionedBy: [] })).toMatch(/still has 1 model/);
    expect(deleteBlocker({ label: "a", models: 0, mentionedBy: ["b", "c"] })).toMatch(/history of b, c mentions this label/);
  });
});

describe("TrainingHistory", () => {
  it("lists each label's runs, snapshots, models and cross-references", async () => {
    render(<TrainingHistory desktopAvailable labels={labels} refreshKey="a" />);
    const rows = await screen.findAllByRole("listitem", { name: "" }).catch(() => []);
    expect(rows).toBeDefined();
    const pinch = (await screen.findByText("pinch", { selector: "code" })).closest("li") as HTMLElement;
    expect(pinch.textContent).toContain("1 run · 1 sealed snapshot · latest 2026-10-02: ready to use");
    expect(pinch.textContent).toContain("Trained against: fist");
    const fist = screen.getByText("fist", { selector: "code" }).closest("li") as HTMLElement;
    expect(fist.textContent).toContain("Mentioned in the history of: Pinch");
  });

  it("disables delete with the reason when models exist or another history mentions the label", async () => {
    render(<TrainingHistory desktopAvailable labels={labels} refreshKey="a" />);
    expect(await screen.findByRole("button", { name: "Delete training history of snap" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete training history of fist" })).toBeDisabled();
    expect(screen.getByText(/still has 2 models/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete training history of pinch" })).toBeEnabled();
  });

  it("deletes a history after a confirmation and then shows the list again", async () => {
    render(<TrainingHistory desktopAvailable labels={labels} refreshKey="a" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete training history of pinch" }));
    expect(invoke).not.toHaveBeenCalledWith("delete_label_history", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Delete history of pinch" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("delete_label_history", { label: "pinch" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete training history of pinch" })).toBeNull());
    // With pinch's history gone, fist is no longer mentioned, so its history can go too.
    list = list.map((p) => (p.label === "fist" ? { ...p, mentionedBy: [] } : p));
    cleanup();
    render(<TrainingHistory desktopAvailable labels={labels} refreshKey="b" />);
    expect(await screen.findByRole("button", { name: "Delete training history of fist" })).toBeEnabled();
  });

  it("says when there is nothing yet and shows the desktop's refusal", async () => {
    list = [];
    render(<TrainingHistory desktopAvailable labels={labels} refreshKey="a" />);
    expect(await screen.findByText(/Nothing yet/)).toBeInTheDocument();
    cleanup();
    list = [project("pinch")];
    invoke.mockImplementation(async (command: string) => { if (command === "list_training_history") return list; throw new Error("refused: busy"); });
    render(<TrainingHistory desktopAvailable labels={labels} refreshKey="a" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete training history of pinch" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete history of pinch" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("refused: busy");
    expect(within(screen.getByRole("region", { name: "Training history" })).getByRole("button", { name: "Delete history of pinch" })).toBeInTheDocument();
  });
});
