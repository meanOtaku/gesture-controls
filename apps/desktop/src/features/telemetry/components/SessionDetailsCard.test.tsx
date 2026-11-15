import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDetailsCard } from "./SessionDetailsCard";

afterEach(cleanup);

describe("the session details card", () => {
  it("shows each choice by its title, and Not said for one left empty", () => {
    render(<SessionDetailsCard context={{ wrist: "left" }} onChange={vi.fn()} recording={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("combobox", { name: "Watch on" })).toHaveTextContent("Left wrist");
    expect(screen.getByRole("combobox", { name: "Arm" })).toHaveTextContent("Not said");
    expect(screen.queryByText(/__not_said__/)).toBeNull();
  });

  it("says the details in one line until asked to edit them, and not while recording", () => {
    const { rerender } = render(<SessionDetailsCard context={{ wrist: "left", arm: "resting" }} onChange={vi.fn()} recording={false} />);
    expect(screen.getByLabelText("Details of this session")).toHaveTextContent("Left wrist");
    expect(screen.queryByRole("combobox")).toBeNull();
    rerender(<SessionDetailsCard context={{}} onChange={vi.fn()} recording />);
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByLabelText("Details of this session")).toHaveTextContent("Nothing said yet");
  });
});
