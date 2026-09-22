import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatasetCaptureCard } from "./DatasetCaptureCard";
import { TooltipProvider } from "../../../components/ui/tooltip";
import { computeLiveQualitySummary } from "../quality/computeLiveQualitySummary";
import type { DatasetRow } from "../store/telemetryStore";

vi.mock("../quality/computeLiveQualitySummary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../quality/computeLiveQualitySummary")>();
  return { ...actual, computeLiveQualitySummary: vi.fn(actual.computeLiveQualitySummary) };
});

afterEach(() => {
  cleanup();
  vi.mocked(computeLiveQualitySummary).mockClear();
});

function makeRow(index: number): DatasetRow {
  return {
    timestampNs: String(index * 20_000_000),
    sequence: String(index),
    ppgGreen: index,
    ppgRed: index,
    ppgIr: index,
    accelX: index,
    accelY: index,
    accelZ: index,
    gyroX: index,
    gyroY: index,
    gyroZ: index,
    quatW: index,
    quatX: index,
    quatY: index,
    quatZ: index,
    contactQuality: index,
    label: "",
  };
}

/** 20 evenly spaced (50 Hz) rows with every channel populated: no M1 warnings. */
const cleanRows: DatasetRow[] = Array.from({ length: 20 }, (_, index) => makeRow(index));
/** A single row is flagged "insufficient_data" by M1 (fewer than two rows), guaranteeing a warning. */
const warningRows: DatasetRow[] = [makeRow(0)];

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
    onMarkStart: vi.fn(),
    onMarkEnd: vi.fn(),
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

  it("requires confirmation before discarding a session, closes the dialog on cancel, and does not discard", async () => {
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
    await waitFor(() => expect(screen.queryByText("Discard dataset session?")).not.toBeInTheDocument());
  });

  it("discards the session and closes the dialog once confirmed", async () => {
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
    await waitFor(() => expect(screen.queryByText("Discard dataset session?")).not.toBeInTheDocument());
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

  describe("export data-quality review gate", () => {
    it("exports directly with no review dialog when there is no buffered summary data", async () => {
      const onExport = vi.fn().mockResolvedValue(undefined);
      renderCard({ datasetRowCount: 5, onExport, datasetRows: [] });
      fireEvent.click(screen.getByRole("button", { name: "Export Dataset CSV" }));
      await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
      expect(screen.queryByText("Review data quality before export")).not.toBeInTheDocument();
    });

    it("clean data shows the review gate with no warnings and exports on Export", async () => {
      const onExport = vi.fn().mockResolvedValue(undefined);
      renderCard({ datasetRowCount: cleanRows.length, onExport, datasetRows: cleanRows });
      fireEvent.click(screen.getByRole("button", { name: "Export Dataset CSV" }));

      expect(await screen.findByText("Review data quality before export")).toBeInTheDocument();
      expect(screen.getByText(/data-quality review/i)).toBeInTheDocument();
      expect(screen.getByText(/not model validation/i)).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      expect(onExport).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByText("Review data quality before export")).not.toBeInTheDocument());
    });

    it("warning data requires explicit 'Export anyway' confirmation and surfaces the M1 warning", async () => {
      const onExport = vi.fn().mockResolvedValue(undefined);
      renderCard({ datasetRowCount: warningRows.length, onExport, datasetRows: warningRows });
      fireEvent.click(screen.getByRole("button", { name: "Export Dataset CSV" }));

      expect(await screen.findByText("Review data quality before export")).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(/fewer than two rows/i);
      expect(screen.queryByRole("button", { name: "Export" })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Export anyway" }));
      expect(onExport).toHaveBeenCalledTimes(1);
    });

    it("Cancel closes the review dialog, exports nothing, and preserves buffered data", async () => {
      const onExport = vi.fn().mockResolvedValue(undefined);
      const onDiscard = vi.fn();
      renderCard({ datasetRowCount: warningRows.length, onExport, onDiscard, datasetRows: warningRows });
      fireEvent.click(screen.getByRole("button", { name: "Export Dataset CSV" }));
      expect(await screen.findByText("Review data quality before export")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByText("Review data quality before export")).not.toBeInTheDocument());
      expect(onExport).not.toHaveBeenCalled();
      expect(onDiscard).not.toHaveBeenCalled();
    });

    it("shows a bounded, non-blocking explanation and still allows export when the summary is unavailable", async () => {
      const onExport = vi.fn().mockResolvedValue(undefined);
      vi.mocked(computeLiveQualitySummary).mockImplementationOnce(() => {
        throw new Error("boom");
      });
      renderCard({ datasetRowCount: warningRows.length, onExport, datasetRows: warningRows });
      fireEvent.click(screen.getByRole("button", { name: "Export Dataset CSV" }));

      expect(await screen.findByText("Review data quality before export")).toBeInTheDocument();
      expect(screen.getByText(/quality review is unavailable/i)).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      expect(onExport).toHaveBeenCalledTimes(1);
    });
  });

  describe("marker (hold-to-mark)", () => {
    it("is disabled before recording, even with a valid label selected", () => {
      renderCard({ datasetRecordingState: "idle", selectedLabel: "idle" });
      expect(screen.getByRole("button", { name: 'Hold to mark "idle"' })).toBeDisabled();
    });

    it("is disabled while recording without a valid label", () => {
      renderCard({ datasetRecording: true, datasetRecordingState: "recording", selectedLabel: null });
      expect(screen.getByRole("button", { name: "Mark label" })).toBeDisabled();
    });

    it("starts marking on pointer down and ends it on pointer up, never on a plain click", () => {
      const onMarkStart = vi.fn();
      const onMarkEnd = vi.fn();
      renderCard({
        datasetRecording: true,
        datasetRecordingState: "recording",
        selectedLabel: "idle",
        onMarkStart,
        onMarkEnd,
      });

      const markerButton = screen.getByRole("button", { name: 'Hold to mark "idle"' });
      expect(markerButton).toBeEnabled();

      fireEvent.click(markerButton);
      expect(onMarkStart).not.toHaveBeenCalled();
      expect(onMarkEnd).not.toHaveBeenCalled();

      fireEvent.pointerDown(markerButton, { pointerId: 1, button: 0 });
      expect(onMarkStart).toHaveBeenCalledTimes(1);
      expect(onMarkEnd).not.toHaveBeenCalled();

      fireEvent.pointerUp(markerButton, { pointerId: 1 });
      expect(onMarkEnd).toHaveBeenCalledTimes(1);
      expect(onMarkStart).toHaveBeenCalledTimes(1);
    });

    it("ends the hold on pointer cancellation and on losing focus, without a second start", () => {
      const onMarkStart = vi.fn();
      const onMarkEnd = vi.fn();
      renderCard({
        datasetRecording: true,
        datasetRecordingState: "recording",
        selectedLabel: "idle",
        onMarkStart,
        onMarkEnd,
      });
      const markerButton = screen.getByRole("button", { name: 'Hold to mark "idle"' });

      fireEvent.pointerDown(markerButton, { pointerId: 1, button: 0 });
      fireEvent.pointerCancel(markerButton, { pointerId: 1 });
      expect(onMarkStart).toHaveBeenCalledTimes(1);
      expect(onMarkEnd).toHaveBeenCalledTimes(1);

      fireEvent.pointerDown(markerButton, { pointerId: 2, button: 0 });
      fireEvent.blur(markerButton);
      expect(onMarkStart).toHaveBeenCalledTimes(2);
      expect(onMarkEnd).toHaveBeenCalledTimes(2);
    });

    it("supports keyboard hold via Space/Enter, with no repeat re-triggering", () => {
      const onMarkStart = vi.fn();
      const onMarkEnd = vi.fn();
      renderCard({
        datasetRecording: true,
        datasetRecordingState: "recording",
        selectedLabel: "idle",
        onMarkStart,
        onMarkEnd,
      });
      const markerButton = screen.getByRole("button", { name: 'Hold to mark "idle"' });

      fireEvent.keyDown(markerButton, { key: " " });
      fireEvent.keyDown(markerButton, { key: " ", repeat: true });
      expect(onMarkStart).toHaveBeenCalledTimes(1);

      fireEvent.keyUp(markerButton, { key: " " });
      expect(onMarkEnd).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(markerButton, { key: "Enter" });
      fireEvent.keyUp(markerButton, { key: "Enter" });
      expect(onMarkStart).toHaveBeenCalledTimes(2);
      expect(onMarkEnd).toHaveBeenCalledTimes(2);
    });

    it("shows the marking label while held", () => {
      renderCard({
        datasetRecording: true,
        datasetRecordingState: "recording",
        selectedLabel: "idle",
        activeMarkerLabel: "idle",
      });
      const markingButton = screen.getByRole("button", { name: 'Marking "idle"…' });
      expect(markingButton).toHaveAttribute("aria-pressed", "true");
    });

    it("ends an in-progress hold when the label changes", () => {
      const onMarkStart = vi.fn();
      const onMarkEnd = vi.fn();
      const { rerender } = render(
        <TooltipProvider>
          <DatasetCaptureCard
            {...({
              selectedLabel: "idle",
              sessionLabels: [],
              onRemoveLabel: vi.fn(() => true),
              getLabelRemovalBlockedReason: vi.fn(() => null),
              desktopAvailable: false,
              datasetExportFolder: null,
              onChooseExportFolder: vi.fn().mockResolvedValue(undefined),
              datasetRecording: true,
              datasetRecordingState: "recording",
              datasetSession: { label: "", startedAtIso: new Date().toISOString() },
              datasetRowCount: 3,
              onSelectLabel: vi.fn(() => true),
              activeMarkerLabel: null,
              onMarkStart,
              onMarkEnd,
              onStart: vi.fn(),
              onStop: vi.fn(),
              onDiscard: vi.fn(),
              onExport: vi.fn().mockResolvedValue(undefined),
            } satisfies React.ComponentProps<typeof DatasetCaptureCard>)}
          />
        </TooltipProvider>,
      );

      const markerButton = screen.getByRole("button", { name: 'Hold to mark "idle"' });
      fireEvent.pointerDown(markerButton, { pointerId: 1, button: 0 });
      expect(onMarkStart).toHaveBeenCalledTimes(1);

      rerender(
        <TooltipProvider>
          <DatasetCaptureCard
            {...({
              selectedLabel: "walking",
              sessionLabels: [],
              onRemoveLabel: vi.fn(() => true),
              getLabelRemovalBlockedReason: vi.fn(() => null),
              desktopAvailable: false,
              datasetExportFolder: null,
              onChooseExportFolder: vi.fn().mockResolvedValue(undefined),
              datasetRecording: true,
              datasetRecordingState: "recording",
              datasetSession: { label: "", startedAtIso: new Date().toISOString() },
              datasetRowCount: 3,
              onSelectLabel: vi.fn(() => true),
              activeMarkerLabel: null,
              onMarkStart,
              onMarkEnd,
              onStart: vi.fn(),
              onStop: vi.fn(),
              onDiscard: vi.fn(),
              onExport: vi.fn().mockResolvedValue(undefined),
            } satisfies React.ComponentProps<typeof DatasetCaptureCard>)}
          />
        </TooltipProvider>,
      );

      expect(onMarkEnd).toHaveBeenCalledTimes(1);
      expect(onMarkStart).toHaveBeenCalledTimes(1);
    });

    it("ends an in-progress hold on unmount", () => {
      const onMarkStart = vi.fn();
      const onMarkEnd = vi.fn();
      renderCard({
        datasetRecording: true,
        datasetRecordingState: "recording",
        selectedLabel: "idle",
        onMarkStart,
        onMarkEnd,
      });
      const markerButton = screen.getByRole("button", { name: 'Hold to mark "idle"' });
      fireEvent.pointerDown(markerButton, { pointerId: 1, button: 0 });
      expect(onMarkStart).toHaveBeenCalledTimes(1);

      cleanup();
      expect(onMarkEnd).toHaveBeenCalledTimes(1);
    });
  });
});
