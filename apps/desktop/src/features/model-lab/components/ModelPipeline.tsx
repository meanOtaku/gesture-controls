import { AnimatedText } from "../../../components/app/AnimatedNumber";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { CNN_MODEL, PULSE_MODEL, type ModelDescription } from "../training";
import { ModelStages } from "./ModelStages";

/** One model the app trains: its pipeline, stage by stage, with what the research measured. */
function PipelineCard({ model, description, help, results, hint }: { model: ModelDescription; description: string; help: string; results: [string, string][]; hint: string }) {
  return (
    <Card role="region" aria-label={`${model.name} pipeline`} className="min-w-0">
      <CardHeader>
        <SectionHeader title={model.name} description={description} help={{ label: `About the ${model.name}`, content: help }} />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm">{model.summary}</p>
        <ModelStages stages={model.stages} />
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-x-6 gap-y-3 text-sm" aria-label="Research results">
          {results.map(([name, value]) => <div key={name}><dt className="text-muted-foreground">{name}</dt><dd className="text-numeric whitespace-nowrap"><AnimatedText>{value}</AnimatedText></dd></div>)}
        </dl>
        <p className="field-hint">{hint}</p>
      </CardContent>
    </Card>
  );
}

/** The two kinds of model the app trains, stage by stage: Model Lab shows it under "How the models work". */
export function ModelPipeline() {
  const trees = PULSE_MODEL.research;
  const cnn = CNN_MODEL.research;
  return (
    <div id="lab-pipeline" className="flex min-w-0 flex-col gap-4">
      <PipelineCard
        model={PULSE_MODEL}
        description="The trees: they train quickly and from little data. For pinches the CNN below catches more, and sooner."
        help="Chosen by the October 2026 research: of 26 methods and several ways of preparing the pulse signal, multi-scale z-scored derivatives with ExtraTrees had the best worst-case score on recordings the model never saw; adding the watch's motion raised it again and halved the false alarms on recordings without the gesture, and firing at the top of the score's climb caught more starts for the same false alarms. The research is in docs/research/ppg-imu-fusion-and-triggers-2026-10.md."
        results={[["Worst-case AUC", trees.worstAuc.toFixed(3)], ["Mean AUC", trees.meanAuc.toFixed(3)], ["Gesture starts caught", `${Math.round(trees.recall * 100)}%`], ["False alarms", `≈${trees.falsePerMinute.toFixed(1)} / min`]]}
        hint="Measured on 37 recordings, testing 20 times on recordings the model never trained on, firing on the peak at a cut-off of 0.65 (picked on those same tests, so a little optimistic). Your models choose their own cut-off, on their training recordings. One that does not pass the checks for going live can be activated, but it only runs in Monitor."
      />
      <PipelineCard
        model={CNN_MODEL}
        description="The CNN: Model Lab's default in the Train card."
        help="It decides sooner than the trees. Since November 2026 each channel is scaled by its median and spread, because the earlier rolling scaling hid pinches for 8 to 10 seconds after heavy motion. The research is in docs/research/cnn-motion-hangover-2026-11.md."
        results={[["Pinch ins caught", `${Math.round(cnn.recall * 100)}%`], ["False alarms", `at most ${cnn.falsePerMinute.toFixed(0)} / min`], ["Decides after", `${cnn.delayMs} ms`], ["Inputs", String(CNN_MODEL.inputs)]]}
        hint={`${CNN_MODEL.trainingNote} Pinch ins from a still hand, against 64% for the trees on the same recordings, measured with the earlier rolling scaling. Your models choose their own cut-off, on their training recordings. One that does not pass the checks for going live can be activated, but it only runs in Monitor.`}
      />
    </div>
  );
}
