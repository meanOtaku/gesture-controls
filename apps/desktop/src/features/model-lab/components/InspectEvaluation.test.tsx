import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import trees from "../fixtures/inspection-trees.json";
import type { Inspection } from "../inspection";
import { InspectEvaluation } from "./InspectEvaluation";

const exportFile = vi.hoisted(() => vi.fn());
vi.mock("../../../shared/tauri/exportCsv", () => ({ exportFile: (...args: unknown[]) => exportFile(...args) }));

beforeEach(() => exportFile.mockReset());
afterEach(cleanup);

// A model whose scores overlap, so every rate is in between and moving the cut-off changes them.
const middling = (): Inspection => {
  const data = structuredClone(trees) as unknown as Inspection;
  data.evaluation.probabilities = [0.9, 0.8, 0.7, 0.6, 0.55, 0.4, 0.3, 0.2];
  data.evaluation.labels = [1, 1, 0, 1, 0, 1, 0, 0];
  data.evaluation.recordings = ["aaaaaaaa-1", "aaaaaaaa-1", "aaaaaaaa-1", "aaaaaaaa-1", "bbbbbbbb-2", "bbbbbbbb-2", "bbbbbbbb-2", "bbbbbbbb-2"];
  data.evaluation.threshold = 0.5;
  return data;
};

describe("InspectEvaluation", () => {
  it("says what the windows are, and the rates and confusion at the model's own cut-off", () => {
    render(<InspectEvaluation inspection={middling()} />);
    expect(screen.getByText(/On 8 moments from 2 recordings the model never trained on: 4 starts of the gesture and 4 other moments/)).toBeInTheDocument();
    const confusion = screen.getByRole("table", { name: "Confusion at the cut-off" });
    expect(confusion).toHaveTextContent("3 hits");
    expect(confusion).toHaveTextContent("1 misses");
    expect(confusion).toHaveTextContent("2 false alarms");
    expect(confusion).toHaveTextContent("2 correct rejections");
    const rates = screen.getByRole("list", { name: "Rates at the cut-off" });
    expect(rates).toHaveTextContent("Found 75% of the gesture");
    expect(rates).toHaveTextContent("60% of what it flagged was right");
    expect(rates).toHaveTextContent("ROC AUC 0.813");
  });

  it("moves the cut-off and everything follows, and goes back to the model's own", () => {
    render(<InspectEvaluation inspection={middling()} />);
    const slider = screen.getByLabelText("Cut-off");
    fireEvent.change(slider, { target: { value: "0.75" } });
    const confusion = screen.getByRole("table", { name: "Confusion at the cut-off" });
    expect(confusion).toHaveTextContent("2 hits"); // 0.9 and 0.8
    expect(confusion).toHaveTextContent("0 false alarms");
    expect(screen.getByRole("list", { name: "Rates at the cut-off" })).toHaveTextContent("Found 50% of the gesture");
    expect(screen.getByRole("img", { name: /At a cut-off of 75% it finds 50% of the gesture and wrongly flags 0% of the rest/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Back to the model's own \(50%\)/ }));
    expect(slider).toHaveValue("0.5");
    expect(screen.getByRole("button", { name: /Back to the model's own/ })).toBeDisabled();
  });

  it("draws every chart with a summary in words, and the held-out recordings one by one", () => {
    render(<InspectEvaluation inspection={middling()} />);
    for (const name of [/^ROC curve\./, /^Precision and recall\./, /^What each cut-off would do\./, /^Where the scores fall\./, /^Can the scores be taken as probabilities\?/]) {
      expect(screen.getByRole("img", { name })).toBeInTheDocument();
    }
    const table = screen.getByRole("table", { name: "Each held-out recording" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByRole("row", { name: /aaaaaaaa/ })).toHaveTextContent("4 (3 / 1)");
    expect(within(table).getByRole("row", { name: /bbbbbbbb/ })).toHaveTextContent("4 (1 / 3)");
  });

  it("reads the real inspection the trainer wrote", () => {
    const { container } = render(<InspectEvaluation inspection={trees as unknown as Inspection} />);
    expect(container.querySelectorAll("figure").length).toBe(5);
  });

  it("draws a second model's curves over this one and compares them at each one's own cut-off", () => {
    const other = middling();
    other.evaluation.probabilities = [0.95, 0.9, 0.1, 0.85, 0.2, 0.7, 0.15, 0.05];
    render(<InspectEvaluation inspection={middling()} other={other} otherName="snap-v2" />);
    const comparison = screen.getByRole("table", { name: "Comparison with another model" });
    expect(within(comparison).getByRole("row", { name: /snap-v2/ })).toHaveTextContent("1.000"); // it ranks every window right
    expect(within(comparison).getByRole("row", { name: /This model/ })).toHaveTextContent("0.813");
    expect(screen.getByText(/snap-v2 \(AUC 1\.00\)/)).toBeInTheDocument();
  });

  it("saves the scores, the curves, the recordings table and a report through the save dialog", async () => {
    exportFile.mockResolvedValue({ status: "saved", path: "/tmp/x" });
    render(<InspectEvaluation inspection={middling()} />);
    const group = screen.getByRole("group", { name: "Save the results" });
    fireEvent.click(within(group).getByRole("button", { name: /every window's score/ }));
    await waitFor(() => expect(exportFile).toHaveBeenCalledTimes(1));
    expect(exportFile.mock.calls[0][0]).toMatchObject({ kind: "csv", suggestedName: "pinch-held-out-scores.csv" });
    expect(exportFile.mock.calls[0][0].content.split("\n")[0]).toBe("recording,is_gesture,score");
    fireEvent.click(within(group).getByRole("button", { name: /the curves/ }));
    fireEvent.click(within(group).getByRole("button", { name: /recordings table/ }));
    fireEvent.click(within(group).getByRole("button", { name: /report/ }));
    await waitFor(() => expect(exportFile).toHaveBeenCalledTimes(4));
    const report = JSON.parse(exportFile.mock.calls[3][0].content);
    expect(report).toMatchObject({ model: { target: "pinch" }, heldOut: { windows: 8, gestureWindows: 4 }, atCutOff: { cutOff: 0.5, tp: 3 } });
    expect(report.perRecording).toHaveLength(2);
    expect(exportFile.mock.calls[3][0]).toMatchObject({ kind: "json", suggestedName: "pinch-held-out-report.json" });
  });

  it("saves a chart as a standalone SVG file", async () => {
    exportFile.mockResolvedValue({ status: "saved", path: "/tmp/roc.svg" });
    render(<InspectEvaluation inspection={middling()} />);
    fireEvent.click(screen.getByRole("button", { name: "Save pinch-held-out-roc as an image" }));
    await waitFor(() => expect(exportFile).toHaveBeenCalled());
    const call = exportFile.mock.calls[0][0];
    expect(call).toMatchObject({ kind: "svg", suggestedName: "pinch-held-out-roc.svg" });
    expect(call.content).toMatch(/^<\?xml version="1.0"/);
    expect(call.content).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(call.content).toContain('fill="#ffffff"'); // on white, readable outside the app
    expect(call.content).toContain("<polyline");
  });
});
