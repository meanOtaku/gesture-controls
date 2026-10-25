import type { DatasetSummary } from "../model-lab/types";
import { SESSION_FIELDS, type SessionField } from "./sessionContext";

/** Recordings that do not say a detail are counted under this. */
export const NOT_SAID = "";

export interface Coverage {
  /** Holds of the label by arm (rows) and wrist (columns), "" where a recording does not say. */
  grid: Record<string, Record<string, number>>;
  arms: string[];
  wrists: string[];
  /** Holds by each other detail's values, most first. */
  byField: { field: SessionField; title: string; counts: [string, number][] }[];
  total: number;
  recordings: number;
}

const optionsOf = (field: SessionField) => SESSION_FIELDS.find((spec) => spec.field === field)?.options?.map((option) => option.value) ?? [];

/**
 * How many holds of `label` the recordings have under each condition, from their session details: what is covered, and
 * which conditions a model has never been shown.
 */
export function coverageOf(datasets: DatasetSummary[], label: string): Coverage {
  const arms = [...optionsOf("arm"), NOT_SAID];
  const wrists = [...optionsOf("wrist"), NOT_SAID];
  const grid: Record<string, Record<string, number>> = Object.fromEntries(arms.map((arm) => [arm, Object.fromEntries(wrists.map((wrist) => [wrist, 0]))]));
  const others: SessionField[] = ["activity", "strap", "pinch"];
  const tallies = new Map<SessionField, Map<string, number>>(others.map((field) => [field, new Map()]));
  let total = 0;
  let recordings = 0;
  for (const dataset of datasets) {
    const holds = dataset.quality?.holds[label] ?? 0;
    if (holds === 0) continue;
    recordings += 1;
    total += holds;
    const context = dataset.context ?? {};
    const arm = arms.includes(context.arm ?? NOT_SAID) ? context.arm ?? NOT_SAID : NOT_SAID;
    const wrist = wrists.includes(context.wrist ?? NOT_SAID) ? context.wrist ?? NOT_SAID : NOT_SAID;
    grid[arm][wrist] += holds;
    for (const field of others) {
      const value = (context[field] ?? NOT_SAID).toLowerCase();
      const tally = tallies.get(field)!;
      tally.set(value, (tally.get(value) ?? 0) + holds);
    }
  }
  return {
    grid,
    arms,
    wrists,
    byField: others.map((field) => ({
      field,
      title: SESSION_FIELDS.find((spec) => spec.field === field)!.title,
      counts: [...tallies.get(field)!.entries()].sort((a, b) => b[1] - a[1]),
    })),
    total,
    recordings,
  };
}

/** The title of a detail's value, or "not said". */
export function valueTitle(field: SessionField, value: string): string {
  if (value === NOT_SAID) return "not said";
  return SESSION_FIELDS.find((spec) => spec.field === field)?.options?.find((option) => option.value === value)?.title ?? value;
}

/** One condition (arm and wrist) of a training split: how many holds of the label train, and how many test. */
export interface SplitCondition {
  arm: string;
  wrist: string;
  train: number;
  test: number;
}

/**
 * A training split's coverage of `label` by arm and wrist: where the test has a condition the model never trains on, its
 * score there says how it copes with something new; where training has one the test lacks, the score says nothing of it.
 */
export function splitCoverage(datasets: DatasetSummary[], trainIds: string[], testIds: string[], label: string): SplitCondition[] {
  const train = coverageOf(datasets.filter((dataset) => trainIds.includes(dataset.id)), label);
  const test = coverageOf(datasets.filter((dataset) => testIds.includes(dataset.id)), label);
  const rows: SplitCondition[] = [];
  for (const arm of train.arms) {
    for (const wrist of train.wrists) {
      const row = { arm, wrist, train: train.grid[arm][wrist], test: test.grid[arm][wrist] };
      if (row.train > 0 || row.test > 0) rows.push(row);
    }
  }
  return rows;
}
