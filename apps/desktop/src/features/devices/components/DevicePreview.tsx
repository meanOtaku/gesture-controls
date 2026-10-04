import type { Recipe } from "../../../shared/protocol/events";
import { faderHandle, snappedAngle } from "../deviceMath";

type DevicePreviewProps = { device: Recipe["device"]; degrees: number };

/** A small picture of the device at a given wrist rotation. Decorative: the numbers beside it carry the meaning. */
export function DevicePreview({ device, degrees }: DevicePreviewProps) {
  if (device.kind === "horizontalFader" || device.kind === "verticalFader") {
    const horizontal = device.kind === "horizontalFader";
    const handle = faderHandle(device, degrees);
    return (
      <svg className="device-preview" viewBox="0 0 120 120" aria-hidden="true">
        {horizontal ? (
          <>
            <line className="device-track" x1="15" y1="60" x2="105" y2="60" />
            <line className="device-tick" x1="60" y1="50" x2="60" y2="70" />
            <rect className="device-handle" x={60 + handle * 45 - 6} y="48" width="12" height="24" />
          </>
        ) : (
          <>
            <line className="device-track" x1="60" y1="15" x2="60" y2="105" />
            <line className="device-tick" x1="50" y1="60" x2="70" y2="60" />
            <rect className="device-handle" x="48" y={60 - handle * 45 - 6} width="24" height="12" />
          </>
        )}
      </svg>
    );
  }

  const stepped = device.kind === "stepKnob";
  const angle = stepped ? snappedAngle(device, degrees) : degrees;
  const ticks = stepped ? Math.min(72, Math.round(360 / Number(device.degreesPerStep))) : 0;
  return (
    <svg className="device-preview" viewBox="0 0 120 120" aria-hidden="true">
      <circle className="device-dial" cx="60" cy="60" r="44" />
      {Array.from({ length: ticks }, (_, i) => {
        const a = (i / ticks) * 2 * Math.PI;
        return (
          <line
            key={i}
            className="device-tick"
            x1={60 + Math.sin(a) * 44}
            y1={60 - Math.cos(a) * 44}
            x2={60 + Math.sin(a) * 52}
            y2={60 - Math.cos(a) * 52}
          />
        );
      })}
      <line className="device-pointer" x1="60" y1="60" x2="60" y2="22" transform={`rotate(${angle} 60 60)`} />
    </svg>
  );
}
