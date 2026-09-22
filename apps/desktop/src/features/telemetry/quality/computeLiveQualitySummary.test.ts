import { describe, expect, it } from "vitest";
import { computeLiveQualitySummary } from "./computeLiveQualitySummary";
import type { LiveInterval } from "../annotations/timeline";
import type { DatasetRow } from "../store/telemetryStore";

function row(timestampNs: number, overrides: Partial<DatasetRow> = {}): DatasetRow {
  return {
    timestampNs: String(timestampNs),
    sequence: "0",
    ppgGreen: 1,
    ppgRed: null,
    ppgIr: null,
    accelX: null,
    accelY: null,
    accelZ: null,
    gyroX: null,
    gyroY: null,
    gyroZ: null,
    quatW: null,
    quatX: null,
    quatY: null,
    quatZ: null,
    contactQuality: null,
    label: "NA",
    ...overrides,
  };
}

function interval(startRawRow: number, endRawRow: number | null, intervalId = "iv-1"): LiveInterval {
  return {
    intervalId,
    labelId: "pinch",
    startMonotonicNs: 0,
    endMonotonicNs: endRawRow === null ? null : 1,
    startRawRow,
    endRawRow,
    creationMechanism: "timeline_edit",
    curationStatus: "unreviewed",
    createdAt: new Date(0).toISOString(),
    revision: 1,
  };
}

describe("computeLiveQualitySummary", () => {
  it("reports ok status and the correct effective sample rate for uniform monotonic rows", () => {
    const rows = Array.from({ length: 11 }, (_, i) => row(i * 20_000_000));
    const summary = computeLiveQualitySummary(rows, []);
    expect(summary.timestampStatus).toBe("ok");
    expect(summary.nonMonotonicRowCount).toBe(0);
    expect(summary.effectiveSampleRateHz).toBeCloseTo(50, 5);
    // Only ppg_green has values in this fixture; every other channel is
    // legitimately missing, so that (and only that) warning is expected.
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toContain("channel(s) have no recorded values");
  });

  it("flags non-monotonic timestamps as a warning and withholds the sample rate", () => {
    const rows = [row(0), row(20_000_000), row(10_000_000), row(40_000_000)];
    const summary = computeLiveQualitySummary(rows, []);
    expect(summary.timestampStatus).toBe("warning");
    expect(summary.nonMonotonicRowCount).toBe(1);
    expect(summary.effectiveSampleRateHz).toBeNull();
    expect(summary.warnings.some((w) => w.includes("out of chronological order"))).toBe(true);
  });

  it("reports insufficient_data for fewer than two rows", () => {
    const summary = computeLiveQualitySummary([row(0)], []);
    expect(summary.timestampStatus).toBe("insufficient_data");
    expect(summary.effectiveSampleRateHz).toBeNull();
  });

  it("flags a channel with zero recorded values across the whole session", () => {
    const rows = [row(0, { ppgGreen: 1 }), row(20_000_000, { ppgGreen: 2 })];
    const summary = computeLiveQualitySummary(rows, []);
    expect(summary.missingChannels).toContain("accel_x");
    expect(summary.missingChannels).not.toContain("ppg_green");
    expect(summary.missingValueCounts.accel_x).toBe(2);
  });

  it("counts labeled/unlabeled rows and flags a short labeled interval", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i * 20_000_000));
    // rows [0,2) span 20ms: under the 150ms short-label threshold.
    const summary = computeLiveQualitySummary(rows, [interval(0, 2)]);
    expect(summary.labeledRowCount).toBe(2);
    expect(summary.unlabeledRowCount).toBe(8);
    expect(summary.shortLabelIntervalIds).toEqual(["iv-1"]);
    expect(summary.warnings.some((w) => w.includes("shorter than"))).toBe(true);
  });

  it("ignores an open (unclosed) interval for coverage and short-label checks", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(i * 20_000_000));
    const summary = computeLiveQualitySummary(rows, [interval(0, null)]);
    expect(summary.intervalCount).toBe(0);
    expect(summary.labeledRowCount).toBe(0);
    expect(summary.unlabeledRowCount).toBe(5);
  });
});
