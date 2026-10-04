import { describe, expect, it } from "vitest";
import { MAX_LOG_LINES, appendLog, buildRequest, describeMetrics, hasLabel, otherLabels, recordingsWithLabel } from "./training";
import type { DatasetSummary } from "./types";

const dataset = (id: string, labels: string[]): DatasetSummary => ({ id, originalFilename: `${id}.csv`, importedAt: "", label: labels.join(", "), labels, rowCount: 10 });
const data = [dataset("a", ["snap"]), dataset("b", ["idle", "walking"]), dataset("c", ["typing"])];

describe("otherLabels", () => {
  it("lists the other labels on the chosen recordings only, sorted", () => {
    expect(otherLabels(data, new Set(["a", "b"]), "snap")).toEqual(["idle", "walking"]);
    expect(otherLabels(data, new Set(["a"]), "snap")).toEqual([]);
    expect(otherLabels(data, new Set(), "snap")).toEqual([]);
  });

  it("knows which recordings have a label", () => {
    expect(hasLabel(data[1], "walking")).toBe(true);
    expect(hasLabel(data[0], "idle")).toBe(false);
  });
});

describe("buildRequest", () => {
  it("asks for movement-only features only when told to", () => {
    const base = { label: "snap", datasetIds: ["a"], others: [], roles: {}, method: "mlp" as const, sources: ["watchPpg" as const] };
    expect(buildRequest(base).movementOnly).toBe(false);
    expect(buildRequest({ ...base, movementOnly: true }).movementOnly).toBe(true);
  });

  it("makes every other label a negative unless it was set aside", () => {
    const request = buildRequest({ label: "snap", datasetIds: ["a", "b"], others: ["idle", "walking"], roles: { walking: "exclude" }, method: "logreg", sources: ["watchAcceleration"] });
    expect(request).toEqual({ label: "snap", datasetIds: ["a", "b"], negatives: ["idle"], excludes: ["walking"], backend: "logreg", sources: ["watchAcceleration"], movementOnly: false });
  });
});

describe("recordingsWithLabel", () => {
  it("counts the chosen recordings that have the label", () => {
    expect(recordingsWithLabel(data, ["a", "b", "c"], "snap")).toBe(1);
    expect(recordingsWithLabel(data, ["b", "c"], "snap")).toBe(0);
    expect(recordingsWithLabel(data, ["a", "ghost"], "snap")).toBe(1);
  });
});

describe("describeMetrics", () => {
  it("says what was found, what was right and how often it was wrong", () => {
    const text = describeMetrics({ windows: 100, positiveWindows: 40, negativeWindows: 60, precision: 0.9, recall: 0.8, f1: 0.85, falseActivationRate: 0.05, rocAuc: 0.97, activationThreshold: 0.6 });
    expect(text).toContain("80% of the 40 windows");
    expect(text).toContain("90% of what it flagged");
    expect(text).toContain("5% of the 60 windows");
  });
});

describe("appendLog", () => {
  it("keeps only the latest lines", () => {
    let log: string[] = [];
    for (let i = 0; i < MAX_LOG_LINES + 20; i += 1) log = appendLog(log, `line ${i}`);
    expect(log).toHaveLength(MAX_LOG_LINES);
    expect(log[log.length - 1]).toBe(`line ${MAX_LOG_LINES + 19}`);
    expect(log[0]).toBe("line 20");
  });
});
