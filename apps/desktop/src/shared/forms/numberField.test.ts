import { describe, expect, it } from "vitest";
import { formatNumber, parseNumber, rangeHint } from "./numberField";

const hz = { min: 1, max: 200, unit: "Hz", integer: true };

describe("parseNumber", () => {
  it("accepts a value in range, with surrounding space", () => {
    expect(parseNumber(" 60 ", hz)).toEqual({ ok: true, value: 60 });
    expect(parseNumber("200", hz)).toEqual({ ok: true, value: 200 });
    expect(parseNumber("1", hz)).toEqual({ ok: true, value: 1 });
  });

  it("says what is wrong, and how far, instead of repairing the value", () => {
    expect(parseNumber("999", hz)).toEqual({ ok: false, message: "Too high: the maximum is 200 Hz." });
    expect(parseNumber("0", hz)).toEqual({ ok: false, message: "Too low: the minimum is 1 Hz." });
    expect(parseNumber("-5", hz)).toEqual({ ok: false, message: "Too low: the minimum is 1 Hz." });
  });

  it("rejects empty, non-numeric and number-like junk", () => {
    for (const bad of ["", "   ", "abc", "1,5", "0x10", "1e", "--3", "NaN", "Infinity", "12 Hz"]) {
      const result = parseNumber(bad, hz);
      expect(result.ok, `"${bad}"`).toBe(false);
    }
    expect(parseNumber("", hz)).toEqual({ ok: false, message: "Enter a value." });
    expect(parseNumber("abc", hz)).toEqual({ ok: false, message: "Enter a number, for example 30." });
  });

  it("holds whole-number fields to whole numbers but lets decimal fields keep their decimals", () => {
    expect(parseNumber("12.5", hz)).toEqual({ ok: false, message: "Use a whole number." });
    expect(parseNumber("0.25", { min: 0.1, max: 10, unit: "Hz" })).toEqual({ ok: true, value: 0.25 });
    expect(parseNumber(".5", { min: 0.1, max: 10 })).toEqual({ ok: true, value: 0.5 });
  });

  it("omits the unit from messages for a unitless field", () => {
    expect(parseNumber("9", { min: 0, max: 5 })).toEqual({ ok: false, message: "Too high: the maximum is 5." });
  });
});

describe("formatNumber and rangeHint", () => {
  it("trims float noise but keeps meaningful decimals", () => {
    expect(formatNumber(1 / 3)).toBe("0.3333");
    expect(formatNumber(60)).toBe("60");
    expect(formatNumber(0.01)).toBe("0.01");
    expect(formatNumber(30.5)).toBe("30.5");
    expect(formatNumber(Number.NaN)).toBe("");
  });

  it("describes the allowed range with its unit", () => {
    expect(rangeHint({ min: 1, max: 200, unit: "Hz" })).toBe("Allowed: 1–200 Hz");
    expect(rangeHint({ min: 0.01, max: 5 })).toBe("Allowed: 0.01–5");
  });
});
