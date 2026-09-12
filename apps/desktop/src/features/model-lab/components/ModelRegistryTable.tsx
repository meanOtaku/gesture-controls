import { SectionHeader } from "../../../components/app/SectionHeader";
import { Badge } from "../../../components/ui/badge";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { formatPercent, type TrainedModelSummary } from "../types";

type ModelRegistryTableProps = {
  trainedModels: TrainedModelSummary[];
};

/** Trained-model evaluation results: accuracy/macro-F1/false-activation metrics per run, and deployability. */
export function ModelRegistryTable({ trainedModels }: ModelRegistryTableProps) {
  const sortedTrainedModels = [...trainedModels].sort((a, b) =>
    (b.modelCard.created_at ?? "").localeCompare(a.modelCard.created_at ?? ""),
  );

  return (
    <Card id="lab-evaluation" role="region" aria-label="Evaluation" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Evaluation"
          description={
            <>
              Each training run writes <code>model_card.json</code> next to <code>model.joblib</code>, with{" "}
              <code>accuracy</code>, <code>macro_f1</code>, a full <code>classification_report</code> and{" "}
              <code>confusion_matrix</code>, plus false-activation metrics that matter more than raw accuracy here:{" "}
              <code>false_activation_count</code>, <code>false_activation_total_negative_windows</code>, and{" "}
              <code>false_activation_rate</code> (negative test windows the model wrongly called an activation).
            </>
          }
          help={{
            label: "About TFLite vs. scikit-learn",
            content: "Only a TFLite bundle can be bound to intents, approved, or activated on this desktop. A scikit-learn model is a baseline for offline evaluation only.",
          }}
        />
      </CardHeader>
      <CardContent>
        {sortedTrainedModels.length === 0 ? (
          <p className="hint">No trained models yet. Start a training run above to produce one.</p>
        ) : (
          <div className="vectors model-lab-models">
            {sortedTrainedModels.map((model) => (
              <div className="vector-row model-lab-label-row" key={model.id}>
                <span className="label">
                  {model.id}
                  {model.modelCard.created_at ? ` — ${model.modelCard.created_at}` : ""}
                </span>
                <span className="model-lab-coverage-count">
                  accuracy {formatPercent(model.modelCard.metrics?.accuracy)}, macro F1{" "}
                  {formatPercent(model.modelCard.metrics?.macro_f1)}, false-activation rate{" "}
                  {formatPercent(model.modelCard.metrics?.false_activation_rate)}
                </span>
                <Badge variant={model.backend === "tflite" ? "default" : "secondary"}>
                  {model.backend === "tflite" ? "TFLite — deployable" : "scikit-learn — not deployable"}
                </Badge>
                {model.backend === "sklearn" && (
                  <p className="hint">
                    This is a baseline evaluation model only: it has no LiteRT bundle, so it cannot be bound to
                    intents, approved, or activated. Train with the TFLite backend above to produce a deployable
                    candidate.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
