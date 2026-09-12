import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntentBindingEditor } from "./IntentBindingEditor";
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
  render(<IntentBindingEditor {...props} />);
  return props;
}

describe("IntentBindingEditor", () => {
  it("only offers safe intents per class", () => {
    renderEditor();
    const negativeSelect = screen.getByRole("combobox", { name: "negative intent for model-a" });
    expect(Array.from(negativeSelect.querySelectorAll("option")).map((option) => option.textContent)).toEqual([
      "No action",
    ]);
    const pinchStartSelect = screen.getByRole("combobox", { name: "pinch_start intent for model-a" });
    expect(Array.from(pinchStartSelect.querySelectorAll("option")).map((option) => option.textContent)).toEqual([
      "Begin volume grab",
      "No action",
    ]);
  });

  it("reports a draft change and saves", async () => {
    const onDraftChange = vi.fn();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderEditor({ onDraftChange, onSave });

    fireEvent.change(screen.getByRole("combobox", { name: "pinch_start intent for model-a" }), {
      target: { value: "volumeGrab" },
    });
    expect(onDraftChange).toHaveBeenCalledWith("pinch_start", "volumeGrab");

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
