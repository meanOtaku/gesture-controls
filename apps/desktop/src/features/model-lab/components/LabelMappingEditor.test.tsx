import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LabelMappingEditor } from "./LabelMappingEditor";
import { LEGACY_COMPATIBILITY_LABEL_MAPPING, type DatasetLabel, type LabelMapping } from "../types";
import { TooltipProvider } from "../../../components/ui/tooltip";

afterEach(() => cleanup());

const LABELS: DatasetLabel[] = [
  {
    id: "pinch_start",
    displayName: "Pinch start",
    description: "User gesture",
    color: "#65e6ff",
    role: "positiveGesture",
    archivedAt: null,
  },
  {
    id: "idle",
    displayName: "Idle",
    description: "No activity",
    color: "#65e6ff",
    role: "negativeBackground",
    archivedAt: null,
  },
  {
    id: "wrist_flick",
    displayName: "Wrist flick",
    description: "Custom gesture",
    color: "#fff",
    role: "positiveGesture",
    archivedAt: null,
  },
];

function renderEditor(overrides: Partial<React.ComponentProps<typeof LabelMappingEditor>> = {}) {
  const props: React.ComponentProps<typeof LabelMappingEditor> = {
    selectedDatasetLabels: new Set(),
    labels: LABELS,
    mapping: LEGACY_COMPATIBILITY_LABEL_MAPPING,
    onMappingChange: vi.fn(),
    ...overrides,
  };
  render(
    <TooltipProvider>
      <LabelMappingEditor {...props} />
    </TooltipProvider>,
  );
  return props;
}

describe("LabelMappingEditor", () => {
  it("renders an accessible region", () => {
    renderEditor();
    expect(screen.getByRole("region", { name: "Training label role mapping" })).toBeInTheDocument();
  });

  it("shows no labels when selection is empty", () => {
    renderEditor({ selectedDatasetLabels: new Set() });
    expect(screen.queryByText("Pinch start")).not.toBeInTheDocument();
  });

  it("marks legacy labels as using their default role", () => {
    renderEditor({
      selectedDatasetLabels: new Set(["pinch_start", "idle"]),
    });
    const pinchStartRow = screen.getByText("Pinch start").closest(".model-lab-label-row");
    expect(pinchStartRow).toHaveTextContent("Legacy default");
    expect(pinchStartRow).toHaveTextContent("Using legacy default");
  });

  it("highlights custom labels that need a training role assignment", () => {
    renderEditor({
      selectedDatasetLabels: new Set(["wrist_flick"]),
      mapping: LEGACY_COMPATIBILITY_LABEL_MAPPING,
    });
    expect(screen.getByText("Needs training role")).toBeInTheDocument();
    expect(screen.getByText(/1 label needs training role/)).toBeInTheDocument();
  });

  it("allows assigning a custom label as a target class", () => {
    const onMappingChange = vi.fn();
    renderEditor({
      selectedDatasetLabels: new Set(["wrist_flick"]),
      onMappingChange,
    });
    fireEvent.click(screen.getByLabelText("wrist_flick-target"));
    expect(onMappingChange).toHaveBeenCalled();
    const mapping = onMappingChange.mock.calls[0][0] as LabelMapping;
    expect(mapping.entries.wrist_flick).toEqual({ role: "target", target: "pinch_start" });
  });

  it("shows a target class dropdown when target role is selected", () => {
    const onMappingChange = vi.fn();
    renderEditor({
      selectedDatasetLabels: new Set(["wrist_flick"]),
      onMappingChange,
    });
    fireEvent.click(screen.getByLabelText("wrist_flick-target"));
    expect(onMappingChange).toHaveBeenCalled();
    const mapping = onMappingChange.mock.calls[0][0] as LabelMapping;
    const newMapping = { ...LEGACY_COMPATIBILITY_LABEL_MAPPING, entries: mapping.entries };
    cleanup();
    renderEditor({
      selectedDatasetLabels: new Set(["wrist_flick"]),
      mapping: newMapping,
      onMappingChange,
    });
    expect(screen.getByRole("combobox", { name: "Target class for wrist_flick" })).toBeInTheDocument();
  });

  it("allows assigning a custom label as negative", () => {
    const onMappingChange = vi.fn();
    renderEditor({
      selectedDatasetLabels: new Set(["wrist_flick"]),
      onMappingChange,
    });
    fireEvent.click(screen.getByLabelText("wrist_flick-negative"));
    expect(onMappingChange).toHaveBeenCalled();
    const mapping = onMappingChange.mock.calls[0][0] as LabelMapping;
    expect(mapping.entries.wrist_flick).toEqual({ role: "negative" });
  });

  it("allows assigning a custom label as excluded", () => {
    const onMappingChange = vi.fn();
    renderEditor({
      selectedDatasetLabels: new Set(["wrist_flick"]),
      onMappingChange,
    });
    fireEvent.click(screen.getByLabelText("wrist_flick-exclude"));
    expect(onMappingChange).toHaveBeenCalled();
    const mapping = onMappingChange.mock.calls[0][0] as LabelMapping;
    expect(mapping.entries.wrist_flick).toEqual({ role: "exclude" });
  });

  it("can reset a custom assignment to legacy default", () => {
    const customMapping = {
      ...LEGACY_COMPATIBILITY_LABEL_MAPPING,
      entries: {
        ...LEGACY_COMPATIBILITY_LABEL_MAPPING.entries,
        wrist_flick: { role: "target" as const, target: "pinch_release" },
      },
    };
    const onMappingChange = vi.fn();
    renderEditor({
      selectedDatasetLabels: new Set(["wrist_flick"]),
      mapping: customMapping,
      onMappingChange,
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(onMappingChange).toHaveBeenCalled();
    const mapping = onMappingChange.mock.calls[0][0] as LabelMapping;
    expect(mapping.entries.wrist_flick).toBeUndefined();
  });

  it("shows the badge count for multiple unmapped labels", () => {
    renderEditor({
      selectedDatasetLabels: new Set(["wrist_flick", "another_custom"]),
      mapping: LEGACY_COMPATIBILITY_LABEL_MAPPING,
    });
    expect(screen.getByText(/2 labels need training roles/)).toBeInTheDocument();
  });

  it("allows changing target class selection", () => {
    const customMapping = {
      ...LEGACY_COMPATIBILITY_LABEL_MAPPING,
      entries: {
        ...LEGACY_COMPATIBILITY_LABEL_MAPPING.entries,
        wrist_flick: { role: "target" as const, target: "pinch_start" },
      },
    };
    const onMappingChange = vi.fn();
    renderEditor({
      selectedDatasetLabels: new Set(["wrist_flick"]),
      mapping: customMapping,
      onMappingChange,
    });
    fireEvent.click(screen.getByRole("combobox", { name: "Target class for wrist_flick" }));
    const releaseOption = screen.getByRole("option", { name: "pinch release" });
    fireEvent.click(releaseOption);
    expect(onMappingChange).toHaveBeenCalled();
    const mapping = onMappingChange.mock.calls[0][0] as LabelMapping;
    expect(mapping.entries.wrist_flick).toEqual({ role: "target", target: "pinch_release" });
  });
});
