import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RawImageLabelRangeRail } from "./RawImageLabelRangeRail";
import type { VisibleLabelRange } from "../annotations/visibleLabelRanges";

afterEach(() => cleanup());

describe("RawImageLabelRangeRail", () => {
  it("shows the quiet empty state for no ranges", () => {
    render(<RawImageLabelRangeRail ranges={[]} />);
    expect(screen.getByRole("note", { name: "Saved label ranges" })).toHaveTextContent(
      "No saved label ranges in this frame.",
    );
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("renders one label for a merged range", () => {
    const ranges: VisibleLabelRange[] = [
      { labelId: "pinching", startRawRow: 128, endRawRow: 256, startFraction: 0.25, endFraction: 0.5 },
    ];
    render(<RawImageLabelRangeRail ranges={ranges} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAccessibleName("pinching, rows 128–255");
  });

  it("renders multiple labels for distinct visible ranges without duplicating any", () => {
    const ranges: VisibleLabelRange[] = [
      { labelId: "pinching", startRawRow: 0, endRawRow: 64, startFraction: 0, endFraction: 0.25 },
      { labelId: "waving", startRawRow: 128, endRawRow: 192, startFraction: 0.5, endFraction: 0.75 },
    ];
    render(<RawImageLabelRangeRail ranges={ranges} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAccessibleName("pinching, rows 0–63");
    expect(items[1]).toHaveAccessibleName("waving, rows 128–191");
  });

  it("positions a range using its start/end fraction", () => {
    const ranges: VisibleLabelRange[] = [
      { labelId: "pinching", startRawRow: 16, endRawRow: 32, startFraction: 0.25, endFraction: 0.5 },
    ];
    render(<RawImageLabelRangeRail ranges={ranges} />);
    const item = screen.getByRole("listitem");
    expect(item.style.top).toBe("25%");
    expect(item.style.height).toBe("25%");
  });

  it("spans the full canvas width edge-to-edge", () => {
    const ranges: VisibleLabelRange[] = [
      { labelId: "pinching", startRawRow: 16, endRawRow: 32, startFraction: 0.25, endFraction: 0.5 },
    ];
    render(<RawImageLabelRangeRail ranges={ranges} />);
    expect(screen.getByRole("list", { name: "Saved label ranges" })).toHaveClass("w-full");
    const item = screen.getByRole("listitem");
    expect(item).toHaveClass("left-0", "right-0");
  });
});
