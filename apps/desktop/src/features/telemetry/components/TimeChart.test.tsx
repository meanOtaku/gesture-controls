import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { chartGeometry, TimeChart } from "./TimeChart";

afterEach(cleanup);

describe("sensor charts", () => {
  it("keeps equal values aligned across channels with different amplitudes", () => {
    const result = chartGeometry([{ at: 0, values: [0, 50] }, { at: 1000, values: [50, 100] }], 2);
    const firstChannelEndY = result.paths[0].split("L")[1].split(",")[1];
    const secondChannelStartY = result.paths[1].split(" ")[0].split(",")[1];
    expect(firstChannelEndY).toBe(secondChannelStartY);
    expect(result.duration).toBe(1000);
  });

  it("centers flat signals and breaks lines around invalid samples", () => {
    const result = chartGeometry([{ at: 0, values: [5] }, { at: 500, values: [NaN] }, { at: 1000, values: [5] }], 1);
    expect(result.paths[0]).not.toMatch(/NaN|Infinity|L/);
    expect(result.paths[0].match(/M/g)).toHaveLength(2);
    expect(result.paths[0]).toContain(",90.0");
  });

  it("explains an empty stream without fabricating a signal", () => {
    render(<TimeChart title="Head tracking" points={[]} labels={["Yaw"]} colors={["cyan"]} />);
    expect(screen.getByText("Waiting for samples")).toBeInTheDocument();
    expect(screen.getByText("No samples received")).toBeInTheDocument();
  });
});
