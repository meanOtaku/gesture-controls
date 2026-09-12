import { AsyncActionButton } from "../../../components/app/AsyncActionButton";
import { HelpTooltip } from "../../../components/app/HelpTooltip";
import { Badge } from "../../../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import {
  ALLOWED_INTENTS_FOR_CLASS,
  DEPLOYABLE_CLASS_LABELS,
  INTENT_COPY,
  bindingsAreComplete,
  type GestureIntent,
  type ModelRegistryModel,
} from "../types";

type IntentBindingEditorProps = {
  model: ModelRegistryModel;
  editable: boolean;
  draft: Record<string, GestureIntent> | undefined;
  onDraftChange: (classLabel: string, intent: GestureIntent) => void;
  onSave: () => Promise<void>;
};

/** Per-model safe intent bindings: every deployable class maps to one of its allowed intents. */
export function IntentBindingEditor({ model, editable, draft, onDraftChange, onSave }: IntentBindingEditorProps) {
  const bindingsComplete = bindingsAreComplete(model.intentBindings);

  return (
    <div aria-label={`Safe intent bindings for ${model.id}`}>
      <div className="flex items-center gap-2">
        <span className="label">Safe intent bindings</span>
        <HelpTooltip label="About safe intent bindings">
          Each predicted class maps to one allowed system action. Only Live mode can act on these bindings, and only
          the intents listed here are ever offered — a model can never be bound to an action outside this fixed
          allow-list.
        </HelpTooltip>
      </div>
      {DEPLOYABLE_CLASS_LABELS.map((classLabel) => {
        const existing = model.intentBindings.find((entry) => entry.classLabel === classLabel);
        const draftIntent = draft?.[classLabel];
        const currentIntent = draftIntent ?? existing?.intent ?? "noAction";
        const options = ALLOWED_INTENTS_FOR_CLASS[classLabel] ?? [];
        return (
          <div className="model-lab-label-row" key={classLabel}>
            <span className="label">{classLabel.replaceAll("_", " ")}</span>
            {editable ? (
              <Select
                value={currentIntent}
                onValueChange={(value) => onDraftChange(classLabel, value as GestureIntent)}
              >
                <SelectTrigger aria-label={`${classLabel} intent for ${model.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((intent) => (
                    <SelectItem key={intent} value={intent}>
                      {INTENT_COPY[intent]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Badge variant="outline">{existing ? INTENT_COPY[existing.intent] : "Unbound"}</Badge>
            )}
          </div>
        );
      })}
      {editable && (
        <AsyncActionButton onPress={onSave} pendingLabel="Saving…">
          Save bindings
        </AsyncActionButton>
      )}
      {!bindingsComplete && <Badge variant="destructive">Bindings incomplete</Badge>}
    </div>
  );
}
