import type { DatasetLabel } from "../model-lab/types";

/** "Nothing here" (`NO_LABEL`) and a stretch left out (`LEFT_OUT`) are drawn the same everywhere. */
const FIXED: Record<string, string> = { "-": "#8a8a8a", left_out: "#52525b" };

/** A steady colour from a label's name, for one that is not in the Labels list. */
export function hashColor(label: string): string {
  let hash = 0;
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 70% 60%)`;
}

/** A label's colour, the same on every page: the one chosen for it on the Labels tab, or else one from its name. */
export function labelColor(label: string, catalogue: Pick<DatasetLabel, "id" | "color">[]): string {
  return FIXED[label] ?? catalogue.find((entry) => entry.id === label)?.color ?? hashColor(label);
}

/** A small square in a label's colour, beside its name. */
export function LabelSwatch({ label, catalogue }: { label: string; catalogue: Pick<DatasetLabel, "id" | "color">[] }) {
  return <span className="labelling-swatch" style={{ background: labelColor(label, catalogue) }} aria-hidden="true" />;
}
