import { useId, useState } from "react";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import type { CascadePlan, CascadeResult } from "./labelCascade";

type Props = {
  plan: CascadePlan;
  onCancel: () => void;
  onRun: (plan: CascadePlan, onProgress: (done: number, total: number) => void) => Promise<CascadeResult>;
};

const TITLES = { archive: "Archive", delete: "Delete", restore: "Restore" } as const;

/**
 * The preview before archiving, deleting or restoring a label together with what uses it. Says exactly what will happen,
 * runs nothing until confirmed, and for a delete asks for the label's id to be typed.
 */
export function CascadePanel({ plan, onCancel, onRun }: Props) {
  const uid = useId();
  const [typed, setTyped] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const running = progress !== null && failure === null;
  const needsTyping = plan.mode === "delete" && plan.steps.length > 1;
  const blocked = plan.blockers.length > 0 || (needsTyping && typed.trim() !== plan.label);
  const title = `${TITLES[plan.mode]} “${plan.label}”`;

  const confirm = async () => {
    setFailure(null);
    setProgress({ done: 0, total: plan.steps.length });
    const result = await onRun(plan, (done, total) => setProgress({ done, total }));
    if (result.ok) onCancel();
    else setFailure(`${result.message} ${result.done} of ${plan.steps.length} steps were done before it stopped.`);
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" role="alertdialog" aria-label={title} aria-describedby={`${uid}-lines`}>
      <strong>{title} and what uses it</strong>
      <p className="text-sm">This is what will happen:</p>
      <ul id={`${uid}-lines`} className="list-disc pl-5 text-sm" aria-label="What will happen">
        {plan.lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
      {plan.blockers.length > 0 && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            <strong>It cannot go ahead yet.</strong>
            <ul className="list-disc pl-5">{plan.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
          </AlertDescription>
        </Alert>
      )}
      {needsTyping && plan.blockers.length === 0 && (
        <div className="field">
          <div className="field-head"><Label htmlFor={`${uid}-confirm`}>Type <code>{plan.label}</code> to confirm</Label></div>
          <Input id={`${uid}-confirm`} value={typed} autoComplete="off" spellCheck={false} onChange={(event) => setTyped(event.target.value)} />
        </div>
      )}
      {progress && !failure && <p className="hint" role="status">Working: {progress.done} of {progress.total} steps…</p>}
      {failure && <p className="field-error" role="alert">{failure}</p>}
      <div className="flex gap-2">
        <Button type="button" variant={plan.mode === "delete" ? "destructive" : "default"} disabled={blocked || running} onClick={() => void confirm()}>
          {TITLES[plan.mode]} everything above
        </Button>
        <Button type="button" variant="outline" disabled={running} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
