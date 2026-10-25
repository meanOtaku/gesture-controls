import type { LabellingStream } from "./labellingApi";

/** A stretch where the data itself is suspect, whatever the labels say. */
export interface Hazard {
  startMs: number;
  endMs: number;
  text: string;
}

/** A stream this long without a sample stalled (`dataset_files` counts stalls from the same quarter second). */
const STALL_MS = 250;
/** A signal unchanged this long is not being measured. */
const FLAT_MS = 1000;
/** This many samples in a row at a column's extreme: the sensor ran out of range. */
const SATURATED_RUN = 10;
/** Contact flagged this long is worth a look. */
const FLAGGED_MS = 500;

function runs(times: number[], test: (i: number) => boolean, minMs: number, minCount = 1): { startMs: number; endMs: number }[] {
  const found: { startMs: number; endMs: number }[] = [];
  let from = -1;
  const close = (end: number) => {
    if (from >= 0 && end - from + 1 >= minCount && times[end] - times[from] >= minMs) found.push({ startMs: times[from], endMs: times[end] });
    from = -1;
  };
  for (let i = 0; i < times.length; i += 1) {
    if (test(i)) {
      if (from < 0) from = i;
    } else close(i - 1);
  }
  close(times.length - 1);
  return found;
}

/** Stalls, and clock jumps (a sample stamped before the one before it) in one stream. */
function timing(name: string, times: number[]): Hazard[] {
  const out: Hazard[] = [];
  for (let i = 1; i < times.length; i += 1) {
    const gap = times[i] - times[i - 1];
    if (gap < 0) out.push({ startMs: times[i], endMs: times[i - 1], text: `The ${name} clock jumped back ${Math.round(-gap)} ms` });
    else if (gap > STALL_MS) out.push({ startMs: times[i - 1], endMs: times[i], text: `${name[0].toUpperCase()}${name.slice(1)} stopped for ${(gap / 1000).toFixed(1)} s` });
  }
  return out;
}

/**
 * Where a recording's data is suspect: a stream that stalled or whose clock jumped, a pulse that went flat, a column stuck
 * at its extreme (out of the sensor's range), and pulse contact the sensor flagged. Worth a look before labelling, and
 * worth leaving out when it is bad.
 */
export function hazardsIn(ppg: LabellingStream, imu: LabellingStream): Hazard[] {
  const found: Hazard[] = [...timing("pulse", ppg.timesMs), ...timing("motion", imu.timesMs)];
  const green = ppg.columns.find((column) => column.name === "ppg_green")?.values;
  if (green) {
    for (const run of runs(ppg.timesMs, (i) => i > 0 && green[i] !== null && green[i] === green[i - 1], FLAT_MS)) {
      found.push({ ...run, text: "The pulse signal is flat: the sensor was not measuring" });
    }
  }
  const contact = ppg.columns.find((column) => column.name === "contact_quality")?.values;
  if (contact) {
    for (const run of runs(ppg.timesMs, (i) => (contact[i] ?? 0) > 0, FLAGGED_MS)) found.push({ ...run, text: "The pulse sensor flagged poor contact" });
  }
  for (const [stream, columns] of [[ppg, ["ppg_green", "ppg_red", "ppg_ir"]], [imu, ["accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z"]]] as const) {
    for (const name of columns) {
      const values = stream.columns.find((column) => column.name === name)?.values;
      if (!values) continue;
      let high = -Infinity;
      let low = Infinity;
      for (const value of values) {
        if (value === null) continue;
        if (value > high) high = value;
        if (value < low) low = value;
      }
      if (!(high > low)) continue;
      for (const extreme of [high, low]) {
        for (const run of runs(stream.timesMs, (i) => values[i] === extreme, 0, SATURATED_RUN)) {
          found.push({ ...run, text: `${name} is stuck at its ${extreme === high ? "highest" : "lowest"} value: out of the sensor's range` });
        }
      }
    }
  }
  return found.sort((a, b) => a.startMs - b.startMs);
}
