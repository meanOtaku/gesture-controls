import type { RawImageViewerChannel, RecordingQualitySummary, TimestampStatus } from "../../../shared/tauri/recordingBundle";
import { RAW_IMAGE_VIEWER_CHANNELS } from "../../../shared/tauri/recordingBundle";
import type { LiveInterval } from "../annotations/timeline";
import type { DatasetRow } from "../store/telemetryStore";

/** A labeled interval shorter than this is flagged as likely too brief for the current 500 ms model window. Mirrors `recording_bundle::SHORT_LABEL_THRESHOLD_MS`. */
export const SHORT_LABEL_THRESHOLD_MS = 150;

const CHANNEL_ACCESSORS: Record<RawImageViewerChannel, (row: DatasetRow) => number | null> = {
  ppg_green: (row) => row.ppgGreen,
  ppg_red: (row) => row.ppgRed,
  ppg_ir: (row) => row.ppgIr,
  accel_x: (row) => row.accelX,
  accel_y: (row) => row.accelY,
  accel_z: (row) => row.accelZ,
  gyro_x: (row) => row.gyroX,
  gyro_y: (row) => row.gyroY,
  gyro_z: (row) => row.gyroZ,
  quat_w: (row) => row.quatW,
  quat_x: (row) => row.quatX,
  quat_y: (row) => row.quatY,
  quat_z: (row) => row.quatZ,
  contact_quality: (row) => row.contactQuality,
};

/**
 * Client-side equivalent of `recording_bundle::compute_quality_summary`, run
 * on the in-memory Timeline Capture session before a bundle is ever saved,
 * so a bad/mixed timestamp stream is visible during review rather than only
 * after persistence. Kept field-for-field compatible with the backend
 * `RecordingQualitySummary` shape so both feed the same display component;
 * `recordingId` is empty since no bundle exists yet.
 */
export function computeLiveQualitySummary(rows: DatasetRow[], intervals: LiveInterval[]): RecordingQualitySummary {
  const timestampsNs = rows.map((row) => Number(row.timestampNs));
  const rowCount = timestampsNs.length;

  let nonMonotonicRowCount = 0;
  for (let index = 1; index < timestampsNs.length; index += 1) {
    if (!Number.isFinite(timestampsNs[index]) || timestampsNs[index] < timestampsNs[index - 1]) {
      nonMonotonicRowCount += 1;
    }
  }
  const timeSpanNs = rowCount >= 2 ? Math.max(0, timestampsNs[rowCount - 1] - timestampsNs[0]) : 0;
  const timeSpanMs = timeSpanNs / 1_000_000;

  let timestampStatus: TimestampStatus;
  if (rowCount < 2) timestampStatus = "insufficient_data";
  else if (nonMonotonicRowCount > 0 || timeSpanNs <= 0) timestampStatus = "warning";
  else timestampStatus = "ok";

  const effectiveSampleRateHz =
    timestampStatus === "ok" ? (rowCount - 1) / (timeSpanNs / 1_000_000_000) : null;

  const missingValueCounts: Record<string, number> = {};
  const missingChannels: string[] = [];
  RAW_IMAGE_VIEWER_CHANNELS.forEach((channel) => {
    const accessor = CHANNEL_ACCESSORS[channel];
    const missing = rows.filter((row) => accessor(row) === null).length;
    missingValueCounts[channel] = missing;
    if (rowCount > 0 && missing === rowCount) missingChannels.push(channel);
  });

  const closedIntervals = intervals.filter((interval) => interval.endRawRow !== null);
  const labeledRowCount = Math.min(
    rowCount,
    closedIntervals.reduce((sum, interval) => sum + ((interval.endRawRow as number) - interval.startRawRow), 0),
  );
  const unlabeledRowCount = Math.max(0, rowCount - labeledRowCount);

  const shortLabelIntervalIds = closedIntervals
    .filter((interval) => {
      const startNs = Number(rows[interval.startRawRow]?.timestampNs ?? Number.NaN);
      const endNs = Number(rows[(interval.endRawRow as number) - 1]?.timestampNs ?? Number.NaN);
      if (!Number.isFinite(startNs) || !Number.isFinite(endNs)) return false;
      return (endNs - startNs) / 1_000_000 < SHORT_LABEL_THRESHOLD_MS;
    })
    .map((interval) => interval.intervalId);

  const warnings: string[] = [];
  if (timestampStatus === "warning") {
    warnings.push(
      nonMonotonicRowCount > 0
        ? `${nonMonotonicRowCount} row(s) are out of chronological order; the effective sample rate cannot be trusted.`
        : "Recording has zero observed time span; timestamps cannot establish a sample rate.",
    );
  } else if (timestampStatus === "insufficient_data") {
    warnings.push("Fewer than two rows; timestamp quality cannot be assessed.");
  }
  if (missingChannels.length > 0) {
    warnings.push(`${missingChannels.length} channel(s) have no recorded values: ${missingChannels.join(", ")}.`);
  }
  if (shortLabelIntervalIds.length > 0) {
    warnings.push(
      `${shortLabelIntervalIds.length} labeled interval(s) are shorter than ${SHORT_LABEL_THRESHOLD_MS} ms, which may be too brief for the current model window.`,
    );
  }

  return {
    recordingId: "",
    rowCount,
    timeSpanMs,
    timestampStatus,
    nonMonotonicRowCount,
    effectiveSampleRateHz,
    missingValueCounts,
    missingChannels,
    intervalCount: closedIntervals.length,
    labeledRowCount,
    unlabeledRowCount,
    shortLabelIntervalIds,
    shortLabelThresholdMs: SHORT_LABEL_THRESHOLD_MS,
    warnings,
  };
}
