import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { SESSION_FIELDS, type SessionContext, type SessionField } from "../sessionContext";

const NOT_SAID = "__not_said__";

type SessionDetailsCardProps = {
  context: SessionContext;
  onChange: (context: SessionContext) => void;
  /** A recording under way keeps the details it started with. */
  recording: boolean;
};

/**
 * How the next recording is made: wrist, arm, what you are doing, strap and pinch. Kept with the recording, so a model can be
 * trained and tested on the conditions it will meet, and so you can see which conditions are still missing.
 */
export function SessionDetailsCard({ context, onChange, recording }: SessionDetailsCardProps) {
  const set = (field: SessionField, value: string) => onChange({ ...context, [field]: value });
  return (
    <Card role="region" aria-label="Session details" className="min-w-0">
      <CardHeader>
        <CardTitle>Session details</CardTitle>
        <CardDescription>
          How this session is recorded. A model only learns the conditions it was shown, so vary them across sessions: arm
          resting, raised, moving and walking. Set them before you start: they are saved with the recording when it starts,
          and the last ones you used are kept.
          {recording ? " The recording under way keeps the details it started with." : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SESSION_FIELDS.map(({ field, title, options, placeholder }) => (
          <div key={field} className="field">
            <Label htmlFor={`session-${field}`}>{title}</Label>
            {options ? (
              <Select value={context[field] ?? NOT_SAID} onValueChange={(value) => set(field, value === NOT_SAID || value === null ? "" : value)} disabled={recording}>
                <SelectTrigger id={`session-${field}`} aria-label={title}>
                  <SelectValue>{(value: string) => (value === NOT_SAID || !value ? "Not said" : options.find((option) => option.value === value)?.title ?? value)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NOT_SAID}>Not said</SelectItem>
                  {options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={`session-${field}`}
                value={context[field] ?? ""}
                placeholder={placeholder}
                maxLength={120}
                disabled={recording}
                onChange={(event) => set(field, event.target.value)}
              />
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
