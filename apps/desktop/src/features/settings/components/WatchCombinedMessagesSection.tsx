import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Switch } from "../../../components/ui/switch";

type WatchCombinedMessagesSectionProps = {
  enabled: boolean;
  onToggle: () => void;
};

/** Whether the watch sends the motion and pulse samples of one flush together, or every motion reading on its own. */
export function WatchCombinedMessagesSection({ enabled, onToggle }: WatchCombinedMessagesSectionProps) {
  return (
    <Card role="region" aria-label="Watch message batching">
      <CardHeader>
        <SectionHeader
          title="Watch message batching"
          description="Galaxy Watch"
          help={{
            label: "About combined watch messages",
            content: "On, the watch holds each motion reading until the next pulse flush (100 ms at the default flush rate) and sends both together in one message. That sends far fewer messages over Bluetooth and keeps motion and pulse samples of the same moment together, but motion gestures can arrive up to one flush later. Off, every motion reading is sent the moment it is measured. Applies immediately, and again each time the watch connects. Only matters while raw PPG is streaming.",
          }}
        />
      </CardHeader>
      <CardContent>
        <div className="vector-row flex items-center justify-between gap-3">
          <span className="flex flex-col">
            <span className="label">Send motion and pulse together</span>
            <small className="text-xs text-muted-foreground">Fewer messages; motion may arrive up to one pulse flush later</small>
          </span>
          <span className="text-xs text-muted-foreground">{enabled ? "On" : "Off"}</span>
          <Switch aria-label={`Combined watch messages ${enabled ? "on" : "off"}`} checked={enabled} onCheckedChange={onToggle} />
        </div>
      </CardContent>
    </Card>
  );
}
