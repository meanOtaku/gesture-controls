import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { HelpTooltip } from "./HelpTooltip";

afterEach(() => cleanup());

function renderHelp() {
  return render(
    <TooltipProvider>
      <HelpTooltip label="About export cancellation">Cancelling leaves your recorded data in memory.</HelpTooltip>
    </TooltipProvider>,
  );
}

describe("HelpTooltip", () => {
  it("exposes a keyboard-focusable trigger with the required accessible label", () => {
    renderHelp();
    expect(screen.getByRole("button", { name: "About export cancellation" })).toBeInTheDocument();
  });

  it("reveals its explanation on keyboard focus", async () => {
    renderHelp();
    fireEvent.focus(screen.getByRole("button", { name: "About export cancellation" }));
    expect(await screen.findByText("Cancelling leaves your recorded data in memory.")).toBeInTheDocument();
  });

  it("toggles its explanation on click/tap, as a fallback with no hover/keyboard input", async () => {
    renderHelp();
    const trigger = screen.getByRole("button", { name: "About export cancellation" });

    fireEvent.click(trigger);
    expect(await screen.findByText("Cancelling leaves your recorded data in memory.")).toBeInTheDocument();

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByText("Cancelling leaves your recorded data in memory.")).not.toBeInTheDocument());
  });
});
