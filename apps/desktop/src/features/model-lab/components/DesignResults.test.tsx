import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupByDesign, type DesignResult } from "../designResults";
import { DesignResults } from "./DesignResults";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const result = (modelId: string, designId: string | null, designName: string | null, auc: number | null, extra: Partial<DesignResult> = {}): DesignResult => ({
  modelId, label: "snap", createdAt: "2026-10-01", designId, designName, method: "torch-mlp", edited: false,
  metrics: auc === null ? null : { rocAuc: auc, f1: 0.5, falseActivationRate: 0.1 }, ...extra,
});

describe("groupByDesign", () => {
  it("averages fresh models, lists edited ones without averaging them, and puts the best design first", () => {
    const groups = groupByDesign([
      result("a", "d1", "Small", 0.6), result("b", "d1", "Small", 0.8), result("c", "d1", "Small", 0.99, { edited: true }),
      result("d", "d2", "Wide", 0.9), result("e", null, null, 0.5), result("f", "gone", null, null),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["Wide", "Small", "No design", "A deleted design"]);
    const small = groups.find((g) => g.name === "Small")!;
    expect([small.models.length, small.scored, small.bestAuc]).toEqual([3, 2, 0.8]);
    expect(small.meanAuc).toBeCloseTo(0.7);
    expect(groups.at(-1)!.meanAuc).toBeNull();
    expect(groups.at(-1)!.note).toMatch(/deleted/);
  });
});

describe("DesignResults", () => {
  beforeEach(() => invokeMock.mockReset());
  afterEach(cleanup);

  it("compares designs, warns about single scores and opens a model", async () => {
    invokeMock.mockResolvedValue([result("m1", "d1", "Small", 0.62), result("m2", "d2", "Wide", 0.91)]);
    const onInspect = vi.fn();
    render(<DesignResults desktopAvailable refreshKey="" onInspect={onInspect} />);
    const table = await screen.findByRole("table", { name: "Designs compared" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Wide");
    expect(rows[0]).toHaveTextContent("0.91");
    expect(rows[1]).toHaveTextContent("Small");
    expect(screen.getByText(/average of one score is just that score/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Wide: 0.91 from 1 model/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Look inside m1 from results" }));
    expect(onInspect).toHaveBeenCalledWith("m1");
  });

  it("says so when nothing was trained here", async () => {
    invokeMock.mockResolvedValue([]);
    render(<DesignResults desktopAvailable refreshKey="" onInspect={() => undefined} />);
    expect(await screen.findByText(/No models trained here yet/)).toBeInTheDocument();
  });
});
