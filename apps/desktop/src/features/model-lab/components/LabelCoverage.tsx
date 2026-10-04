import { useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { bestState, type LabelModel } from "../labelModels";
import type { DatasetLabel } from "../types";

type LabelCoverageProps = {
  labels: DatasetLabel[];
  models: LabelModel[];
  /** Recorded sessions per label id. */
  coverageByLabel: Map<string, number>;
};

/** For each label: how many recordings cover it and how far along its model is. */
export function LabelCoverage({ labels, models, coverageByLabel }: LabelCoverageProps) {
  const [showAll, setShowAll] = useState(false);
  const ids = [...new Set([...labels.map((label) => label.id), ...coverageByLabel.keys(), ...models.map((model) => model.label)])].sort();
  const used = (id: string) => (coverageByLabel.get(id) ?? 0) > 0 || models.some((model) => model.label === id);
  const shown = showAll ? ids : ids.filter(used);
  const hidden = ids.length - ids.filter(used).length;

  return (
    <Card id="lab-coverage" role="region" aria-label="Label coverage" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Labels"
          description="Recordings per label, and how far along each label's model is."
          help={{
            label: "About label coverage",
            content: "A model is trained on whole recordings and tested on recordings it never saw, so a label needs at least two separate sessions before a model can be checked fairly. Record more sessions for gestures that are easy to confuse with everyday movement.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {shown.length === 0 ? (
          <p className="hint">No labels in use yet. Record a labelled session from the Live data tab, or import a model.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Labels">
            {shown.map((id) => {
              const sessions = coverageByLabel.get(id) ?? 0;
              const labelModels = models.filter((model) => model.label === id);
              const state = bestState(labelModels);
              const name = labels.find((label) => label.id === id)?.displayName ?? id.replaceAll("_", " ");
              return (
                <li key={id} className="recipe-item">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm">{name}{name !== id && <> <code>{id}</code></>}</span>
                    <small className="text-xs text-muted-foreground">
                      {sessions} recording{sessions === 1 ? "" : "s"}
                      {sessions === 1 ? ": record at least one more so a model can be tested on a session it did not see" : ""}
                    </small>
                  </div>
                  <Badge variant={state === "active" ? "default" : "secondary"}>
                    {state === null ? "No model" : `Model: ${state}`}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
        {hidden > 0 && (
          <Button type="button" variant="ghost" className="self-start" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Hide unused labels" : `Show ${hidden} unused label${hidden === 1 ? "" : "s"}`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
