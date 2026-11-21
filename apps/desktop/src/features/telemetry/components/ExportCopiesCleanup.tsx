import { useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import { chooseExportFolder } from "../../../shared/tauri/exportCsv";
import { CopyGroupsList, moveLabel, useCopyCleanup } from "../../duplicates/copyCleanup";

/**
 * Finds copies of the same recording in an export folder (the same sensor samples, whatever their names or labels) and
 * moves the older ones to the Trash, keeping the newest of each, or the one you pick. Nothing goes until you confirm, and
 * only copies directly in that folder are ever touched, never the app's own recordings. The Duplicates tab does the same
 * for a whole tree of folders.
 */
export function ExportCopiesCleanup({ folder }: { folder: string | null }) {
  const [open, setOpen] = useState(false);
  const cleanup = useCopyCleanup();

  const scan = (target: string) => {
    setOpen(true);
    void cleanup.scan(target);
  };

  const scanAnother = async () => {
    const picked = await chooseExportFolder("Find copies in");
    if (picked) scan(picked);
  };

  const trash = async () => {
    if (await cleanup.trash()) setOpen(false);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={!folder || cleanup.busy} onClick={() => folder && scan(folder)}>
          Find duplicate copies…
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={cleanup.busy} onClick={() => void scanAnother()}>
          In another folder…
        </Button>
      </div>
      <AlertDialog open={open} onOpenChange={(next) => !cleanup.busy && setOpen(next)}>
        <AlertDialogContent className="data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Copies of the same recording</AlertDialogTitle>
            <AlertDialogDescription className="break-all">
              {cleanup.scanned ? `In ${cleanup.scanned.folder}. ` : ""}
              Copies hold the same sensor samples, whatever their names or labels. The newest of each is kept; the rest go to the Trash, where you can get them back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-[55vh] overflow-y-auto">
            <CopyGroupsList cleanup={cleanup} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cleanup.busy}>Cancel</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={cleanup.busy || cleanup.removing.length === 0} onClick={() => void trash()}>
              {moveLabel(cleanup.removing.length)}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
