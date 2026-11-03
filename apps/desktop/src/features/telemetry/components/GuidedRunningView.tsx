import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { guidedRunner, type GuidedSnapshot } from "../recording/guidedRunner";
import { prompt, totalMs } from "../recording/guidedSession";

const minutes = (ms: number) => `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

/** The prompts of a guided session under way: what to do now, the progress, and Stop and save. */
export function GuidedRunningView({ session, nameOf, onStop, title, description = "Follow the prompts. The recording stops and is saved by itself at the end." }: {
  session: GuidedSnapshot;
  nameOf: (label: string) => string;
  onStop: () => void;
  title: string;
  description?: string;
}) {
  const elapsed = session.elapsedMs;
  const shown = elapsed === null
    ? { title: "Waiting for the watch…", detail: "The session starts with the first sample.", tone: "rest" as const }
    : prompt(session.steps, elapsed, nameOf, session.plan.cueText);
  const total = totalMs(session.steps);
  return (
    <Card role="region" aria-label={title} className="min-w-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className={`guided-prompt guided-${shown.tone}`} role="status" aria-live="assertive">
          <strong>{shown.title}</strong>
          <span>{shown.detail}</span>
        </div>
        <div className="guided-progress" aria-label="Session progress">
          <div style={{ width: `${Math.min(100, ((elapsed ?? 0) / total) * 100)}%` }} />
        </div>
        <p className="hint">
          {elapsed === null ? minutes(total) : `${minutes(Math.max(0, total - elapsed))} left`}
          {session.buzzFailed ? ". The watch could not be buzzed: follow the screen." : ""}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => { guidedRunner.stop(); onStop(); }}>Stop and save</Button>
        </div>
      </CardContent>
    </Card>
  );
}
