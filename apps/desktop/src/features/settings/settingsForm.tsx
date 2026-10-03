import { createContext, useContext } from "react";
import { NumberField } from "../../components/app/NumberField";
import type { NumberDrafts } from "../../shared/forms/useNumberDrafts";
import { SETTINGS_FIELDS, type NumericSettingKey } from "./settingsFields";

export type SettingsDrafts = NumberDrafts<NumericSettingKey>;

const SettingsFormContext = createContext<SettingsDrafts | null>(null);

export const SettingsFormProvider = SettingsFormContext.Provider;

/** The id of a setting's input, so a failed submit can move focus to it. */
export const settingInputId = (name: NumericSettingKey) => `setting-${name}`;

/** One numeric setting, wired to the page's shared draft state. */
export function SettingsNumberField({ name }: { name: NumericSettingKey }) {
  const drafts = useContext(SettingsFormContext);
  if (!drafts) throw new Error("SettingsNumberField must be rendered inside a SettingsFormProvider");
  return (
    <NumberField
      id={settingInputId(name)}
      spec={SETTINGS_FIELDS[name]}
      state={drafts.fields[name]}
      onChange={(text) => drafts.setText(name, text)}
      onBlur={() => drafts.touch(name)}
      onResetToDefault={() => drafts.resetToDefault(name)}
    />
  );
}
