/**
 * The gestures MediaPipe's pretrained Gesture Recognizer knows (Apache-2.0, trained only on hand gestures), by the
 * names it reports. It runs in the same pass as the hand landmarks, so having it costs almost nothing extra.
 */
export const PRETRAINED_GESTURES = [
  { id: "Closed_Fist", label: "Closed fist" },
  { id: "Open_Palm", label: "Open palm" },
  { id: "Pointing_Up", label: "Pointing up" },
  { id: "Thumb_Down", label: "Thumb down" },
  { id: "Thumb_Up", label: "Thumb up" },
  { id: "Victory", label: "Victory (peace)" },
  { id: "ILoveYou", label: "I love you" },
] as const;

export type PretrainedGestureId = (typeof PRETRAINED_GESTURES)[number]["id"];

export interface PretrainedReading {
  gesture: PretrainedGestureId;
  /** 0 to 1: how sure the model is. */
  score: number;
}

export const PRETRAINED_IDS: readonly string[] = PRETRAINED_GESTURES.map((g) => g.id);

export const pretrainedLabel = (id: string): string => PRETRAINED_GESTURES.find((g) => g.id === id)?.label ?? id;

/** The model's best guess for one hand, or undefined when it says "none" or something this app does not know. */
export function pretrainedReading(categories: { categoryName?: string; score?: number }[] | undefined): PretrainedReading | undefined {
  const best = categories?.[0];
  if (!best?.categoryName || !PRETRAINED_IDS.includes(best.categoryName)) return undefined;
  return { gesture: best.categoryName as PretrainedGestureId, score: best.score ?? 0 };
}

/** A hand counts as making the gesture from this confidence, and keeps counting until it drops below the lower one (so it does not flicker). */
export const PRETRAINED_ENTER = 0.6;
export const PRETRAINED_EXIT = 0.4;
