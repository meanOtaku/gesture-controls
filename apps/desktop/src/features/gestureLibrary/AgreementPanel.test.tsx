import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgreementPanel } from "./AgreementPanel";
import { AgreementTracker } from "./agreement";
import { blankDefinition, type GestureDefinition } from "./definition";
import type { LabelRuntimeStatus } from "../model-lab/labelModels";

const pinch: GestureDefinition = { ...blankDefinition(), id: "g1", name: "Pinch", labelId: "pinch" };
const status = (over: Partial<LabelRuntimeStatus> = {}): LabelRuntimeStatus => ({
  mode: "monitor", loadedLabels: ["pinch"], loadFailures: [], quarantined: [], registryError: null, activeDetections: [], lastScores: {}, ...over,
});
afterEach(() => cleanup());

describe("AgreementPanel", () => {
  it("shows the counts for a gesture whose label has a loaded model", () => {
    const tracker = new AgreementTracker();
    const long = performance.now() - 10_000;
    tracker.setHandInView(long - 1000, true);
    tracker.cameraOnset("pinch", long);
    tracker.modelDetected("pinch", long + 400);
    render(<AgreementPanel tracker={tracker} definitions={[pinch]} status={status()} cameraOn />);
    const row = screen.getByRole("row", { name: /Pinch/ });
    expect(row.textContent).toBe("Pinch11000400 ms");
  });

  it("says what is missing instead of showing an empty table", () => {
    render(<AgreementPanel tracker={new AgreementTracker()} definitions={[pinch]} status={status({ mode: "off" })} cameraOn={false} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Turn the camera on.*Monitor/);
    cleanup();
    render(<AgreementPanel tracker={new AgreementTracker()} definitions={[pinch]} status={status({ loadedLabels: [] })} cameraOn />);
    expect(screen.getByRole("status").textContent).toMatch(/linked to a label that has an active model/);
  });
});
