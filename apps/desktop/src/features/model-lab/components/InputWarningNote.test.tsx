import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { InputWarning } from "../labelModels";
import { InputWarningNote, inputTitle } from "./InputWarningNote";

afterEach(cleanup);

const warning: InputWarning = {
  label: "pinch", modelId: "pinch-abc", unfamiliarShare: 0.93,
  worst: [
    { name: "ppg_z1000ms_d1_green_n8_mean", value: 4932, low: 95336, high: 213912 },
    { name: "ppg_z4000ms_d3_ir_n32_std", value: 3.1, low: 0.02, high: 0.4 },
  ],
};

describe("InputWarningNote", () => {
  it("says which model, how much of the time, which inputs and by how much, and what usually causes it", () => {
    render(<InputWarningNote warning={warning} />);
    const note = screen.getByRole("alert", { name: "Inputs outside training for pinch-abc" });
    expect(note).toHaveTextContent("pinch-abc is seeing values it was never trained on");
    expect(note).toHaveTextContent("about 93% of the last few seconds");
    const list = within(note).getByRole("list", { name: "Inputs furthest outside" });
    expect(list).toHaveTextContent("Pulse sensor · green slope against the last 1 s: mean over 0.32 s is 4,932; in training it was 95,336 to 213,912.");
    expect(list).toHaveTextContent("is 3.10; in training it was 0.0200 to 0.400");
    expect(note).toHaveTextContent("train on recordings made the way you wear it now");
  });

  it("names an input the way the rest of the app does", () => {
    expect(inputTitle("ppg_z2000ms_d2_red_n16_q90")).toBe("Pulse sensor · red curvature against the last 2 s: 90th percentile over 0.64 s");
  });
});
