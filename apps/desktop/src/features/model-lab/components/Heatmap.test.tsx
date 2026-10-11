import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { divergingColor, foldGrid, maxAbs, minMax, normaliseRows, sequentialColor } from "../inspection";
import { Heatmap } from "./Heatmap";

afterEach(cleanup);

describe("Heatmap", () => {
  it("draws a cell per value, says the range, and names each cell for hover", () => {
    const { container } = render(<Heatmap title="Layer 1 weights" matrix={[[1, -2], [0, 0.5]]} rowLabels={["a", "b"]} colLabels={["x", "y"]} />);
    expect(container.querySelectorAll("rect")).toHaveLength(4);
    expect(screen.getByRole("img", { name: /Layer 1 weights: 2 by 2, from -2\.00 to 2\.00/ })).toBeInTheDocument();
    expect(container.querySelector("title")?.textContent).toBe("a, x: 1.00");
    expect(screen.getByText(/2 × 2/)).toBeInTheDocument();
  });

  it("says so instead of drawing an empty matrix", () => {
    render(<Heatmap title="Nothing" matrix={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Nothing: nothing to show.");
  });
});

describe("inspection helpers", () => {
  it("colours blue below zero, white at zero, red above, and holds at the limit", () => {
    expect(divergingColor(0, 1)).toBe("rgb(255,255,255)");
    expect(divergingColor(1, 1)).toBe("rgb(215,48,39)");
    expect(divergingColor(-1, 1)).toBe("rgb(44,123,182)");
    expect(divergingColor(5, 1)).toBe(divergingColor(1, 1));
    expect(divergingColor(NaN, 1)).toBe("rgb(255,255,255)");
    expect(sequentialColor(0, 0, 1)).toBe("rgb(255,255,255)");
    expect(sequentialColor(1, 0, 1)).toBe("rgb(42,157,143)");
  });

  it("measures, folds and normalises matrices", () => {
    expect(maxAbs([[1, -3], [2, 0]])).toBe(3);
    expect(minMax([[1, -3], [2, 0]])).toEqual([-3, 2]);
    expect(foldGrid([1, 2, 3, 4, 5, 6], 3)).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(normaliseRows([[10, 20, 30], [5, 5, 5]])).toEqual([[0, 0.5, 1], [0, 0, 0]]);
  });
});
