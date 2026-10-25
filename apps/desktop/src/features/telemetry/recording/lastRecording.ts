/** The recording the Recorder saved last, so it can be reviewed straight away. Kept for the app's lifetime only. */
export interface LastRecording {
  recordingId: string;
  rowCount: number;
  intervalCount: number;
  savedAt: number;
}

let last: LastRecording | null = null;
const listeners = new Set<() => void>();

export const lastRecording = {
  set(next: LastRecording | null): void {
    last = next;
    listeners.forEach((listener) => listener());
  },
  get(): LastRecording | null {
    return last;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
