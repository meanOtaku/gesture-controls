import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CsvCaptureCard } from "./CsvCaptureCard";
import { TooltipProvider } from "../../../components/ui/tooltip";
import { MAX_CSV_ROWS } from "../store/telemetryStore";

afterEach(() => cleanup());

describe("CsvCaptureCard", () => {
  it("disables Save CSV when the buffer is empty", () => {
    render(<TooltipProvider><CsvCaptureCard recording={false} rowCount={0} savedCount={0} onToggleRecording={vi.fn()} onSaveCsv={vi.fn()} /></TooltipProvider>);
    expect(screen.getByRole("button", { name: "Save CSV" })).toBeDisabled();
  });

  it("enables Save CSV once rows are buffered and reflects the recording state", () => {
    const onToggleRecording = vi.fn();
    render(<TooltipProvider><CsvCaptureCard recording={true} rowCount={12} savedCount={0} onToggleRecording={onToggleRecording} onSaveCsv={vi.fn()} /></TooltipProvider>);
    expect(screen.getByRole("button", { name: "Save CSV" })).toBeEnabled();
    expect(screen.getByText("Capturing incoming samples")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(onToggleRecording).toHaveBeenCalled();
  });

  it("reports buffer-full status once the row cap is reached", () => {
    render(<TooltipProvider><CsvCaptureCard recording={false} rowCount={MAX_CSV_ROWS} savedCount={0} onToggleRecording={vi.fn()} onSaveCsv={vi.fn()} /></TooltipProvider>);
    expect(screen.getByText(/buffer full, oldest rows dropping/)).toBeInTheDocument();
  });

  it("shows pending feedback while saving and re-enables afterward", async () => {
    let resolveSave: () => void = () => {};
    const onSaveCsv = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    render(<TooltipProvider><CsvCaptureCard recording={false} rowCount={3} savedCount={0} onToggleRecording={vi.fn()} onSaveCsv={onSaveCsv} /></TooltipProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Save CSV" }));
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    resolveSave();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save CSV" })).toBeEnabled());
  });
});
