import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { SectionHeader } from "../../components/app/SectionHeader";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import type { DatasetSummary } from "../model-lab/types";

/**
 * Where this recording's labels stand: reviewed, or needing work (with what is left to do). Model Lab shows it beside each
 * recording and can list the ones nobody has checked.
 */
export function ReviewStatus({ dataset, dirty, onChanged }: { dataset: DatasetSummary; dirty: boolean; onChanged: (updated: DatasetSummary) => void }) {
  const [note, setNote] = useState(dataset.review?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setNote(dataset.review?.note ?? ""), [dataset.id, dataset.review?.note]);

  const set = async (status: "reviewed" | "needs_work" | null) => {
    setError(null);
    try {
      onChanged(await invoke<DatasetSummary>("set_dataset_review", { id: dataset.id, status, note: status === "needs_work" ? note : null }));
    } catch (err) {
      setError(String(err));
    }
  };
  const review = dataset.review;
  return (
    <Card role="region" aria-label="Review">
      <CardHeader>
        <SectionHeader
          title="Review"
          description="Say where this recording's labels stand once you have looked through it, so Model Lab can tell you which recordings nobody has checked."
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <p>
          {review?.status === "reviewed"
            ? `Labels reviewed (${review.at.slice(0, 10)}).`
            : review?.status === "needs_work"
              ? `Labels need work${review.note ? `: ${review.note}` : ""} (${review.at.slice(0, 10)}).`
              : "Not reviewed yet."}
          {dirty ? " Save your labels first: the review is of the recording as it is saved." : ""}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={dirty} onClick={() => void set("reviewed")}>Labels are right</Button>
          <Input aria-label="What still needs doing" placeholder="What still needs doing" className="max-w-sm" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
          <Button size="sm" variant="outline" disabled={dirty} onClick={() => void set("needs_work")}>Needs work</Button>
          {review && <Button size="sm" variant="ghost" onClick={() => void set(null)}>Clear</Button>}
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}
      </CardContent>
    </Card>
  );
}
