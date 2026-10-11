import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LabelTiming, bestOffset } from "./LabelTiming";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
beforeEach(() => invokeMock.mockReset());
afterEach(cleanup);

const scores = (aucs: Array<number | null>) => aucs.map((auc, i) => ({ offsetMs: -250 + i * 250, auc, windows: 400, positives: 80 }));
const request = { label: "x" } as never;

describe("bestOffset", () => {
  it("picks the highest score and the spread, skipping unscored offsets", () => {
    const found = bestOffset(scores([0.7, null, 0.82, 0.75]));
    expect(found?.best.offsetMs).toBe(250);
    expect(found?.spread).toBeCloseTo(0.12);
    expect(bestOffset(scores([null, null]))).toBeNull();
  });
});

describe("LabelTiming", () => {
  it("clamps a typed offset to the allowed range", () => {
    const onOffset = vi.fn();
    render(<LabelTiming request={request} offset={0} onOffset={onOffset} disabled={false} />);
    const input = screen.getByLabelText("Label timing (ms)");
    fireEvent.change(input, { target: { value: "9000" } });
    fireEvent.blur(input);
    expect(onOffset).toHaveBeenCalledWith(1500);
  });

  it("checks the timing without the current offset and offers the best one", async () => {
    invokeMock.mockResolvedValue(scores([0.7, 0.72, 0.85, 0.74]));
    const onOffset = vi.fn();
    render(<LabelTiming request={request} offset={0} onOffset={onOffset} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Check which timing fits" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Use +250 ms" })).toBeTruthy());
    expect(invokeMock.mock.calls[0][0]).toBe("suggest_label_offset");
    expect(invokeMock.mock.calls[0][1].request.labelOffsetMs).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Use +250 ms" }));
    expect(onOffset).toHaveBeenCalledWith(250);
  });

  it("says the timing barely matters when the scores are flat, and shows a refusal", async () => {
    invokeMock.mockResolvedValueOnce(scores([0.8, 0.81, 0.82, 0.81]));
    render(<LabelTiming request={request} offset={0} onOffset={vi.fn()} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Check which timing fits" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("barely matters"));
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
    invokeMock.mockRejectedValueOnce("not enough recordings");
    fireEvent.click(screen.getByRole("button", { name: "Check which timing fits" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("not enough recordings"));
  });
});
