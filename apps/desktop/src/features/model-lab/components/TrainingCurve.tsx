import { LineChart } from "../../../components/charts/LineChart";

/** One report from the trainer while a network learns (see `on_epoch` in the trainer). */
export interface CurvePoint {
  epoch: number;
  epochs: number;
  trainLoss: number;
  evalLoss?: number;
  evalAuc?: number;
  evalAccuracy?: number;
}

const LINE_PREFIX = "@curve ";

/** A trainer line carrying a progress report, or null for any other line. */
export function parseCurveLine(line: string): CurvePoint | null {
  if (!line.startsWith(LINE_PREFIX)) return null;
  try {
    const value = JSON.parse(line.slice(LINE_PREFIX.length)) as Partial<CurvePoint>;
    if (typeof value.epoch !== "number" || typeof value.trainLoss !== "number") return null;
    return value as CurvePoint;
  } catch {
    return null;
  }
}

const TRAIN = "#ff6f91";
const HELD_OUT = "#2a9d8f";

/** How training is going: the loss on the training windows and on the held-out ones, and the held-out ROC AUC. */
export function TrainingCurve({ points }: { points: CurvePoint[] }) {
  if (points.length === 0) return null;
  const last = points[points.length - 1];
  const withEval = points.filter((p) => p.evalLoss !== undefined);
  const withAuc = points.filter((p) => p.evalAuc !== undefined);
  const withAccuracy = points.filter((p) => p.evalAccuracy !== undefined);
  const lossSummary = `Round ${last.epoch} of ${last.epochs}: training loss ${last.trainLoss.toFixed(4)}${last.evalLoss !== undefined ? `, held-out loss ${last.evalLoss.toFixed(4)}` : ""}.`;
  return (
    <section aria-label="Training progress" className="flex flex-col gap-2">
      <p className="field-hint" role="status">{lossSummary} The held-out numbers are only shown for you to watch: nothing is chosen with them while training.</p>
      <div className="grid gap-4 md:grid-cols-2">
        <LineChart
          title="Loss"
          xLabel="Round"
          yLabel="Loss (lower is better)"
          summary={lossSummary}
          series={[
            { name: "Training windows", color: TRAIN, points: points.map((p) => ({ x: p.epoch, y: p.trainLoss })) },
            { name: "Held-out windows", color: HELD_OUT, dashed: true, points: withEval.map((p) => ({ x: p.epoch, y: p.evalLoss as number })) },
          ]}
        />
        {withAuc.length > 0 && (
          <LineChart
            title="Held-out ROC AUC"
            xLabel="Round"
            yLabel="AUC (0.5 is chance)"
            yRange={[0, 1]}
            summary={`The held-out AUC is ${(withAuc[withAuc.length - 1].evalAuc as number).toFixed(2)} at round ${withAuc[withAuc.length - 1].epoch}.`}
            series={[{ name: "Held-out windows", color: HELD_OUT, points: withAuc.map((p) => ({ x: p.epoch, y: p.evalAuc as number })) }]}
          />
        )}
        {withAuc.length === 0 && withAccuracy.length > 0 && (
          <LineChart
            title="Accuracy on windows the network held back"
            xLabel="Round"
            yLabel="Accuracy"
            yRange={[0, 1]}
            summary={`${((withAccuracy[withAccuracy.length - 1].evalAccuracy as number) * 100).toFixed(0)}% at round ${withAccuracy[withAccuracy.length - 1].epoch}.`}
            series={[{ name: "Held back by the network", color: HELD_OUT, points: withAccuracy.map((p) => ({ x: p.epoch, y: p.evalAccuracy as number })) }]}
          />
        )}
      </div>
    </section>
  );
}
