import { AnimatedNumber, AnimatedText } from "../../../components/app/AnimatedNumber";
import { Badge } from "../../../components/ui/badge";
import { HelpTooltip } from "../../../components/app/HelpTooltip";
import type { RecordingQualitySummary } from "../../../shared/tauri/recordingBundle";

function timestampStatusVariant(status: RecordingQualitySummary["timestampStatus"]): "outline" | "destructive" {
  return status === "ok" ? "outline" : "destructive";
}

function timestampStatusLabel(status: RecordingQualitySummary["timestampStatus"]): string {
  if (status === "ok") return "Timing OK";
  if (status === "warning") return "Timing warning";
  return "Timing unknown";
}

/**
 * Compact, read-only recording/collection quality summary (M1): row count,
 * observed time span and effective sample rate, missing-channel counts, and
 * label coverage/short-label warnings. Shared between the pre-save Timeline
 * recorder review and the saved-recording detail path so both surfaces speak
 * the same quality vocabulary. Never implies any rewrite of raw data.
 */
export function RecordingQualitySummaryCard({ summary }: { summary: RecordingQualitySummary }) {
  return (
    <div aria-label="Recording quality summary" className="flex flex-col gap-2 rounded-md border p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={timestampStatusVariant(summary.timestampStatus)}>
          {timestampStatusLabel(summary.timestampStatus)}
        </Badge>
        <HelpTooltip label="About timestamp quality">
          Whether this recording's rows are in strict chronological order with a usable time span. A
          warning means the effective sample rate below is not trustworthy and any offline derivative
          computed from this recording would be unavailable, not fabricated.
        </HelpTooltip>
        <span className="text-muted-foreground">
          <AnimatedText>{summary.rowCount.toLocaleString()}</AnimatedText> rows · {<AnimatedNumber value={(summary.timeSpanMs / 1000)} digits={1} />}s span
          {summary.effectiveSampleRateHz !== null && (
            <> · {<AnimatedNumber value={summary.effectiveSampleRateHz} digits={1} />} Hz effective rate</>
          )}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <span>
          <AnimatedText>{summary.labeledRowCount.toLocaleString()}</AnimatedText> labeled / <AnimatedText>{summary.unlabeledRowCount.toLocaleString()}</AnimatedText> unlabeled rows
          {summary.intervalCount > 0 && <> across {<AnimatedNumber value={summary.intervalCount} />} interval(s)</>}
        </span>
        {summary.missingChannels.length > 0 && (
          <Badge variant="destructive">{<AnimatedNumber value={summary.missingChannels.length} />} missing channel(s)</Badge>
        )}
      </div>

      {summary.warnings.length > 0 && (
        <ul role="alert" className="flex flex-col gap-1 text-destructive">
          {summary.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
