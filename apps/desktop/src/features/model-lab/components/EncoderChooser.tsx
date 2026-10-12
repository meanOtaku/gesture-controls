import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Checkbox } from "../../../components/ui/checkbox";
import { Label } from "../../../components/ui/label";
import type { NetworkDesign } from "../designs";

/** A pre-trained motion encoder in this checkout (`motion_encoders.rs`). */
export interface MotionEncoder {
  id: string;
  windowMs: number;
  steps: number;
  accuracy: number | null;
  gestureVsNothingAuc: number | null;
  pinchVsOtherGesturesAuc: number | null;
  sha256: string;
}

/** The six columns an encoder reads, in its order. */
export const MOTION_COLUMNS = ["accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z"];

const score = (value: number | null) => (value === null ? "?" : value.toFixed(2));

/** What a design must read to start from `encoder`: its columns, readings and window, each window centred as it was. */
export function fitToEncoder(design: NetworkDesign, encoder: MotionEncoder): Partial<NetworkDesign> {
  return {
    pretrained: encoder.id,
    columns: [...MOTION_COLUMNS],
    sources: ["watchAcceleration", "watchGyroscope"],
    readings: encoder.steps,
    windowMs: encoder.windowMs,
    movementOnly: true,
    baselineMs: null,
    spikeMethod: "none",
    pretrainedFreeze: design.pretrainedFreeze ?? false,
  };
}

/**
 * For the convolutional method: start its convolution layers from a motion encoder pre-trained on many people (MicroDPad),
 * instead of from nothing, and optionally keep them as they are. Choosing one sets the design to read what the encoder read.
 */
export function EncoderChooser({ design, set, uid }: { design: NetworkDesign; set: (patch: Partial<NetworkDesign>) => void; uid: string }) {
  const [encoders, setEncoders] = useState<MotionEncoder[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(invoke<MotionEncoder[]>("list_motion_encoders"))
      .then((found) => { if (!cancelled) setEncoders(found ?? []); })
      .catch(() => { if (!cancelled) setEncoders([]); });
    return () => { cancelled = true; };
  }, []);
  const chosen = encoders?.find((encoder) => encoder.id === design.pretrained) ?? null;
  const missing = design.pretrained && encoders !== null && chosen === null;

  return (
    <div className="field">
      <div className="field-head"><Label htmlFor={`${uid}-encoder`}>Start from a pre-trained encoder</Label></div>
      <select
        id={`${uid}-encoder`}
        className="recipe-select"
        value={design.pretrained ?? ""}
        disabled={encoders === null}
        onChange={(event) => {
          const encoder = encoders?.find((e) => e.id === event.target.value);
          set(encoder ? fitToEncoder(design, encoder) : { pretrained: null, pretrainedFreeze: false });
        }}
      >
        <option value="">None: learn everything from these recordings</option>
        {(encoders ?? []).map((encoder) => (
          <option key={encoder.id} value={encoder.id}>{`${encoder.id} (${encoder.windowMs / 1000} s, ${encoder.steps} readings)`}</option>
        ))}
        {missing && <option value={design.pretrained ?? ""}>{`${design.pretrained} (not in this checkout)`}</option>}
      </select>
      {encoders !== null && encoders.length === 0 ? (
        <p className="field-hint" role="note">
          No pre-trained encoder in this checkout. Make one from the MicroDPad dataset with the trainer&apos;s <code>--pretrain-microdpad</code> (see tools/label-trainer/README.md); it is saved in data/external/microdpad/encoders.
        </p>
      ) : chosen ? (
        <>
          <p className="field-hint">
            {`Its convolution layers learnt from 55 other people's wrist gestures; on 10 people it never saw it told a gesture from nothing with AUC ${score(chosen.gestureVsNothingAuc)} and a pinch from other gestures with ${score(chosen.pinchVsOtherGesturesAuc)}. The design now reads what it read: acceleration and gyroscope, ${chosen.steps} readings over ${chosen.windowMs / 1000} s, each window centred on its own average. The network's layers come from the encoder; its rounds, learning rate and other settings below still apply. For use on this computer only (MicroDPad's licence does not allow sharing what is made from it).`}
          </p>
          <div className="flex items-center gap-2">
            <Checkbox id={`${uid}-freeze`} checked={design.pretrainedFreeze ?? false} onCheckedChange={(checked) => set({ pretrainedFreeze: checked === true })} />
            <Label htmlFor={`${uid}-freeze`}>Keep its layers as they are (only the last layer learns)</Label>
          </div>
          <p className="field-hint">On the first recordings, letting its layers adjust (this box off) did better: the encoder learnt on another device.</p>
        </>
      ) : missing ? (
        <p className="field-hint" role="alert">This design names an encoder that is not in this checkout, so it cannot train here. Choose another, or none.</p>
      ) : (
        <p className="field-hint">With few recordings a convolutional network learns slowly and differently each time; starting from an encoder pre-trained on many people makes it steadier.</p>
      )}
    </div>
  );
}
