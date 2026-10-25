import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../../../shared/tauri/recordingBundle", () => ({ listRecordingBundles: async () => ({ status: "ok", value: [{}, {}] }), onRecordingsChanged: () => () => undefined }));
import { appNavigation } from "../../../shared/navigation/appNavigation";
import { ModelWorkflowCard } from "./ModelWorkflowCard";

afterEach(() => {
  cleanup();
  appNavigation.takeLabellingFocus();
});

describe("the making-a-model card", () => {
  it("marks the next step and takes you to the next recording to label", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    invoke.mockImplementation(async (command: string) =>
      command === "list_model_datasets" ? ["a", "b", "c", "d"].map((id) => ({ id, originalFilename: id, importedAt: "", label: "pinch", rowCount: 1, contentSha: id })) : [],
    );
    render(<ModelWorkflowCard />);
    expect(await screen.findByText("Label (next)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Label the next →" }));
    expect(appNavigation.takeLabellingFocus()).toEqual({ datasetId: "a", atMs: 0 });
  });
});
