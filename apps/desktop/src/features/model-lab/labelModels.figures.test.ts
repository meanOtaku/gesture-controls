import { describe, expect, it } from "vitest";
import { modelStats } from "./labelModels";

describe("modelStats", () => {
  it("says which threshold the held-out figures are at when it is not the one the model runs at", () => {
    const trained = { recall: 0.75, falseActivationsPerHour: 16, atThreshold: 0.95, measured: "training" as const };
    expect(modelStats({ activation: 0.99, evaluation: trained })).toEqual([
      { term: "Threshold", value: "0.99" },
      { term: "Held-out recall", value: "75% at 0.95, when trained" },
      { term: "False / hour", value: "16 at 0.95, when trained" },
    ]);
    expect(modelStats({ activation: 0.95, evaluation: trained })[1]).toEqual({ term: "Held-out recall", value: "75%" });
    const measured = { recall: 0.93, falseActivationsPerHour: 5, atThreshold: 0.99, measured: "thresholdCard" as const };
    expect(modelStats({ activation: 0.99, evaluation: measured }).slice(1)).toEqual([
      { term: "Held-out recall", value: "93%" },
      { term: "False / hour", value: "5.0" },
    ]);
  });
});
