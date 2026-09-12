import type { PpgState } from "../../shared/protocol/events";

const PPG_STATE_LABELS: Record<PpgState, string> = {
  idle: "PPG idle (25Hz continuous)",
  permission_required: "PPG permission required",
  connecting: "PPG connecting (25Hz continuous)",
  streaming: "PPG streaming (25Hz continuous)",
  unavailable: "PPG unavailable",
  error: "PPG error",
};

export function ppgStateLabel(state: PpgState | null): string {
  return state ? PPG_STATE_LABELS[state] : "No PPG data";
}

export const number = (value: number, digits = 2) => value.toFixed(digits);

export const vector = (values: readonly number[] | null, digits = 3) =>
  values ? `[${values.map((value) => number(value, digits)).join(", ")}]` : "Unavailable";
