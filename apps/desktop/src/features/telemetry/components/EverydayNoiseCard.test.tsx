import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { guidedRunner } from "../recording/guidedRunner";
import { NOISE_ACTIVITIES } from "../recording/guidedSession";
import { telemetryStore } from "../store/telemetryStore";
import { EverydayNoiseCard } from "./EverydayNoiseCard";

beforeEach(() => {
  localStorage.clear();
  telemetryStore.reset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("EverydayNoiseCard", () => {
  it("records only everyday activity and stillness, under the standard labels, with no gesture cued", () => {
    render(<EverydayNoiseCard recording={false} watchConnected onStop={() => undefined} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(NOISE_ACTIVITIES.length);
    // The first activity is the hand at rest, the rest everyday noise unless they say otherwise.
    expect(screen.getByLabelText("Label of noise activity 1")).toHaveValue("still");
    expect(screen.getByLabelText("Label of noise activity 2")).toHaveValue("everyday_noise");
    expect(screen.getByText("About 9 min 37 s.")).toBeInTheDocument();
    const start = vi.spyOn(guidedRunner, "start").mockReturnValue(true);
    fireEvent.change(screen.getByLabelText("Label of noise activity 2"), { target: { value: "still" } });
    fireEvent.click(screen.getByRole("button", { name: "Start everyday noise session" }));
    const plan = start.mock.calls[0][0];
    expect(plan).toMatchObject({ label: "", cues: 0, everydayLabel: "everyday_noise" });
    expect(plan.activities[1]).toMatchObject({ activity: NOISE_ACTIVITIES[1].activity, label: "still" });
    expect(start.mock.calls[0][2]).toBe("noise");
  });

  it("waits for the watch", () => {
    render(<EverydayNoiseCard recording={false} watchConnected={false} onStop={() => undefined} />);
    expect(screen.getByText("Connect the watch (Watch page) first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start everyday noise session" })).toBeDisabled();
  });
});
