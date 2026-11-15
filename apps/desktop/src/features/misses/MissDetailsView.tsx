import { AnimatedNumber, AnimatedText } from "../../components/app/AnimatedNumber";
import { Drawer } from "vaul";
import { Button } from "../../components/ui/button";
import { appNavigation } from "../../shared/navigation/appNavigation";
import { CAMERA_LINE, type MissDetails } from "./MissMarker";

/** The saved recording is 45 s long and ends at the mark; open it a little before its end, where the miss was. */
const OPEN_AT_MS = 35_000;

const score = (value: number | null) => (value === null ? "–" : value.toFixed(2));

/**
 * Everything a saved miss says, in a drawer that slides up from the bottom (Vaul): what each model scored and did, whether
 * the watch's streams had gaps, and whether the camera's view was saved, with the way on to Labelling. Its own module, so
 * the drawer library loads the first time a miss's details are opened, not with the app.
 */
export function MissDetailsView({ details, open, onClose }: { details: MissDetails | null; open: boolean; onClose: () => void }) {
  const saved = details?.saved;
  return (
    <Drawer.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Drawer.Portal>
        <Drawer.Overlay className="miss-drawer-overlay" />
        <Drawer.Content className="miss-drawer" aria-describedby="miss-drawer-description">
          <div className="miss-drawer-handle" aria-hidden="true" />
          {saved && details && (
            <div className="miss-drawer-body">
              <Drawer.Title className="miss-drawer-title">{saved.name}</Drawer.Title>
              <Drawer.Description id="miss-drawer-description" className="field-hint">
                The last 45 seconds before you marked it, saved to Recordings under “Misses”. {CAMERA_LINE[details.camera]}
              </Drawer.Description>
              <ul className="miss-summary">
                {saved.summary.lines.map((line) => <li key={line}>{line}</li>)}
              </ul>
              {saved.summary.labels.length > 0 && (
                <table className="miss-table">
                  <caption className="sr-only">What each model did in the saved seconds</caption>
                  <thead>
                    <tr><th scope="col">Model</th><th scope="col">Starts at</th><th scope="col">Highest score</th><th scope="col">Before the mark</th><th scope="col">Detected</th><th scope="col">Acted on</th><th scope="col">Rejections</th></tr>
                  </thead>
                  <tbody>
                    {saved.summary.labels.map((label) => (
                      <tr key={label.label}>
                        <th scope="row">{label.label}</th>
                        <td><AnimatedText>{score(label.activation)}</AnimatedText></td>
                        <td><AnimatedText>{score(label.peak)}</AnimatedText></td>
                        <td>{label.peakMsBeforeMark === null ? "–" : <><AnimatedNumber value={(label.peakMsBeforeMark / 1000)} digits={1} />{" s"}</>}</td>
                        <td>{<AnimatedNumber value={label.detected} />}</td>
                        <td>{<AnimatedNumber value={label.acted} />}</td>
                        <td>{Object.entries(label.rejections).map(([reason, count]) => `${reason} ×${count}`).join(", ") || "none"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="field-hint">
                Watch streams: motion {<AnimatedNumber value={saved.summary.motion.seconds} digits={0} />} s with {<AnimatedNumber value={saved.summary.motion.gaps} />} gap{saved.summary.motion.gaps === 1 ? "" : "s"}
                {saved.summary.motion.gaps > 0 ? <>{" (longest "}<AnimatedNumber value={saved.summary.motion.longestGapMs} />{" ms)"}</> : ""}; pulse {<AnimatedNumber value={saved.summary.pulse.seconds} digits={0} />} s with {<AnimatedNumber value={saved.summary.pulse.gaps} />} gap{saved.summary.pulse.gaps === 1 ? "" : "s"}
                {saved.summary.pulse.gaps > 0 ? <>{" (longest "}<AnimatedNumber value={saved.summary.pulse.longestGapMs} />{" ms)"}</> : ""}.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => { onClose(); appNavigation.openInLabelling({ datasetId: saved.datasetId, atMs: OPEN_AT_MS }); }}>Open in Labelling</Button>
                <Button variant="outline" onClick={() => onClose()}>Close</Button>
              </div>
            </div>
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
