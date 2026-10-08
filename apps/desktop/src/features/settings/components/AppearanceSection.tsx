import { useId, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { SegmentedControl } from "../../../components/app/SegmentedControl";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { THEMES, readTheme, saveTheme, type AppTheme } from "../../../shared/theme/theme";

/** Which look the app has. It applies at once and is remembered on this computer; it is not part of the settings you apply. */
export function AppearanceSection() {
  const labelId = useId();
  const [theme, setTheme] = useState<AppTheme>(readTheme);

  const choose = (next: AppTheme) => {
    setTheme(next);
    saveTheme(next);
  };

  return (
    <Card role="region" aria-label="Appearance">
      <CardHeader>
        <SectionHeader
          title="Appearance"
          description="How the app looks"
          help={{
            label: "About appearance",
            content: "Changes the colours and outlines only. It applies immediately and is remembered on this computer. The floating volume knob keeps its own look.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="field">
          <div className="field-head"><span id={labelId} className="label">Theme</span></div>
          <SegmentedControl labelledBy={labelId} value={theme} options={THEMES.map(({ value, label }) => ({ value, label }))} onValueChange={choose} />
          <p className="field-hint">{THEMES.find((option) => option.value === theme)?.summary}</p>
        </div>
      </CardContent>
    </Card>
  );
}
