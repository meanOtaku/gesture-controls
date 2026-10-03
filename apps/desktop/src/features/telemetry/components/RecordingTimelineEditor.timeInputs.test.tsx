import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundaryEditor, SplitControl } from "./RecordingTimelineEditor";

afterEach(cleanup);

describe("BoundaryEditor", () => {
  it("commits a changed time when the field is left", () => {
    const onCommit = vi.fn();
    render(<BoundaryEditor label="Start" seconds={2} onCommit={onCommit} />);
    const input = screen.getByLabelText("Start time in seconds");
    fireEvent.change(input, { target: { value: "3.5" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(3.5);
  });

  it("commits on Enter too", () => {
    const onCommit = vi.fn();
    render(<BoundaryEditor label="End" seconds={9} onCommit={onCommit} />);
    const input = screen.getByLabelText("End time in seconds");
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith(10);
  });

  it("does not turn an empty box into 0, and says what is wrong", () => {
    const onCommit = vi.fn();
    render(<BoundaryEditor label="Start" seconds={2} onCommit={onCommit} />);
    const input = screen.getByLabelText("Start time in seconds");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a value.");
  });

  it("rejects a negative time and clears the message once the user edits again", () => {
    const onCommit = vi.fn();
    render(<BoundaryEditor label="Start" seconds={2} onCommit={onCommit} />);
    const input = screen.getByLabelText("Start time in seconds");
    fireEvent.change(input, { target: { value: "-1" } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/minimum is 0 s/);
    fireEvent.change(input, { target: { value: "1" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does nothing when the time was not changed", () => {
    const onCommit = vi.fn();
    render(<BoundaryEditor label="Start" seconds={2} onCommit={onCommit} />);
    fireEvent.blur(screen.getByLabelText("Start time in seconds"));
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("SplitControl", () => {
  it("splits at a valid time, by button or Enter", () => {
    const onSplit = vi.fn();
    render(<SplitControl seconds={4} onSplit={onSplit} />);
    const input = screen.getByLabelText("Split at time in seconds");
    expect(input).toHaveValue("5.0");
    fireEvent.change(input, { target: { value: "6.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSplit).toHaveBeenCalledTimes(2);
    expect(onSplit).toHaveBeenCalledWith(6.25);
  });

  it("refuses to split at something that is not a time", () => {
    const onSplit = vi.fn();
    render(<SplitControl seconds={4} onSplit={onSplit} />);
    fireEvent.change(screen.getByLabelText("Split at time in seconds"), { target: { value: "soon" } });
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(onSplit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a number, for example 30.");
  });
});
