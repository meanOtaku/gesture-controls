import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { InputPicker } from "./InputPicker";

afterEach(cleanup);

const AVAILABLE = ["accel_x_mean", "accel_x_std", "accel_y_std", "gyro_x_std", "ppg_green_mean", "ppg_green_spike_z", "sample_count"];

function Harness({ onChange, start = null }: { onChange?: (v: string[] | null) => void; start?: string[] | null }) {
  const [chosen, setChosen] = useState<string[] | null>(start);
  return <InputPicker available={AVAILABLE} chosen={chosen} spikeMethodLabel="Rolling median residual" onChange={(next) => { setChosen(next); onChange?.(next); }} />;
}

describe("InputPicker", () => {
  it("lists every available input by stream and group, with what each takes as its value", () => {
    render(<Harness />);
    expect(screen.getByText(/7 of 7 used/)).toBeInTheDocument();
    for (const title of ["Acceleration", "Gyroscope", "Pulse sensor"]) expect(screen.getByRole("list", { name: `${title} inputs` })).toBeInTheDocument();
    const box = screen.getByRole("checkbox", { name: "Acceleration X spread" });
    expect(box).toHaveAttribute("aria-description", expect.stringContaining("standard deviation"));
    expect(screen.getByRole("checkbox", { name: "Pulse sensor Green spike strength" })).toHaveAttribute("aria-description", expect.stringContaining("Rolling median residual"));
  });

  it("narrows to the ticked inputs, reports all as null, and never lets the last one go", () => {
    const seen: (string[] | null)[] = [];
    render(<Harness onChange={(v) => seen.push(v)} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Acceleration X mean" }));
    expect(seen.at(-1)).toEqual(["accel_x_std", "accel_y_std", "gyro_x_std", "ppg_green_mean", "ppg_green_spike_z", "sample_count"]);
    expect(screen.getByText(/6 of 7 used/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Acceleration X mean" }));
    expect(seen.at(-1)).toBeNull(); // everything again: no narrowing to send
    // The Acceleration "None" and "All" buttons act on the whole stream.
    const accelNone = screen.getAllByRole("button", { name: "None" })[0];
    fireEvent.click(accelNone);
    expect(seen.at(-1)).toEqual(["gyro_x_std", "ppg_green_mean", "ppg_green_spike_z", "sample_count"]);
    fireEvent.click(screen.getAllByRole("button", { name: "All" })[0]);
    expect(seen.at(-1)).toBeNull();
    // Down to one input: it stays.
    for (const button of screen.getAllByRole("button", { name: "None" })) fireEvent.click(button);
    expect(screen.getByText(/1 of 7 used/)).toBeInTheDocument();
  });

  it("says channels for the convolutional method, and shows nothing when there are no inputs", () => {
    const { rerender, container } = render(<InputPicker available={["accel_x", "ppg_red"]} chosen={null} onChange={() => undefined} channels />);
    expect(screen.getByText(/Choose individual channels/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Acceleration X signal" })).toBeInTheDocument();
    rerender(<InputPicker available={[]} chosen={null} onChange={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("can be told to start narrowed, and Use all clears it", () => {
    const seen: (string[] | null)[] = [];
    render(<Harness start={["accel_x_std"]} onChange={(v) => seen.push(v)} />);
    expect(screen.getByText(/1 of 7 used/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use all" }));
    expect(seen.at(-1)).toBeNull();
  });
});
