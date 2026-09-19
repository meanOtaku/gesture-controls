import {
  getRawRecordingWindow,
  RAW_WINDOW_MAX_VALUES,
  RAW_WINDOW_ROW_HOP,
  type RawImageViewerChannel,
  type RawRecordingWindow,
} from "../../../shared/tauri/recordingBundle";

/**
 * Visual inspection only: this state module (and the `get_raw_recording_window`
 * command it calls) never feeds model-lab, capture, export, annotation, or
 * inference code, and never writes raw.csv. See GC-009's delivery plan.
 */
export type RawImageNormalizationMode = "recording" | "frame";

export type RawImageViewerStatus = "empty" | "loading" | "loaded" | "error";

/**
 * Every request path (recording, channel, or row-start change) is
 * `Math.floor`-aligned to `RAW_WINDOW_ROW_HOP` before it is sent, so
 * `startRawRow % RAW_WINDOW_ROW_HOP === 0` holds for every navigation path,
 * not just the ones the backend would otherwise reject.
 */
function alignToRowHop(value: number): number {
  const nonNegative = Number.isFinite(value) ? Math.max(0, value) : 0;
  return Math.floor(nonNegative / RAW_WINDOW_ROW_HOP) * RAW_WINDOW_ROW_HOP;
}

/**
 * Mirrors `recording_bundle::resolve_raw_window_bounds`'s `last_valid_start`
 * computation so slider/navigation bounds are derived from the same backend
 * fact (`totalRawRowCount`) the command itself resolves against, rather than
 * a locally guessed limit.
 */
function lastValidStart(totalRawRowCount: number, maxValues: number): number {
  if (totalRawRowCount <= maxValues) return 0;
  return alignToRowHop(totalRawRowCount - maxValues);
}

class RawImageViewerStore {
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private requestVersion = 0;

  private recordingId: string | null = null;
  private channel: RawImageViewerChannel | null = null;
  private normalizationMode: RawImageNormalizationMode = "recording";
  private requestedStartRawRow = 0;

  private status: RawImageViewerStatus = "empty";
  private errorMessage: string | null = null;
  private window: RawRecordingWindow | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private notify(): void {
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }

  getRecordingId(): string | null {
    return this.recordingId;
  }

  getChannel(): RawImageViewerChannel | null {
    return this.channel;
  }

  getNormalizationMode(): RawImageNormalizationMode {
    return this.normalizationMode;
  }

  getRequestedStartRawRow(): number {
    return this.requestedStartRawRow;
  }

  getStatus(): RawImageViewerStatus {
    return this.status;
  }

  getErrorMessage(): string | null {
    return this.errorMessage;
  }

  /** The last window successfully resolved for the current recording/channel/start selection, or `null` if none has loaded yet or the selection has since changed. */
  getWindow(): RawRecordingWindow | null {
    return this.window;
  }

  /**
   * Slider/navigation bounds derived only from the last loaded window's
   * `totalRawRowCount`; `null` until a window has been loaded, since there is
   * no backend fact to derive bounds from before that.
   */
  getNavigationBounds(): { minStartRawRow: number; maxStartRawRow: number } | null {
    if (this.window === null) return null;
    const maxStartRawRow = lastValidStart(this.window.totalRawRowCount, RAW_WINDOW_MAX_VALUES);
    return { minStartRawRow: 0, maxStartRawRow };
  }

  setRecording(recordingId: string | null): void {
    if (recordingId === this.recordingId) return;
    this.recordingId = recordingId;
    this.requestedStartRawRow = 0;
    this.resetAndReload();
  }

  setChannel(channel: RawImageViewerChannel | null): void {
    if (channel === this.channel) return;
    this.channel = channel;
    this.requestedStartRawRow = 0;
    this.resetAndReload();
  }

  setNormalizationMode(mode: RawImageNormalizationMode): void {
    if (mode === this.normalizationMode) return;
    this.normalizationMode = mode;
    // Normalization is a pure rendering choice over the already-loaded
    // window (recording-scale extent is already part of every response); it
    // never triggers a new request.
    this.notify();
  }

  /** Jumps to an explicit raw row start (e.g. from a slider drag), aligned down to the nearest `RAW_WINDOW_ROW_HOP` multiple. */
  setStartRawRow(startRawRow: number): void {
    const aligned = alignToRowHop(startRawRow);
    if (aligned === this.requestedStartRawRow) return;
    this.requestedStartRawRow = aligned;
    this.reload();
  }

  goToPreviousFrame(): void {
    this.setStartRawRow(this.requestedStartRawRow - RAW_WINDOW_ROW_HOP);
  }

  goToNextFrame(): void {
    this.setStartRawRow(this.requestedStartRawRow + RAW_WINDOW_ROW_HOP);
  }

  goToFirstFrame(): void {
    this.setStartRawRow(0);
  }

  goToLastFrame(): void {
    const bounds = this.getNavigationBounds();
    this.setStartRawRow(bounds === null ? this.requestedStartRawRow : bounds.maxStartRawRow);
  }

  private resetAndReload(): void {
    this.window = null;
    this.errorMessage = null;
    this.reload();
  }

  private reload(): void {
    const recordingId = this.recordingId;
    const channel = this.channel;
    if (recordingId === null || channel === null) {
      this.requestVersion += 1;
      this.status = "empty";
      this.errorMessage = null;
      this.window = null;
      this.notify();
      return;
    }

    const requestVersion = ++this.requestVersion;
    const startRawRow = this.requestedStartRawRow;
    this.status = "loading";
    this.errorMessage = null;
    this.notify();

    void getRawRecordingWindow({ recordingId, column: channel, startRawRow }).then((result) => {
      // Discard this response if a newer request has since been issued, or
      // if the recording/channel selection has moved on entirely (e.g. the
      // user switched recordings while this request was in flight): either
      // way, the current selection must never be overwritten by a
      // superseded response.
      if (requestVersion !== this.requestVersion) return;
      if (this.recordingId !== recordingId || this.channel !== channel) return;

      if (result.status === "error") {
        this.status = "error";
        this.errorMessage = result.message;
        this.window = null;
      } else {
        this.status = "loaded";
        this.errorMessage = null;
        this.window = result.value;
        // The backend resolves/clamps `startRawRow` deterministically; keep
        // the requested value in sync with what was actually served so the
        // next relative navigation (prev/next) starts from the real window.
        this.requestedStartRawRow = result.value.startRawRow;
      }
      this.notify();
    });
  }
}

export const rawImageViewerStore = new RawImageViewerStore();
