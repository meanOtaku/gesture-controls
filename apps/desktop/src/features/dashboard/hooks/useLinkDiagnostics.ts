import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { WATCH_LINK_DIAGNOSTICS_EVENT, type LinkDiagnostics } from "../../../shared/protocol/events";

/** The watch link's live diagnostics; null outside the desktop app, where there is no link. */
export function useLinkDiagnostics(): LinkDiagnostics | null {
  const [diagnostics, setDiagnostics] = useState<LinkDiagnostics | null>(null);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let cancelled = false;
    const registration = listen<LinkDiagnostics>(WATCH_LINK_DIAGNOSTICS_EVENT, ({ payload }) => {
      if (!cancelled) setDiagnostics(payload);
    });
    // Ask for a snapshot straight away rather than waiting for the next tick.
    void invoke<LinkDiagnostics>("get_watch_link_diagnostics")
      .then((snapshot) => {
        if (!cancelled) setDiagnostics((current) => current ?? snapshot);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      void registration.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, []);

  return diagnostics;
}
