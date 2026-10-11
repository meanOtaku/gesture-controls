import { LineChart } from "../../../components/charts/LineChart";
import type { Inspection } from "../inspection";
import { percent } from "../inspection";

/** Whether more recordings would help, and how the score holds up when each recording is left out in turn. */
export function InspectResearch({ inspection }: { inspection: Inspection }) {
  const research = inspection.research;
  if (!research) return null;
  const { learningCurve, leaveOneOut } = research;
  const last = learningCurve[learningCurve.length - 1];
  const first = learningCurve[0];
  const rising = last && first && learningCurve.length > 1 ? last.aucMean - learningCurve[learningCurve.length - 2].aucMean : 0;
  return (
    <section aria-label="Research checks" className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">Research checks</h3>
      <p className="field-hint">The same model, retrained several times to see how far its score can be trusted. Nothing here changes the model that was kept.</p>

      {learningCurve.length > 0 ? (
        <>
          <LineChart
            title="Does more data help?"
            exportName={`${inspection.target}-learning-curve`}
            xLabel="Training windows"
            yLabel="Held-out ROC AUC"
            yRange={[0, 1]}
            series={[
              { name: "Average of the draws", color: "#ff6f91", points: learningCurve.map((row) => ({ x: row.windows, y: row.aucMean })) },
              { name: "Average plus a spread", color: "#999999", dashed: true, points: learningCurve.map((row) => ({ x: row.windows, y: Math.min(1, row.aucMean + row.aucStd) })) },
              { name: "Average minus a spread", color: "#999999", dashed: true, points: learningCurve.map((row) => ({ x: row.windows, y: Math.max(0, row.aucMean - row.aucStd) })) },
            ]}
            summary={`From ${first.windows} windows to ${last.windows}, the held-out AUC went from ${first.aucMean.toFixed(2)} to ${last.aucMean.toFixed(2)}.`}
          />
          <p className="field-hint" role="status">
            With {first.windows} windows it scored {first.aucMean.toFixed(2)}; with all {last.windows}, {last.aucMean.toFixed(2)}.{" "}
            {rising > 0.02 ? "It was still climbing at the end, so more recordings would probably help." : last.aucMean - first.aucMean > 0.02 ? "It levelled off before the end, so more of the same recordings would add little; different ones (other positions, other people) might." : "More data made no difference here, so the limit is in what the model reads, not in how much of it there is."}
          </p>
        </>
      ) : <p className="hint">There was too little data to retrain on a share of it.</p>}

      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-semibold">Leave one recording out</h4>
        <p className="field-hint" role="status">
          {leaveOneOut.pooledAuc === null
            ? "There were not enough recordings of both kinds to pool the folds into one score."
            : `Every recording scored by a model trained on all the others: pooled ROC AUC ${leaveOneOut.pooledAuc.toFixed(2)} over ${leaveOneOut.pooledWindows} windows. This is the fairest single number when there are few recordings, because each recording was unseen exactly once.`}
        </p>
        <div className="max-w-full overflow-auto">
          <table className="w-full text-sm" aria-label="Leave one recording out">
            <thead><tr className="text-left"><th className="pr-3">Left out</th><th className="pr-3">Windows (gesture / other)</th><th className="pr-3">Average score</th><th className="pr-3">ROC AUC</th></tr></thead>
            <tbody>
              {leaveOneOut.folds.map((fold) => (
                <tr key={fold.recording} className="border-t border-input/40">
                  <th scope="row" className="pr-3 text-left font-medium">{fold.recording.slice(0, 8)}</th>
                  <td className="pr-3">{fold.windows} ({fold.gestureWindows} / {fold.otherWindows})</td>
                  {fold.skipped ? <td className="pr-3 text-muted-foreground" colSpan={2}>Skipped: {fold.skipped}</td> : (
                    <>
                      <td className="pr-3">{fold.meanScore === undefined ? "–" : percent(fold.meanScore)}</td>
                      <td className="pr-3">{fold.auc === null || fold.auc === undefined ? "– (one kind of window only)" : fold.auc.toFixed(2)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
