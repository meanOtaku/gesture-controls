import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MissMarker } from "./MissMarker";

describe("MissMarker", () => {
  it("shows nothing outside the desktop app, where there is nothing to save", () => {
    const { container } = render(<MissMarker />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("group", { name: "Mark a miss" })).toBeNull();
  });
});
