import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { niceTicks } from "../../../components/charts/LineChart";
import { TrainingCurve, parseCurveLine, type CurvePoint } from "./TrainingCurve";

afterEach(cleanup);

describe("parseCurveLine", () => {
  it("reads a progress line from the trainer and ignores every other line", () => {
    expect(parseCurveLine('@curve {"epoch": 3, "epochs": 40, "trainLoss": 0.5, "evalLoss": 0.6, "evalAuc": 0.8}')).toEqual({ epoch: 3, epochs: 40, trainLoss: 0.5, evalLoss: 0.6, evalAuc: 0.8 });
    expect(parseCurveLine('{"outcome": "deployable", "message": ""}')).toBeNull();
    expect(parseCurveLine("@curve not json")).toBeNull();
    expect(parseCurveLine('@curve {"epoch": "x"}')).toBeNull();
  });
});

const points = (n: number): CurvePoint[] => Array.from({ length: n }, (_, i) => ({ epoch: i + 1, epochs: n, trainLoss: 1 / (i + 1), evalLoss: 1.2 / (i + 1), evalAuc: 0.5 + i / (2 * n) }));

describe("TrainingCurve", () => {
  it("draws nothing until the trainer has reported", () => {
    const { container } = render(<TrainingCurve points={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the loss on both sets and the held-out AUC, with a summary in words", () => {
    render(<TrainingCurve points={points(20)} />);
    expect(screen.getByRole("status")).toHaveTextContent("Round 20 of 20: training loss 0.0500, held-out loss 0.0600");
    expect(screen.getByRole("img", { name: /^Loss\./ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Held-out ROC AUC\. The held-out AUC is 0\.97 at round 20/ })).toBeInTheDocument();
    expect(screen.getByText("Training windows")).toBeInTheDocument();
    expect(screen.getAllByText("Held-out windows", { selector: "span" })).toHaveLength(2); // in each chart's legend
  });

  it("shows the accuracy a scikit-learn network held back when there is no AUC", () => {
    render(<TrainingCurve points={[{ epoch: 1, epochs: 2, trainLoss: 0.7, evalAccuracy: 0.6 }, { epoch: 2, epochs: 2, trainLoss: 0.5, evalAccuracy: 0.8 }]} />);
    expect(screen.getByRole("img", { name: /Accuracy on windows the network held back\. 80% at round 2/ })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /ROC AUC/ })).not.toBeInTheDocument();
  });
});

describe("niceTicks", () => {
  it("picks round values inside the range", () => {
    expect(niceTicks(0, 1, 5)).toEqual([0, 0.5, 1]);
    expect(niceTicks(0, 0.6, 5)).toEqual([0, 0.2, 0.4, 0.6]);
    expect(niceTicks(1, 200, 5)).toEqual([50, 100, 150, 200]);
    expect(niceTicks(3, 3)).toEqual([3]);
  });
});
