import { SectionHeader } from "../../components/app/SectionHeader";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader } from "../../components/ui/card";
import type { MeasureSample } from "./calibration";
import { checkLibrary } from "./confusion";
import type { GestureDefinition } from "./definition";

const percent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * Checks the library's gestures against each other: for every pair, how often one gesture's rule would fire on the
 * frames the other was recorded with. A high number means the two will be mistaken for each other. It uses the frames
 * kept when each gesture was calibrated, so a gesture calibrated before they were kept has to be recorded again to
 * take part.
 */
export function LibraryCheckPanel({ definitions, samples }: { definitions: GestureDefinition[]; samples: Record<string, MeasureSample[]> }) {
  if (definitions.length < 2) return null;
  const check = checkLibrary(definitions, samples);
  return (
    <Card role="region" aria-label="Library check">
      <CardHeader>
        <SectionHeader
          title="Library check"
          description="Which gestures would be mistaken for each other"
          help={{
            label: "About the library check",
            content: "Each gesture's rule is tried on the frames every other gesture was recorded with. If a rule fires on a large share of another gesture's frames, the two will be confused when you make either one. Fix a pair by recording one again so it differs more (for example the thumb up versus the thumb tucked in), or by changing a threshold. The check uses the start thresholds only, so it is slightly stricter than live recognition, which also needs the pose to be held. Gestures calibrated before their frames were kept are not included until you record them again.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {check.checked < 2 ? (
          <p className="hint" role="status">Needs two gestures calibrated with this version. Edit a gesture and record it again to include it.</p>
        ) : check.pairs.length === 0 ? (
          <p role="status"><Badge>All clear</Badge> None of the {check.checked} checked gestures fires on another's frames (more than {percent(0.1)}).</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Gestures that would be confused">
            {check.pairs.map((pair) => (
              <li key={`${pair.rule.id}>${pair.on.id}`} className="flex flex-wrap items-center gap-2">
                <Badge variant={pair.severity === "bad" ? "destructive" : "secondary"}>{percent(pair.firesOn)}</Badge>
                <span>“{pair.rule.name}” also fires on “{pair.on.name}” frames{pair.severity === "bad" ? ": they will be mixed up." : "."}</span>
              </li>
            ))}
          </ul>
        )}
        {check.checked >= 2 && check.recall.length > 0 && (
          <p className="field-hint">
            Each gesture finds: {check.recall.map((r) => `${r.gesture.name} ${percent(r.finds)}`).join(", ")} of its own recorded frames.
          </p>
        )}
        {check.unchecked.length > 0 && (
          <p className="field-hint" role="status">Not in the check (no saved frames): {check.unchecked.map((g) => g.name).join(", ")}. Edit and record {check.unchecked.length === 1 ? "it" : "them"} again to include {check.unchecked.length === 1 ? "it" : "them"}.</p>
        )}
      </CardContent>
    </Card>
  );
}
