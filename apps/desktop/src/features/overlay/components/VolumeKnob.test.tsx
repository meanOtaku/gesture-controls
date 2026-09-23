import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VolumeKnob } from "./VolumeKnob";

describe("VolumeKnob", () => {
  it("renders system volume as an accessible animated dial", () => {
    const { container } = render(<VolumeKnob volume={64} />);

    expect(screen.getByRole("meter", { name: "Current volume" })).toHaveAttribute("aria-valuenow", "64");
    expect(screen.getByText("64%")) .toBeInTheDocument();
    expect(container.querySelector(".volume-knob__progress")).toHaveStyle({ "--volume-progress": "64" });
  });

  it("shows no corner-demo status when the phase is absent", () => {
    render(<VolumeKnob volume={50} />);
    expect(screen.queryByText(/Ready|Targeting|Adjusting|Unavailable/)).not.toBeInTheDocument();
  });

  it.each([
    ["targeting", "Targeting…"],
    ["ready", "Ready — twist wrist"],
    ["adjusting", "Adjusting"],
    ["unavailableNoOrientation", "Unavailable — no Watch orientation"],
    ["unavailableVolumeUnsupported", "Unavailable — volume control unsupported"],
  ] as const)("shows the %s corner-demo status", (phase, label) => {
    render(<VolumeKnob volume={50} cornerDemoPhase={phase} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("shows no native-error alert when there is none", () => {
    render(<VolumeKnob volume={50} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("surfaces a native volume error as a visible alert instead of a static overlay", () => {
    render(<VolumeKnob volume={50} nativeVolumeError="native volume backend failed: osascript is not authorized" />);
    expect(screen.getByRole("alert")).toHaveTextContent("osascript is not authorized");
  });
});
