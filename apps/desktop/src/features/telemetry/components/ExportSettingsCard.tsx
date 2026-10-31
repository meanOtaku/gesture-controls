import { useSyncExternalStore } from "react";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group";
import { chooseExportFolder, isTauriDesktop } from "../../../shared/tauri/exportCsv";
import { exportFolderStore, type ExportFormat } from "../store/exportFolderStore";

/**
 * Where exports go and in what form: one setting for every export (the Recorder's Export button, the export at the end of a
 * timed or guided recording, and the Labelling page's Export). Changing it here changes it everywhere, and it is remembered.
 */
export function ExportSettingsCard({ compact = false }: { compact?: boolean }) {
  const folder = useSyncExternalStore(exportFolderStore.subscribe, exportFolderStore.get, exportFolderStore.get);
  const format = useSyncExternalStore(exportFolderStore.subscribe, exportFolderStore.getFormat, exportFolderStore.getFormat);
  const desktop = isTauriDesktop();

  const choose = async () => {
    const picked = await chooseExportFolder("Choose where exports go");
    if (picked) exportFolderStore.set(picked);
  };

  const controls = (
    <div className="flex flex-col gap-3 text-sm">
      {desktop ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="label">Export folder</span>
          <span className="truncate max-w-[28rem] font-mono text-xs" title={folder ?? undefined}>{folder ?? "Not chosen"}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void choose()}>{folder ? "Change…" : "Choose…"}</Button>
        </div>
      ) : (
        <p className="hint">The browser preview has no folder picker: it downloads one CSV file.</p>
      )}
      <RadioGroup
        value={desktop ? format : "csv"}
        onValueChange={(value) => exportFolderStore.setFormat(value as ExportFormat)}
        className="flex flex-wrap gap-4"
        aria-label="Export as"
      >
        <label className="flex items-center gap-2"><RadioGroupItem value="folder" disabled={!desktop} /> Folder of two files (ppg.csv, imu.csv)</label>
        <label className="flex items-center gap-2"><RadioGroupItem value="csv" disabled={!desktop} /> One CSV</label>
      </RadioGroup>
    </div>
  );

  if (compact) return controls;
  return (
    <Card role="region" aria-label="Exports" className="min-w-0">
      <CardHeader>
        <CardTitle>Exports</CardTitle>
        <CardDescription>
          Where every export goes, and in what form: the Export button, the export when a timed or guided recording ends, and
          the Labelling page&apos;s Export. A folder of two files is what Model Lab imports; one CSV is the older format.
          Recordings are also saved in the app either way.
        </CardDescription>
      </CardHeader>
      <CardContent>{controls}</CardContent>
    </Card>
  );
}
