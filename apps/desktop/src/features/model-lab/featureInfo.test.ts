import { describe, expect, it } from "vitest";
import { describeInput, groupInputs } from "./featureInfo";

describe("describeInput", () => {
  it("says what each kind of input is, and where it comes from", () => {
    expect(describeInput("accel_x_std")).toMatchObject({ stream: "watchAcceleration", group: "X", short: "spread" });
    expect(describeInput("accel_magnitude_mean")).toMatchObject({ group: "Overall strength", short: "mean" });
    expect(describeInput("gyro_z_max").text).toMatch(/highest value of the turning speed on the z axis/);
    expect(describeInput("quat_w_mean")).toMatchObject({ stream: "watchOrientation", group: "W" });
    expect(describeInput("quat_delta_angle_deg").text).toMatch(/angle, in degrees/);
    expect(describeInput("ppg_ir_slope")).toMatchObject({ stream: "watchPpg", group: "Infrared", short: "slope" });
    expect(describeInput("contact_quality_mean")).toMatchObject({ stream: "watchPpg", group: "Window" });
    expect(describeInput("sample_count").short).toBe("sample count");
  });

  it("names the spike method in the description of a spike input, and describes a channel for the convolutional method", () => {
    const spike = describeInput("ppg_green_spike_z", "Morphological top-hat");
    expect(spike.text).toMatch(/robust standard deviations/);
    expect(spike.text).toMatch(/Morphological top-hat/);
    expect(describeInput("ppg_green_spike_z").text).not.toMatch(/spikes pulled out with/);
    expect(describeInput("ppg_red")).toMatchObject({ group: "Red", short: "signal" });
    expect(describeInput("accel_y").text).toMatch(/row of evenly spaced points/);
    expect(describeInput("quat_x")).toMatchObject({ stream: "watchOrientation", short: "signal" });
  });

  it("describes an unknown name as itself", () => {
    expect(describeInput("something_else")).toMatchObject({ group: "Other", short: "something_else" });
  });
});

describe("groupInputs", () => {
  it("groups by stream in a fixed order, then by group in the order they appear", () => {
    const grouped = groupInputs(["ppg_green_mean", "gyro_x_std", "accel_y_mean", "accel_x_mean", "accel_x_std", "sample_count"]);
    expect(grouped.map((g) => g.stream)).toEqual(["watchAcceleration", "watchGyroscope", "watchPpg"]);
    expect(grouped[0].groups.map((g) => g.group)).toEqual(["Y", "X"]);
    expect(grouped[0].groups[1].inputs.map((i) => i.name)).toEqual(["accel_x_mean", "accel_x_std"]);
    expect(grouped[2].groups.map((g) => g.group)).toEqual(["Green", "Window"]);
  });
});

describe("the level against the recent past", () => {
  it("describes the two inputs in words", () => {
    const low = describeInput("ppg_red_rel_low");
    expect(low).toMatchObject({ stream: "watchPpg", group: "Red", short: "above its resting level" });
    expect(low.text).toMatch(/low end \(10th percentile\)/);
    expect(describeInput("ppg_ir_rel_high")).toMatchObject({ group: "Infrared", short: "above its highest level" });
  });
});
