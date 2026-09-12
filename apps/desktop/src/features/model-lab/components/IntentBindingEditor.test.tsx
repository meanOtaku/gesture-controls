import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntentBindingEditor } from "./IntentBindingEditor";
import { TooltipProvider } from "../../../components/ui/tooltip";
import type { ModelRegistryModel } from "../types";

afterEach(() => cleanup());

const MODEL: ModelRegistryModel = { id: "model-a", state: "draft", createdAt: "2026-08-31T01:00:00Z", intentBindings: [] };

function renderEditor(overrides: Partial<React.ComponentProps<typeof IntentBindingEditor>> = {}) {
  const props: React.ComponentProps<typeof IntentBindingEditor> = {
    model: MODEL,
    editable: true,
    draft: undefined,
    onDraftChange: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<TooltipProvider><IntentBindingEditor {...props} /></TooltipProvider>);
  return props;
}

// Base UI's Select commits an item selection on pointerdown/pointerup, not a bare click.
function selectOption(option: HTMLElement) {
  fireEvent.pointerDown(option, { button: 0, pointerId: 1 });
  fireEvent.pointerUp(option, { button: 0, pointerId: 1 });
  fireEvent.click(option);
}

describe("IntentBindingEditor", () => {
  it("explains safe intent bindings via an accessible help tooltip", async () => {
    renderEditor();
    const trigger = screen.getByRole("button", { name: "About safe intent bindings" });
    fireEvent.focus(trigger);
    expect(await screen.findByText(/only Live mode can act on these bindings/i)).toBeInTheDocument();
  });

  it("only offers safe intents per class", async () => {
    renderEditor();
    fireEvent.click(screen.getByRole("combobox", { name: "negative intent for model-a" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["No action"]);
    selectOption(screen.getByRole("option", { name: "No action" }));

    fireEvent.click(screen.getByRole("combobox", { name: "pinch_start intent for model-a" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Begin volume grab",
      "No action",
    ]);
  });

  it("reports a draft change and saves", async () => {
    const onDraftChange = vi.fn();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderEditor({ onDraftChange, onSave });

    fireEvent.click(screen.getByRole("combobox", { name: "pinch_start intent for model-a" }));
    selectOption(await screen.findByRole("option", { name: "Begin volume grab" }));
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith("pinch_start", "volumeGrab"));

    fireEvent.click(screen.getByRole("button", { name: "Save bindings" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
  });

  it("shows Bindings incomplete until every class has a safe binding", () => {
    renderEditor({
      model: { ...MODEL, intentBindings: [{ classLabel: "negative", intent: "noAction" }] },
    });
    expect(screen.getByText("Bindings incomplete")).toBeInTheDocument();
  });

  it("hides the incomplete badge once bindings are complete", () => {
    renderEditor({
      model: {
        ...MODEL,
        intentBindings: [
          { classLabel: "negative", intent: "noAction" },
          { classLabel: "pinch_start", intent: "volumeGrab" },
          { classLabel: "pinch_release", intent: "volumeRelease" },
        ],
      },
    });
    expect(screen.queryByText("Bindings incomplete")).not.toBeInTheDocument();
  });

  it("shows read-only badges and no select or save button when not editable", () => {
    renderEditor({
      editable: false,
      model: {
        ...MODEL,
        state: "approved",
        intentBindings: [{ classLabel: "pinch_start", intent: "volumeGrab" }],
      },
    });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save bindings" })).not.toBeInTheDocument();
    expect(screen.getByText("Begin volume grab")).toBeInTheDocument();
    expect(screen.getAllByText("Unbound")).toHaveLength(2);
  });
});
