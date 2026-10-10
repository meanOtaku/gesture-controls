import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CascadePanel } from "./CascadePanel";
import type { CascadePlan } from "./labelCascade";

afterEach(() => cleanup());

const plan = (over: Partial<CascadePlan> = {}): CascadePlan => ({
  mode: "delete", label: "pinch", lines: ["Delete 1 recipe: “Pause”.", "Delete the label itself. This cannot be undone."], blockers: [],
  steps: [{ kind: "deleteRecipe", id: "x", name: "Pause" }, { kind: "deleteLabel" }], ...over,
});

describe("CascadePanel", () => {
  it("shows what will happen and runs nothing until the label's id is typed, for a delete", async () => {
    const onRun = vi.fn().mockResolvedValue({ ok: true, done: 2 });
    const onCancel = vi.fn();
    render(<CascadePanel plan={plan()} onCancel={onCancel} onRun={onRun} />);
    expect(screen.getByRole("list", { name: "What will happen" }).textContent).toContain("Delete 1 recipe");
    const go = screen.getByRole("button", { name: "Delete everything above" });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: "pinc" } });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: "pinch" } });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
  });

  it("needs no typing for an archive, and says how far it got when a step fails", async () => {
    const onRun = vi.fn().mockResolvedValue({ ok: false, done: 1, failedStep: { kind: "deleteLabel" }, message: "Stopped while deleting the label: busy." });
    const onCancel = vi.fn();
    render(<CascadePanel plan={plan({ mode: "archive", lines: ["Archive the label."] })} onCancel={onCancel} onRun={onRun} />);
    expect(screen.queryByLabelText(/Type/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Archive everything above" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("1 of 2 steps were done before it stopped");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("will not go ahead while something blocks it, and says what", () => {
    render(<CascadePanel plan={plan({ blockers: ["The training recording “both.csv” also holds fist."] })} onCancel={vi.fn()} onRun={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("both.csv");
    expect(screen.getByRole("button", { name: "Delete everything above" })).toBeDisabled();
    expect(screen.queryByLabelText(/Type/)).toBeNull();
  });
});
