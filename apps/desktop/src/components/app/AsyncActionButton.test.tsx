import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncActionButton } from "./AsyncActionButton";

afterEach(() => cleanup());

describe("AsyncActionButton", () => {
  it("disables itself while pending and re-enables once the action settles", async () => {
    let resolveAction!: () => void;
    const onPress = vi.fn(() => new Promise<void>((resolve) => { resolveAction = resolve; }));

    render(<AsyncActionButton onPress={onPress} pendingLabel="Saving…">Save</AsyncActionButton>);
    const button = screen.getByRole("button", { name: "Save" });

    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();

    resolveAction();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
  });

  it("ignores clicks while a request is already pending", async () => {
    let resolveAction!: () => void;
    const onPress = vi.fn(() => new Promise<void>((resolve) => { resolveAction = resolve; }));

    render(<AsyncActionButton onPress={onPress} pendingLabel="Saving…">Save</AsyncActionButton>);
    const button = screen.getByRole("button", { name: "Save" });

    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
    fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
    expect(onPress).toHaveBeenCalledTimes(1);

    resolveAction();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
  });

  it("still re-enables after a rejected action", async () => {
    const onPress = vi.fn(() => Promise.reject(new Error("boom")));

    render(<AsyncActionButton onPress={() => onPress().catch(() => undefined)} pendingLabel="Saving…">Save</AsyncActionButton>);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
  });
});
