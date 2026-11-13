import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../components/ui/tooltip";
import type { AutomationState } from "../../../shared/protocol/events";
import { RecipesCard } from "./RecipesCard";

const automation = {
  recipes: [{
    id: "safariVolume", name: "Volume in Safari", enabled: true, action: "volume", apps: ["Safari"],
    stages: [{ kind: "hold", hold: "doubleTap" }, { kind: "drive", axis: "roll", deadZoneDegrees: 3, invert: false }],
    device: { kind: "rotationKnob", fractionPerDegree: 0.01 },
  }],
  blocked: [], conflicts: [], unavailable: [], loadedLabels: [], unavailableCameras: [], cameraArmed: false,
} as unknown as AutomationState;

describe("RecipesCard", () => {
  it("says where a recipe works and that nothing has been used yet", () => {
    render(<TooltipProvider><RecipesCard automation={automation} calibration={null} isPending={() => false} onSetRecipeEnabled={vi.fn()} /></TooltipProvider>);
    expect(screen.getByText("Double-tap watch → Roll wrist → rotation knob → Volume (only in Safari)")).toBeInTheDocument();
    const recent = within(screen.getByRole("group", { name: "Recent use" }));
    expect(recent.getByText(/Nothing yet this session/)).toBeInTheDocument();
    expect(screen.queryByText("In use")).not.toBeInTheDocument();
  });
});
