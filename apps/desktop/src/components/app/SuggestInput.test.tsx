import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SuggestInput } from "./SuggestInput";

afterEach(() => cleanup());

function Field({ start = "" }: { start?: string }) {
  const [value, setValue] = useState(start);
  return <SuggestInput aria-label="Group name" value={value} onValueChange={setValue} suggestions={["Manual Verified", "Misses", "Noisy"]} />;
}

describe("SuggestInput", () => {
  it("shows the suggestions in a themed list, not a native datalist", () => {
    const { container } = render(<Field />);
    fireEvent.focus(screen.getByRole("combobox", { name: "Group name" }));
    const list = screen.getByRole("listbox");
    expect(list.closest('[data-slot="select-content"]')).not.toBeNull();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Manual Verified", "Misses", "Noisy"]);
    expect(container.querySelector("datalist")).toBeNull();
  });

  it("filters by what is typed and picks with the mouse", () => {
    render(<Field />);
    const field = screen.getByRole("combobox", { name: "Group name" });
    fireEvent.change(field, { target: { value: "mis" } });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Misses"]);
    fireEvent.mouseDown(screen.getByRole("option", { name: "Misses" }));
    expect(field).toHaveValue("Misses");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("is driven by the arrow keys, Enter and Escape", () => {
    render(<Field />);
    const field = screen.getByRole("combobox", { name: "Group name" });
    fireEvent.focus(field);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "Misses" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field).toHaveValue("Misses");

    fireEvent.change(field, { target: { value: "" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("lets any other name be typed", () => {
    render(<Field />);
    const field = screen.getByRole("combobox", { name: "Group name" });
    fireEvent.change(field, { target: { value: "Fresh group" } });
    expect(field).toHaveValue("Fresh group");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
