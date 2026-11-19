import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { READINESS_MOTION_CHOICES, SteadyStartsSection } from "./SteadyStartsSection";
import { DEFAULT_SETTINGS } from "../settingsFields";

afterEach(cleanup);

function setup(readinessMotion = DEFAULT_SETTINGS.readinessMotion) {
  const onReadinessMotionChange = vi.fn();
  render(
    <SteadyStartsSection
      enabled={false}
      onToggle={() => {}}
      buzzWhenReady={false}
      onToggleBuzz={() => {}}
      readinessMotion={readinessMotion}
      onReadinessMotionChange={onReadinessMotionChange}
    />,
  );
  return onReadinessMotionChange;
}

describe("the wrist-moving warning choice", () => {
  it("defaults to warning on any fast turn, the behaviour before the setting existed", () => {
    expect(DEFAULT_SETTINGS.readinessMotion).toBe("anyFastTurn");
    expect(READINESS_MOTION_CHOICES[0].value).toBe("anyFastTurn");
    setup();
    expect(screen.getByRole("combobox", { name: "Warn that the wrist is moving" })).toHaveTextContent("Any fast turn");
    expect(screen.getByText(/a finger snap included/)).toBeInTheDocument();
  });

  it("offers ignoring snaps, or never warning, from a dropdown", async () => {
    const onChange = setup();
    fireEvent.click(screen.getByRole("combobox", { name: "Warn that the wrist is moving" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Any fast turn", "Ignore snaps and taps", "Never"]);
    fireEvent.click(screen.getByRole("option", { name: "Ignore snaps and taps" }));
    expect(onChange).toHaveBeenCalledWith("ignoreShortJolts");
  });

  it("explains the chosen option and that detection does not change", () => {
    setup("ignoreShortJolts");
    expect(screen.getByRole("combobox", { name: "Warn that the wrist is moving" })).toHaveTextContent("Ignore snaps and taps");
    expect(screen.getByText(/longer than 0.4 s/)).toHaveTextContent("Detection itself is the same whatever you choose.");
  });
});
