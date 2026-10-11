import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { describeInput, STREAM_TITLES } from "../featureInfo";
import type { InputWarning } from "../labelModels";

const number = (value: number) => Math.abs(value) >= 100 ? Math.round(value).toLocaleString("en-US") : value.toPrecision(3);

/** How an input is named to a person: "Pulse sensor · Green signal". */
export function inputTitle(name: string): string {
  const info = describeInput(name);
  return `${STREAM_TITLES[info.stream]} · ${info.group} ${info.short}`;
}

/**
 * Says that a model is being given inputs far outside what it was trained on, so its answers mean little right now, which
 * inputs, and what usually causes it. Shown wherever a running model is.
 */
export function InputWarningNote({ warning }: { warning: InputWarning }) {
  return (
    <Alert role="alert" aria-label={`Inputs outside training for ${warning.modelId}`}>
      <AlertTitle>{warning.modelId} is seeing values it was never trained on</AlertTitle>
      <AlertDescription>
        <p>For about {Math.round(warning.unfamiliarShare * 100)}% of the last few seconds, an input of this model has been far outside the range it had in the model&apos;s training recordings (or most of them well outside it), so what it scores means little right now: it may fire on everything, or on nothing.</p>
        <ul className="mt-1 list-disc pl-5" aria-label="Inputs furthest outside">
          {warning.worst.map((input) => (
            <li key={input.name}><strong>{inputTitle(input.name)}</strong> is {number(input.value)}; in training it was {number(input.low)} to {number(input.high)}.</li>
          ))}
        </ul>
        <p className="mt-1">Usually the watch sits differently, or the sensor&apos;s level has drifted since the training recordings. Train on recordings made now, or use inputs that do not depend on the absolute level (for example the pulse level against the recent past).</p>
      </AlertDescription>
    </Alert>
  );
}
