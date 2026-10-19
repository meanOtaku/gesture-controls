import { describe, expect, it } from "vitest";
import trees from "./fixtures/inspection-trees.json";
import { area, calibration, confusionAt, counts, curvesCsv, histogram, perRecording, prCurve, recordingsCsv, rocAuc, rocCurve, scoresCsv, thresholdSweep, toCsv } from "./evaluation";

const p = [0.9, 0.8, 0.7, 0.6, 0.55, 0.4, 0.3, 0.2];
const y = [1, 1, 0, 1, 0, 1, 0, 0];

describe("curves and rates", () => {
  it("counts the confusion at a cut-off, with a score at the cut-off counting as called", () => {
    expect(confusionAt(p, y, 0.55)).toMatchObject({ tp: 3, fp: 2, fn: 1, tn: 2 });
    const at = confusionAt(p, y, 0.55);
    expect(at.precision).toBeCloseTo(3 / 5);
    expect(at.recall).toBeCloseTo(3 / 4);
    expect(at.falseAlarmRate).toBeCloseTo(2 / 4);
    expect(at.f1).toBeCloseTo((2 * 0.6 * 0.75) / 1.35);
    expect(confusionAt([], [], 0.5)).toMatchObject({ precision: 0, recall: 0, f1: 0, accuracy: 0 });
  });

  it("draws the ROC curve from (0,0) to (1,1) and its area is the textbook AUC", () => {
    const curve = rocCurve(p, y);
    expect(curve[0]).toEqual({ x: 0, y: 0 });
    expect(curve[curve.length - 1]).toEqual({ x: 1, y: 1 });
    // 4 positives x 4 negatives: the positive scores higher in 4 + 4 + 3 + 2 of the 16 pairs.
    expect(rocAuc(p, y)).toBeCloseTo(13 / 16);
    expect(rocAuc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
    expect(rocAuc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
    expect(rocAuc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1])).toBeCloseTo(0.5); // ties are one step, not an order
    expect(area([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeCloseTo(0.5);
  });

  it("gives the precision-recall curve and the average precision", () => {
    const { points, averagePrecision } = prCurve(p, y);
    expect(points[0]).toEqual({ x: 0.25, y: 1 });
    expect(points[points.length - 1].x).toBe(1);
    // recall steps of 0.25 at precisions 1, 1, 3/4 (the third hit is at rank 4), 4/6
    expect(averagePrecision).toBeCloseTo(0.25 * (1 + 1 + 0.75 + 4 / 6));
    expect(prCurve([0.9, 0.1], [1, 0]).averagePrecision).toBe(1);
  });

  it("sweeps the cut-off, bins the scores and checks calibration", () => {
    const sweep = thresholdSweep(p, y);
    expect(sweep[0].threshold).toBe(0.05);
    expect(sweep[sweep.length - 1].threshold).toBe(0.95);
    expect(sweep.find((row) => row.threshold === 0.55)).toMatchObject({ tp: 3, fp: 2 });
    expect(sweep[0].recall).toBe(1);
    expect(sweep[sweep.length - 1].recall).toBe(0);
    const bins = histogram(p, y, 10);
    expect(bins.gesture.reduce((a, b) => a + b, 0)).toBe(4);
    expect(bins.other.reduce((a, b) => a + b, 0)).toBe(4);
    expect(bins.gesture[9]).toBe(1); // 0.9 falls in the last slice
    expect(histogram([1], [1], 4).gesture[3]).toBe(1); // a score of exactly 1 is in the last slice, not off the end
    const rows = calibration(p, y, 5);
    expect(rows.reduce((sum, r) => sum + r.windows, 0)).toBe(8);
    expect(rows.every((r) => r.shareGesture >= 0 && r.shareGesture <= 1)).toBe(true);
    expect(counts(y)).toEqual({ positives: 4, negatives: 4 });
  });

  it("breaks the result down by recording, leaving out what a recording cannot say", () => {
    const rows = perRecording({ probabilities: [0.9, 0.2, 0.8, 0.7, 0.1], labels: [1, 0, 1, 0, 0], recordings: ["a", "a", "b", "b", "c"] }, 0.5);
    expect(rows.map((r) => r.recording)).toEqual(["a", "b", "c"]);
    expect(rows[0]).toMatchObject({ windows: 2, gestureWindows: 1, otherWindows: 1, auc: 1, recall: 1, falseAlarmRate: 0 });
    expect(rows[1]).toMatchObject({ auc: 1, recall: 1, falseAlarmRate: 1 }); // ranks right, but its cut-off is too low for this recording
    expect(rows[2].auc).toBeUndefined(); // only windows of something else
    expect(rows[2].recall).toBeUndefined();
    expect(rows[2].falseAlarmRate).toBe(0);
  });
});

describe("what the trainer saved", () => {
  it("is reproduced by these functions: the AUC the trainer reported is the area under this ROC curve", () => {
    for (const data of [trees]) {
      const { probabilities, labels, metrics } = data.evaluation;
      expect(rocAuc(probabilities, labels)).toBeCloseTo(metrics.rocAuc as number, 3);
      const threshold = data.evaluation.threshold;
      const at = confusionAt(probabilities, labels, threshold);
      expect(at.recall).toBeCloseTo(metrics.recall as number, 3);
      expect(at.precision).toBeCloseTo(metrics.precision as number, 3);
      expect(at.falseAlarmRate).toBeCloseTo(metrics.falseActivationRate as number, 3);
    }
  });
});

describe("exports", () => {
  it("writes the scores, the curves and the recordings as CSV a person can chart themselves", () => {
    const scored = { probabilities: [0.9, 0.2], labels: [1, 0], recordings: ["a,b", "c"] };
    expect(scoresCsv(scored)).toBe('recording,is_gesture,score\n"a,b",1,0.9\nc,0,0.2\n');
    const curves = curvesCsv(scored).split("\n");
    expect(curves[0]).toBe("curve,x,y,threshold");
    expect(curves.some((line) => line.startsWith("roc,"))).toBe(true);
    expect(curves.filter((line) => line.startsWith("sweep_f1,")).length).toBe(91);
    expect(recordingsCsv(scored, 0.5).split("\n")[0]).toBe("recording,windows,gesture_windows,other_windows,mean_score,roc_auc,recall,false_alarm_rate");
    expect(toCsv(["a"], [['say "hi"']])).toBe('a\n"say ""hi"""\n');
  });
});
