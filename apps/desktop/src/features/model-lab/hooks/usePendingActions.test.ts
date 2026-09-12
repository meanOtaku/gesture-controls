import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePendingActions } from "./usePendingActions";

describe("usePendingActions", () => {
  it("marks a key pending during the action and clears it after", async () => {
    const { result } = renderHook(() => usePendingActions());
    let resolveAction: () => void = () => {};
    const action = vi.fn(() => new Promise<void>((resolve) => { resolveAction = resolve; }));

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run("activate:model-a", action);
    });
    expect(result.current.isPending("activate:model-a")).toBe(true);
    expect(result.current.isPending("other-key")).toBe(false);

    await act(async () => {
      resolveAction();
      await runPromise;
    });
    expect(result.current.isPending("activate:model-a")).toBe(false);
  });

  it("ignores a duplicate run for a key that is already pending", async () => {
    const { result } = renderHook(() => usePendingActions());
    let resolveAction: () => void = () => {};
    const action = vi.fn(() => new Promise<void>((resolve) => { resolveAction = resolve; }));

    let firstRun!: Promise<void>;
    act(() => {
      firstRun = result.current.run("save:model-a", action);
      void result.current.run("save:model-a", action);
    });
    expect(action).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveAction();
      await firstRun;
    });
  });

  it("clears the pending key even when the action rejects", async () => {
    const { result } = renderHook(() => usePendingActions());
    const action = vi.fn(() => Promise.reject(new Error("boom")));

    await act(async () => {
      await result.current.run("recheck", () => action().catch(() => undefined));
    });
    expect(result.current.isPending("recheck")).toBe(false);
  });
});
