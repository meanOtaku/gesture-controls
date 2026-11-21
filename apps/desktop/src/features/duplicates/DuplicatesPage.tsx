import { useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription } from "../../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { chooseExportFolder, isTauriDesktop } from "../../shared/tauri/exportCsv";
import { exportFolderStore } from "../telemetry/store/exportFolderStore";
import { CopyGroupsList, moveLabel, useCopyCleanup } from "./copyCleanup";

/**
 * Duplicate recordings in a datasets folder: copies of the same recording (the same sensor samples, whatever their names or
 * labels), in the folder and, if you like, every folder below it, as exported folders or older single CSVs. For each, the
 * newest is chosen to keep when that can be told; you can pick another, and nothing goes until you confirm. The rest go to
 * the Trash. The app's own recordings are never scanned or touched here.
 */
export function DuplicatesPage() {
  const desktop = isTauriDesktop();
  const exportFolder = useSyncExternalStore(exportFolderStore.subscribe, exportFolderStore.get, exportFolderStore.get);
  const [picked, setPicked] = useState<string | null>(null);
  const [subfolders, setSubfolders] = useState(true);
  const cleanup = useCopyCleanup();
  const folder = picked ?? exportFolder;

  const choose = async () => {
    const chosen = await chooseExportFolder("Find duplicates in");
    if (chosen) setPicked(chosen);
  };

  const scan = () => {
    if (folder) void cleanup.scan(folder, subfolders);
  };

  const trash = async () => {
    const scanned = cleanup.scanned;
    if ((await cleanup.trash()) && scanned) void cleanup.scan(scanned.folder, scanned.subfolders);
  };

  const groups = cleanup.groups;
  const older = (groups ?? []).reduce((sum, group) => sum + group.copies.length - 1, 0);

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <h1>Duplicates</h1>
          <p className="subtitle">Find copies of the same recording in a datasets folder, keep the newest and move the rest to the Trash.</p>
        </div>
      </header>
      {!desktop ? (
        <Alert role="status"><AlertDescription>Scanning folders needs the desktop app.</AlertDescription></Alert>
      ) : null}
      <Card role="region" aria-label="Folder to scan">
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label">Folder</span>
            <span className="min-w-0 break-all font-mono text-xs" title={folder ?? undefined}>{folder ?? "Not chosen"}</span>
            <Button type="button" variant="outline" size="sm" disabled={!desktop || cleanup.busy} onClick={() => void choose()}>{folder ? "Change…" : "Choose…"}</Button>
            {picked && exportFolder && picked !== exportFolder ? (
              <Button type="button" variant="ghost" size="sm" disabled={cleanup.busy} onClick={() => setPicked(null)}>Use the export folder</Button>
            ) : null}
          </div>
          <label className="flex items-center gap-2">
            <Checkbox checked={subfolders} disabled={cleanup.busy} onCheckedChange={(on) => setSubfolders(Boolean(on))} aria-label="Include subfolders" />
            Include subfolders (copies in different folders are grouped too)
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled={!desktop || !folder || cleanup.busy} onClick={scan}>{cleanup.busy && !groups ? "Scanning…" : "Scan"}</Button>
            {groups ? (
              <span className="hint">
                {groups.length === 0 ? "Nothing to clean up." : `${groups.length} ${groups.length === 1 ? "recording has" : "recordings have"} copies: ${older} older ${older === 1 ? "copy" : "copies"}.`}
              </span>
            ) : null}
          </div>
          <p className="hint">
            Copies hold the same sensor samples, whatever their names or labels; relabelling changes only the label columns. Exported folders and older single CSVs are read; nothing is changed by a scan. If the folder is tracked by git or listed in a manifest (such as data/recordings.manifest.json), update those after a clean-up.
          </p>
        </CardContent>
      </Card>
      {cleanup.scanned ? (
        <Card role="region" aria-label="Duplicates found" className="mt-3">
          <CardContent className="flex flex-col gap-3">
            <CopyGroupsList cleanup={cleanup} />
            {groups && groups.length > 0 ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button type="button" variant="destructive" disabled={cleanup.busy || cleanup.removing.length === 0}>{moveLabel(cleanup.removing.length)}</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{moveLabel(cleanup.removing.length)}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The copies marked “to the Trash” go to the Trash, where you can get them back. The copy kept of each recording stays where it is
                        {cleanup.undecided > 0 ? `, and the ${cleanup.undecided} ${cleanup.undecided === 1 ? "recording" : "recordings"} still waiting for your choice ${cleanup.undecided === 1 ? "is" : "are"} left alone` : ""}.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep them</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={() => void trash()}>Move to the Trash</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </main>
  );
}
