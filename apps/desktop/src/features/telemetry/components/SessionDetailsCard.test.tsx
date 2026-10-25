import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDetailsCard } from "./SessionDetailsCard";

afterEach(cleanup);

describe("the session details card", () => {
  it("shows each choice by its title, and Not said for one left empty", () => {
    render(<SessionDetailsCard context={{ wrist: "left" }} onChange={vi.fn()} recording={false} />);
    expect(screen.getByRole("combobox", { name: "Watch on" })).toHaveTextContent("Left wrist");
    expect(screen.getByRole("combobox", { name: "Arm" })).toHaveTextContent("Not said");
    expect(screen.queryByText(/__not_said__/)).toBeNull();
  });
});
