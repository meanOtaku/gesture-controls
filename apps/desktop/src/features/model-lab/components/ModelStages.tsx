import type { ModelStage } from "../training";

/** A model's pipeline, stage by stage. */
export function ModelStages({ stages }: { stages: readonly ModelStage[] }) {
  return (
    <ol className="flex flex-wrap items-stretch gap-2" aria-label="Pipeline stages">
      {stages.map((stage, index) => (
        <li key={stage.title} className="flex items-center gap-2">
          <div className="rounded-md border px-3 py-2 text-sm" style={{ maxWidth: 190 }}>
            <strong className="block">{stage.title}</strong>
            <small className="text-muted-foreground">{stage.detail}</small>
          </div>
          {index < stages.length - 1 && <span aria-hidden="true">→</span>}
        </li>
      ))}
    </ol>
  );
}
