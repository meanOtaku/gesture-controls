import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VolumeKnob } from "./VolumeKnob";

afterEach(cleanup);

describe("VolumeKnob", () => {
  it("renders system volume as an accessible animated dial", () => {
    const { container } = render(<VolumeKnob volume={64} />);

    expect(screen.getByRole("meter", { name: "Current volume" })).toHaveAttribute("aria-valuenow", "64");
    expect(screen.getByText("64%")) .toBeInTheDocument();
    expect(container.querySelector(".volume-knob__progress")).toHaveStyle({ "--volume-progress": "64" });
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

it("preserves fractional movement in the dial while rounding only its readout", () => {
  const { container } = render(<VolumeKnob volume={42.35} grabbed />);
  expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "42.35");
  expect(screen.getByText("42%")).toBeInTheDocument();
  expect(container.querySelector(".volume-knob__progress")).toHaveStyle({ "--volume-progress": "42.35" });
  expect(screen.getByText("Grabbed · Turn wrist")).toBeInTheDocument();
});
