import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadinessPanel } from "./ReadinessPanel";
import { TooltipProvider } from "../../../components/ui/tooltip";

afterEach(() => cleanup());

function renderPanel(overrides: Partial<React.ComponentProps<typeof ReadinessPanel>> = {}) {
  const props: React.ComponentProps<typeof ReadinessPanel> = {
    desktopAvailable: true,
    diagnostics: [],
    error: null,
    onRecheck: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<TooltipProvider><ReadinessPanel {...props} /></TooltipProvider>);
  return props;
}

describe("ReadinessPanel", () => {
  it("exposes an accessible region and shows a loading hint with nothing checked yet", () => {
    renderPanel();
    expect(screen.getByRole("region", { name: "Desktop readiness" })).toBeInTheDocument();
    expect(screen.getByText(/checking local desktop requirements/i)).toBeInTheDocument();
  });

  it("lists diagnostics with status and optional action text", () => {
    renderPanel({
      diagnostics: [
        { id: "training-runner", title: "Training and replay runner", status: "attention", detail: "uv was not found on PATH.", action: "Install uv and restart the app." },
        { id: "volume-backend", title: "System volume backend", status: "ready", detail: "The desktop can read the host system volume.", action: null },
      ],
    });
    expect(screen.getByText("Training and replay runner")).toBeInTheDocument();
    expect(screen.getByText(/install uv and restart the app/i)).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.getByText("attention")).toBeInTheDocument();
  });

  it("shows an inline error when the last recheck failed", () => {
    renderPanel({ error: "disk unavailable" });
    expect(screen.getByRole("alert")).toHaveTextContent(/disk unavailable/i);
  });

  it("disables Recheck outside the desktop app", () => {
    renderPanel({ desktopAvailable: false });
    expect(screen.getByRole("button", { name: "Recheck" })).toBeDisabled();
  });

  it("runs onRecheck when clicked and shows pending state meanwhile", async () => {
    let resolveRecheck: () => void = () => {};
    const onRecheck = vi.fn(() => new Promise<void>((resolve) => { resolveRecheck = resolve; }));
    renderPanel({ onRecheck });

    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Rechecking…" })).toBeDisabled();

    resolveRecheck();
    await waitFor(() => expect(screen.getByRole("button", { name: "Recheck" })).toBeEnabled());
  });
});
