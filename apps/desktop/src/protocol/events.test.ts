import { describe, expect, it } from "vitest";
import { newestRuntimeStatus, type HeadTrackerRuntimeStatus } from "./events";

const status = (revision: number, message: string): HeadTrackerRuntimeStatus => ({
  state: "searching",
  message,
  device: null,
  revision,
  canRecenter: true,
});

describe("newestRuntimeStatus", () => {
  it("does not let a delayed command snapshot overwrite a newer event", () => {
    const current = status(8, "connected event");
    const delayed = status(7, "older command response");
    expect(newestRuntimeStatus(current, delayed)).toBe(current);
  });

  it("accepts a status with an equal or newer revision", () => {
    const current = status(8, "current");
    const incoming = status(9, "newer");
    expect(newestRuntimeStatus(current, incoming)).toBe(incoming);
  });
});
