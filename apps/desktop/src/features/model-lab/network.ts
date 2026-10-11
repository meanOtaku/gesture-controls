import type { TrainMethod } from "./training";

/** The shape of a neural network and how it is trained: the same settings, limits and defaults as the trainer's `network.py`. */

export type Activation = "relu" | "tanh" | "sigmoid" | "leaky_relu";
export type Pooling = "mean_max" | "mean" | "max";

export const ACTIVATIONS: ReadonlyArray<{ value: Activation; label: string }> = [
  { value: "relu", label: "ReLU" },
  { value: "tanh", label: "Tanh" },
  { value: "sigmoid", label: "Sigmoid" },
  { value: "leaky_relu", label: "Leaky ReLU" },
];
export const POOLINGS: ReadonlyArray<{ value: Pooling; label: string }> = [
  { value: "mean_max", label: "Average and maximum" },
  { value: "mean", label: "Average" },
  { value: "max", label: "Maximum" },
];
export const KERNELS = [3, 5, 7, 9, 11, 13, 15] as const;

export const LIMITS = {
  hiddenLayers: 6,
  convLayers: 4,
  units: 512,
  filters: 128,
  epochs: [5, 1000],
  batch: 256,
  learningRate: [0.0001, 0.1],
  weightDecay: [0, 0.1],
  dropout: [0, 0.7],
} as const;

export interface DenseLayer { units: number; activation: Activation }
export interface ConvLayer { filters: number; kernel: number; activation: Activation }

export interface NetworkSettings {
  hidden: DenseLayer[];
  conv: ConvLayer[];
  pooling: Pooling;
  dropout: number;
  learningRate: number;
  epochs: number;
  /** 0 trains on the whole set at once. */
  batchSize: number;
  weightDecay: number;
  balanceClasses: boolean;
  augment: boolean;
}

export const NEURAL_METHODS: TrainMethod[] = ["mlp", "torch-mlp", "cnn1d"];
export const isNeural = (method: TrainMethod): boolean => NEURAL_METHODS.includes(method);

/** What each method trained with before it could be set. */
export function defaultNetwork(method: TrainMethod): NetworkSettings {
  if (method === "cnn1d") {
    return {
      hidden: [], conv: [{ filters: 16, kernel: 5, activation: "relu" }, { filters: 16, kernel: 5, activation: "relu" }], pooling: "mean_max",
      dropout: 0.2, learningRate: 0.003, epochs: 80, batchSize: 64, weightDecay: 0.001, balanceClasses: true, augment: true,
    };
  }
  return {
    hidden: [{ units: 32, activation: "relu" }, { units: 16, activation: "relu" }], conv: [], pooling: "mean_max",
    dropout: 0, learningRate: 0.01, epochs: method === "mlp" ? 600 : 200, batchSize: 0, weightDecay: 0, balanceClasses: true, augment: false,
  };
}

/** Which settings the method honours; the others are shown but not used. */
export function appliesTo(method: TrainMethod) {
  return {
    activations: method !== "mlp", // the scikit-learn network is always ReLU
    conv: method === "cnn1d",
    pooling: method === "cnn1d",
    dropout: method !== "mlp",
    learningRate: method !== "mlp",
    epochs: true,
    batchSize: method !== "mlp",
    weightDecay: method !== "mlp",
    balanceClasses: method !== "mlp",
    augment: method === "cnn1d",
  };
}

/** How many numbers the network learns: every weight and bias, counted layer by layer (as `parameter_count` in the trainer). */
export function parameterCount(settings: NetworkSettings, inputs: number, method: TrainMethod): number {
  let total = 0;
  let width = inputs;
  if (method === "cnn1d") {
    let channels = inputs;
    for (const layer of settings.conv) {
      total += layer.filters * channels * layer.kernel + layer.filters;
      channels = layer.filters;
    }
    width = channels * (settings.pooling === "mean_max" ? 2 : 1);
  }
  for (const layer of settings.hidden) {
    total += width * layer.units + layer.units;
    width = layer.units;
  }
  return total + width * 2 + 2;
}

export const sameNetwork = (a: NetworkSettings, b: NetworkSettings): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The `network` part of a training request: only what the method honours, and nothing at all while it is the default. */
export function networkRequest(settings: NetworkSettings, method: TrainMethod): Record<string, unknown> | undefined {
  if (!isNeural(method) || sameNetwork(settings, defaultNetwork(method))) return undefined;
  const use = appliesTo(method);
  return {
    hidden: settings.hidden.map((layer) => ({ units: layer.units, activation: use.activations ? layer.activation : "relu" })),
    ...(use.conv ? { conv: settings.conv } : {}),
    ...(use.pooling ? { pooling: settings.pooling } : {}),
    ...(use.dropout ? { dropout: settings.dropout } : {}),
    ...(use.learningRate ? { learningRate: settings.learningRate } : {}),
    epochs: settings.epochs,
    ...(use.batchSize ? { batchSize: settings.batchSize } : {}),
    ...(use.weightDecay ? { weightDecay: settings.weightDecay } : {}),
    ...(use.balanceClasses ? { balanceClasses: settings.balanceClasses } : {}),
    ...(use.augment ? { augment: settings.augment } : {}),
  };
}

export const clamp = (value: number, [low, high]: readonly [number, number] | readonly number[]): number => Math.min(Math.max(value, low), high);
