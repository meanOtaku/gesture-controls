import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { HelpTooltip } from "../../../components/app/HelpTooltip";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { WatchBleStatus, WatchTransport, WatchTransportStatus } from "../../../shared/protocol/events";

/** How often the BLE scan/connect/trust state is re-read while Bluetooth is selected. */
const BLE_STATUS_POLL_MS = 1000;

/** One human-readable line per `BleStatus` variant in `crates/watch-bridge/src/ble.rs`. */
function describeBle(status: WatchBleStatus): string {
  switch (status.state) {
    case "idle":
      return "Not running.";
    case "scanning":
      return "Scanning for a Watch advertising the gesture-controls service…";
    case "connecting":
      return "Connecting and subscribing to Watch telemetry…";
    case "awaitingWatchTrust":
      return "Connected. Approve this computer on the Watch to start streaming.";
    case "streaming":
      return "Streaming over Bluetooth.";
    case "failed":
      return status.detail ?? "Bluetooth transport failed.";
  }
}

type WatchTransportSectionProps = {
  /** Selected transport from settings; the section reflects it until the live status loads. */
  selected: WatchTransport;
  onSelect: (transport: WatchTransport) => void;
};

/**
 * Chooses the live Watch link and shows what the Bluetooth central is doing.
 * Selecting one transport stops the other outright on the desktop side (see
 * `settings::apply_watch_transport`), so this is never a display-only toggle.
 */
export function WatchTransportSection({ selected, onSelect }: WatchTransportSectionProps) {
  const [ble, setBle] = useState<WatchBleStatus>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    invoke<WatchTransportStatus>("get_watch_transport_status")
      .then((status) => setBle(status.ble))
      .catch((cause: unknown) => setError(String(cause)));
  }, []);

  useEffect(() => {
    refresh();
    if (selected !== "bluetooth") return;
    const timer = setInterval(refresh, BLE_STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, selected]);

  const select = (transport: WatchTransport) => {
    setError(null);
    invoke("set_watch_transport", { transport })
      .then(() => {
        onSelect(transport);
        refresh();
      })
      .catch((cause: unknown) => setError(String(cause)));
  };

  const rescan = () => {
    setError(null);
    invoke("rescan_watch_ble")
      .then(refresh)
      .catch((cause: unknown) => setError(String(cause)));
  };

  return (
    <Card role="region" aria-label="Watch transport">
      <CardHeader>
        <div className="flex items-center gap-2">
          <SectionHeader title="Transport" description="Galaxy Watch" />
          <HelpTooltip label="About the Watch transport">
            Bluetooth connects directly to the Watch's BLE service — no network needed — and only streams once
            you approve this computer on the Watch itself. Wi-Fi uses the LAN WebSocket bridge with mDNS
            discovery. Exactly one runs at a time.
          </HelpTooltip>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <Button
            aria-pressed={selected === "bluetooth"}
            variant={selected === "bluetooth" ? "default" : "outline"}
            onClick={() => select("bluetooth")}
          >
            Bluetooth
          </Button>
          <Button
            aria-pressed={selected === "wifi"}
            variant={selected === "wifi" ? "default" : "outline"}
            onClick={() => select("wifi")}
          >
            Wi-Fi
          </Button>
        </div>

        {selected === "bluetooth" && (
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{describeBle(ble)}</span>
            <Button variant="outline" onClick={rescan}>
              Scan again
            </Button>
          </div>
        )}

        {selected === "wifi" && (
          <p className="mt-3 text-xs text-muted-foreground">
            Bluetooth scanning, the GATT connection and its notification subscription are released while Wi-Fi is
            selected.
          </p>
        )}

        {error && (
          <p className="mt-3 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
