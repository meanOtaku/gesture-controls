/** Results by design (see `design_results.rs`): the models trained here, grouped by the network design they came from. */

export interface DesignResult {
  modelId: string;
  label: string;
  createdAt: string;
  designId: string | null;
  designName: string | null;
  method: string | null;
  edited: boolean;
  metrics: { rocAuc?: number; f1?: number; precision?: number; recall?: number; falseActivationRate?: number } | null;
}

export interface DesignGroup {
  key: string;
  name: string;
  /** Why there is no name, when there is none. */
  note: string | null;
  models: DesignResult[];
  /** Models with a score, trained from scratch (an edited model is another model's descendant, not a fresh sample). */
  scored: number;
  meanAuc: number | null;
  bestAuc: number | null;
  meanF1: number | null;
  meanFalseActivation: number | null;
}

const mean = (values: number[]) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
const numbers = (models: DesignResult[], key: "rocAuc" | "f1" | "falseActivationRate") =>
  models.flatMap((m) => (typeof m.metrics?.[key] === "number" ? [m.metrics[key] as number] : []));

/** Groups results by design, best mean AUC first; groups with no scores last. Edited models are listed but not averaged. */
export function groupByDesign(results: DesignResult[]): DesignGroup[] {
  const groups = new Map<string, DesignResult[]>();
  for (const result of results) {
    const key = result.designId ?? "none";
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  const rows: DesignGroup[] = [...groups.entries()].map(([key, models]) => {
    const fresh = models.filter((m) => !m.edited);
    const named = models.find((m) => m.designName)?.designName ?? null;
    const aucs = numbers(fresh, "rocAuc");
    return {
      key,
      name: key === "none" ? "No design" : named ?? "A deleted design",
      note: key === "none" ? "Trained before designs existed, or with settings chosen another way." : named ? null : "The design these models were trained with has since been deleted.",
      models,
      scored: aucs.length,
      meanAuc: mean(aucs),
      bestAuc: aucs.length === 0 ? null : Math.max(...aucs),
      meanF1: mean(numbers(fresh, "f1")),
      meanFalseActivation: mean(numbers(fresh, "falseActivationRate")),
    };
  });
  return rows.sort((a, b) => (b.meanAuc ?? -1) - (a.meanAuc ?? -1) || a.name.localeCompare(b.name));
}
