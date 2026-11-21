import { useState } from "react";
import { OperationFeedback } from "../../components/app/OperationFeedback";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import { basename, scanExportCopies, trashExportCopies, type CopyGroup, type ExportCopy } from "../../shared/tauri/exportCopies";

function when(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : "unknown";
}

function details(copy: ExportCopy): string {
  const labels = copy.labels.length > 0 ? copy.labels.join(", ") : "no labels";
  const hand = copy.handLabelledRows > 0 ? `${copy.handLabelledRows.toLocaleString()} hand-labelled rows` : "no hand labels";
  const edited = copy.relabelledAfterExport ? " · relabelled after export" : "";
  const form = copy.kind === "csv" ? " · one CSV" : copy.csvPath ? " · with its CSV" : "";
  const from = copy.exportedFrom === "labelling" ? " · exported from Labelling" : copy.exportedFrom === "recorder" ? " · exported from the Recorder" : "";
  return `last changed ${when(copy.modifiedMs)} · ${hand} · ${labels}${from}${edited}${form}`;
}

/** The folder a copy is in, below the scanned folder ("" when directly in it). */
function folderOf(copy: ExportCopy): string {
  const parts = copy.name.split(/[\\/]/);
  return parts.slice(0, -1).join("/");
}

/**
 * Scanning a folder for copies of the same recording and moving the chosen older ones to the Trash: what the Duplicates tab
 * and the Exports card's clean-up share. Where the newest copy is known it is chosen to keep; otherwise nothing is chosen,
 * and that recording is left alone until the person picks.
 */
export function useCopyCleanup() {
  const [scanned, setScanned] = useState<{ folder: string; subfolders: boolean } | null>(null);
  const [groups, setGroups] = useState<CopyGroup[] | null>(null);
  const [keep, setKeep] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const scan = async (folder: string, subfolders = false) => {
    setScanned({ folder, subfolders });
    setGroups(null);
    setError(null);
    setBusy(true);
    try {
      const found = await scanExportCopies(folder, subfolders);
      setGroups(found);
      setKeep(Object.fromEntries(found.filter((group) => group.newestKnown).map((group) => [group.signal, group.copies[0].path])));
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };

  const removing = (groups ?? []).flatMap((group) => (keep[group.signal] ? group.copies.filter((copy) => copy.path !== keep[group.signal]) : []));
  const undecided = (groups ?? []).filter((group) => !keep[group.signal]).length;

  /** Moves the chosen older copies to the Trash; true when every one went. The folder is scanned again afterwards. */
  const trash = async (): Promise<boolean> => {
    if (!scanned || removing.length === 0) return false;
    setBusy(true);
    let done = false;
    try {
      const outcome = await trashExportCopies(scanned.folder, removing.map((copy) => copy.path), scanned.subfolders);
      // A copy and its CSV are one copy.
      const moved = removing.filter((copy) => outcome.moved.includes(copy.path)).length;
      if (outcome.error) OperationFeedback.error("Clean up copies", `Moved ${moved} to the Trash, then stopped: ${outcome.error}`);
      else OperationFeedback.success("Clean up copies", `Moved ${moved} older ${moved === 1 ? "copy" : "copies"} to the Trash.`);
      done = !outcome.error;
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
    return done;
  };

  const choose = (signal: string, path: string) => setKeep((was) => ({ ...was, [signal]: path }));

  return { scanned, groups, keep, choose, error, busy, scan, trash, removing, undecided };
}

export type CopyCleanup = ReturnType<typeof useCopyCleanup>;

/** What a scan found: each recording's copies, newest first, with the one to keep chosen (or to be chosen). */
export function CopyGroupsList({ cleanup }: { cleanup: CopyCleanup }) {
  const { groups, keep, choose, busy, error, undecided } = cleanup;
  return (
    <div className="text-sm" aria-live="polite">
      {busy && !groups ? <p className="hint">Reading every recording in the folder… a large one takes a while.</p> : null}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      {groups && groups.length === 0 ? <p>No recording has more than one copy here.</p> : null}
      {groups?.map((group) => {
        const kept = keep[group.signal];
        const newest = group.copies[0].path;
        const keptCopy = group.copies.find((copy) => copy.path === kept);
        const moreHandLabels = keptCopy ? group.copies.filter((copy) => copy.path !== kept && copy.handLabelledRows > keptCopy.handLabelledRows) : [];
        const folders = new Set(group.copies.map(folderOf));
        return (
          <section key={group.signal} aria-label={`Copies of ${group.copies[0].name}`} className="mb-3 rounded-md border p-2">
            {!group.newestKnown ? (
              <p className="mb-1 text-xs font-medium">These copies have different labels, and nothing about them (file times, names, which page exported them) says which came later. Choose the one to keep; until you do, none of them is touched.</p>
            ) : group.newestReason ? (
              <p className="mb-1 text-xs text-muted-foreground">{basename(newest)}: {group.newestReason}</p>
            ) : null}
            {folders.size > 1 ? (
              <p className="mb-1 text-xs text-muted-foreground">The copies are in different folders ({[...folders].map((f) => f || "this folder").join(", ")}): one may be there on purpose, such as a relabelled set.</p>
            ) : null}
            <RadioGroup value={kept ?? ""} onValueChange={(value) => choose(group.signal, value)} aria-label={`Which copy of ${group.copies[0].name} to keep`}>
              {group.copies.map((copy) => (
                <label key={copy.path} className="flex items-start gap-2 py-1">
                  <RadioGroupItem value={copy.path} aria-label={`Keep ${copy.name}`} className="mt-0.5" disabled={busy} />
                  <span className="min-w-0">
                    <span className="font-mono text-xs break-all">{copy.name}</span>{" "}
                    <span className={copy.path === kept ? "font-medium" : "text-muted-foreground"}>{!kept ? "" : copy.path === kept ? "kept" : "to the Trash"}</span>
                    <span className="block text-xs text-muted-foreground">{details(copy)}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
            {kept && group.newestKnown && kept !== newest ? <p className="text-xs text-destructive">You are keeping an older copy: the newest ({basename(newest)}) goes to the Trash.</p> : null}
            {keptCopy && moreHandLabels.length > 0 ? (
              <p className="text-xs text-destructive">
                {moreHandLabels.map((copy) => copy.name).join(", ")} {moreHandLabels.length === 1 ? "has" : "have"} more hand-labelled rows than the copy kept ({keptCopy.handLabelledRows.toLocaleString()}). Fine if you tightened the labels; check before moving.
              </p>
            ) : null}
          </section>
        );
      })}
      {undecided > 0 && groups && groups.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {undecided === 1 ? "1 recording needs" : `${undecided} recordings need`} you to choose the copy to keep; {undecided === 1 ? "it is" : "they are"} left as {undecided === 1 ? "it is" : "they are"} until then.
        </p>
      ) : null}
    </div>
  );
}

export function moveLabel(count: number): string {
  return count === 1 ? "Move 1 copy to the Trash" : `Move ${count} copies to the Trash`;
}
