import { AnimatedNumber, AnimatedWord } from "../../../components/app/AnimatedNumber";
import { describe, secondsLeft, useModelReadiness, type Readiness } from "../readiness";

/**
 * Whether a pinch made now would be caught: ready, hold still (with how long), or no signal (and when it is back). Shown
 * only while a model runs.
 */
export function ReadinessLight() {
  const { readiness, now } = useModelReadiness();
  if (!readiness) return null;
  return <ReadinessLightView readiness={readiness} now={now} />;
}

export function ReadinessLightView({ readiness, now }: { readiness: Readiness; now: number }) {
  const { title, tone, countdown } = describe(readiness.state);
  const left = countdown !== null && readiness.readyAt !== null ? secondsLeft(readiness.readyAt, now) : null;
  return (
    <div className="readiness-light" data-tone={tone} data-state={readiness.state} role="status" aria-label={`Gesture models: ${title}`}>
      <span className="readiness-dot" aria-hidden="true" />
      <span className="readiness-text">
        <AnimatedWord>{title}</AnimatedWord>
        {left && (
          <span className="readiness-countdown" aria-hidden="true">
            {" · "}{countdown}<AnimatedNumber value={left.value} digits={left.digits} />{" s"}
          </span>
        )}
      </span>
    </div>
  );
}
