import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MissSaved } from "./missApi";
import { MissDetailsDrawer, showMissDetails } from "./MissMarker";

afterEach(cleanup);

const saved: MissSaved = {
  datasetId: "d1", name: "Miss: did not fire, 13 Nov 07:20:00", kind: "missed",
  summary: {
    motion: { samples: 4500, seconds: 45, gaps: 1, longestGapMs: 910 },
    pulse: { samples: 1125, seconds: 45, gaps: 0, longestGapMs: 0 },
    labels: [{ label: "pinch_in", activation: 0.99, scores: 900, peak: 0.97, peakMsBeforeMark: 2000, detected: 0, acted: 0, rejections: { NoMovement: 2 } }],
    lines: ["pinch_in: never detected. Its highest score was 0.97, 2.0 s before the mark (it starts at 0.99)."],
  },
};

describe("MissDetailsDrawer", () => {
  it("is closed until a miss is shown, then says what each model did, the gaps and the camera", () => {
    render(<MissDetailsDrawer />);
    expect(screen.queryByText(saved.name)).not.toBeInTheDocument();
    act(() => showMissDetails({ saved, camera: "off" }));
    expect(screen.getByText(saved.name)).toBeInTheDocument();
    expect(screen.getByText(/The camera was off/)).toBeInTheDocument();
    const row = within(screen.getByRole("row", { name: /pinch_in/ }));
    expect(row.getByText("0.99")).toBeInTheDocument();
    expect(row.getByText("0.97")).toBeInTheDocument();
    expect(row.getByText("2.0 s")).toBeInTheDocument();
    expect(row.getByText("NoMovement ×2")).toBeInTheDocument();
    expect(screen.getByText(/motion 45 s with 1 gap \(longest 910 ms\); pulse 45 s with 0 gaps/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open in Labelling" })).toBeInTheDocument();
    act(() => showMissDetails(null));
    expect(screen.queryByRole("button", { name: "Open in Labelling" })).not.toBeInTheDocument();
  });
});
