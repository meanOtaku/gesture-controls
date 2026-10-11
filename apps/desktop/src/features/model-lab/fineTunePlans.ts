/** Saved fine-tune plans (see `fine_tune_plans.rs`): how a trained model is carried on training, independent of which model. */

export type FreezeMode = "none" | "allButOutput";

export interface FineTunePlan {
  id: string;
  name: string;
  description: string;
  epochs: number;
  /** Null: a third of the rate the model was trained at. */
  learningRate: number | null;
  freeze: FreezeMode;
  builtIn: boolean;
}

export const FREEZE_OPTIONS: ReadonlyArray<{ value: FreezeMode; label: string }> = [
  { value: "none", label: "Nothing: every layer can change" },
  { value: "allButOutput", label: "Everything but the output layer" },
];

export const isBuiltInPlan = (plan: FineTunePlan) => plan.builtIn;

export const newPlan = (): FineTunePlan => ({ id: "", name: "", description: "", epochs: 30, learningRate: null, freeze: "none", builtIn: false });

export const duplicatePlan = (plan: FineTunePlan): FineTunePlan => ({ ...plan, id: "", name: `${plan.name} copy`.slice(0, 40), builtIn: false });

/** One line saying what a plan does. */
export function describePlan(plan: FineTunePlan): string {
  const rate = plan.learningRate === null ? "a gentle step" : `learning rate ${plan.learningRate}`;
  const frozen = plan.freeze === "allButOutput" ? "only the output layer changes" : "every layer can change";
  return `${plan.epochs} round${plan.epochs === 1 ? "" : "s"} · ${rate} · ${frozen}`;
}
