import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { MAX_LABEL_OFFSET_MS, type OffsetScore, type TrainRequest } from "../training";

/** The offset whose recordings-left-out score is highest, with a note on how much the timing matters at all. */
export function bestOffset(scores: OffsetScore[]): { best: OffsetScore; spread: number } | null {
  const scored = scores.filter((s): s is OffsetScore & { auc: number } => s.auc !== null);
  if (scored.length === 0) return null;
  const best = scored.reduce((a, b) => (b.auc > a.auc ? b : a));
  return { best, spread: best.auc - Math.min(...scored.map((s) => s.auc)) };
}

const signed = (ms: number) => (ms > 0 ? `+${ms}` : `${ms}`);

/** Below this spread between the best and worst offset the timing barely matters for the recordings. */
export const TIMING_MATTERS_SPREAD = 0.03;

/**
 * The timing of the labels against the sensors. Camera marking labels a hold when the camera has seen it, which can be a
 * fraction of a second before or after the sensors show it. This sets how far to move every label before windows are made,
 * and can try a range of offsets on the chosen recordings and say which fits best.
 */
export function LabelTiming({ request, offset, onOffset, disabled }: { request: TrainRequest | null; offset: number; onOffset: (ms: number) => void; disabled: boolean }) {
  const uid = useId();
  const [text, setText] = useState(String(offset));
  const [scores, setScores] = useState<OffsetScore[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setText(String(offset)), [offset]);

  const commit = (value: string) => {
    const number = Math.round(Number(value));
    if (value.trim() === "" || !Number.isFinite(number)) return setText(String(offset));
    const clamped = Math.max(-MAX_LABEL_OFFSET_MS, Math.min(MAX_LABEL_OFFSET_MS, number));
    onOffset(clamped);
    setText(String(clamped));
  };

  const check = async () => {
    if (request === null) return;
    setChecking(true);
    setError(null);
    try {
      // Whatever offset is set now is not part of the question: every offset is tried.
      const found = await invoke<OffsetScore[]>("suggest_label_offset", { request: { ...request, labelOffsetMs: undefined } });
      setScores(Array.isArray(found) ? found : []);
    } catch (err) {
      setError(String(err));
      setScores(null);
    } finally {
      setChecking(false);
    }
  };

  const verdict = scores ? bestOffset(scores) : null;
  const top = verdict ? Math.max(...scores!.filter((s) => s.auc !== null).map((s) => s.auc as number)) : 1;
  return (
    <div className="field">
      <div className="field-head"><Label htmlFor={`${uid}-offset`}>Label timing (ms)</Label></div>
      <div className="flex flex-wrap items-center gap-2">
        <Input id={`${uid}-offset`} type="number" className="w-28" step={50} min={-MAX_LABEL_OFFSET_MS} max={MAX_LABEL_OFFSET_MS} value={text} disabled={disabled}
          onChange={(event) => setText(event.target.value)} onBlur={(event) => commit(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") commit((event.target as HTMLInputElement).value); }} />
        <Button type="button" variant="outline" disabled={disabled || checking || request === null} onClick={() => void check()}>{checking ? "Checking the timing…" : "Check which timing fits"}</Button>
      </div>
      <p className="field-hint">
        0 uses the labels as recorded. A positive number moves every label later in time by that much (for when the camera marked a hold before the sensors showed it); a negative number moves them earlier. The samples are not changed.
      </p>
      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      {scores && (
        <div className="flex flex-col gap-2" role="group" aria-label="Timing check">
          <table className="w-full text-sm" aria-label="Score at each label offset">
            <thead><tr className="text-left"><th>Offset</th><th>Score (AUC)</th><th /></tr></thead>
            <tbody>
              {scores.map((s) => (
                <tr key={s.offsetMs} className={verdict?.best.offsetMs === s.offsetMs ? "font-semibold" : ""}>
                  <th scope="row" className="text-left font-normal">{signed(s.offsetMs)} ms</th>
                  <td>{s.auc === null ? "–" : s.auc.toFixed(3)}</td>
                  <td>{s.auc !== null && <span aria-hidden="true" className="inline-block h-2 rounded-sm" style={{ width: `${Math.max(2, ((s.auc - 0.5) / Math.max(0.01, top - 0.5)) * 90)}px`, background: verdict?.best.offsetMs === s.offsetMs ? "#ff6f91" : "#999" }} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {verdict === null ? (
            <p className="field-hint">The timing could not be scored: the recordings do not give a model enough of each kind to learn from and be judged on.</p>
          ) : (
            <>
              <p className="field-hint" role="status">
                {verdict.spread < TIMING_MATTERS_SPREAD
                  ? `The timing barely matters for these recordings: the best offset (${signed(verdict.best.offsetMs)} ms) scores only ${verdict.spread.toFixed(3)} above the worst. `
                  : `Best fit: ${signed(verdict.best.offsetMs)} ms, ${verdict.spread.toFixed(3)} above the worst offset. `}
                Each recording was scored by a model trained without it (logistic regression on the design&apos;s inputs), over {verdict.best.windows.toLocaleString()} windows. The offset is chosen using all of them, so its score is a little optimistic, and with few recordings the differences are small and noisy.
              </p>
              {verdict.best.offsetMs !== offset && verdict.spread >= TIMING_MATTERS_SPREAD && (
                <div><Button type="button" variant="outline" disabled={disabled} onClick={() => onOffset(verdict.best.offsetMs)}>Use {signed(verdict.best.offsetMs)} ms</Button></div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
