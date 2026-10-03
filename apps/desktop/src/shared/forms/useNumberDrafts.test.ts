import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useNumberDrafts } from "./useNumberDrafts";
import type { NumberSpec } from "./numberField";

const specs: Record<"rate" | "gain", NumberSpec> = {
  rate: { label: "Rate", unit: "Hz", min: 1, max: 200, step: 1, integer: true, defaultValue: 60 },
  gain: { label: "Gain", min: 0.01, max: 5, step: 0.01, defaultValue: 1 / 3 },
};

const setup = (committed = { rate: 60, gain: 1 / 3 }) =>
  renderHook(({ values }) => useNumberDrafts(specs, values), { initialProps: { values: committed } });

describe("useNumberDrafts", () => {
  it("starts clean, showing saved values with float noise trimmed", () => {
    const { result } = setup();
    expect(result.current.fields.rate).toMatchObject({ text: "60", dirty: false, error: null });
    expect(result.current.fields.gain.text).toBe("0.3333");
    expect(result.current.fields.gain.dirty).toBe(false);
    expect(result.current.dirtyCount).toBe(0);
  });

  it("marks a field dirty as it is edited but only shows its error after it is left", () => {
    const { result } = setup();
    act(() => result.current.setText("rate", "999"));
    expect(result.current.fields.rate.dirty).toBe(true);
    expect(result.current.fields.rate.error).toBeNull(); // still typing
    expect(result.current.invalidCount).toBe(1);
    act(() => result.current.touch("rate"));
    expect(result.current.fields.rate.error).toBe("Too high: the maximum is 200 Hz.");
  });

  it("is not dirty again when the text is put back", () => {
    const { result } = setup();
    act(() => result.current.setText("rate", "70"));
    act(() => result.current.setText("rate", "60"));
    expect(result.current.dirtyCount).toBe(0);
  });

  it("refuses to submit an invalid value, names the first bad field, and shows every error", () => {
    const { result } = setup();
    act(() => {
      result.current.setText("gain", "abc");
      result.current.setText("rate", "999");
    });
    let outcome: ReturnType<typeof result.current.submit> | undefined;
    act(() => {
      outcome = result.current.submit();
    });
    expect(outcome).toEqual({ values: null, firstInvalid: "rate" });
    expect(result.current.fields.rate.error).toMatch(/maximum is 200/);
    expect(result.current.fields.gain.error).toMatch(/Enter a number/);
  });

  it("submits parsed edits and keeps the exact saved value for a field that was not touched", () => {
    const { result } = setup();
    act(() => result.current.setText("rate", "90"));
    let outcome: ReturnType<typeof result.current.submit> | undefined;
    act(() => {
      outcome = result.current.submit();
    });
    expect(outcome).toEqual({ values: { rate: 90, gain: 1 / 3 } }); // 1/3, not 0.3333
  });

  it("follows a saved value that changed without disturbing a half-typed neighbour", () => {
    const { result, rerender } = setup();
    act(() => result.current.setText("gain", "2.5"));
    rerender({ values: { rate: 90, gain: 1 / 3 } });
    expect(result.current.fields.rate.text).toBe("90");
    expect(result.current.fields.gain.text).toBe("2.5");
    expect(result.current.fields.gain.dirty).toBe(true);
  });

  it("discards every edit and every shown error", () => {
    const { result } = setup();
    act(() => {
      result.current.setText("rate", "999");
      result.current.touch("rate");
    });
    act(() => result.current.discard());
    expect(result.current.fields.rate).toMatchObject({ text: "60", dirty: false, error: null });
  });

  it("resets a field to its default as an edit that still has to be applied", () => {
    const { result } = setup({ rate: 120, gain: 1 / 3 });
    expect(result.current.fields.rate.differsFromDefault).toBe(true);
    act(() => result.current.resetToDefault("rate"));
    expect(result.current.fields.rate).toMatchObject({ text: "60", dirty: true, differsFromDefault: false });
    expect(result.current.dirtyCount).toBe(1);
  });
});
