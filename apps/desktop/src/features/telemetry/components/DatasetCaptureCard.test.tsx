import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatasetCaptureCard } from "./DatasetCaptureCard";
import { TooltipProvider } from "../../../components/ui/tooltip";

afterEach(() => cleanup());

function renderCard(overrides: Partial<React.ComponentProps<typeof DatasetCaptureCard>> = {}) {
  const props: React.ComponentProps<typeof DatasetCaptureCard> = {
    selectedLabel: "idle",
    sessionLabels: [],
    onRemoveLabel: vi.fn(() => true),
    getLabelRemovalBlockedReason: vi.fn(() => null),
    desktopAvailable: false,
    datasetExportFolder: null,
    onChooseExportFolder: vi.fn().mockResolvedValue(undefined),
    datasetRecording: false,
    datasetSession: null,
    datasetRowCount: 0,
    onSelectLabel: vi.fn(() => true),
    activeMarkerLabel: null,
    onToggleMarker: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onDiscard: vi.fn(),
    onExport: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<TooltipProvider><DatasetCaptureCard {...props} /></TooltipProvider>);
  return props;
}

describe("DatasetCaptureCard", () => {
  it("accepts a valid custom label and clears the field", () => {
    const props = renderCard();
    fireEvent.change(screen.getByLabelText("Dataset label"), { target: { value: "wrist_flick" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply label" }));
    expect(props.onSelectLabel).toHaveBeenCalledWith("wrist_flick");
    expect(screen.getByLabelText("Dataset label")).toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a validation error for an invalid custom label and keeps the field", () => {
    renderCard({ onSelectLabel: vi.fn(() => false) });
    fireEvent.change(screen.getByLabelText("Dataset label"), { target: { value: "9bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply label" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/letters, numbers, or underscores/);
    expect(screen.getByLabelText("Dataset label")).toHaveValue("9bad");
  });

  it("disables label editing while a dataset session is recording", () => {
    renderCard({ datasetRecording: true, datasetSession: { label: "", startedAtIso: new Date().toISOString() } });
    expect(screen.getByLabelText("Dataset label")).toBeDisabled();

    expect(screen.getByRole("button", { name: "Stop dataset capture" })).toBeInTheDocument();
  });

  it("requires a duration within range before dataset capture can start", () => {
    const onStart = vi.fn();
    renderCard({ onStart, selectedLabel: null });

    const durationInput = screen.getByLabelText("Recording duration in seconds");
    const startButton = screen.getByRole("button", { name: "Start dataset capture" });

    fireEvent.change(durationInput, { target: { value: "0" } });
    expect(startButton).toBeDisabled();

    fireEvent.change(durationInput, { target: { value: "3601" } });
    expect(startButton).toBeDisabled();

    fireEvent.change(durationInput, { target: { value: "45" } });
    expect(startButton).toBeEnabled();
    fireEvent.click(startButton);
    expect(onStart).toHaveBeenCalledWith(45);
  });

  it("requires confirmation before discarding a session, and does not discard on cancel", () => {
    const onDiscard = vi.fn();
    renderCard({
      onDiscard,
      datasetSession: { label: "", startedAtIso: new Date().toISOString() },
      datasetRowCount: 42,
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByText("Discard dataset session?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep session" }));
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("discards the session once confirmed", async () => {
    const onDiscard = vi.fn();
    renderCard({
      onDiscard,
      datasetSession: { label: "", startedAtIso: new Date().toISOString() },
      datasetRowCount: 42,
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    const discardButtons = await screen.findAllByRole("button", { name: "Discard" });
    fireEvent.click(discardButtons[discardButtons.length - 1]);
    expect(onDiscard).toHaveBeenCalled();
  });

  it("disables Discard when there is no dataset session", () => {
    renderCard({ datasetSession: null });
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });

  it("disables Export Dataset CSV when there are no buffered rows and enables it once rows exist", () => {
    renderCard({ datasetRowCount: 0 });
    expect(screen.getByRole("button", { name: "Export Dataset CSV" })).toBeDisabled();
    cleanup();
    renderCard({ datasetRowCount: 5 });
    expect(screen.getByRole("button", { name: "Export Dataset CSV" })).toBeEnabled();
  });

  it("shows pending feedback while exporting and re-enables afterward", async () => {
    let resolveExport: () => void = () => {};
    const onExport = vi.fn(() => new Promise<void>((resolve) => { resolveExport = resolve; }));
    renderCard({ datasetRowCount: 5, onExport });

    fireEvent.click(screen.getByRole("button", { name: "Export Dataset CSV" }));
    expect(await screen.findByRole("button", { name: "Exporting…" })).toBeDisabled();
    resolveExport();
    await waitFor(() => expect(screen.getByRole("button", { name: "Export Dataset CSV" })).toBeEnabled());
  });

  describe("marker", () => {
    it("is disabled before recording, even with a valid label selected", () => {
      renderCard({ datasetRecordingState: "idle", selectedLabel: "idle" });
      expect(screen.getByRole("button", { name: 'Mark "idle"' })).toBeDisabled();
    });

    it("is disabled while recording without a valid label", () => {
      renderCard({ datasetRecording: true, datasetRecordingState: "recording", selectedLabel: null });
      expect(screen.getByRole("button", { name: "Mark label" })).toBeDisabled();
    });

    it("toggles: press starts marking the selected label, press again ends it", () => {
      const onToggleMarker = vi.fn();
      const { rerender } = render(
        <TooltipProvider>
          <DatasetCaptureCard
            selectedLabel="idle"
            sessionLabels={[]}
            onRemoveLabel={vi.fn(() => true)}
            getLabelRemovalBlockedReason={vi.fn(() => null)}
            desktopAvailable={false}
            datasetExportFolder={null}
            onChooseExportFolder={vi.fn().mockResolvedValue(undefined)}
            datasetRecording
            datasetRecordingState="recording"
            datasetSession={{ label: "", startedAtIso: new Date().toISOString() }}
            datasetRowCount={3}
            onSelectLabel={vi.fn(() => true)}
            activeMarkerLabel={null}
            onToggleMarker={onToggleMarker}
            onStart={vi.fn()}
            onStop={vi.fn()}
            onDiscard={vi.fn()}
            onExport={vi.fn().mockResolvedValue(undefined)}
          />
        </TooltipProvider>,
      );

      const markerButton = screen.getByRole("button", { name: 'Mark "idle"' });
      expect(markerButton).toBeEnabled();
      fireEvent.click(markerButton);
      expect(onToggleMarker).toHaveBeenCalledTimes(1);

      rerender(
        <TooltipProvider>
          <DatasetCaptureCard
            selectedLabel="idle"
            sessionLabels={[]}
            onRemoveLabel={vi.fn(() => true)}
            getLabelRemovalBlockedReason={vi.fn(() => null)}
            desktopAvailable={false}
            datasetExportFolder={null}
            onChooseExportFolder={vi.fn().mockResolvedValue(undefined)}
            datasetRecording
            datasetRecordingState="recording"
            datasetSession={{ label: "", startedAtIso: new Date().toISOString() }}
            datasetRowCount={3}
            onSelectLabel={vi.fn(() => true)}
            activeMarkerLabel="idle"
            onToggleMarker={onToggleMarker}
            onStart={vi.fn()}
            onStop={vi.fn()}
            onDiscard={vi.fn()}
            onExport={vi.fn().mockResolvedValue(undefined)}
          />
        </TooltipProvider>,
      );

      const stopMarkerButton = screen.getByRole("button", { name: 'Stop marking "idle"' });
      expect(stopMarkerButton).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(stopMarkerButton);
      expect(onToggleMarker).toHaveBeenCalledTimes(2);
    });
  });
});
