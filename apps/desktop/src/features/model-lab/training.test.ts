import { describe, expect, it } from "vitest";
import { MAX_LOG_LINES, appendLog, buildRequest, describeEvents, describeMetrics, hasLabel, otherLabels, recordingsWithLabel, thresholdNote } from "./training";
import type { DatasetSummary } from "./types";

const dataset = (id: string, labels: string[]): DatasetSummary => ({ id, originalFilename: `${id}.csv`, importedAt: "", label: labels.join(", "), labels, rowCount: 10 });
const data = [dataset("a", ["snap"]), dataset("b", ["idle", "walking"]), dataset("c", ["typing"])];

describe("otherLabels", () => {
  it("lists the other labels on the chosen recordings only, sorted", () => {
    expect(otherLabels(data, new Set(["a", "b"]), "snap")).toEqual(["idle", "walking"]);
    expect(otherLabels(data, new Set(["a"]), "snap")).toEqual([]);
    expect(otherLabels(data, new Set(), "snap")).toEqual([]);
  });

  it("leaves out stretches left out on the Labelling page: they are always excluded, so need no role", () => {
    expect(otherLabels([dataset("d", ["snap", "left_out", "idle"])], new Set(["d"]), "snap")).toEqual(["idle"]);
  });

  it("knows which recordings have a label", () => {
    expect(hasLabel(data[1], "walking")).toBe(true);
    expect(hasLabel(data[0], "idle")).toBe(false);
  });
});

describe("buildRequest", () => {
  it("makes every other label a negative unless it was set aside", () => {
    const request = buildRequest({ label: "snap", datasetIds: ["a", "b"], others: ["idle", "walking"], roles: { walking: "exclude" } });
    expect(request).toEqual({ label: "snap", datasetIds: ["a", "b"], negatives: ["idle"], excludes: ["walking"] });
  });

  it("asks for the research checks and a label offset only when chosen", () => {
    const request = buildRequest({ label: "snap", datasetIds: ["a"], others: [], roles: {}, research: true, labelOffsetMs: -250 });
    expect(request).toMatchObject({ research: true, labelOffsetMs: -250 });
    expect(buildRequest({ label: "snap", datasetIds: ["a"], others: [], roles: {}, labelOffsetMs: 0 })).not.toHaveProperty("labelOffsetMs");
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
    expect(text).toContain("80% of the 40 gesture starts");
    expect(text).toContain("90% of what it flagged");
    expect(text).toContain("5% of the 60 other moments");
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

describe("describeEvents", () => {
  it("says what someone using it would notice: gestures caught, how soon, and false alarms over the time without one", () => {
    const text = describeEvents({ recordings: 2, gestures: 12, caught: 11, gestureRecall: 11 / 12, repeats: 0, medianLatencyMs: 240.4, falseActivations: 2, negativeSeconds: 300, falseActivationsPerHour: 24 });
    expect(text).toContain("caught 11 of 12 gestures, typically 240 ms after each began");
    expect(text).toContain("went off 2 times in 5.0 minutes without the gesture (about 24 an hour)");
  });

  it("leaves out the gestures when the test recordings hold none", () => {
    const text = describeEvents({ recordings: 1, gestures: 0, caught: 0, gestureRecall: null, repeats: 0, medianLatencyMs: null, falseActivations: 0, negativeSeconds: 45, falseActivationsPerHour: 0 });
    expect(text).toBe("Played through the test recordings as it would run live, it went off 0 times in 45 seconds without the gesture (about 0 an hour).");
  });
});

describe("thresholdNote", () => {
  const metrics = { windows: 100, positiveWindows: 40, negativeWindows: 60, precision: 0.9, recall: 0.8, f1: 0.85, falseActivationRate: 0.05, rocAuc: 0.97, activationThreshold: 0.6 };

  it("calls the numbers fair when the cut-off came from the training recordings", () => {
    expect(thresholdNote({ ...metrics, thresholdSource: "trainingRecordings", thresholdChosenOnEvaluationRecordings: false })).toContain("chosen on the training recordings");
  });

  it("keeps the old caveat for a run from before, which chose it on the test recordings", () => {
    expect(thresholdNote(metrics)).toContain("chosen using those same test recordings");
  });
});
