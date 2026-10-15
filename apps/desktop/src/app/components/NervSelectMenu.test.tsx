import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NervSelectMenu } from "./NervSelectMenu";

function Form({ onChange }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("b");
  return (
    <>
      <label htmlFor="pick">Label to teach</label>
      <select id="pick" value={value} onChange={(event) => { setValue(event.target.value); onChange?.(event.target.value); }}>
        <option value="a">Fist</option>
        <option value="b">Hand open</option>
        <option value="c" disabled>Pinch</option>
        <optgroup label="More">
          <option value="d">Thumbs up</option>
        </optgroup>
      </select>
      <NervSelectMenu />
    </>
  );
}

/** The themed list's options (the native <option> elements have the same role). */
const menu = () => within(screen.getByRole("listbox"));
const select = () => document.getElementById("pick") as HTMLSelectElement;
const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });

beforeEach(() => {
  document.documentElement.setAttribute("data-theme", "nerv");
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

describe("NervSelectMenu", () => {
  it("shows a themed list of the dropdown's options when it is pressed, with the chosen one marked", () => {
    render(<Form />);
    fireEvent.mouseDown(select(), { button: 0 });
    const list = screen.getByRole("listbox", { name: "Label to teach" });
    expect(list).toHaveClass("nerv-select-menu");
    expect(menu().getAllByRole("option").map((option) => option.textContent)).toEqual(["Fist", "Hand open", "Pinch", "Thumbs up"]);
    expect(menu().getByRole("option", { name: "Hand open" })).toHaveAttribute("aria-selected", "true");
    expect(menu().getByRole("option", { name: "Pinch" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("More")).toBeInTheDocument();
    expect(select()).toHaveAttribute("aria-expanded", "true");
  });

  it("sets a clicked option on the real dropdown through its change event, then closes", () => {
    const onChange = vi.fn();
    render(<Form onChange={onChange} />);
    fireEvent.mouseDown(select(), { button: 0 });
    fireEvent.click(menu().getByRole("option", { name: "Thumbs up" }));
    expect(onChange).toHaveBeenCalledWith("d");
    expect(select().value).toBe("d");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(select()).not.toHaveAttribute("aria-expanded");
  });

  it("opens from the keyboard, skips disabled options, and chooses with Enter", () => {
    const onChange = vi.fn();
    render(<Form onChange={onChange} />);
    act(() => select().focus());
    press(" ");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    press("ArrowDown");
    expect(select()).toHaveAttribute("aria-activedescendant", menu().getByRole("option", { name: "Thumbs up" }).id);
    press("Enter");
    expect(onChange).toHaveBeenCalledWith("d");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(select());
  });

  it("jumps to an option by typing its first letters, and Escape closes without changing anything", () => {
    const onChange = vi.fn();
    render(<Form onChange={onChange} />);
    fireEvent.mouseDown(select(), { button: 0 });
    press("f");
    expect(menu().getByRole("option", { name: "Fist" })).toHaveAttribute("data-active", "true");
    press("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes when something else on the page is pressed", () => {
    render(<Form />);
    fireEvent.mouseDown(select(), { button: 0 });
    fireEvent.mouseDown(document.body, { button: 0 });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("leaves the system list alone under other themes", () => {
    document.documentElement.removeAttribute("data-theme");
    render(<Form />);
    const event = fireEvent.mouseDown(select(), { button: 0 });
    expect(event).toBe(true);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
