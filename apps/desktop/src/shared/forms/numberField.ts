/** What a numeric field allows. The same record drives the input's attributes, its validation and its hint text. */
export interface NumberSpec {
  label: string;
  unit?: string;
  min: number;
  max: number;
  step: number;
  /** Whole numbers only. */
  integer?: boolean;
  defaultValue: number;
  /** One line about what the field does; shown under it when there is no error. */
  description?: string;
}

export type NumberParse = { ok: true; value: number } | { ok: false; message: string };

/** A number as the text shown in a field, with float noise trimmed: `0.3333333333333333` becomes `0.3333`. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  return String(Number(value.toFixed(4)));
}

function range(spec: Pick<NumberSpec, "min" | "max" | "unit">): string {
  return `${formatNumber(spec.min)}–${formatNumber(spec.max)}${spec.unit ? ` ${spec.unit}` : ""}`;
}

/** The hint shown under a field that has nothing to complain about. */
export function rangeHint(spec: Pick<NumberSpec, "min" | "max" | "unit">): string {
  return `Allowed: ${range(spec)}`;
}

/**
 * Reads what the user typed. Never silently repairs it: a value that is empty, not a number, out of
 * range, or fractional where only whole numbers are allowed is reported, in words that say how to fix it.
 */
export function parseNumber(text: string, spec: Pick<NumberSpec, "min" | "max" | "unit" | "integer">): NumberParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, message: "Enter a value." };
  // Number("") is 0 and Number("0x10") is 16; neither is what someone typing into a rate box means.
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) {
    return { ok: false, message: "Enter a number, for example 30." };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, message: "Enter a number, for example 30." };
  if (spec.integer && !Number.isInteger(value)) return { ok: false, message: "Use a whole number." };
  if (value < spec.min) return { ok: false, message: `Too low: the minimum is ${formatNumber(spec.min)}${spec.unit ? ` ${spec.unit}` : ""}.` };
  if (value > spec.max) return { ok: false, message: `Too high: the maximum is ${formatNumber(spec.max)}${spec.unit ? ` ${spec.unit}` : ""}.` };
  return { ok: true, value };
}
