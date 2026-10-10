import { Alert, AlertDescription } from "../../components/ui/alert";
import type { UsageTab } from "../model-lab/components/LabelCoverage";
import { LabelCoverage } from "../model-lab/components/LabelCoverage";
import { useLabelCatalogue } from "./useLabelCatalogue";

/**
 * Every label in one place. A label is a name for something the app can learn or recognise (a gesture, or an everyday
 * activity to tell it apart from). Recordings, the Gesture library, Model Lab and recipes all read this list, so a label
 * made here is available everywhere and renaming it here renames it everywhere.
 */
export function LabelsPage({ onOpen }: { onOpen?: (tab: UsageTab) => void }) {
  const catalogue = useLabelCatalogue();
  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Labels</h1>
          <p className="subtitle">The names of the gestures and activities the app knows. Make them here once and use them in recordings, the Gesture library, Model Lab and recipes. Recording and training happen in their own tabs.</p>
        </div>
      </header>
      {!catalogue.desktopAvailable && (
        <Alert role="status"><AlertDescription>Labels are kept by the desktop app, so they are unavailable in browser preview.</AlertDescription></Alert>
      )}
      {catalogue.error && <Alert variant="destructive" role="alert"><AlertDescription>{catalogue.error}</AlertDescription></Alert>}
      <LabelCoverage
        labels={catalogue.labels}
        models={catalogue.models}
        coverageByLabel={catalogue.coverageByLabel}
        gestureCountByLabel={catalogue.gestureCountByLabel}
        recorderCountByLabel={catalogue.recorderCountByLabel}
        usageFor={catalogue.usageFor}
        planFor={catalogue.planFor}
        onRunPlan={catalogue.execute}
        onOpenTab={onOpen}
        onCreate={catalogue.create}
        onUpdate={catalogue.update}
        onSetArchived={catalogue.setArchived}
        onDelete={catalogue.remove}
      />
    </main>
  );
}
