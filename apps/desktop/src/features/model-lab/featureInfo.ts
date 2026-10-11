/** What each input of a model is, in words: where it comes from and what value it takes. Used wherever inputs are listed. */

export type InputStream = "watchAcceleration" | "watchGyroscope" | "watchOrientation" | "watchPpg";

export interface InputInfo {
  name: string;
  stream: InputStream;
  /** The group inside its stream: an axis, a light, or the window itself. */
  group: string;
  /** A few words, enough to tell it from its neighbours in a list. */
  short: string;
  /** What value it takes. */
  text: string;
}

export const STREAM_TITLES: Record<InputStream, string> = {
  watchAcceleration: "Acceleration",
  watchGyroscope: "Gyroscope",
  watchOrientation: "Orientation",
  watchPpg: "Pulse sensor",
};
export const STREAM_ORDER: InputStream[] = ["watchAcceleration", "watchGyroscope", "watchOrientation", "watchPpg"];

const STATS: Record<string, { short: string; text: (what: string) => string }> = {
  mean: { short: "mean", text: (w) => `The average of ${w} over the window.` },
  std: { short: "spread", text: (w) => `How much ${w} varies inside the window (its standard deviation).` },
  min: { short: "minimum", text: (w) => `The lowest value of ${w} in the window.` },
  max: { short: "maximum", text: (w) => `The highest value of ${w} in the window.` },
  slope: { short: "slope", text: (w) => `How much ${w} rose or fell across the window, per millisecond (last minus first, over its duration).` },
};

const LIGHTS: Record<string, string> = { green: "green light", red: "red light", ir: "infrared light" };
const SPIKE_STATS: Record<string, { short: string; text: (w: string) => string }> = {
  spike_height: { short: "spike height", text: (w) => `How far the biggest spike of the ${w} stands from the rest (signed: up is positive), in the sensor's own units.` },
  spike_z: { short: "spike strength", text: (w) => `How many robust standard deviations above the noise the biggest spike of the ${w} is (at most 50).` },
  spike_time_frac: { short: "spike position", text: (w) => `Where in the window the biggest spike of the ${w} is: 0 is the start, 1 the end.` },
  spike_rise_ms: { short: "spike rise", text: (w) => `How long the ${w} stays above half the biggest spike's height before its peak, in milliseconds.` },
  spike_fall_ms: { short: "spike fall", text: (w) => `How long the ${w} stays above half the biggest spike's height after its peak, in milliseconds.` },
  spike_count: { short: "spike count", text: (w) => `How many separate peaks of the ${w} reach 3 robust standard deviations above the noise.` },
  deriv_max: { short: "steepest rise", text: (w) => `The steepest rise of the ${w} between neighbouring points, per millisecond.` },
  deriv_min: { short: "steepest fall", text: (w) => `The steepest fall of the ${w} between neighbouring points, per millisecond (negative).` },
};

const BASELINE_STATS: Record<string, { short: string; text: (w: string) => string }> = {
  rel_low: { short: "above its resting level", text: (w) => `How far the average of the ${w} in this window sits above the low end (10th percentile) of where it was in the last few seconds: the change against the recent past, not the level itself, which differs from one session to the next.` },
  rel_high: { short: "above its highest level", text: (w) => `How far the average of the ${w} in this window sits above the high end (90th percentile) of where it was in the last few seconds (negative when it is below it).` },
};

const AXES: Record<string, string> = { x: "x axis", y: "y axis", z: "z axis", magnitude: "overall strength" };
const QUAT: Record<string, string> = { w: "w", x: "x", y: "y", z: "z" };

/**
 * Describes one input of a model by its name. `spikeMethod` is the Spike extraction method in use, named in the
 * description of the spike inputs, which depend on it. Unknown names are described as themselves.
 */
export function describeInput(name: string, spikeMethod?: string): InputInfo {
  const part = name.split("_");
  const spikeNote = spikeMethod ? ` (spikes pulled out with: ${spikeMethod})` : "";

  // A pulse statistic, or a spike input, or (for a convolutional model) the pulse channel itself.
  if (part[0] === "ppg" && LIGHTS[part[1]]) {
    const light = LIGHTS[part[1]];
    const group = part[1] === "ir" ? "Infrared" : part[1] === "red" ? "Red" : "Green";
    const rest = part.slice(2).join("_");
    if (rest === "") return { name, stream: "watchPpg", group, short: "signal", text: `The ${light} signal over the window, as a row of evenly spaced points.` };
    if (STATS[rest]) return { name, stream: "watchPpg", group, short: STATS[rest].short, text: STATS[rest].text(`the ${light} signal`) };
    if (BASELINE_STATS[rest]) return { name, stream: "watchPpg", group, short: BASELINE_STATS[rest].short, text: BASELINE_STATS[rest].text(`${light} signal`) };
    if (SPIKE_STATS[rest]) return { name, stream: "watchPpg", group, short: SPIKE_STATS[rest].short, text: SPIKE_STATS[rest].text(`${light} signal`) + spikeNote };
  }
  if (part[0] === "accel" || part[0] === "gyro") {
    const stream: InputStream = part[0] === "accel" ? "watchAcceleration" : "watchGyroscope";
    const what = part[0] === "accel" ? "acceleration" : "turning speed";
    const axis = AXES[part[1]];
    if (axis) {
      const rest = part.slice(2).join("_");
      const group = part[1] === "magnitude" ? "Overall strength" : part[1].toUpperCase();
      if (rest === "") return { name, stream, group, short: "signal", text: `The ${what} on the ${axis} over the window, as a row of evenly spaced points.` };
      if (STATS[rest]) return { name, stream, group, short: STATS[rest].short, text: STATS[rest].text(`the ${what}${part[1] === "magnitude" ? " (its overall strength)" : ` on the ${axis}`}`) };
    }
  }
  if (part[0] === "quat" && QUAT[part[1]]) {
    const rest = part.slice(2).join("_");
    const group = part[1].toUpperCase();
    if (rest === "") return { name, stream: "watchOrientation", group, short: "signal", text: `The ${QUAT[part[1]]} number of the watch's orientation over the window, as a row of evenly spaced points.` };
    if (STATS[rest]) return { name, stream: "watchOrientation", group, short: STATS[rest].short, text: STATS[rest].text(`the ${QUAT[part[1]]} number of the orientation`) };
  }
  if (name === "quat_delta_angle_deg") return { name, stream: "watchOrientation", group: "Turn", short: "turn", text: "The angle, in degrees, between the watch's orientation at the start and at the end of the window." };
  if (name === "contact_quality_mean") return { name, stream: "watchPpg", group: "Window", short: "contact quality", text: "The average contact quality the watch reported for the pulse sensor in the window (0 is best)." };
  if (name === "sample_count") return { name, stream: "watchPpg", group: "Window", short: "sample count", text: "How many samples the window held." };
  if (name === "duration_ms") return { name, stream: "watchPpg", group: "Window", short: "duration", text: "The time from the first to the last pulse sample in the window, in milliseconds." };
  return { name, stream: "watchPpg", group: "Other", short: name, text: name };
}

/** The inputs grouped for display: by stream (in a fixed order), then by group (in the order they first appear). */
export function groupInputs(names: string[], spikeMethod?: string): { stream: InputStream; groups: { group: string; inputs: InputInfo[] }[] }[] {
  const byStream = new Map<InputStream, Map<string, InputInfo[]>>();
  for (const name of names) {
    const info = describeInput(name, spikeMethod);
    const groups = byStream.get(info.stream) ?? new Map<string, InputInfo[]>();
    groups.set(info.group, [...(groups.get(info.group) ?? []), info]);
    byStream.set(info.stream, groups);
  }
  return STREAM_ORDER.filter((stream) => byStream.has(stream)).map((stream) => ({
    stream,
    groups: [...(byStream.get(stream) ?? new Map()).entries()].map(([group, inputs]) => ({ group, inputs })),
  }));
}

const SHORT_STREAM: Record<InputStream, string> = { watchAcceleration: "Accel", watchGyroscope: "Gyro", watchOrientation: "Orient.", watchPpg: "Pulse" };

/** A short label that tells inputs apart anywhere (a chart axis, a list): "Accel X spread", "Pulse Green signal". */
export function inputLabel(name: string): string {
  const info = describeInput(name);
  return `${SHORT_STREAM[info.stream]} ${info.group} ${info.short}`;
}

const COLUMN_MEANING: Record<string, string> = {
  ppg_green: "the green light of the pulse sensor", ppg_red: "the red light of the pulse sensor", ppg_ir: "the infrared light of the pulse sensor",
  accel_x: "the acceleration on the x axis", accel_y: "the acceleration on the y axis", accel_z: "the acceleration on the z axis",
  gyro_x: "the turning speed about the x axis", gyro_y: "the turning speed about the y axis", gyro_z: "the turning speed about the z axis",
  quat_w: "the w number of the watch's orientation", quat_x: "the x number of the watch's orientation", quat_y: "the y number of the watch's orientation", quat_z: "the z number of the watch's orientation",
};

/** What a raw column feeds the network: its latest reading, or its readings across the window, one neuron for each. */
export function describeColumn(name: string, steps: number): string {
  const meaning = COLUMN_MEANING[name] ?? name;
  return steps === 1
    ? `The latest reading of ${meaning} in the window (one input neuron).`
    : `${meaning[0].toUpperCase()}${meaning.slice(1)} across the window, laid onto ${steps} evenly spaced readings: ${steps} input neurons, one for each.`;
}
