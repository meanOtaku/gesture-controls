import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { defaultNetwork, type NetworkSettings } from "../network";
import type { TrainMethod } from "../training";
import { NetworkDesigner } from "./NetworkDesigner";
import { networkColumns } from "./NetworkDiagram";

afterEach(cleanup);

function Harness({ method, inputs = 28, onSettings }: { method: TrainMethod; inputs?: number; onSettings?: (s: NetworkSettings) => void }) {
  const [settings, setSettings] = useState(defaultNetwork(method));
  return <NetworkDesigner method={method} settings={settings} inputs={inputs} steps={32} onChange={(next) => { setSettings(next); onSettings?.(next); }} />;
}

describe("NetworkDesigner (dense)", () => {
  it("shows the layers and counts the parameters", () => {
    render(<Harness method="torch-mlp" />);
    expect(screen.getByLabelText("Neurons in layer 1")).toHaveValue(32);
    expect(screen.getByLabelText("Neurons in layer 2")).toHaveValue(16);
    expect(screen.getByRole("status")).toHaveTextContent("28 inputs → 32 → 16 → 2 outputs");
    expect(screen.getByRole("status")).toHaveTextContent("1,490 parameters");
    expect(screen.getByRole("img", { name: /The network, left to right: Inputs \(28\), then 32 \(ReLU\), then 16 \(ReLU\), then Output/ })).toBeInTheDocument();
  });

  it("edits neurons and activation, adds and removes layers within the limits, and keeps at least one", () => {
    let latest: NetworkSettings | undefined;
    render(<Harness method="torch-mlp" onSettings={(s) => { latest = s; }} />);
    fireEvent.change(screen.getByLabelText("Neurons in layer 1"), { target: { value: "64" } });
    fireEvent.change(screen.getByLabelText("Activation of layer 2"), { target: { value: "tanh" } });
    expect(latest?.hidden).toEqual([{ units: 64, activation: "relu" }, { units: 16, activation: "tanh" }]);
    fireEvent.change(screen.getByLabelText("Neurons in layer 1"), { target: { value: "9999" } });
    expect(latest?.hidden[0].units).toBe(512); // held to the limit
    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    expect(screen.getByLabelText("Neurons in layer 3")).toHaveValue(16);
    for (let i = 0; i < 5; i += 1) if (screen.queryByRole("button", { name: "Add layer" })?.hasAttribute("disabled") === false) fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    expect(screen.getByRole("button", { name: "Add layer" })).toBeDisabled(); // six at most
    fireEvent.click(screen.getByRole("button", { name: "Remove layer 1" }));
    expect(latest?.hidden.length).toBe(5);
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole("button", { name: "Remove layer 1" }));
    expect(screen.getByRole("button", { name: "Remove layer 1" })).toBeDisabled(); // one stays
  });

  it("sets how it learns, and resets to the method's defaults", () => {
    let latest: NetworkSettings | undefined;
    render(<Harness method="torch-mlp" onSettings={(s) => { latest = s; }} />);
    expect(screen.getByRole("button", { name: /Reset to the method/ })).toBeDisabled(); // already the default
    fireEvent.change(screen.getByLabelText("Learning rate"), { target: { value: "0.05" } });
    fireEvent.change(screen.getByLabelText("Rounds"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("Batch size"), { target: { value: "32" } });
    fireEvent.change(screen.getByLabelText("Dropout"), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Balance the classes" }));
    expect(latest).toMatchObject({ learningRate: 0.05, epochs: 50, batchSize: 32, dropout: 0.3, balanceClasses: false });
    fireEvent.change(screen.getByLabelText("Learning rate"), { target: { value: "5" } });
    expect(latest?.learningRate).toBe(0.1);
    fireEvent.click(screen.getByRole("button", { name: /Reset to the method/ }));
    expect(latest).toEqual(defaultNetwork("torch-mlp"));
  });

  it("warns when a network is large for the data", () => {
    render(<Harness method="torch-mlp" inputs={200} />);
    expect(screen.getByRole("status")).toHaveTextContent(/a smaller network is safer/);
  });
});

describe("NetworkDesigner (scikit-learn and convolutional)", () => {
  it("lets the scikit-learn network take only layer sizes and rounds", () => {
    render(<Harness method="mlp" />);
    expect(screen.getByLabelText("Activation of layer 1")).toBeDisabled();
    expect(screen.getByLabelText("Most rounds")).toHaveValue(600);
    expect(screen.queryByLabelText("Learning rate")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/always uses ReLU/);
  });

  it("designs convolution layers and pooling, with no dense layers needed", () => {
    let latest: NetworkSettings | undefined;
    render(<Harness method="cnn1d" inputs={6} onSettings={(s) => { latest = s; }} />);
    expect(screen.getByLabelText("Filters in convolution layer 1")).toHaveValue(16);
    expect(screen.getByLabelText("Width of convolution layer 2")).toHaveValue("5");
    expect(screen.getByText(/None: the pooled values go straight to the two outputs/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("6 inputs → convolution → 2 outputs");
    fireEvent.change(screen.getByLabelText("Width of convolution layer 1"), { target: { value: "9" } });
    fireEvent.change(screen.getByLabelText("Activation of convolution layer 2"), { target: { value: "leaky_relu" } });
    fireEvent.change(screen.getByLabelText("Pooling over time"), { target: { value: "max" } });
    fireEvent.click(screen.getByRole("button", { name: "Add convolution layer" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Shift, scale and add noise while training" }));
    expect(latest?.conv).toEqual([
      { filters: 16, kernel: 9, activation: "relu" },
      { filters: 16, kernel: 5, activation: "leaky_relu" },
      { filters: 16, kernel: 5, activation: "relu" },
    ]);
    expect(latest).toMatchObject({ pooling: "max", augment: false });
    fireEvent.click(screen.getByRole("button", { name: "Remove convolution layer 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove convolution layer 2" }));
    expect(screen.getByRole("button", { name: "Remove convolution layer 1" })).toBeDisabled(); // one stays
    within(screen.getByRole("group", { name: "Network design" })).getByRole("button", { name: "Add layer" });
  });
});

describe("networkColumns", () => {
  it("lists a convolutional network's window, convolutions, pooling, dense layers and output", () => {
    const settings = { ...defaultNetwork("cnn1d"), hidden: [{ units: 8, activation: "tanh" as const }], pooling: "mean" as const };
    expect(networkColumns(settings, 6, "cnn1d", 32).map((c) => c.title)).toEqual(["Window", "Conv 16 × 5", "Conv 16 × 5", "Pooling", "8", "Output"]);
    expect(networkColumns(settings, 6, "cnn1d", 32)[0].detail).toBe("6 channels × 32 steps");
    expect(networkColumns(defaultNetwork("torch-mlp"), 28, "torch-mlp", 32).map((c) => c.size)).toEqual([28, 32, 16, 2]);
  });
});
