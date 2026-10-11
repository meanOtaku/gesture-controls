/** What the Inspect view shows about a model: the trainer's inspection of it (see `inspection.py`), and helpers to draw it. */

export type WindowCategory = "truePositive" | "falseNegative" | "trueNegative" | "falsePositive";

export interface InspectionInput {
  name: string;
  mean: number;
  std: number;
}
export interface DenseLayerData {
  units: number;
  activation: string | null;
  /** (inputs, units): one row of weights for each input of this layer. */
  weights: number[][];
  bias: number[];
}
export interface ConvLayerData {
  filters: number;
  kernel: number;
  activation: string | null;
  /** (filters, channels, kernel) */
  weights: number[][][];
  bias: number[];
}
export interface InspectionWindow {
  category: WindowCategory;
  recording: string;
  startNs: number;
  /** The label the recording gave this window. */
  label: string;
  /** 1 if it is the gesture the model is for. */
  target: number;
  probability: number;
  /** What each input took as its value (for a convolutional model, the window as a flat grid: channel after channel). */
  values: number[];
  /** What each layer produced: dense layers give a row of neurons; a convolution layer gives (filters, steps); the pooling a row. */
  activations: unknown[];
  /** Dense models: how much the answer falls when each input takes its average value instead. */
  contributions?: number[];
  /** Convolutional models: how much the answer falls when a stretch of a channel is replaced by its average. */
  occlusion?: { blockSteps: number; drop: number[][] };
}
export interface CurveRow {
  epoch: number;
  epochs: number;
  trainLoss: number;
  evalLoss?: number;
  evalAuc?: number;
  evalAccuracy?: number;
}
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
  backend: string;
  target: string;
  inputKind: "features" | "channels";
  gridSteps: number | null;
  centreWindows: boolean;
  spikeMethod: string | null;
  inputs: InspectionInput[];
  network: {
    kind: "linear" | "dense" | "conv";
    conv: ConvLayerData[];
    pooling: string | null;
    dense: DenseLayerData[];
    output: { outputs: number; weights: number[][]; bias: number[] };
  };
  parameters: number | null;
  importance: { name: string; aucDrop: number; aucDropStd: number }[];
  windows: InspectionWindow[];
  curve: CurveRow[];
  evaluation: {
    threshold: number;
    recordings: string[];
    labels: number[];
    probabilities: number[];
    metrics: Record<string, unknown> & { rocAuc: number };
  };
  forwardMaxAbsDifference: number;
  /** Only when research checks were asked for. */
  research?: Research | null;
  /** Only for a model made by editing another. */
  edit?: { fromModel: string | null; edits: unknown[]; said: string[]; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null } | null;
}
export interface ModelInspectionView {
  id: string;
  label: string;
  origin: "trained" | "imported";
  manifest: Record<string, unknown>;
  inspection: Inspection | null;
}

export const CATEGORY_TEXT: Record<WindowCategory, { title: string; says: string }> = {
  truePositive: { title: "Clearest hit", says: "A window of the gesture that the model called the gesture." },
  falseNegative: { title: "A miss", says: "A window of the gesture that the model did not call the gesture." },
  trueNegative: { title: "Clearest rejection", says: "A window of something else that the model correctly left alone." },
  falsePositive: { title: "A false alarm", says: "A window of something else that the model called the gesture." },
};

export const maxAbs = (matrix: number[][]): number => matrix.reduce((best, row) => row.reduce((m, v) => Math.max(m, Math.abs(v)), best), 0);
export const minMax = (matrix: number[][]): [number, number] => {
  let low = Infinity;
  let high = -Infinity;
  for (const row of matrix) for (const v of row) { low = Math.min(low, v); high = Math.max(high, v); }
  return low === Infinity ? [0, 0] : [low, high];
};

const mix = (a: number[], b: number[], t: number): string => `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * t)).join(",")})`;
const WHITE = [255, 255, 255];
const NEGATIVE = [44, 123, 182]; // blue
const POSITIVE = [215, 48, 39]; // red
const LOW = [255, 255, 255];
const HIGH = [42, 157, 143]; // teal

/** Blue for negative, red for positive, white at zero; full colour at `limit`. */
export function divergingColor(value: number, limit: number): string {
  if (!(limit > 0) || !Number.isFinite(value)) return "rgb(255,255,255)";
  const t = Math.min(Math.abs(value) / limit, 1);
  return mix(WHITE, value >= 0 ? POSITIVE : NEGATIVE, t);
}
/** White at `low`, teal at `high`. */
export function sequentialColor(value: number, low: number, high: number): string {
  if (!(high > low) || !Number.isFinite(value)) return "rgb(255,255,255)";
  return mix(LOW, HIGH, Math.min(Math.max((value - low) / (high - low), 0), 1));
}

/** Each row of a matrix scaled to 0..1 on its own, so channels in different units can share one picture. */
export function normaliseRows(matrix: number[][]): number[][] {
  return matrix.map((row) => {
    const low = Math.min(...row);
    const high = Math.max(...row);
    return row.map((v) => (high > low ? (v - low) / (high - low) : 0));
  });
}

/** `flat` (channel after channel) folded into rows of `steps`. */
export function foldGrid(flat: number[], steps: number): number[][] {
  const rows: number[][] = [];
  for (let start = 0; start + steps <= flat.length; start += steps) rows.push(flat.slice(start, start + steps));
  return rows;
}

export const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;
