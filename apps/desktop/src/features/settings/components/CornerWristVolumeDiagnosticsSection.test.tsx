import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CornerWristVolumeDiagnosticsSection } from "./CornerWristVolumeDiagnosticsSection";
import type { OverlayState, WatchOrientationSample, WatchStatus } from "../../../shared/protocol/events";

afterEach(cleanup);

const overlay: OverlayState = {
  visible: true,
  grabbed: false,
  volume: 42,
  rotationAngle: 0,
  screenX: 0,
  screenY: 0,
  cornerDemoPhase: null,
  lastRelativeRollDegrees: null,
  lastNativeVolumeError: null,
};

const orientation: WatchOrientationSample = {
  deviceId: "watch-1",
  sequence: 1,
  timestampNs: 1_000_000,
  quaternion: [1, 0, 0, 0],
  accelerometer: null,
  gyroscope: null,
};

const watchStatus: WatchStatus = {
  connected: true,
  lastOrientation: orientation,
  lastHeartbeat: null,
  clockOffsetNs: null,
  roundTripNs: null,
  ppgState: null,
  ppgLastSample: null,
  ppgRateHz: null,
  lastButtonState: null,
  medicalStatus: {},
  sensorStatus: {},
  heartRateLast: null,
  heartRateRateHz: null,
  skinTemperatureLast: null,
  skinTemperatureRateHz: null,
  edaLast: null,
  edaRateHz: null,
  spo2Last: null,
  ecgLast: null,
  biaLast: null,
  sweatLossLast: null,
};

describe("CornerWristVolumeDiagnosticsSection", () => {
  it("distinguishes an inactive corner gate, absent orientation, and no relative roll delta", () => {
    render(<CornerWristVolumeDiagnosticsSection overlay={overlay} watchStatus={null} invertDirection={false} />);
    expect(screen.getByText("Inactive")).toBeInTheDocument();
    expect(screen.getByText("Absent")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("Normal")).toBeInTheDocument();
  });

  it("shows the corner gate phase, direction, and live relative roll delta once a sample arrives", () => {
    render(
      <CornerWristVolumeDiagnosticsSection
        overlay={{ ...overlay, cornerDemoPhase: "adjusting", lastRelativeRollDegrees: 12.3456 }}
        watchStatus={watchStatus}
        invertDirection={true}
      />,
    );
    expect(screen.getByText("Adjusting")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("12.3°")).toBeInTheDocument();
    expect(screen.getByText("Inverted")).toBeInTheDocument();
  });

  it("reports the current native volume value when reads succeed", () => {
    render(<CornerWristVolumeDiagnosticsSection overlay={overlay} watchStatus={null} invertDirection={false} />);
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("None")).toBeInTheDocument();
  });

  it("surfaces the exact native volume error instead of a static value", () => {
    render(
      <CornerWristVolumeDiagnosticsSection
        overlay={{ ...overlay, lastNativeVolumeError: "native volume backend failed: not authorized" }}
        watchStatus={null}
        invertDirection={false}
      />,
    );
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("native volume backend failed: not authorized")).toBeInTheDocument();
  });

  it("marks the Watch orientation stale once no new sample has arrived for a while", () => {
    vi.useFakeTimers();
    try {
      render(
        <CornerWristVolumeDiagnosticsSection overlay={overlay} watchStatus={watchStatus} invertDirection={false} />,
      );
      expect(screen.getByText("Live")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(screen.getByText("Stale")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
