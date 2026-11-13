import { useState } from "react";
import { AnimatedText } from "../../../components/app/AnimatedNumber";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";

/** A cut-off as a percentage, with a decimal only when it needs one: 95%, 99.5%. */
export const cutOffPercent = (value: number): string => {
  const pct = Math.round(value * 1000) / 10;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)}%`;
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * The cut-offs the slider stops at: every hundredth from 0.05 to 0.90, then every half-hundredth to 0.995, since a
 * model's scores bunch up near 1 and a small step there changes a lot. `include` adds values that must be reachable (the
 * model's own cut-off, the one it runs at).
 */
export function cutOffSteps(include: number[] = []): number[] {
  const steps: number[] = [];
  for (let i = 5; i <= 90; i += 1) steps.push(i / 100);
  for (let i = 905; i <= 995; i += 5) steps.push(i / 1000);
  return [...new Set([...steps, ...include.filter((v) => v > 0 && v <= 1)].map(round3))].sort((a, b) => a - b);
}

/** The step nearest `value`. */
const nearest = (steps: number[], value: number) =>
  steps.reduce((best, step, i) => (Math.abs(step - value) < Math.abs(steps[best] - value) ? i : best), 0);

/**
 * A cut-off to look at, and to use. The slider covers the whole range up to 99.5%, in finer steps near the top; − and +
 * move one step, and a box takes an exact percentage. It can jump back to the cut-off the model was trained with, or to
 * the one it runs at now if that was changed. With `onApply`, the cut-off being looked at can be made the model's own,
 * after a confirmation that says what these numbers are and are not.
 */
export function CutOffControl({ value, onChange, trained, running, onApply, applying = false, note }: {
  value: number;
  onChange: (value: number) => void;
  /** The cut-off the model was trained with. */
  trained: number;
  /** The cut-off it runs at now, when known (it may have been changed since training). */
  running?: number | null;
  /** Makes `value` the model's cut-off. Absent when it cannot be changed here. */
  onApply?: (value: number) => void;
  applying?: boolean;
  /** Said before using a cut-off: what the numbers it was chosen on mean. */
  note?: string;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const steps = cutOffSteps([trained, ...(running != null ? [running] : []), value]);
  const index = nearest(steps, value);
  const go = (next: number) => { setConfirming(false); onChange(round3(next)); };
  const now = running ?? trained;
  const typedValue = typed === null || typed.trim() === "" ? null : Number(typed) / 100;
  const typedOk = typedValue !== null && Number.isFinite(typedValue) && typedValue > 0 && typedValue <= 1;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>Cut-off</span>
        <Button type="button" variant="outline" size="sm" aria-label="Lower the cut-off one step" disabled={index === 0} onClick={() => go(steps[index - 1])}>−</Button>
        <input
          type="range"
          aria-label="Cut-off"
          aria-valuetext={cutOffPercent(steps[index])}
          className="min-w-40 flex-1"
          min={0}
          max={steps.length - 1}
          step={1}
          value={index}
          onChange={(event) => go(steps[Number(event.target.value)])}
        />
        <Button type="button" variant="outline" size="sm" aria-label="Raise the cut-off one step" disabled={index === steps.length - 1} onClick={() => go(steps[index + 1])}>+</Button>
        <Input
          aria-label="Cut-off in percent"
          className="w-24"
          type="number"
          min={0.1}
          max={100}
          step={0.1}
          value={typed ?? String(Math.round(value * 1000) / 10)}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={() => { if (typedOk) go(typedValue!); setTyped(null); }}
          onKeyDown={(event) => { if (event.key === "Enter" && typedOk) { go(typedValue!); setTyped(null); } }}
        />
        <span>%</span>
      </div>
      {typed !== null && typed.trim() !== "" && !typedOk && <p className="field-hint text-destructive">Enter a percentage above 0 and at most 100.</p>}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button type="button" variant="outline" size="sm" disabled={round3(value) === round3(trained)} onClick={() => go(trained)}>
          Trained at <AnimatedText>{cutOffPercent(trained)}</AnimatedText>
        </Button>
        {running != null && round3(running) !== round3(trained) && (
          <Button type="button" variant="outline" size="sm" disabled={round3(value) === round3(running)} onClick={() => go(running)}>
            Runs at <AnimatedText>{cutOffPercent(running)}</AnimatedText>
          </Button>
        )}
        {onApply && round3(value) !== round3(now) && !confirming && (
          <Button type="button" size="sm" disabled={applying} onClick={() => setConfirming(true)}>
            Use <AnimatedText>{cutOffPercent(value)}</AnimatedText> for this model
          </Button>
        )}
      </div>
      {onApply && confirming && round3(value) !== round3(now) && (
        <div className="flex flex-col gap-2 rounded-md border p-2 text-sm" role="group" aria-label="Use this cut-off">
          <p>
            The model will run at <AnimatedText>{cutOffPercent(value)}</AnimatedText> instead of <AnimatedText>{cutOffPercent(now)}</AnimatedText>, from now on.{note ? ` ${note}` : ""}
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={applying} onClick={() => { setConfirming(false); onApply(round3(value)); }}>
              Use <AnimatedText>{cutOffPercent(value)}</AnimatedText>
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(false)}>Keep <AnimatedText>{cutOffPercent(now)}</AnimatedText></Button>
          </div>
        </div>
      )}
    </div>
  );
}
