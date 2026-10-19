/** What the Inspect view shows about a model: the trainer's inspection of it (`inspection.json`, see `label_train.py`). */

export interface LearningCurveRow {
  fraction: number;
  windows: number;
  aucMean: number;
  aucStd: number;
  draws: number;
}
export interface LeaveOneOutFold {
  recording: string;
  windows: number;
  gestureWindows: number;
  otherWindows: number;
  meanScore?: number;
  auc?: number | null;
  /** Why this recording could not be left out. */
  skipped?: string;
}
export interface Research {
  learningCurve: LearningCurveRow[];
  leaveOneOut: { folds: LeaveOneOutFold[]; pooledAuc: number | null; pooledWindows: number };
}
export interface Inspection {
  version: number;
  kind: "trees";
  backend: string;
  target: string;
  /** How many inputs the model reads (the PPG pinch-start features). */
  inputCount: number;
  trees: number;
  /** The inputs the trees lean on most (mean decrease in impurity), most first. */
  importance: { name: string; importance: number }[];
  /** Every held-out decision: its recording, whether it is a start of the gesture (1), and the model's score. */
  evaluation: {
    threshold: number;
    recordings: string[];
    labels: number[];
    probabilities: number[];
    /** What each decision is: a start, another label's start, inside a hold, or unlabelled time. */
    kinds?: string[];
    metrics: Record<string, unknown> & { rocAuc: number };
  };
  examples: { train: number; trainStarts: number; evaluation: number; evaluationStarts: number };
  /** Only when research checks were asked for. */
  research?: Research | null;
}
export interface ModelInspectionView {
  id: string;
  label: string;
  origin: "trained" | "imported";
  manifest: Record<string, unknown>;
  /** Present for a model trained here whose inspection is in the current form. */
  inspection: Inspection | null;
}

/** The inspection, if it is one this view can show (a model trained with the pulse model). */
export function currentInspection(value: unknown): Inspection | null {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "trees" ? (value as Inspection) : null;
}

export const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

const PART: Record<string, string> = { green: "green", red: "red", ir: "infrared" };
const STAT: Record<string, string> = {
  q10: "10th percentile", q25: "25th percentile", median: "median", q75: "75th percentile", q90: "90th percentile", mad: "median absolute deviation",
  mean: "mean", std: "spread", energy: "energy", min: "lowest", max: "highest", positive_peak: "highest rise", negative_peak: "deepest fall",
  absolute_peak: "largest swing", zero_crossings: "sign changes", max_age_seconds: "time since the highest", min_age_seconds: "time since the lowest",
  absolute_peak_age_seconds: "time since the largest swing", end_minus_start: "change over the window", late_minus_early_mean: "late half less early half",
  mean_absolute_change: "average step",
};
const ORDER: Record<string, string> = { d1: "slope", d2: "curvature", d3: "jerk" };

/** One input's name (`ppg_z1000ms_d1_green_n8_q10`) in words: "green slope against the last 1 s, 10th percentile over 0.32 s". */
export function describeInput(name: string): string {
  const match = /^ppg_z(\d+)ms_(d[123])_(green|red|ir)_n(\d+)_(.+)$/.exec(name);
  if (!match) return name;
  const [, history, order, channel, window, stat] = match;
  return `${PART[channel]} ${ORDER[order]} against the last ${Number(history) / 1000} s: ${STAT[stat] ?? stat} over ${(Number(window) * 0.04).toFixed(2)} s`;
}
