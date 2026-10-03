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
} from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";

type ApplySettingsFooterProps = {
  /** Edited fields that differ from what is applied. */
  dirtyCount: number;
  /** Of those, how many cannot be applied as typed. */
  invalidCount: number;
  applyPending: boolean;
  resetPending: boolean;
  onDiscard: () => void;
  onReset: () => void;
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The form's action bar: says how many edits are waiting (and how many cannot be applied as typed),
 * applies them together on submit (a submit button, so Enter in any field works), discards them,
 * or restores every default after explicit confirmation. Stays in view while the page scrolls.
 */
export function ApplySettingsFooter({
  dirtyCount,
  invalidCount,
  applyPending,
  resetPending,
  onDiscard,
  onReset,
}: ApplySettingsFooterProps) {
  const busy = applyPending || resetPending;
  const status =
    invalidCount > 0
      ? `${plural(invalidCount, "field needs", "fields need")} attention before ${invalidCount === 1 ? "it" : "they"} can be applied.`
      : dirtyCount > 0
        ? `${plural(dirtyCount, "change", "changes")} not applied yet.`
        : "All changes are applied.";

  return (
    <Card role="region" aria-label="Apply or reset settings" className="settings-footer">
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <p className={invalidCount > 0 ? "field-error" : "hint"} role="status" aria-live="polite">{status}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy || dirtyCount === 0}>
            {applyPending ? "Applying…" : "Apply changes"}
          </Button>
          <Button type="button" variant="outline" disabled={busy || dirtyCount === 0} onClick={onDiscard}>
            Discard changes
          </Button>
          <AlertDialog>
            <AlertDialogTrigger
              render={<Button type="button" variant="ghost" disabled={busy}>{resetPending ? "Resetting…" : "Reset to defaults"}</Button>}
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset all settings to defaults?</AlertDialogTitle>
                <AlertDialogDescription>
                  This restores every rate and wrist-rotation value to its factory default. Sensor switches
                  and any unsaved edits in the fields above will be discarded.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep current settings</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={onReset}>
                  Reset to defaults
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}
