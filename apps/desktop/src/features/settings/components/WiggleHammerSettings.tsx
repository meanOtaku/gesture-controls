import { AnimatedNumber } from "../../../components/app/AnimatedNumber";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { useWristExtras } from "../../gestures/useWristExtras";
import { SettingsNumberField } from "../settingsForm";

/** How easily a wiggle and a hammer blow are recognised, with a live count of each to try the settings against. */
export function WiggleHammerSettings() {
  const extras = useWristExtras(typeof window !== "undefined" && "__TAURI_INTERNALS__" in window);
  return (
    <Card role="region" aria-label="Wiggle and hammer sensitivity">
      <CardHeader>
        <SectionHeader
          title="Wiggle and hammer sensitivity"
          description="Wrist wiggle and hammer-on-palm gestures"
          help={{
            label: "About the wiggle and the hammer",
            content: "A wiggle is four quick twists of the wrist back and forth in about a second, like rattling a door knob; its speed is how fast the wrist turns at the top of each twist. A hammer is the fist brought down on the other palm, or a clap: the moving arm stopping dead and then resting, reported about a quarter of a second after the blow. Lower a setting if the gesture is missed, raise it if ordinary movement sets it off.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SettingsNumberField name="wigglePeakRate" />
          <SettingsNumberField name="hammerPeakThreshold" />
        </div>
        <p className="field-hint" role="status" aria-live="polite">
          Recognised since you opened this page: <AnimatedNumber value={extras.wiggles} /> wiggle{extras.wiggles === 1 ? "" : "s"}, <AnimatedNumber value={extras.hammers} /> hammer blow{extras.hammers === 1 ? "" : "s"} (needs the watch connected with its acceleration and orientation sensors on)
        </p>
      </CardContent>
    </Card>
  );
}
