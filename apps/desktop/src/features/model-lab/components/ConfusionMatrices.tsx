import type { Confusion } from "../training";

const perHour = (value: number | null | undefined) => (value === null || value === undefined ? "" : ` (about ${Math.round(value)} an hour)`);

/**
 * A multi-gesture model's two confusion matrices, on the held-out recordings: each gesture's starts played through as the
 * runtime runs them (which gesture's model caught each, or none), with the false alarms when no gesture was under way,
 * and every held-out moment by what it is and what the network said at the cut-offs. The diagonal is right; anything
 * else off it is one gesture taken for another (or for nothing). `current`, in Inspect, is the gesture whose model is
 * open: its column is marked.
 */
export function ConfusionMatrices({ confusion, current }: { confusion: Confusion; current?: string }) {
  const { events, moments } = confusion;
  const mark = (gesture: string) => (gesture === current ? "confusion-current" : undefined);
  const cell = (right: boolean, count: number) => (count === 0 ? undefined : right ? "confusion-hit" : "confusion-miss");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 overflow-x-auto">
        <table className="coverage-grid confusion-grid" aria-label="Gestures caught as each gesture, played through live">
          <caption className="text-left text-sm">Played through as it runs live, each gesture at its own cut-off</caption>
          <thead>
            <tr>
              <th scope="col">Gesture made</th>
              <th scope="col">Times</th>
              {events.gestures.map((g) => <th key={g} scope="col" className={mark(g)}>Caught as {g}</th>)}
              <th scope="col">Missed</th>
            </tr>
          </thead>
          <tbody>
            {events.rows.map((row) => (
              <tr key={row.gesture}>
                <th scope="row">{row.gesture}</th>
                <td>{row.starts}</td>
                {events.gestures.map((g) => <td key={g} className={cell(g === row.gesture, row.caughtBy[g] ?? 0)}>{row.caughtBy[g] ?? 0}</td>)}
                <td className={cell(false, row.missed)}>{row.missed}</td>
              </tr>
            ))}
            <tr>
              <th scope="row">No gesture</th>
              <td>{Object.values(events.noGesture.hours)[0] !== undefined ? `${(Object.values(events.noGesture.hours)[0] * 60).toFixed(0)} min` : "–"}</td>
              {events.gestures.map((g) => (
                <td key={g} className={cell(false, events.noGesture.falseActivations[g] ?? 0)}>
                  {events.noGesture.falseActivations[g] ?? 0}{perHour(events.noGesture.falseActivationsPerHour[g])}
                </td>
              ))}
              <td>–</td>
            </tr>
          </tbody>
        </table>
        <p className="field-hint">Each row is what was made; each column, the model that went off. A gesture caught by two models counts in both. In the last row, a model going off with no gesture under way is a false alarm.</p>
      </div>
      <div className="flex flex-col gap-1 overflow-x-auto">
        <table className="coverage-grid confusion-grid" aria-label="Each held-out moment by what it is and what the model said">
          <caption className="text-left text-sm">Each moment of the test recordings</caption>
          <thead>
            <tr>
              <th scope="col">It was</th>
              {moments.labels.map((said) => <th key={said} scope="col" className={mark(said)}>Said {said}</th>)}
            </tr>
          </thead>
          <tbody>
            {moments.labels.map((was, row) => (
              <tr key={was}>
                <th scope="row">{was === "nothing" ? "nothing (no start)" : `a start of ${was}`}</th>
                {moments.counts[row].map((count, column) => <td key={column} className={cell(row === column, count)}>{count.toLocaleString("en-US")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="field-hint">What the network said: the gesture whose score passed its cut-off (the highest, if more than one did), else nothing.</p>
      </div>
    </div>
  );
}
