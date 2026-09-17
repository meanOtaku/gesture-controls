import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { HelpTooltip } from "../../../components/app/HelpTooltip";
import {
  LEGACY_COMPATIBILITY_LABEL_MAPPING,
  DEPLOYABLE_CLASS_LABELS,
  missingLabelMappings,
  type DatasetLabel,
  type LabelMapping,
  type LabelMappingEntry,
} from "../types";

type LabelMappingEditorProps = {
  selectedDatasetLabels: Set<string>;
  labels: DatasetLabel[];
  mapping: LabelMapping;
  onMappingChange: (mapping: LabelMapping) => void;
};

/** Configure explicit training roles (target/negative/exclude) for labels before training starts.
 * Legacy-covered labels show as read-only; new labels must have an explicit role configured.
 * Prevents training until all required labels have a role assigned. */
export function LabelMappingEditor({
  selectedDatasetLabels,
  labels,
  mapping,
  onMappingChange,
}: LabelMappingEditorProps) {
  const unmapped = missingLabelMappings(mapping, selectedDatasetLabels);
  const hasUnmapped = unmapped.length > 0;

  const handleRoleChange = (labelId: string, role: "target" | "negative" | "exclude", target?: string) => {
    const newEntries = { ...mapping.entries };
    if (role === "target" && target) {
      newEntries[labelId] = { role: "target", target };
    } else if (role === "negative") {
      newEntries[labelId] = { role: "negative" };
    } else if (role === "exclude") {
      newEntries[labelId] = { role: "exclude" };
    }
    onMappingChange({ ...mapping, entries: newEntries });
  };

  const handleRemoveCustom = (labelId: string) => {
    const newEntries = { ...mapping.entries };
    delete newEntries[labelId];
    onMappingChange({ ...mapping, entries: newEntries });
  };

  return (
    <div aria-label="Training label role mapping" className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="label">Label training roles</span>
        <HelpTooltip label="About label training roles">
          Each collection label must be assigned an explicit training role: as a training target class, as negative
          examples, or excluded from this training run. Built-in labels show their legacy defaults; custom labels must
          be configured before training starts.
        </HelpTooltip>
      </div>

      {hasUnmapped && (
        <Badge variant="destructive">
          {unmapped.length} label{unmapped.length === 1 ? "" : "s"} need{unmapped.length === 1 ? "s" : ""} training
          role{unmapped.length === 1 ? "" : "s"}
        </Badge>
      )}

      <div className="vectors model-lab-labels">
        {Array.from(selectedDatasetLabels)
          .sort()
          .map((labelId) => {
            const label = labels.find((l) => l.id === labelId);
            const isLegacy = labelId in LEGACY_COMPATIBILITY_LABEL_MAPPING.entries;
            const entry = mapping.entries[labelId];
            const isMissing = !entry && !isLegacy;

            return (
              <div
                key={labelId}
                className={`vector-row model-lab-label-row ${isMissing ? "ring-1 ring-destructive" : ""}`}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="label">{label?.displayName || labelId}</span>
                    <code>{labelId}</code>
                    {isLegacy && <Badge variant="outline">Legacy default</Badge>}
                    {isMissing && <Badge variant="destructive">Needs assignment</Badge>}
                  </div>
                </div>

                {isLegacy && !entry ? (
                  <span className="hint">Using legacy default</span>
                ) : (
                  <div className="flex items-center gap-3">
                    <RadioGroup
                      value={entry?.role ?? (isLegacy ? "legacy" : "")}
                      onValueChange={(role) => {
                        if (role === "target") {
                          handleRoleChange(labelId, "target", "pinch_start");
                        } else if (role === "negative") {
                          handleRoleChange(labelId, "negative");
                        } else if (role === "exclude") {
                          handleRoleChange(labelId, "exclude");
                        }
                      }}
                      className="flex items-center gap-2"
                    >
                      <label className="flex items-center gap-2 cursor-pointer">
                        <RadioGroupItem value="target" id={`${labelId}-target`} />
                        <span className="text-sm">Target</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <RadioGroupItem value="negative" id={`${labelId}-negative`} />
                        <span className="text-sm">Negative</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <RadioGroupItem value="exclude" id={`${labelId}-exclude`} />
                        <span className="text-sm">Exclude</span>
                      </label>
                    </RadioGroup>

                    {entry?.role === "target" && (
                      <Select
                        value={entry.target}
                        onValueChange={(target) => handleRoleChange(labelId, "target", target)}
                      >
                        <SelectTrigger className="w-[150px]" aria-label={`Target class for ${labelId}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DEPLOYABLE_CLASS_LABELS.map((target) => (
                            <SelectItem key={target} value={target}>
                              {target.replaceAll("_", " ")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}

                    {entry && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleRemoveCustom(labelId)}
                      >
                        Reset to default
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
