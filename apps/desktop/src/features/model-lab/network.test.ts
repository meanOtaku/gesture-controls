import { describe, expect, it } from "vitest";
import { appliesTo, defaultNetwork, networkRequest, parameterCount, sameNetwork } from "./network";

describe("network settings", () => {
  it("defaults to what each method trained with before it could be set", () => {
    expect(defaultNetwork("torch-mlp")).toMatchObject({ hidden: [{ units: 32 }, { units: 16 }], learningRate: 0.01, epochs: 200, batchSize: 0, dropout: 0 });
    expect(defaultNetwork("mlp").epochs).toBe(600);
    expect(defaultNetwork("cnn1d")).toMatchObject({ conv: [{ filters: 16, kernel: 5 }, { filters: 16, kernel: 5 }], pooling: "mean_max", dropout: 0.2, epochs: 80, batchSize: 64, augment: true });
  });

  it("counts parameters as the trainer does", () => {
    expect(parameterCount(defaultNetwork("torch-mlp"), 28, "torch-mlp")).toBe(28 * 32 + 32 + 32 * 16 + 16 + 16 * 2 + 2); // 1490
    // 6 channels -> 16 -> 16 filters of width 5, average and maximum -> 32 -> 2
    expect(parameterCount(defaultNetwork("cnn1d"), 6, "cnn1d")).toBe(16 * 6 * 5 + 16 + 16 * 16 * 5 + 16 + 32 * 2 + 2);
    const custom = { ...defaultNetwork("cnn1d"), pooling: "max" as const, hidden: [{ units: 4, activation: "tanh" as const }] };
    expect(parameterCount(custom, 6, "cnn1d")).toBe(16 * 6 * 5 + 16 + 16 * 16 * 5 + 16 + 16 * 4 + 4 + 4 * 2 + 2);
  });

  it("sends nothing while the network is the default, and only what the method honours when it is not", () => {
    expect(networkRequest(defaultNetwork("torch-mlp"), "torch-mlp")).toBeUndefined();
    expect(networkRequest(defaultNetwork("logreg"), "logreg")).toBeUndefined();
    const changed = { ...defaultNetwork("mlp"), hidden: [{ units: 8, activation: "tanh" as const }], learningRate: 0.05, dropout: 0.3 };
    // The scikit-learn network takes layer sizes and rounds only (its activation is always ReLU).
    expect(networkRequest(changed, "mlp")).toEqual({ hidden: [{ units: 8, activation: "relu" }], epochs: 600 });
    const dense = { ...defaultNetwork("torch-mlp"), hidden: [{ units: 8, activation: "tanh" as const }], dropout: 0.1 };
    expect(networkRequest(dense, "torch-mlp")).toMatchObject({ hidden: [{ units: 8, activation: "tanh" }], dropout: 0.1, learningRate: 0.01 });
    expect(networkRequest(dense, "torch-mlp")).not.toHaveProperty("conv");
    const cnn = { ...defaultNetwork("cnn1d"), augment: false };
    expect(networkRequest(cnn, "cnn1d")).toMatchObject({ augment: false, conv: [{ filters: 16 }, { filters: 16 }], pooling: "mean_max" });
  });

  it("says which settings each method honours", () => {
    expect(appliesTo("mlp")).toMatchObject({ activations: false, learningRate: false, epochs: true, conv: false });
    expect(appliesTo("torch-mlp")).toMatchObject({ activations: true, conv: false, augment: false });
    expect(appliesTo("cnn1d")).toMatchObject({ conv: true, pooling: true, augment: true });
    expect(sameNetwork(defaultNetwork("cnn1d"), defaultNetwork("cnn1d"))).toBe(true);
  });
});
