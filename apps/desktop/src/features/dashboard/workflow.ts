import { hasProblem } from "../model-lab/recordingFilters";
import type { DatasetSummary } from "../model-lab/types";

/** One step of making a model, from recording to the final test. */
export interface WorkflowStep {
  key: "record" | "label" | "clean" | "train" | "test";
  title: string;
  status: string;
  complete: boolean;
  tab: "recorder" | "labelling" | "modelLab";
  action: string;
}

/** Fewer recordings than this is too few to train and test on different ones. */
const ENOUGH_RECORDINGS = 4;

/** Where each step stands, from what the app has: recordings, their reviews and problems, models and final tests. */
export function workflowSteps(input: { recorderRecordings: number; datasets: DatasetSummary[]; models: number; finalTests: number }): WorkflowStep[] {
  const { datasets } = input;
  const reviewed = datasets.filter((dataset) => dataset.review?.status === "reviewed").length;
  const needsWork = datasets.filter((dataset) => dataset.review?.status === "needs_work").length;
  const problems = datasets.filter((dataset) => hasProblem(dataset, datasets)).length;
  const sealed = datasets.filter((dataset) => dataset.sealed).length;
  return [
    {
      key: "record",
      title: "Record",
      status: `${input.recorderRecordings} from the Recorder, ${datasets.length} in Model Lab${datasets.length < ENOUGH_RECORDINGS ? `: record at least ${ENOUGH_RECORDINGS}, in different conditions` : ""}.`,
      complete: datasets.length >= ENOUGH_RECORDINGS,
      tab: "recorder",
      action: "Record →",
    },
    {
      key: "label",
      title: "Label",
      status: datasets.length === 0 ? "Nothing to label yet." : `${reviewed} of ${datasets.length} reviewed${needsWork > 0 ? `, ${needsWork} need work` : ""}.`,
      complete: datasets.length > 0 && reviewed === datasets.length,
      tab: "labelling",
      action: "Label →",
    },
    {
      key: "clean",
      title: "Clean",
      status: problems === 0 ? "Nothing to fix." : `${problems} recording${problems === 1 ? " has" : "s have"} something to fix: copies, poor contact, stalls or short holds.`,
      complete: datasets.length > 0 && problems === 0,
      tab: "modelLab",
      action: "See recordings →",
    },
    {
      key: "train",
      title: "Train",
      status: input.models === 0 ? "No model yet." : `${input.models} model${input.models === 1 ? "" : "s"}.`,
      complete: input.models > 0,
      tab: "modelLab",
      action: "Train →",
    },
    {
      key: "test",
      title: "Final test",
      status: sealed === 0 ? "No day sealed for it yet." : `${sealed} sealed recording${sealed === 1 ? "" : "s"}, ${input.finalTests} test${input.finalTests === 1 ? "" : "s"} so far.`,
      complete: input.finalTests > 0,
      tab: "modelLab",
      action: "Final test →",
    },
  ];
}
