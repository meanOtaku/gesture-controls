import { useMemo, useState } from "react";
import { BarChart } from "../../../components/charts/BarChart";
import { LineChart, type ChartSeries } from "../../../components/charts/LineChart";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { Button } from "../../../components/ui/button";
import { exportFile } from "../../../shared/tauri/exportCsv";
import { area, calibration, confusionAt, counts, curvesCsv, histogram, perRecording, prCurve, recordingsCsv, rocAuc, rocCurve, scoresCsv, thresholdSweep } from "../evaluation";
import { percent, type Inspection } from "../inspection";

const MODEL = "#ff6f91";
const OTHER = "#2a9d8f";
const COMPARE = "#6c5ce7";
const GREY = "#999999";
const fixed = (value: number, digits = 3) => value.toFixed(digits);

/**
 * How well the model does on the moments of the recordings it was tested on (each start of the gesture, and other moments): ROC and precision-recall curves, what each
 * cut-off would do, where its scores fall, whether they can be taken as probabilities, and how each recording went. With a
 * second model of the same label, the curves are drawn together. Everything can be saved for charting elsewhere.
 */
export function InspectEvaluation({ inspection, other, otherName }: { inspection: Inspection; other?: Inspection | null; otherName?: string }) {
  const { probabilities, labels, recordings, threshold: modelThreshold } = inspection.evaluation;
  const [threshold, setThreshold] = useState(modelThreshold);
  const scored = useMemo(() => ({ probabilities, labels, recordings }), [probabilities, labels, recordings]);
  const roc = useMemo(() => rocCurve(probabilities, labels), [probabilities, labels]);
  const pr = useMemo(() => prCurve(probabilities, labels), [probabilities, labels]);
  const sweep = useMemo(() => thresholdSweep(probabilities, labels), [probabilities, labels]);
  const bins = useMemo(() => histogram(probabilities, labels, 20), [probabilities, labels]);
  const reliability = useMemo(() => calibration(probabilities, labels, 10), [probabilities, labels]);
  const recordingRows = useMemo(() => perRecording(scored, threshold), [scored, threshold]);
  const at = confusionAt(probabilities, labels, threshold);
  const { positives, negatives } = counts(labels);
  const auc = rocAuc(probabilities, labels);

  const otherEval = other?.evaluation;
  const otherRoc = useMemo(() => (otherEval ? rocCurve(otherEval.probabilities, otherEval.labels) : null), [otherEval]);
  const otherPr = useMemo(() => (otherEval ? prCurve(otherEval.probabilities, otherEval.labels) : null), [otherEval]);
  const otherAt = otherEval ? confusionAt(otherEval.probabilities, otherEval.labels, otherEval.threshold) : null;

  const rocSeries: ChartSeries[] = [
    { name: "Chance", color: GREY, dashed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    { name: `This model (AUC ${fixed(auc, 2)})`, color: MODEL, points: roc },
    ...(otherRoc && otherEval ? [{ name: `${otherName ?? "Other"} (AUC ${fixed(area(otherRoc), 2)})`, color: COMPARE, points: otherRoc }] : []),
  ];
  const prSeries: ChartSeries[] = [
    { name: `This model (average precision ${fixed(pr.averagePrecision, 2)})`, color: MODEL, points: pr.points },
    ...(otherPr ? [{ name: `${otherName ?? "Other"} (average precision ${fixed(otherPr.averagePrecision, 2)})`, color: COMPARE, points: otherPr.points }] : []),
  ];

  const save = async (content: string, name: string, kind: "csv" | "json", title: string) => {
    const result = await exportFile({ content, suggestedName: name, title, kind });
    if (result.status === "saved") OperationFeedback.success(title, `Saved ${result.path.split(/[/\\]/).pop()}`);
    else if (result.status === "error") OperationFeedback.error(title, result.message);
  };
  const stem = `${inspection.target}-held-out`;
  const report = () => JSON.stringify({
    model: { target: inspection.target, backend: inspection.backend, inputs: inspection.inputCount, trees: inspection.trees },
    heldOut: { windows: probabilities.length, gestureWindows: positives, otherWindows: negatives, recordings: [...new Set(recordings)] },
    trainerMetrics: inspection.evaluation.metrics,
    atCutOff: { cutOff: threshold, ...at },
    rocAuc: auc, averagePrecision: pr.averagePrecision,
    perRecording: recordingRows,
    importance: inspection.importance,
  }, null, 2);

  return (
    <section aria-label="How well it works" className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">How well it works</h3>
      <p className="field-hint">
        On {probabilities.length} moments from {new Set(recordings).size} recording{new Set(recordings).size === 1 ? "" : "s"} the model never trained on: {positives} starts of the gesture and {negatives} other moments (other gestures&apos; starts, the middle of holds, and time with no gesture). {inspection.evaluation.metrics.thresholdChosenOnEvaluationRecordings === false
          ? "The model's own cut-off for “detected” was chosen on its training recordings, not on these windows, so the numbers at it are fair: move the cut-off to see what any other would do."
          : "The model's own cut-off for “detected” was chosen on these same windows, so the numbers at it are a little optimistic: move the cut-off to see what any other would do."}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          Cut-off
          <input type="range" min={0.05} max={0.95} step={0.01} value={threshold} aria-label="Cut-off" onChange={(event) => setThreshold(Number(event.target.value))} />
          <strong>{percent(threshold)}</strong>
        </label>
        <Button type="button" variant="outline" size="sm" disabled={threshold === modelThreshold} onClick={() => setThreshold(modelThreshold)}>Back to the model&apos;s own ({percent(modelThreshold)})</Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <table className="text-sm" aria-label="Confusion at the cut-off">
          <caption className="caption-top text-left text-xs text-muted-foreground">What it called, at a cut-off of {percent(threshold)}</caption>
          <thead><tr><th /><th className="px-2 text-left">Called the gesture</th><th className="px-2 text-left">Called something else</th></tr></thead>
          <tbody>
            <tr><th scope="row" className="pr-2 text-left">Really the gesture</th><td className="px-2" style={{ background: "rgba(42,157,143,0.25)" }}>{at.tp} hits</td><td className="px-2" style={{ background: "rgba(215,48,39,0.18)" }}>{at.fn} misses</td></tr>
            <tr><th scope="row" className="pr-2 text-left">Really something else</th><td className="px-2" style={{ background: "rgba(215,48,39,0.18)" }}>{at.fp} false alarms</td><td className="px-2" style={{ background: "rgba(42,157,143,0.25)" }}>{at.tn} correct rejections</td></tr>
          </tbody>
        </table>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm" aria-label="Rates at the cut-off">
          <li>Found <strong>{percent(at.recall)}</strong> of the gesture (recall)</li>
          <li><strong>{percent(at.precision)}</strong> of what it flagged was right (precision)</li>
          <li>Wrongly flagged <strong>{percent(at.falseAlarmRate)}</strong> of the rest</li>
          <li>F1 <strong>{fixed(at.f1, 2)}</strong> · accuracy <strong>{percent(at.accuracy)}</strong></li>
          <li>ROC AUC <strong>{fixed(auc, 3)}</strong></li>
          <li>Average precision <strong>{fixed(pr.averagePrecision, 3)}</strong></li>
        </ul>
      </div>

      {otherEval && otherAt && (
        <table className="text-sm" aria-label="Comparison with another model">
          <caption className="caption-top text-left text-xs text-muted-foreground">Each model at its own cut-off, on its own held-out windows (they may not be the same windows)</caption>
          <thead><tr className="text-left"><th /><th className="px-2">ROC AUC</th><th className="px-2">Average precision</th><th className="px-2">Recall</th><th className="px-2">Precision</th><th className="px-2">False alarms</th></tr></thead>
          <tbody>
            {[
              { name: "This model", auc, ap: pr.averagePrecision, c: confusionAt(probabilities, labels, modelThreshold) },
              { name: otherName ?? "The other model", auc: area(otherRoc ?? []), ap: otherPr?.averagePrecision ?? 0, c: otherAt },
            ].map((row) => (
              <tr key={row.name}><th scope="row" className="pr-2 text-left">{row.name}</th><td className="px-2">{fixed(row.auc, 3)}</td><td className="px-2">{fixed(row.ap, 3)}</td><td className="px-2">{percent(row.c.recall)}</td><td className="px-2">{percent(row.c.precision)}</td><td className="px-2">{percent(row.c.falseAlarmRate)}</td></tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <LineChart
          title="ROC curve" exportName={`${stem}-roc`} xLabel="False alarm rate" yLabel="Recall" xRange={[0, 1]} yRange={[0, 1]}
          series={rocSeries}
          markers={[{ x: at.falseAlarmRate, y: at.recall, label: `Cut-off ${percent(threshold)}`, color: MODEL }]}
          summary={`Area under the curve ${fixed(auc, 3)}. At a cut-off of ${percent(threshold)} it finds ${percent(at.recall)} of the gesture and wrongly flags ${percent(at.falseAlarmRate)} of the rest.`}
        />
        <LineChart
          title="Precision and recall" exportName={`${stem}-precision-recall`} xLabel="Recall" yLabel="Precision" xRange={[0, 1]} yRange={[0, 1]}
          series={prSeries}
          markers={[{ x: at.recall, y: at.precision, label: `Cut-off ${percent(threshold)}`, color: MODEL }]}
          summary={`Average precision ${fixed(pr.averagePrecision, 3)}. At a cut-off of ${percent(threshold)}, recall ${percent(at.recall)} and precision ${percent(at.precision)}.`}
        />
        <LineChart
          title="What each cut-off would do" exportName={`${stem}-cut-off-sweep`} xLabel="Cut-off" yLabel="Rate" xRange={[0, 1]} yRange={[0, 1]}
          series={[
            { name: "Recall", color: MODEL, points: sweep.map((r) => ({ x: r.threshold, y: r.recall })) },
            { name: "Precision", color: OTHER, points: sweep.map((r) => ({ x: r.threshold, y: r.precision })) },
            { name: "F1", color: "#e9a800", points: sweep.map((r) => ({ x: r.threshold, y: r.f1 })) },
            { name: "False alarm rate", color: GREY, dashed: true, points: sweep.map((r) => ({ x: r.threshold, y: r.falseAlarmRate })) },
          ]}
          verticalLine={{ x: threshold, label: percent(threshold) }}
          summary={`At ${percent(threshold)}: recall ${percent(at.recall)}, precision ${percent(at.precision)}, F1 ${fixed(at.f1, 2)}, false alarm rate ${percent(at.falseAlarmRate)}.`}
        />
        <BarChart
          title="Where the scores fall" exportName={`${stem}-score-histogram`} xLabel="Score" yLabel="Windows"
          bins={bins.gesture.map((_, i) => `${i * 5}`)}
          series={[{ name: "Gesture", color: MODEL, values: bins.gesture }, { name: "Something else", color: OTHER, values: bins.other }]}
          summary={`A good model puts the gesture's windows on the right and the others on the left. ${bins.gesture.reduce((a, b) => a + b, 0)} windows of the gesture, ${bins.other.reduce((a, b) => a + b, 0)} of something else.`}
        />
        <LineChart
          title="Can the scores be taken as probabilities?" exportName={`${stem}-calibration`} xLabel="Average score in the slice" yLabel="Share that really were the gesture" xRange={[0, 1]} yRange={[0, 1]}
          series={[
            { name: "Perfect", color: GREY, dashed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
            { name: "This model", color: MODEL, points: reliability.map((r) => ({ x: r.meanScore, y: r.shareGesture })) },
          ]}
          summary={`${reliability.length} slices of scores, from ${reliability[0] ? percent(reliability[0].meanScore) : "none"} to ${reliability.length ? percent(reliability[reliability.length - 1].meanScore) : "none"}. On the dashed line, a score of 80% would mean 80% of those windows were the gesture. With so few windows this is rough.`}
        />
      </div>

      <div className="max-w-full overflow-auto">
        <table className="w-full text-sm" aria-label="Each held-out recording">
          <caption className="caption-top text-left text-xs text-muted-foreground">Recording by recording, at a cut-off of {percent(threshold)}: a model that does well overall can do badly on one of them</caption>
          <thead><tr className="text-left"><th className="pr-3">Recording</th><th className="pr-3">Windows (gesture / other)</th><th className="pr-3">Average score</th><th className="pr-3">ROC AUC</th><th className="pr-3">Recall</th><th className="pr-3">False alarms</th></tr></thead>
          <tbody>
            {recordingRows.map((row) => (
              <tr key={row.recording} className="border-t border-input/40">
                <th scope="row" className="pr-3 text-left font-medium">{row.recording.slice(0, 8)}</th>
                <td className="pr-3">{row.windows} ({row.gestureWindows} / {row.otherWindows})</td>
                <td className="pr-3">{percent(row.meanScore)}</td>
                <td className="pr-3">{row.auc === undefined ? "–" : fixed(row.auc, 2)}</td>
                <td className="pr-3">{row.recall === undefined ? "–" : percent(row.recall)}</td>
                <td className="pr-3">{row.falseAlarmRate === undefined ? "–" : percent(row.falseAlarmRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Save the results">
        <Button type="button" variant="outline" size="sm" onClick={() => void save(scoresCsv(scored), `${stem}-scores.csv`, "csv", "Save scores")}>Save every window&apos;s score (CSV)</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void save(curvesCsv(scored), `${stem}-curves.csv`, "csv", "Save curves")}>Save the curves (CSV)</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void save(recordingsCsv(scored, threshold), `${stem}-recordings.csv`, "csv", "Save recordings table")}>Save the recordings table (CSV)</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void save(report(), `${stem}-report.json`, "json", "Save report")}>Save a report (JSON)</Button>
      </div>
    </section>
  );
}
