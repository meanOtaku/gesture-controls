import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdvancedSection } from "./AdvancedSection";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("AdvancedSection", () => {
  it("is closed until opened, renders its tools only then, and remembers being left open", () => {
    render(<AdvancedSection storageKey="page" summary="Two tools"><p>Inside</p></AdvancedSection>);
    expect(screen.getByText("Two tools")).toBeInTheDocument();
    expect(screen.queryByText("Inside")).not.toBeInTheDocument();
    const details = screen.getByText("Advanced").closest("details") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(screen.getByText("Inside")).toBeInTheDocument();
    cleanup();
    render(<AdvancedSection storageKey="page" summary="Two tools"><p>Inside</p></AdvancedSection>);
    expect(screen.getByText("Inside")).toBeInTheDocument();
  });
});
