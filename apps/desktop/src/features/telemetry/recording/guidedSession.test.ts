import { describe, expect, it } from "vitest";
import { COUNTDOWN_MS, DEFAULT_PLAN, LEAD_IN_MS, labelAt, noisePlan, planProblem, planSteps, prompt, stepAt, totalMs, type GuidedPlan } from "./guidedSession";

const plan: GuidedPlan = { ...DEFAULT_PLAN, label: "pinch", cues: 3, holdMs: 800, minGapSeconds: 4, maxGapSeconds: 8, everydayLabel: "everyday", activities: [{ activity: "Type", seconds: 10 }] };

describe("a guided session's plan", () => {
  it("of everyday noise has no cue, only labelled activities", () => {
    const noise = noisePlan([{ activity: "Type", seconds: 10 }, { activity: "Rest", seconds: 20, label: "still" }], "everyday");
    expect(planProblem(noise)).toBeNull();
    const steps = planSteps(noise);
    expect(steps.map((step) => step.kind)).toEqual(["rest", "rest", "activity", "rest", "activity", "rest"]);
    expect(labelAt(steps, steps[2].atMs + 1)).toBe("everyday");
    // A stretch with its own label keeps it.
    expect(labelAt(steps, steps[4].atMs + 1)).toBe("still");
    expect(noisePlan(noise.activities).everydayLabel).toBe("everyday_noise");
    expect(planProblem(noisePlan(noise.activities, null))).toBe("Choose the everyday label to give the activities.");
    expect(planProblem(noisePlan([]))).toBe("Add at least one everyday activity.");
    // A gesture plan still needs its gesture.
    expect(planProblem({ ...noise, cues: 3 })).toBe("Choose the gesture to cue.");
  });

  it("leads in, cues with rests drawn between the shortest and longest, then the activities", () => {
    const steps = planSteps(plan, () => 0.5); // every rest 6 s
    expect(steps.map((step) => step.kind)).toEqual(["rest", "cue", "rest", "cue", "rest", "cue", "rest", "activity", "rest"]);
    const cues = steps.filter((step) => step.kind === "cue");
    expect(cues.map((step) => step.atMs)).toEqual([LEAD_IN_MS, LEAD_IN_MS + 800 + 6000, LEAD_IN_MS + 2 * (800 + 6000)]);
    expect(planSteps(plan, () => 0)[2].durationMs).toBe(4000);
    expect(planSteps(plan, () => 0.999999)[2].durationMs).toBe(8000);
    // Each step starts where the last ended.
    steps.slice(1).forEach((step, i) => expect(step.atMs).toBe(steps[i].atMs + steps[i].durationMs));
    expect(totalMs(steps)).toBe(LEAD_IN_MS + 3 * 800 + 2 * 6000 + 3000 + 10_000 + 2000);
  });

  it("labels the gesture during each cue and the everyday label during an activity, nothing in between", () => {
    const steps = planSteps(plan, () => 0.5);
    expect(labelAt(steps, LEAD_IN_MS - 1)).toBeNull();
    expect(labelAt(steps, LEAD_IN_MS)).toBe("pinch");
    expect(labelAt(steps, LEAD_IN_MS + 799)).toBe("pinch");
    expect(labelAt(steps, LEAD_IN_MS + 800)).toBeNull();
    const activity = steps.find((step) => step.kind === "activity")!;
    expect(labelAt(steps, activity.atMs + 1)).toBe("everyday");
    expect(labelAt(steps, totalMs(steps))).toBeNull();
    expect(stepAt(steps, totalMs(steps))).toBeNull();
  });

  it("counts down to each cue and names the gesture at it", () => {
    const steps = planSteps(plan, () => 0.5);
    expect(prompt(steps, 0).tone).toBe("rest");
    expect(prompt(steps, LEAD_IN_MS - COUNTDOWN_MS + 1)).toMatchObject({ title: "Get ready… 3", tone: "ready" });
    expect(prompt(steps, LEAD_IN_MS - 500)).toMatchObject({ title: "Get ready… 1" });
    expect(prompt(steps, LEAD_IN_MS + 10, () => "Pinch")).toMatchObject({ title: "Pinch now", detail: "Hold it… (1 of 3)", tone: "cue" });
    expect(prompt(steps, totalMs(steps)).tone).toBe("done");
  });

  it("says to let go just after each hold, and can say its own cue", () => {
    const steps = planSteps(plan, () => 0.5);
    const afterFirst = LEAD_IN_MS + 800;
    expect(prompt(steps, afterFirst + 10)).toMatchObject({ title: "Let go", tone: "release" });
    expect(prompt(steps, afterFirst + 1500).tone).not.toBe("release");
    expect(prompt(steps, LEAD_IN_MS + 10, () => "Pinch in", "Pinch")).toMatchObject({ title: "Pinch", tone: "cue" });
  });

  it("says what is wrong with a plan", () => {
    expect(planProblem(plan)).toBeNull();
    expect(planProblem({ ...plan, label: "" })).toMatch(/gesture/);
    expect(planProblem({ ...plan, cues: 0 })).toMatch(/1 to 500/);
    expect(planProblem({ ...plan, minGapSeconds: 9 })).toMatch(/shortest/);
    expect(planProblem({ ...plan, activities: [{ activity: "", seconds: 10 }] })).toMatch(/activity/);
  });
});
