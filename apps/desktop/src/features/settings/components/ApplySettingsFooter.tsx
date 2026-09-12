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
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SectionHeader } from "../../../components/app/SectionHeader";

type ApplySettingsFooterProps = {
  applyPending: boolean;
  resetPending: boolean;
  onApply: () => void;
  onReset: () => void;
};

/** Commits every edited rate together, or restores defaults after explicit confirmation. */
export function ApplySettingsFooter({ applyPending, resetPending, onApply, onReset }: ApplySettingsFooterProps) {
  const busy = applyPending || resetPending;

  return (
    <Card role="region" aria-label="Apply or reset settings">
      <CardHeader>
        <SectionHeader title="Apply rate changes" description="Runtime configuration" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="hint">Applies every edited rate to its corresponding desktop or Watch stream.</p>
        <div className="recording-actions">
          <Button type="button" disabled={busy} onClick={onApply}>
            {applyPending ? "Applying…" : "Apply rates"}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger
              render={<Button type="button" variant="outline" disabled={busy}>{resetPending ? "Resetting…" : "Reset to defaults"}</Button>}
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
