import { defaultNetwork, isNeural, networkRequest, parameterCount, type ConvLayer, type DenseLayer, type NetworkSettings, type Pooling } from "./network";
import { ALL_COLUMNS, DEFAULT_WINDOW_MS, METHODS, type DataStream, type PpgChannel, type SpikeMethodId, type TrainMethod } from "./training";

/**
 * A network design: a named, reusable recipe for the network a model is trained with (see `network_designs.rs`). It says what
 * goes into the model, how the pulse sensor's spikes are pulled out, how long a window is, and the shape of the network and
 * how it learns; it says nothing about which label or recordings.
 */
export interface NetworkDesign {
  /** Empty for a design not saved yet. Built-in designs start with `builtin-`. */
  id: string;
  name: string;
  description: string;
  method: TrainMethod;
  inputMode: "statistics" | "raw";
  sources: DataStream[];
  ppgChannels: PpgChannel[] | null;
  movementOnly: boolean;
  features: string[] | null;
  columns: string[];
  readings: number;
  spikeMethod: SpikeMethodId;
  /** How far back (milliseconds) the pulse sensor's level is compared with, or null for no comparison. Statistics only. */
  baselineMs: number | null;
  windowMs: number;
  /** The network's settings that differ from the method's own default; null means the default. */
  network: Record<string, unknown> | null;
  /** The convolutional method only: a pre-trained motion encoder (by name) to start from, and whether to keep its layers. */
  pretrained?: string | null;
  pretrainedFreeze?: boolean;
  builtIn: boolean;
}

/** What a design would read, from the desktop. */
export interface DesignPreview {
  problem: string | null;
  available: string[];
  inputs: string[];
  neurons: number;
}

export const isBuiltIn = (design: NetworkDesign): boolean => design.builtIn || design.id.startsWith("builtin-");

/** A new design to start from: a small PyTorch network on the statistics of acceleration and gyroscope. */
export function newDesign(): NetworkDesign {
  return {
    id: "", name: "", description: "", method: "torch-mlp", inputMode: "statistics", sources: ["watchAcceleration", "watchGyroscope"],
    ppgChannels: null, movementOnly: false, features: null, columns: [...ALL_COLUMNS], readings: 1, spikeMethod: "none", baselineMs: null, windowMs: DEFAULT_WINDOW_MS, network: null, builtIn: false,
  };
}

/** A copy to change: no id, a name that says it is a copy, never built in. */
export function duplicateOf(design: NetworkDesign): NetworkDesign {
  return { ...structuredClone(design), id: "", name: `${design.name} copy`.slice(0, 40), builtIn: false };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The network settings a design stands for: its own over the method's defaults. */
export function networkSettingsOf(design: NetworkDesign): NetworkSettings {
  const base = defaultNetwork(design.method);
  const spec = design.network;
  if (!isNeural(design.method) || !isRecord(spec)) return base;
  const number = (key: string, fallback: number) => (typeof spec[key] === "number" ? (spec[key] as number) : fallback);
  const dense = (value: unknown): DenseLayer[] | null => (Array.isArray(value) ? value.filter(isRecord).map((l) => ({ units: Number(l.units) || 1, activation: (l.activation as DenseLayer["activation"]) ?? "relu" })) : null);
  const conv = (value: unknown): ConvLayer[] | null => (Array.isArray(value) ? value.filter(isRecord).map((l) => ({ filters: Number(l.filters) || 1, kernel: Number(l.kernel) || 5, activation: (l.activation as ConvLayer["activation"]) ?? "relu" })) : null);
  return {
    hidden: dense(spec.hidden) ?? base.hidden,
    conv: conv(spec.conv) ?? base.conv,
    pooling: (typeof spec.pooling === "string" ? spec.pooling : base.pooling) as Pooling,
    dropout: number("dropout", base.dropout),
    learningRate: number("learningRate", base.learningRate),
    epochs: number("epochs", base.epochs),
    batchSize: number("batchSize", base.batchSize),
    weightDecay: number("weightDecay", base.weightDecay),
    balanceClasses: typeof spec.balanceClasses === "boolean" ? spec.balanceClasses : base.balanceClasses,
    augment: typeof spec.augment === "boolean" ? spec.augment : base.augment,
  };
}

/** The design with its network set from `settings` (nothing is kept while they are the method's defaults). */
export function withNetwork(design: NetworkDesign, settings: NetworkSettings): NetworkDesign {
  return { ...design, network: networkRequest(settings, design.method) ?? null };
}

/** Whether the design reads the dataset's own columns (always for the convolutional method). */
export const readsColumns = (design: Pick<NetworkDesign, "method" | "inputMode">): boolean => design.method === "cnn1d" || design.inputMode === "raw";

/** One line saying what the design is: the method, what goes in, the layers and the size. */
export function describeDesign(design: NetworkDesign, preview: DesignPreview | null): string {
  const method = METHODS.find((option) => option.value === design.method)?.label ?? design.method;
  if (!preview || preview.problem) return `${method} · ${preview?.problem ?? "…"}`;
  const settings = networkSettingsOf(design);
  const columns = readsColumns(design);
  const input = design.method === "cnn1d"
    ? `${design.columns.length} channel${design.columns.length === 1 ? "" : "s"} × ${design.readings} steps`
    : columns
      ? `${design.columns.length} column${design.columns.length === 1 ? "" : "s"} × ${design.readings} reading${design.readings === 1 ? "" : "s"} = ${preview.neurons} input neurons`
      : `${preview.neurons} statistics`;
  const shape = isNeural(design.method)
    ? ` · ${design.method === "cnn1d" ? "convolution → " : ""}${settings.hidden.map((layer) => `${layer.units} → `).join("")}2 · ${parameterCount(settings, preview.neurons, design.method).toLocaleString("en-US")} parameters`
    : "";
  const baseline = design.baselineMs ? (columns ? ` · pulse in units of the last ${design.baselineMs / 1000} s` : ` · level against the last ${design.baselineMs / 1000} s`) : "";
  const encoder = design.method === "cnn1d" && design.pretrained ? ` · from encoder ${design.pretrained}${design.pretrainedFreeze ? " (kept as it is)" : ""}` : "";
  return `${method} · ${input}${shape} · ${design.windowMs / 1000} s window${baseline}${encoder}`;
}
