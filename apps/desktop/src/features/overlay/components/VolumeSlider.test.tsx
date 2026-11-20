import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { VolumeSlider } from "./VolumeSlider";

afterEach(cleanup);

it("shows the volume as a slider that fills, in either orientation", () => {
  const { container, rerender } = render(<VolumeSlider volume={64} orientation="vertical" />);
  const meter = screen.getByRole("meter", { name: "Current volume" });
  expect(meter).toHaveAttribute("aria-valuenow", "64");
  expect(meter).toHaveAttribute("aria-orientation", "vertical");
  expect(screen.getByText("64%")).toBeInTheDocument();
  expect(container.querySelector(".volume-slider__fill")).toHaveStyle({ "--volume-progress": "64" });
  rerender(<VolumeSlider volume={20} orientation="horizontal" grabbed />);
  expect(screen.getByRole("meter")).toHaveAttribute("aria-orientation", "horizontal");
  expect(screen.getByText("Grabbed · Turn wrist")).toBeInTheDocument();
});

it("shows brightness, and a dash when it cannot be read", () => {
  const { container, rerender } = render(<VolumeSlider volume={70} label="Brightness" orientation="vertical" />);
  expect(screen.getByRole("meter", { name: "Current brightness" })).toHaveAttribute("aria-valuenow", "70");
  expect(screen.getByText("Brightness")).toBeInTheDocument();
  rerender(<VolumeSlider volume={null} label="Brightness" orientation="vertical" />);
  expect(screen.getByText("–")).toBeInTheDocument();
  expect(screen.getByRole("meter")).not.toHaveAttribute("aria-valuenow");
  expect(container.querySelector(".volume-slider__fill")).toHaveStyle({ "--volume-progress": "0" });
});

it("surfaces a native volume error", () => {
  render(<VolumeSlider volume={50} orientation="vertical" nativeVolumeError="no output device" />);
  expect(screen.getByRole("alert")).toHaveTextContent("no output device");
});
