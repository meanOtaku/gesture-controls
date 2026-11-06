import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditableLabelRail } from "./EditableLabelRail";

afterEach(cleanup);
describe("drag snapping", () => {
  it.each([false, true])("snaps to a sample unless Alt is held (%s)", (altKey) => {
    const commit = vi.fn();
    render(<EditableLabelRail spans={[{ startMs: 100, endMs: 200, label: "pinch" }]} view={{ startMs: 0, endMs: 1000 }} duration={1000}
      colorOf={() => "cyan"} nameOf={(label) => label} onPreview={vi.fn()} onCommit={commit} onSelect={vi.fn()} snap snapPoints={[500]} />);
    const rail = screen.getByRole("list");
    rail.getBoundingClientRect = () => ({ left: 0, width: 1000 } as DOMRect);
    const body = screen.getByRole("button", { name: "Move pinch" });
    fireEvent.pointerDown(body, { button: 0, clientX: 150, pointerId: 1 });
    fireEvent.pointerMove(body, { clientX: 545, pointerId: 1, altKey });
    fireEvent.pointerUp(body, { pointerId: 1 });
    expect(commit).toHaveBeenCalledWith([{ startMs: altKey ? 495 : 500, endMs: altKey ? 595 : 600, label: "pinch" }]);
  });
});
