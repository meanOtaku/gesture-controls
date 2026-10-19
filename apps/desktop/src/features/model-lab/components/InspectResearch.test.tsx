import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import trees from "../fixtures/inspection-trees.json";
import type { Inspection } from "../inspection";
import { InspectResearch } from "./InspectResearch";

afterEach(cleanup);

const withResearch = (value: Inspection["research"]): Inspection => ({ ...(trees as unknown as Inspection), research: value });

describe("InspectResearch", () => {
  it("shows nothing unless the checks were run", () => {
    const { container } = render(<InspectResearch inspection={withResearch(null)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("reads the real research the trainer wrote: the learning curve and every recording left out in turn", () => {
    render(<InspectResearch inspection={trees as unknown as Inspection} />);
    expect(screen.getByRole("img", { name: /^Does more data help\?/ })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Leave one recording out" });
    expect(within(table).getAllByRole("row").length).toBe(7); // header + the six recordings
    expect(screen.getByText(/pooled ROC AUC/)).toBeInTheDocument();
  });

  it("says whether more data would help, from the shape of the curve", () => {
    const curve = (aucs: number[]) => aucs.map((aucMean, i) => ({ fraction: [0.25, 0.5, 0.75, 1][i], windows: 50 * (i + 1), aucMean, aucStd: 0.02, draws: 3 }));
    const folds = { folds: [], pooledAuc: null, pooledWindows: 0 };
    const { rerender } = render(<InspectResearch inspection={withResearch({ learningCurve: curve([0.6, 0.7, 0.8, 0.9]), leaveOneOut: folds })} />);
    expect(screen.getByText(/still climbing at the end, so more recordings would probably help/)).toBeInTheDocument();
    rerender(<InspectResearch inspection={withResearch({ learningCurve: curve([0.6, 0.85, 0.9, 0.9]), leaveOneOut: folds })} />);
    expect(screen.getByText(/levelled off before the end/)).toBeInTheDocument();
    rerender(<InspectResearch inspection={withResearch({ learningCurve: curve([0.6, 0.6, 0.6, 0.6]), leaveOneOut: folds })} />);
    expect(screen.getByText(/More data made no difference here/)).toBeInTheDocument();
    expect(screen.getByText(/not enough recordings of both kinds to pool/)).toBeInTheDocument();
  });

  it("says why a recording was skipped, and when one kind of window leaves no AUC", () => {
    render(<InspectResearch inspection={withResearch({
      learningCurve: [],
      leaveOneOut: { pooledAuc: 0.81, pooledWindows: 40, folds: [
        { recording: "aaaaaaaa-1", windows: 20, gestureWindows: 20, otherWindows: 0, meanScore: 0.7, auc: null },
        { recording: "bbbbbbbb-2", windows: 20, gestureWindows: 0, otherWindows: 20, skipped: "without it there are only 8 windows of the gesture and 30 of something else to train on" },
      ] },
    })} />);
    expect(screen.getByText(/There was too little data to retrain on a share of it/)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Leave one recording out" });
    expect(within(table).getByRole("row", { name: /aaaaaaaa/ })).toHaveTextContent("one kind of window only");
    expect(within(table).getByRole("row", { name: /bbbbbbbb/ })).toHaveTextContent("Skipped: without it there are only 8 windows");
    expect(screen.getByText(/pooled ROC AUC 0\.81 over 40 windows/)).toBeInTheDocument();
  });
});
