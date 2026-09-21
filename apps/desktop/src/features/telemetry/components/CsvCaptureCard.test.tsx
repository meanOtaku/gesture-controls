import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CsvCaptureCard } from "./CsvCaptureCard";
import { TooltipProvider } from "../../../components/ui/tooltip";
import { DEFAULT_ORDINARY_LABEL, MAX_CSV_ROWS } from "../store/telemetryStore";

afterEach(() => cleanup());

function renderCard(overrides: Partial<ComponentProps<typeof CsvCaptureCard>> = {}) {
  const props: ComponentProps<typeof CsvCaptureCard> = {
    recording: false,
    rowCount: 0,
    savedCount: 0,
    appliedLabel: DEFAULT_ORDINARY_LABEL,
    onToggleRecording: vi.fn(),
    onSaveCsv: vi.fn(),
    onApplyLabel: vi.fn(() => true),
    onClearLabel: vi.fn(),
    ...overrides,
  };
  render(<TooltipProvider><CsvCaptureCard {...props} /></TooltipProvider>);
  return props;
}

describe("CsvCaptureCard", () => {
  it("disables Save CSV when the buffer is empty", () => {
    renderCard();
    expect(screen.getByRole("button", { name: "Save CSV" })).toBeDisabled();
  });

  it("enables Save CSV once rows are buffered and reflects the recording state", () => {
    const props = renderCard({ recording: true, rowCount: 12 });
    expect(screen.getByRole("button", { name: "Save CSV" })).toBeEnabled();
    expect(screen.getByText("Capturing incoming samples")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(props.onToggleRecording).toHaveBeenCalled();
  });

  it("reports buffer-full status once the row cap is reached", () => {
    renderCard({ rowCount: MAX_CSV_ROWS });
    expect(screen.getByText(/buffer full, oldest rows dropping/)).toBeInTheDocument();
  });

  it("shows pending feedback while saving and re-enables afterward", async () => {
    let resolveSave: () => void = () => {};
    const onSaveCsv = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    renderCard({ rowCount: 3, onSaveCsv });

    fireEvent.click(screen.getByRole("button", { name: "Save CSV" }));
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    resolveSave();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save CSV" })).toBeEnabled());
  });

  it("shows no label applied by default and disables Apply for whitespace-only input", () => {
    renderCard();
    expect(screen.getByText(`No row label applied (rows save as "${DEFAULT_ORDINARY_LABEL}")`)).toBeInTheDocument();
    const applyButton = screen.getByRole("button", { name: "Apply label" });
    expect(applyButton).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Row label" }), { target: { value: "   " } });
    expect(applyButton).toBeDisabled();
  });

  it("applies a trimmed label via the explicit button and clears the draft, without calling onApplyLabel for editing alone", () => {
    const onApplyLabel = vi.fn(() => true);
    renderCard({ onApplyLabel });
    const input = screen.getByRole("textbox", { name: "Row label" });
    fireEvent.change(input, { target: { value: "  gesture_1  " } });
    expect(onApplyLabel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply label" }));
    expect(onApplyLabel).toHaveBeenCalledWith("  gesture_1  ");
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("shows the active applied label and allows clearing it via the explicit button", () => {
    const onClearLabel = vi.fn();
    renderCard({ appliedLabel: "gesture_1", onClearLabel });
    expect(screen.getByText("Active row label: gesture_1")).toBeInTheDocument();
    const clearButton = screen.getByRole("button", { name: "Clear label" });
    expect(clearButton).toBeEnabled();
    fireEvent.click(clearButton);
    expect(onClearLabel).toHaveBeenCalled();
  });

  it("disables Clear label when no label is applied", () => {
    renderCard({ appliedLabel: DEFAULT_ORDINARY_LABEL });
    expect(screen.getByRole("button", { name: "Clear label" })).toBeDisabled();
  });
});
