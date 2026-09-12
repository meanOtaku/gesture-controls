import { AsyncActionButton } from "../../../components/app/AsyncActionButton";
import { Badge } from "../../../components/ui/badge";
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
      {DEPLOYABLE_CLASS_LABELS.map((classLabel) => {
        const existing = model.intentBindings.find((entry) => entry.classLabel === classLabel);
        const draftIntent = draft?.[classLabel];
        const currentIntent = draftIntent ?? existing?.intent ?? "noAction";
        const options = ALLOWED_INTENTS_FOR_CLASS[classLabel] ?? [];
        return (
          <div className="model-lab-label-row" key={classLabel}>
            <span className="label">{classLabel.replaceAll("_", " ")}</span>
            {editable ? (
              <select
                aria-label={`${classLabel} intent for ${model.id}`}
                value={currentIntent}
                onChange={(event) => onDraftChange(classLabel, event.target.value as GestureIntent)}
              >
                {options.map((intent) => (
                  <option key={intent} value={intent}>
                    {INTENT_COPY[intent]}
                  </option>
                ))}
              </select>
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
