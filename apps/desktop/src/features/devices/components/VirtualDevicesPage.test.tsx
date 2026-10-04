import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationState } from "../../../shared/protocol/events";
import { VirtualDevicesPage } from "./VirtualDevicesPage";

afterEach(cleanup);

const automation: AutomationState = {
  recipes: [
    {
      id: "a", name: "Pinch volume", enabled: true, action: "volume",
      stages: [{ kind: "hold", hold: "pinch" }, { kind: "drive", axis: "roll", deadZoneDegrees: 3, invert: false }],
      device: { kind: "stepKnob", degreesPerStep: 15, fractionPerStep: 0.05 },
    },
  ],
  blocked: [],
  conflicts: [],
};

describe("VirtualDevicesPage", () => {
  it("lists the four devices and says which recipes use each", () => {
    render(<VirtualDevicesPage automation={automation} onMakeRecipe={() => {}} />);
    for (const name of ["Rotation knob", "Horizontal fader", "Vertical fader", "Step knob"]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
    expect(within(screen.getByRole("region", { name: "Step knob" })).getByText("Used by Pinch volume.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Rotation knob" })).getByText("No recipe uses it yet.")).toBeInTheDocument();
  });

  it("shows what a wrist rotation would change on each device", () => {
    render(<VirtualDevicesPage automation={null} onMakeRecipe={() => {}} />);
    const read = (name: string) => within(screen.getByRole("region", { name })).getByText(/^[+-]?[\d.]+ pts$/).textContent;
    expect(read("Rotation knob")).toBe("0 pts");

    fireEvent.change(screen.getByLabelText("Wrist rotation"), { target: { value: "30" } });
    expect(read("Rotation knob")).toBe("+10 pts"); // a third of a point per degree
    expect(read("Horizontal fader")).toBe("+33.3 pts"); // 30 of 45 degrees of travel, across a 50 point range
    expect(read("Step knob")).toBe("+10 pts"); // two whole 15 degree steps of 5 pts

    fireEvent.change(screen.getByLabelText("Wrist rotation"), { target: { value: "-120" } });
    expect(read("Horizontal fader")).toBe("-50 pts"); // stops at its end
    expect(read("Rotation knob")).toBe("-40 pts"); // no end stop
  });

  it("starts a recipe with the chosen device", () => {
    const onMakeRecipe = vi.fn();
    render(<VirtualDevicesPage automation={null} onMakeRecipe={onMakeRecipe} />);
    fireEvent.click(within(screen.getByRole("region", { name: "Vertical fader" })).getByRole("button", { name: "Make a recipe with this" }));
    expect(onMakeRecipe).toHaveBeenCalledWith("verticalFader");
  });
});
