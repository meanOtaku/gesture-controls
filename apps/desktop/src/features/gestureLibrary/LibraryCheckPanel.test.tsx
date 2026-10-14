import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MeasureSample } from "./calibration";
import { blankDefinition, type GestureDefinition } from "./definition";
import { LibraryCheckPanel } from "./LibraryCheckPanel";

afterEach(cleanup);

const gesture = (id: string, name: string, conditions: GestureDefinition["conditions"]): GestureDefinition => ({ ...blankDefinition(), id, name, conditions });
const frames = (value: number): MeasureSample[] => Array.from({ length: 30 }, () => ({ "thumb.up": value, "thumb.out": 1.5 }));
const up = gesture("up", "Thumbs up", [{ measure: "thumb.up", direction: "above", enter: 0.5, exit: 0.3 }]);
const down = gesture("down", "Thumbs down", [{ measure: "thumb.up", direction: "below", enter: -0.5, exit: -0.3 }]);
const any = gesture("any", "Any thumb", [{ measure: "thumb.out", direction: "above", enter: 1, exit: 0.8 }]);

describe("LibraryCheckPanel", () => {
  it("shows nothing for a library of one", () => {
    const { container } = render(<LibraryCheckPanel definitions={[up]} samples={{ up: frames(0.9) }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says all clear when no gesture fires on another", () => {
    render(<LibraryCheckPanel definitions={[up, down]} samples={{ up: frames(0.9), down: frames(-0.9) }} />);
    expect(screen.getByText("All clear")).toBeInTheDocument();
  });

  it("names the pairs that would be mixed up, and the gestures that could not be checked", () => {
    const legacy = gesture("old", "Old fist", [{ measure: "extension.index", direction: "below", enter: 0.7, exit: 0.8 }]);
    render(<LibraryCheckPanel definitions={[up, down, any, legacy]} samples={{ up: frames(0.9), down: frames(-0.9), any: frames(0) }} />);
    const list = screen.getByRole("list", { name: "Gestures that would be confused" });
    expect(list.textContent).toContain("“Any thumb” also fires on “Thumbs up” frames: they will be mixed up.");
    expect(screen.getByText(/Not in the check \(no saved frames\): Old fist/)).toBeInTheDocument();
  });

  it("asks for a recording again when fewer than two gestures have frames", () => {
    render(<LibraryCheckPanel definitions={[up, down]} samples={{ up: frames(0.9) }} />);
    expect(screen.getByText(/Needs two gestures calibrated with this version/)).toBeInTheDocument();
  });
});
