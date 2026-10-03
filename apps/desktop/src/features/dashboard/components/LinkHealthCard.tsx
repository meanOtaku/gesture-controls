import { useEffect, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { LinkDiagnostics, LinkEvent } from "../../../shared/protocol/events";
import { useLinkDiagnostics } from "../hooks/useLinkDiagnostics";
import {
  endReasonLabel,
  formatAgo,
  formatClock,
  formatDuration,
  formatMs,
  phaseHint,
  phaseLabel,
} from "../linkFormat";
import { Metric } from "./MetricRow";

const VISIBLE_EVENTS = 8;

type LinkHealthPanelProps = {
  diagnostics: LinkDiagnostics | null;
  /** The current time, supplied by the caller so the panel is a pure function of its props. */
  nowUnixMs: number;
  onCopy?: () => void;
};

/** Everything the watch link knows about itself: its phase, how it last ended, latencies, and a history. */
export function LinkHealthPanel({ diagnostics, nowUnixMs, onCopy }: LinkHealthPanelProps) {
  const [showAll, setShowAll] = useState(false);

  if (!diagnostics) {
    return (
      <Card role="region" aria-label="Link health">
        <CardHeader><SectionHeader title="Link health" description="Watch connection diagnostics" /></CardHeader>
        <CardContent><p className="hint">Link diagnostics are available in the desktop app.</p></CardContent>
      </Card>
    );
  }

  const hint = phaseHint(diagnostics);
  const uptime = diagnostics.connectedSinceUnixMs != null
    ? formatDuration((nowUnixMs - diagnostics.connectedSinceUnixMs) / 1000)
    : "—";
  const events = [...diagnostics.events].reverse();
  const shown = showAll ? events : events.slice(0, VISIBLE_EVENTS);
  const transport = diagnostics.transport === "bluetooth" ? "Bluetooth" : diagnostics.transport === "wifi" ? "Wi-Fi" : "—";

  return (
    <Card role="region" aria-label="Link health">
      <CardHeader>
        <SectionHeader
          title="Link health"
          description={`${transport} link to the watch`}
          status={<Badge variant={diagnostics.phase === "streaming" ? "default" : "secondary"}>{phaseLabel(diagnostics.phase)}</Badge>}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {hint && <p className="hint" role="status">{hint}</p>}
        {diagnostics.retryInMs != null && diagnostics.phase === "failed" && (
          <p className="hint">Trying again in {formatMs(diagnostics.retryInMs)}.</p>
        )}
        <section className="metric-grid" aria-label="Link metrics">
          <Metric label="Connected for" value={uptime} />
          <Metric label="Last message" value={formatAgo(diagnostics.lastMessageUnixMs, nowUnixMs)} />
          <Metric label="Drops / sessions" value={`${diagnostics.drops} / ${diagnostics.sessions}`} />
          <Metric label="Write latency (last / worst)" value={`${formatMs(diagnostics.writeLastMs)} / ${formatMs(diagnostics.writeMaxMs)}`} />
          <Metric label="Longest silence" value={formatMs(diagnostics.maxGapMs)} />
          <Metric label="MTU" value={diagnostics.mtu ? `${diagnostics.mtu} bytes` : "—"} />
          <Metric label="Messages" value={String(diagnostics.messagesReceived)} />
          <Metric label="Rejected (invalid / out of order)" value={`${diagnostics.invalidMessages} / ${diagnostics.outOfOrderMessages}`} />
          <Metric label="Write failures" value={`${diagnostics.writeFailures} of ${diagnostics.writes}`} />
        </section>
        {diagnostics.lastEnd && (
          <p className="hint" aria-label="Last disconnect">
            Last disconnect {formatAgo(diagnostics.lastEnd.atUnixMs, nowUnixMs)}, after {formatDuration(diagnostics.lastEnd.sessionSeconds)}:
            {" "}{endReasonLabel(diagnostics.lastEnd)} — {diagnostics.lastEnd.detail}.
          </p>
        )}
        <div className="flex items-center justify-between">
          <span className="label">Recent events</span>
          {onCopy && <Button type="button" variant="ghost" size="sm" onClick={onCopy}>Copy diagnostics</Button>}
        </div>
        {events.length === 0 ? (
          <p className="hint">Nothing has happened on the link yet.</p>
        ) : (
          <ol className="model-lab-log" aria-label="Link events">
            {shown.map((event: LinkEvent, index) => (
              <li key={`${event.atUnixMs}-${index}`} data-level={event.level}>
                <span>{formatClock(event.atUnixMs)}</span> {event.message}
              </li>
            ))}
          </ol>
        )}
        {events.length > VISIBLE_EVENTS && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Show fewer" : `Show all ${events.length}`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** The panel wired to the live diagnostics, with a ticking clock so ages and uptime keep moving. */
export function LinkHealthCard() {
  const diagnostics = useLinkDiagnostics();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <LinkHealthPanel
      diagnostics={diagnostics}
      nowUnixMs={now}
      onCopy={() => {
        if (diagnostics) void navigator.clipboard?.writeText(JSON.stringify(diagnostics, null, 2));
      }}
    />
  );
}
