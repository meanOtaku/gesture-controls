import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { OperationFeedback } from "../../components/app/OperationFeedback";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import type { DatasetLabel } from "../model-lab/types";

type Props = {
  /** The label chosen for the next recording, if any. */
  selectedLabel: string | null;
  /** Chooses a label; resolves true when it was accepted. */
  onSelect: (label: string) => boolean;
  disabled?: boolean;
};

/**
 * Offers the labels from the Labels tab as buttons, so a recording uses the same names as the rest of the app. A label
 * typed by hand that is not in that list yet can be added to it from here.
 */
export function CatalogueLabelPicker({ selectedLabel, onSelect, disabled }: Props) {
  const [labels, setLabels] = useState<DatasetLabel[] | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await invoke<DatasetLabel[]>("list_model_labels");
      setLabels(Array.isArray(all) ? all : []);
    } catch {
      setLabels([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (labels === null) return null;
  const live = labels.filter((label) => label.archivedAt === null);
  const missing = selectedLabel !== null && !labels.some((label) => label.id === selectedLabel);

  const addSelected = async () => {
    if (!selectedLabel) return;
    try {
      await invoke("create_model_label", {
        input: { id: selectedLabel.slice(0, 48), displayName: selectedLabel.replaceAll("_", " "), description: "", color: "#65e6ff", role: "positiveGesture" },
      });
      OperationFeedback.success("Add label", `Added ${selectedLabel} to Labels.`);
      await load();
    } catch (error) {
      OperationFeedback.error("Add label", String(error));
    }
  };

  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Labels from the Labels tab">
      <Label className="text-xs text-muted-foreground w-full">Your labels (from the Labels tab)</Label>
      {live.length === 0 ? (
        <p className="field-hint">No labels yet. Add them on the Labels tab and they appear here.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {live.map((label) => (
            <Button key={label.id} type="button" size="sm" className="text-xs" disabled={disabled} variant={selectedLabel === label.id ? "default" : "outline"} onClick={() => onSelect(label.id)}>
              {label.displayName}
            </Button>
          ))}
        </div>
      )}
      {missing && (
        <p className="field-hint">
          “{selectedLabel}” is not in your Labels list, so models and the Gesture library cannot use it.{" "}
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => void addSelected()}>Add to Labels</Button>
        </p>
      )}
    </div>
  );
}
