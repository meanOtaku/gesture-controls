import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { describeInput } from "../inspection";
import type { InputWarning } from "../labelModels";

const number = (value: number) => Math.abs(value) >= 100 ? Math.round(value).toLocaleString("en-US") : value.toPrecision(3);

/** How an input is named to a person: "Pulse sensor · green slope against the last 1 s: …". */
export function inputTitle(name: string): string {
  return `Pulse sensor · ${describeInput(name)}`;
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
        <p className="mt-1">Usually the watch sits differently or touches the skin less well than in the training recordings, so the pulse moves in ways the model never saw. Check the fit, or train on recordings made the way you wear it now.</p>
      </AlertDescription>
    </Alert>
  );
}
