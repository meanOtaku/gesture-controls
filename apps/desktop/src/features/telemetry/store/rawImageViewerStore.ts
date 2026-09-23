import {
  DEFAULT_RAW_GRID_SIZE,
  getCompactObservationWindow,
  getRawRecordingDerivativeWindow,
  getRawRecordingWindow,
  rawWindowMaxValues,
  rawWindowRowHop,
  type RawGridSize,
  type RawImageViewerChannel,
  type RawRecordingCompactWindow,
  type RawRecordingDerivativeWindow,
  type RawRecordingWindow,
} from "../../../shared/tauri/recordingBundle";

/**
 * Raw rows (existing default/audit mode, exact `raw.csv` rows, nulls
 * visible) vs. Observed samples (M3 read-only compact mode: only this
 * channel's finite observed values, in timestamp order, no missing-value
 * pixels by design). See
 * `.hermes/plans/2026-09-23-compact-sample-order-image-viewer.md`.
 */
export type RawImageViewMode = "rawRows" | "observedSamples";

/**
 * Visual inspection only: this state module (and the `get_raw_recording_window`
 * command it calls) never feeds model-lab, capture, export, annotation, or
 * inference code, and never writes raw.csv. See GC-009's delivery plan.
 */
export type RawImageNormalizationMode = "recording" | "frame";

export type RawImageViewerStatus = "empty" | "loading" | "loaded" | "error";

/**
 * Every request path (recording, channel, grid-size, or row-start change) is
 * `Math.floor`-aligned to the selected grid size's row hop before it is
 * sent, so `startRawRow % hop === 0` holds for every navigation path, not
 * just the ones the backend would otherwise reject.
 */
function alignToRowHop(value: number, rowHop: number): number {
  const nonNegative = Number.isFinite(value) ? Math.max(0, value) : 0;
  return Math.floor(nonNegative / rowHop) * rowHop;
}

/**
 * Mirrors `recording_bundle::resolve_raw_window_bounds`'s `last_valid_start`
 * computation so slider/navigation bounds are derived from the same backend
 * fact (`totalRawRowCount`) the command itself resolves against, rather than
 * a locally guessed limit.
 */
function lastValidStart(totalRawRowCount: number, maxValues: number, rowHop: number): number {
  if (totalRawRowCount <= maxValues) return 0;
  return alignToRowHop(totalRawRowCount - maxValues, rowHop);
}

class RawImageViewerStore {
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private requestVersion = 0;
  /** Separate from `requestVersion`: navigating compact mode must not cancel
   * an in-flight raw-window request (and vice versa), since a user can only
   * be looking at one mode's controls at a time but both windows' loaded
   * state is retained across a mode toggle (see `setViewMode`). */
  private compactRequestVersion = 0;

  private recordingId: string | null = null;
  private channel: RawImageViewerChannel | null = null;
  private normalizationMode: RawImageNormalizationMode = "recording";
  private gridSize: RawGridSize = DEFAULT_RAW_GRID_SIZE;
  private requestedStartRawRow = 0;
  private viewMode: RawImageViewMode = "rawRows";
  private requestedStartSampleIndex = 0;

  private compactStatus: RawImageViewerStatus = "empty";
  private compactErrorMessage: string | null = null;
  private compactWindow: RawRecordingCompactWindow | null = null;

  private status: RawImageViewerStatus = "empty";
  private errorMessage: string | null = null;
  private window: RawRecordingWindow | null = null;

  /**
   * The M3 derivative view's own load state, kept alongside (never gating)
   * the raw window's: it is requested with the identical
   * recording/channel/grid-size/start-row on every reload and validated
   * against the same `requestVersion`/selection guard, so a stale derivative
   * response can never land on a since-changed selection, and a slow or
   * failed derivative fetch never blocks the raw Grayscale/Rainbow canvases.
   */
  private derivativeStatus: RawImageViewerStatus = "empty";
  private derivativeErrorMessage: string | null = null;
  private derivativeWindow: RawRecordingDerivativeWindow | null = null;

  /**
   * GC-032: the "preview by sample order" legacy fallback. Unlike the
   * time-based derivative above, this is never fetched automatically — it
   * only loads when `requestSampleOrderPreview()` is called explicitly (the
   * Derivative panel's opt-in button), and it is cleared on every selection
   * change like everything else here so a stale preview can never survive a
   * recording/channel/grid-size switch.
   */
  private sampleOrderPreviewStatus: RawImageViewerStatus = "empty";
  private sampleOrderPreviewErrorMessage: string | null = null;
  private sampleOrderPreviewWindow: RawRecordingDerivativeWindow | null = null;

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

  getGridSize(): RawGridSize {
    return this.gridSize;
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

  getDerivativeStatus(): RawImageViewerStatus {
    return this.derivativeStatus;
  }

  getDerivativeErrorMessage(): string | null {
    return this.derivativeErrorMessage;
  }

  /** The last M3 derivative window successfully resolved for the current recording/channel/start selection, or `null` if none has loaded yet, the fetch failed, or the selection has since changed. Row-aligned with `getWindow()` by construction (see `reload()`). */
  getDerivativeWindow(): RawRecordingDerivativeWindow | null {
    return this.derivativeWindow;
  }

  getSampleOrderPreviewStatus(): RawImageViewerStatus {
    return this.sampleOrderPreviewStatus;
  }

  getSampleOrderPreviewErrorMessage(): string | null {
    return this.sampleOrderPreviewErrorMessage;
  }

  getSampleOrderPreviewWindow(): RawRecordingDerivativeWindow | null {
    return this.sampleOrderPreviewWindow;
  }

  /**
   * Explicit opt-in fetch for the GC-032 "preview by sample order" legacy
   * fallback, for the current recording/channel/grid-size/start-row
   * selection. Never called automatically — only from the Derivative panel's
   * opt-in button, and only once the time-based derivative has already come
   * back unavailable with `unavailableIsCadenceIssue: true`.
   */
  requestSampleOrderPreview(): void {
    const recordingId = this.recordingId;
    const channel = this.channel;
    if (recordingId === null || channel === null) return;

    const requestVersion = this.requestVersion;
    const startRawRow = this.requestedStartRawRow;
    const gridSize = this.gridSize;
    this.sampleOrderPreviewStatus = "loading";
    this.sampleOrderPreviewErrorMessage = null;
    this.notify();

    void getRawRecordingDerivativeWindow({ recordingId, column: channel, startRawRow, gridSize }, true).then(
      (result) => {
        if (
          requestVersion !== this.requestVersion ||
          this.recordingId !== recordingId ||
          this.channel !== channel ||
          this.gridSize !== gridSize
        ) {
          return;
        }

        if (result.status === "error") {
          this.sampleOrderPreviewStatus = "error";
          this.sampleOrderPreviewErrorMessage = result.message;
          this.sampleOrderPreviewWindow = null;
        } else {
          this.sampleOrderPreviewStatus = "loaded";
          this.sampleOrderPreviewErrorMessage = null;
          this.sampleOrderPreviewWindow = result.value;
        }
        this.notify();
      },
    );
  }

  /**
   * Slider/navigation bounds derived only from the last loaded window's
   * `totalRawRowCount`; `null` until a window has been loaded, since there is
   * no backend fact to derive bounds from before that.
   */
  getNavigationBounds(): { minStartRawRow: number; maxStartRawRow: number } | null {
    if (this.window === null) return null;
    const maxStartRawRow = lastValidStart(
      this.window.totalRawRowCount,
      rawWindowMaxValues(this.window.gridSize),
      rawWindowRowHop(this.window.gridSize),
    );
    return { minStartRawRow: 0, maxStartRawRow };
  }

  getViewMode(): RawImageViewMode {
    return this.viewMode;
  }

  /** Switches between the raw-row audit view and the M3 compact
   * observed-samples view. Never re-fetches the mode being left (its loaded
   * window, if any, is kept so toggling back is instant); fetches the
   * compact window on first entry into `"observedSamples"` for the current
   * selection if it hasn't already loaded. */
  setViewMode(mode: RawImageViewMode): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    if (mode === "observedSamples" && this.compactWindow === null && this.compactStatus !== "loading") {
      this.loadCompact();
    } else {
      this.notify();
    }
  }

  getRequestedStartSampleIndex(): number {
    return this.requestedStartSampleIndex;
  }

  getCompactStatus(): RawImageViewerStatus {
    return this.compactStatus;
  }

  getCompactErrorMessage(): string | null {
    return this.compactErrorMessage;
  }

  /** The last compact observed-samples window successfully resolved for the
   * current recording/channel/grid-size/start-sample selection, or `null` if
   * none has loaded yet, the fetch failed, or the selection has since changed. */
  getCompactWindow(): RawRecordingCompactWindow | null {
    return this.compactWindow;
  }

  /** Compact-mode navigation bounds, in observed-sample-sequence positions
   * (never raw rows), derived only from the last loaded compact window's
   * `totalObservedSampleCount` — mirrors `getNavigationBounds()`. */
  getCompactNavigationBounds(): { minStartSampleIndex: number; maxStartSampleIndex: number } | null {
    if (this.compactWindow === null) return null;
    const maxStartSampleIndex = lastValidStart(
      this.compactWindow.totalObservedSampleCount,
      rawWindowMaxValues(this.compactWindow.gridSize),
      rawWindowRowHop(this.compactWindow.gridSize),
    );
    return { minStartSampleIndex: 0, maxStartSampleIndex };
  }

  /** Jumps to an explicit observed-sample-index start, aligned down to the
   * nearest sample-hop multiple for the selected grid size. */
  setStartSampleIndex(startSampleIndex: number): void {
    const aligned = alignToRowHop(startSampleIndex, rawWindowRowHop(this.gridSize));
    if (aligned === this.requestedStartSampleIndex) return;
    this.requestedStartSampleIndex = aligned;
    this.loadCompact();
  }

  goToPreviousCompactFrame(): void {
    this.setStartSampleIndex(this.requestedStartSampleIndex - rawWindowRowHop(this.gridSize));
  }

  goToNextCompactFrame(): void {
    this.setStartSampleIndex(this.requestedStartSampleIndex + rawWindowRowHop(this.gridSize));
  }

  goToFirstCompactFrame(): void {
    this.setStartSampleIndex(0);
  }

  goToLastCompactFrame(): void {
    const bounds = this.getCompactNavigationBounds();
    this.setStartSampleIndex(bounds === null ? this.requestedStartSampleIndex : bounds.maxStartSampleIndex);
  }

  private loadCompact(): void {
    const recordingId = this.recordingId;
    const channel = this.channel;
    if (recordingId === null || channel === null) {
      this.compactRequestVersion += 1;
      this.compactStatus = "empty";
      this.compactErrorMessage = null;
      this.compactWindow = null;
      this.notify();
      return;
    }

    const requestVersion = ++this.compactRequestVersion;
    const startSampleIndex = this.requestedStartSampleIndex;
    const gridSize = this.gridSize;
    this.compactStatus = "loading";
    this.compactErrorMessage = null;
    this.notify();

    void getCompactObservationWindow({ recordingId, column: channel, startSampleIndex, gridSize }).then((result) => {
      if (
        requestVersion !== this.compactRequestVersion ||
        this.recordingId !== recordingId ||
        this.channel !== channel ||
        this.gridSize !== gridSize
      ) {
        return;
      }

      if (result.status === "error") {
        this.compactStatus = "error";
        this.compactErrorMessage = result.message;
        this.compactWindow = null;
      } else {
        this.compactStatus = "loaded";
        this.compactErrorMessage = null;
        this.compactWindow = result.value;
        // The backend resolves/clamps `startSampleIndex` deterministically;
        // keep the requested value in sync so the next relative navigation
        // (prev/next) starts from the real window, exactly like raw rows.
        this.requestedStartSampleIndex = result.value.startSampleIndex;
      }
      this.notify();
    });
  }

  setRecording(recordingId: string | null): void {
    if (recordingId === this.recordingId) return;
    this.recordingId = recordingId;
    this.requestedStartRawRow = 0;
    this.requestedStartSampleIndex = 0;
    this.resetAndReload();
  }

  setChannel(channel: RawImageViewerChannel | null): void {
    if (channel === this.channel) return;
    this.channel = channel;
    this.requestedStartRawRow = 0;
    this.requestedStartSampleIndex = 0;
    this.resetAndReload();
  }

  /** Changing grid size realigns the current start to the new hop (never resets to 0 unless already there) and reloads against the new N*N window. */
  setGridSize(gridSize: RawGridSize): void {
    if (gridSize === this.gridSize) return;
    this.gridSize = gridSize;
    this.requestedStartRawRow = alignToRowHop(this.requestedStartRawRow, rawWindowRowHop(gridSize));
    this.requestedStartSampleIndex = alignToRowHop(this.requestedStartSampleIndex, rawWindowRowHop(gridSize));
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

  /** Jumps to an explicit raw row start (e.g. from a slider drag), aligned down to the nearest row-hop multiple for the selected grid size. */
  setStartRawRow(startRawRow: number): void {
    const aligned = alignToRowHop(startRawRow, rawWindowRowHop(this.gridSize));
    if (aligned === this.requestedStartRawRow) return;
    this.requestedStartRawRow = aligned;
    this.reload();
  }

  goToPreviousFrame(): void {
    this.setStartRawRow(this.requestedStartRawRow - rawWindowRowHop(this.gridSize));
  }

  goToNextFrame(): void {
    this.setStartRawRow(this.requestedStartRawRow + rawWindowRowHop(this.gridSize));
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
    this.derivativeWindow = null;
    this.derivativeErrorMessage = null;
    this.sampleOrderPreviewStatus = "empty";
    this.sampleOrderPreviewErrorMessage = null;
    this.sampleOrderPreviewWindow = null;
    this.compactStatus = "empty";
    this.compactErrorMessage = null;
    this.compactWindow = null;
    this.reload();
    if (this.viewMode === "observedSamples") this.loadCompact();
  }

  private reload(): void {
    const recordingId = this.recordingId;
    const channel = this.channel;
    if (recordingId === null || channel === null) {
      this.requestVersion += 1;
      this.status = "empty";
      this.errorMessage = null;
      this.window = null;
      this.derivativeStatus = "empty";
      this.derivativeErrorMessage = null;
      this.derivativeWindow = null;
      this.sampleOrderPreviewStatus = "empty";
      this.sampleOrderPreviewErrorMessage = null;
      this.sampleOrderPreviewWindow = null;
      this.notify();
      return;
    }

    const requestVersion = ++this.requestVersion;
    const startRawRow = this.requestedStartRawRow;
    const gridSize = this.gridSize;
    this.status = "loading";
    this.errorMessage = null;
    this.derivativeStatus = "loading";
    this.derivativeErrorMessage = null;
    // A new row-start/selection request supersedes any sample-order preview
    // for the previous window — it is row-specific and must never be shown
    // against a different selection than the one the user opted it in for.
    this.sampleOrderPreviewStatus = "empty";
    this.sampleOrderPreviewErrorMessage = null;
    this.sampleOrderPreviewWindow = null;
    this.notify();

    // Discard a response if a newer request has since been issued, or if
    // the recording/channel/grid-size selection has moved on entirely (e.g.
    // the user switched recordings or grid size while this request was in
    // flight): either way, the current selection must never be overwritten
    // by a superseded response. Shared by the raw and derivative fetches
    // below so both are held to the identical staleness guard.
    const isStale = (): boolean =>
      requestVersion !== this.requestVersion ||
      this.recordingId !== recordingId ||
      this.channel !== channel ||
      this.gridSize !== gridSize;

    void getRawRecordingWindow({ recordingId, column: channel, startRawRow, gridSize }).then((result) => {
      if (isStale()) return;

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

    // Requested with the identical recording/channel/grid-size/start-row as
    // the raw window above, so a resolved derivative response is row-aligned
    // with it by construction. Resolves independently of the raw fetch: a
    // slow, failed, or "unavailable" derivative never blocks or replaces the
    // raw Grayscale/Rainbow canvases, and vice versa.
    void getRawRecordingDerivativeWindow({ recordingId, column: channel, startRawRow, gridSize }).then((result) => {
      if (isStale()) return;

      if (result.status === "error") {
        this.derivativeStatus = "error";
        this.derivativeErrorMessage = result.message;
        this.derivativeWindow = null;
      } else {
        this.derivativeStatus = "loaded";
        this.derivativeErrorMessage = null;
        this.derivativeWindow = result.value;
      }
      this.notify();
    });
  }
}

export const rawImageViewerStore = new RawImageViewerStore();
