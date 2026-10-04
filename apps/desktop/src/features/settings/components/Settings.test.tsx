import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Settings } from "./Settings";
import type { AppSettings } from "../../../shared/protocol/events";

afterEach(cleanup);

const settings: AppSettings = {
  headphonesEnabled: true,
  headphonesRateHz: 60,
  recordingRateHz: 30,
  graphRefreshRateHz: 15,
  watchOrientationRateHz: 50,
  watchAccelerationRateHz: 50,
  watchGyroscopeRateHz: 50,
  watchPpgFlushRateHz: 1,
  watchHeartRateAcceptanceRateHz: 200,
  watchSkinTemperatureAcceptanceRateHz: 200,
  watchEdaAcceptanceRateHz: 200,
  shakePeakThreshold: 6,
  shakeStrokes: 4,
  swipePeakThreshold: 8,
  tapPeakThreshold: 12,
  rotateAngleDegrees: 60,
  watchWrist: "left",
  wristMaxAngularVelocityDegreesPerSecond: 360,
  wristMaxVolumePointsPerSecond: 30,
  watchSensorsEnabled: { orientation: true, acceleration: true, gyroscope: true },
  watchTransport: "bluetooth",
};

describe("Settings", () => {
  it("renders every numeric control with its current value, unit and allowed range", () => {
    render(<Settings settings={settings} onUpdate={() => {}} onReset={() => {}} />);
    expect(screen.getByLabelText("Headphones rate")).toHaveValue(60);
    expect(screen.getByLabelText("Max angular velocity")).toHaveValue(360);
    expect(screen.getByLabelText("Raw PPG flush")).toHaveValue(1);
    // The range and default are stated up front, not discovered by failing.
    expect(screen.getByLabelText("Headphones rate")).toHaveAccessibleDescription(/Allowed: 1–200 Hz.*default 60 Hz/);
  });

  it("shows the settings error near the affected controls", () => {
    render(<Settings settings={settings} error="Settings write failed" onUpdate={() => {}} onReset={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Settings write failed");
  });

  it("starts with nothing to apply, and says so", () => {
    render(<Settings settings={settings} onUpdate={() => {}} onReset={() => {}} />);
    expect(screen.getByRole("button", { name: "Apply changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeDisabled();
    expect(screen.getByText("All changes are applied.")).toBeInTheDocument();
  });

  it("applies every edited value together", () => {
    const updates: AppSettings[] = [];
    render(<Settings settings={settings} onUpdate={(next) => updates.push(next)} onReset={() => {}} />);

    fireEvent.change(screen.getByLabelText("Headphones rate"), { target: { value: "90" } });
    fireEvent.change(screen.getByLabelText("Max angular velocity"), { target: { value: "500" } });
    expect(screen.getByText("2 changes not applied yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));

    expect(updates).toHaveLength(1);
    expect(updates[0].headphonesRateHz).toBe(90);
    expect(updates[0].wristMaxAngularVelocityDegreesPerSecond).toBe(500);
    // A field nobody touched keeps its exact saved value, not the rounded text shown for it.
    expect(updates[0].wristMaxVolumePointsPerSecond).toBe(30);
  });

  it("refuses an out-of-range value, says why, and applies nothing", () => {
    const updates: AppSettings[] = [];
    render(<Settings settings={settings} onUpdate={(next) => updates.push(next)} onReset={() => {}} />);

    fireEvent.change(screen.getByLabelText("Headphones rate"), { target: { value: "999" } });
    fireEvent.change(screen.getByLabelText("Max angular velocity"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));

    expect(updates).toHaveLength(0); // the old behaviour silently applied 60 for the bad field
    const input = screen.getByLabelText("Headphones rate");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Too high: the maximum is 200 Hz.");
    expect(screen.getByText("1 field needs attention before it can be applied.")).toBeInTheDocument();
    // What was typed is kept, so it can be corrected rather than retyped.
    expect(input).toHaveValue(999);
    // The valid edit beside it is not lost.
    expect(screen.getByLabelText("Max angular velocity")).toHaveValue(500);
  });

  it("moves focus to the first invalid field when applying fails", () => {
    render(<Settings settings={settings} onUpdate={() => {}} onReset={() => {}} />);
    fireEvent.change(screen.getByLabelText("Headphones rate"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(screen.getByLabelText("Headphones rate")).toHaveFocus();
  });

  it("holds back an error until the field is left, so typing is not scolded mid-word", () => {
    render(<Settings settings={settings} onUpdate={() => {}} onReset={() => {}} />);
    const input = screen.getByLabelText("Headphones rate");
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveAttribute("aria-invalid", "false");
    fireEvent.blur(input);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Enter a value.");
  });

  it("submits from the keyboard: Enter in a field applies, like the button", () => {
    const updates: AppSettings[] = [];
    render(<Settings settings={settings} onUpdate={(next) => updates.push(next)} onReset={() => {}} />);
    fireEvent.change(screen.getByLabelText("Recording rate"), { target: { value: "45" } });
    fireEvent.submit(screen.getByRole("form", { name: "Settings" }));
    expect(updates[0].recordingRateHz).toBe(45);
  });

  it("discards edits and their errors", () => {
    render(<Settings settings={settings} onUpdate={() => {}} onReset={() => {}} />);
    fireEvent.change(screen.getByLabelText("Headphones rate"), { target: { value: "999" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByLabelText("Headphones rate")).toHaveValue(60);
    expect(screen.getByLabelText("Headphones rate")).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByText("All changes are applied.")).toBeInTheDocument();
  });

  it("marks an edited field, and resets a field to its default as a pending edit", () => {
    render(<Settings settings={{ ...settings, headphonesRateHz: 120 }} onUpdate={() => {}} onReset={() => {}} />);
    expect(screen.queryByText("Edited")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset Headphones rate to its default, 60 Hz" }));
    expect(screen.getByLabelText("Headphones rate")).toHaveValue(60);
    expect(screen.getByText("Edited")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply changes" })).toBeEnabled();
  });

  it("keeps a half-typed value when a switch elsewhere changes the saved settings", () => {
    const { rerender } = render(<Settings settings={settings} onUpdate={() => {}} onReset={() => {}} />);
    fireEvent.change(screen.getByLabelText("Headphones rate"), { target: { value: "75" } });
    rerender(
      <Settings
        settings={{ ...settings, watchSensorsEnabled: { ...settings.watchSensorsEnabled, orientation: false } }}
        onUpdate={() => {}}
        onReset={() => {}}
      />,
    );
    expect(screen.getByLabelText("Headphones rate")).toHaveValue(75);
  });

  it("shows the shake sensitivity with its range, applies a change, and counts recognised shakes", () => {
    const updates: AppSettings[] = [];
    const { rerender } = render(<Settings settings={settings} onUpdate={(next) => updates.push(next)} onReset={() => {}} />);
    expect(screen.getByLabelText("Shake strength")).toHaveValue(6);
    expect(screen.getByLabelText("Shake strokes")).toHaveValue(4);
    expect(screen.getByLabelText("Shake strength")).toHaveAccessibleDescription(/Allowed: 2–30 m\/s²/);

    fireEvent.change(screen.getByLabelText("Shake strength"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Shake strokes"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(updates[0]).toMatchObject({ shakePeakThreshold: 4, shakeStrokes: 3 });

    // Strokes are whole numbers within 3 to 10; the box says so instead of repairing the value.
    fireEvent.change(screen.getByLabelText("Shake strokes"), { target: { value: "2" } });
    fireEvent.blur(screen.getByLabelText("Shake strokes"));
    expect(screen.getByLabelText("Shake strokes")).toHaveAttribute("aria-invalid", "true");

    expect(screen.getByText(/Shakes recognised since you opened the app/)).toHaveTextContent("0");
    rerender(<Settings settings={settings} shakeDetections={3} onUpdate={() => {}} onReset={() => {}} />);
    expect(screen.getByText(/Shakes recognised since you opened the app/)).toHaveTextContent(": 3");
  });

  it("sets which wrist the watch is on, tunes swipe strength, and shows the last swipe", () => {
    const updates: AppSettings[] = [];
    const { rerender } = render(<Settings settings={settings} onUpdate={(next) => updates.push(next)} onReset={() => {}} />);
    expect(screen.getByLabelText("Swipe strength")).toHaveValue(8);
    expect(screen.getByText(/No swipe recognised yet/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /Right wrist/ }));
    expect(updates).toEqual([{ ...settings, watchWrist: "right" }]);

    fireEvent.change(screen.getByLabelText("Swipe strength"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(updates[1]).toMatchObject({ swipePeakThreshold: 5 });

    rerender(<Settings settings={settings} lastSwipe={{ direction: "left", count: 2 }} onUpdate={() => {}} onReset={() => {}} />);
    expect(screen.getByText(/Last swipe recognised/)).toHaveTextContent("left");
    expect(screen.getByText(/Last swipe recognised/)).toHaveTextContent("2 so far");
  });

  it("tunes tap strength and shows the last tap", () => {
    const updates: AppSettings[] = [];
    const { rerender } = render(<Settings settings={settings} onUpdate={(next) => updates.push(next)} onReset={() => {}} />);
    expect(screen.getByLabelText("Tap strength")).toHaveValue(12);
    expect(screen.getByText(/No tap recognised yet/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Tap strength"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(updates[0]).toMatchObject({ tapPeakThreshold: 9 });
    rerender(<Settings settings={settings} lastTap={{ kind: "double", count: 4 }} onUpdate={() => {}} onReset={() => {}} />);
    expect(screen.getByText(/Last tap recognised/)).toHaveTextContent("double tap (4 so far)");
  });

  it("tunes the rotate angle, refuses a fraction, and shows the last rotate", () => {
    const updates: AppSettings[] = [];
    const { rerender } = render(<Settings settings={settings} onUpdate={(next) => updates.push(next)} onReset={() => {}} />);
    expect(screen.getByLabelText("Rotate angle")).toHaveValue(60);
    expect(screen.getByText(/No rotate recognised yet/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Rotate angle"), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(updates[0]).toMatchObject({ rotateAngleDegrees: 45 });
    fireEvent.change(screen.getByLabelText("Rotate angle"), { target: { value: "20" } });
    fireEvent.blur(screen.getByLabelText("Rotate angle"));
    expect(screen.getByLabelText("Rotate angle")).toHaveAttribute("aria-invalid", "true");
    rerender(<Settings settings={settings} lastRotate={{ direction: "counterClockwise", count: 3 }} onUpdate={() => {}} onReset={() => {}} />);
    expect(screen.getByText(/Last rotate recognised/)).toHaveTextContent("counter-clockwise (3 so far)");
  });

  it("toggles a watch sensor switch immediately without a confirmation dialog", () => {
    const updates: AppSettings[] = [];
    render(<Settings settings={settings} onUpdate={(next) => updates.push(next)} onReset={() => {}} />);
    fireEvent.click(screen.getByRole("switch", { name: /Orientation \(rotation vector\) enabled by default/ }));
    expect(updates).toEqual([{ ...settings, watchSensorsEnabled: { ...settings.watchSensorsEnabled, orientation: false } }]);
  });

  it("requires confirmation before resetting to defaults, and does nothing on cancel", () => {
    let resetCount = 0;
    render(<Settings settings={settings} onUpdate={() => {}} onReset={() => resetCount++} />);

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(screen.getByText("Reset all settings to defaults?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep current settings" }));
    expect(resetCount).toBe(0);
  });

  it("resets to defaults only after the destructive action is confirmed", async () => {
    let resetCount = 0;
    render(<Settings settings={settings} onUpdate={() => {}} onReset={() => resetCount++} />);

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    const confirmButtons = await screen.findAllByRole("button", { name: "Reset to defaults" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    expect(resetCount).toBe(1);
  });

  it("explains the difference between recording and graph refresh rate via help", async () => {
    render(<Settings settings={settings} onUpdate={() => {}} onReset={() => {}} />);
    fireEvent.focus(screen.getByRole("button", { name: "About recording and graph rates" }));
    expect(await screen.findByText(/does not affect what gets saved/i)).toBeInTheDocument();
  });

  it("shows pending feedback and disables both apply and reset while either is in flight", () => {
    render(
      <Settings
        settings={settings}
        isPending={(key) => key === "settings:apply"}
        onUpdate={() => {}}
        onReset={() => {}}
      />,
    );
    const applyButton = screen.getByRole("button", { name: "Applying…" });
    expect(applyButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset to defaults" })).toBeDisabled();
  });
});
