import { AnimatedNumber, AnimatedWord, AnimatedText } from "../../../components/app/AnimatedNumber";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SectionHeader } from "../../../components/app/SectionHeader";

type SetupStep = {
  key: string;
  complete: boolean;
  title: string;
  description: string;
  navigateTo?: "headphone" | "watch";
  navigateLabel?: string;
};

type OverviewSectionProps = {
  connected: boolean;
  calibrated: boolean;
  watchConnected: boolean;
  gestureReady: boolean;
  deviceName: string | null;
  onNavigate?: (view: "headphone" | "watch") => void;
};

/**
 * Main-tab device/gesture status cards and the onboarding checklist that guides first-time setup. Once the watch is
 * connected the checklist shrinks to a line, with its steps folded beneath.
 */
export function OverviewSection({ connected, calibrated, watchConnected, gestureReady, deviceName, onNavigate }: OverviewSectionProps) {
  // The watch comes first: shakes, taps and the other wrist gestures need nothing else. The headphones add head
  // locations, for recipes that start by looking somewhere.
  const steps: SetupStep[] = [
    {
      key: "watch",
      complete: watchConnected,
      title: "Connect your Galaxy Watch",
      description: "Open the Watch app and enable streaming. It connects over Bluetooth by default; Wi-Fi is under Settings → Watch.",
      navigateTo: "watch",
      navigateLabel: "Check Watch →",
    },
    {
      key: "headphones",
      complete: connected,
      title: "Connect your headphones (optional)",
      description: "Only for recipes that start by looking somewhere. Connect your headset in Bluetooth settings.",
      navigateTo: "headphone",
      navigateLabel: "Check headphones →",
    },
    {
      key: "calibration",
      complete: connected && calibrated,
      title: "Set your head positions (optional)",
      description: "Capture the screen center, then the top-right corner. Hold still for each capture.",
      navigateTo: "headphone",
      navigateLabel: "Open calibration →",
    },
  ];
  const completedCount = steps.filter((step) => step.complete).length;
  const stepList = (
    <ol className="setup-steps">
      {steps.map((step, index) => (
        <li key={step.key} data-complete={step.complete}>
          <span className="step-number"><AnimatedText>{step.complete ? "✓" : String(index + 1)}</AnimatedText></span>
          <div><strong>{step.title}</strong><p>{step.description}</p></div>
          {onNavigate && step.navigateTo && (
            <Button type="button" variant="outline" onClick={() => onNavigate(step.navigateTo!)}>
              {step.navigateLabel}
            </Button>
          )}
        </li>
      ))}
    </ol>
  );

  return (
    <>
      <section className="overview-grid" aria-label="Device overview">
        <Card><CardContent><span className="label">Headphones</span><strong><AnimatedWord>{connected ? "Connected" : "Waiting"}</AnimatedWord></strong><small><AnimatedWord>{deviceName ?? "Sony bridge not detected"}</AnimatedWord></small></CardContent></Card>
        <Card><CardContent><span className="label">Galaxy Watch</span><strong><AnimatedWord>{watchConnected ? "Connected" : "Waiting"}</AnimatedWord></strong><small><AnimatedWord>{watchConnected ? "Streaming to this desktop" : "Searching for desktop"}</AnimatedWord></small></CardContent></Card>
        <Card>
          <CardContent>
            <span className="label">Volume gesture</span>
            <strong><AnimatedWord>{gestureReady ? "Ready" : watchConnected ? "Watch only" : "Set up"}</AnimatedWord></strong>
            <small>{!watchConnected ? "Connect the Watch to begin" : !connected ? "Wrist gestures work now; headphones add head locations" : !calibrated ? "Capture your two head positions" : "Look top-right to open the knob"}</small>
          </CardContent>
        </Card>
      </section>

      {watchConnected ? (
        // Set up already: one line, with the steps a click away for when a device needs connecting again.
        <Card role="region" aria-label="Setup checklist">
          <CardContent className="flex flex-col gap-2">
            <p className="text-sm">
              <strong>{gestureReady ? "You’re ready to take control." : "The watch is ready."}</strong>{" "}
              {connected ? (calibrated ? "Headphones and head positions too." : "Headphones connected; head positions not captured yet.") : "Headphones are optional, for recipes that start by looking somewhere."}
            </p>
            <p className="interaction-guide">
              {connected
                ? "Look top-right to show the knob. Hold the Watch button, rotate your wrist, then release. Press Escape to hide the knob. On macOS, the arrow or +/- keys also change the volume while the knob is visible."
                : "With the watch alone: make a recipe from a shake, a tap or a hammer on your palm under Recipes, and try each gesture under Gestures. A double tap can switch a volume dial on and off."}
            </p>
            <details className="text-sm">
              <summary className="cursor-pointer">Setup steps (<AnimatedNumber value={completedCount} /> / {<AnimatedNumber value={steps.length} />} done)</summary>
              {stepList}
            </details>
          </CardContent>
        </Card>
      ) : (
        <Card role="region" aria-label="Setup checklist">
          <CardHeader>
            <SectionHeader
              title="Get your devices ready"
              description="Your next steps"
              status={<Badge variant="secondary"><AnimatedNumber value={completedCount} /> / {<AnimatedNumber value={steps.length} />} complete</Badge>}
            />
          </CardHeader>
          <CardContent>
            {stepList}
            <p className="interaction-guide">
              {connected
                ? "Look top-right to show the knob. Hold the Watch button, rotate your wrist, then release. Press Escape to hide the knob. On macOS, the arrow or +/- keys also change the volume while the knob is visible."
                : "With the watch alone: make a recipe from a shake, a tap or a hammer on your palm under Recipes, and try each gesture under Gestures. A double tap can switch a volume dial on and off."}
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}
