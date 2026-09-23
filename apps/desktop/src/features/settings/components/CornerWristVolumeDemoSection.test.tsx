import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CornerWristVolumeDemoSection } from "./CornerWristVolumeDemoSection";

afterEach(cleanup);

describe("CornerWristVolumeDemoSection", () => {
  it("defaults to disabled and hides the direction toggle while disabled", () => {
    render(
      <CornerWristVolumeDemoSection
        enabled={false}
        invertDirection={false}
        onToggleEnabled={() => {}}
        onToggleInvertDirection={() => {}}
      />,
    );
    expect(screen.getByRole("switch", { name: "Corner wrist volume demo disabled" })).not.toBeChecked();
    expect(screen.queryByRole("switch", { name: /Corner wrist volume direction/ })).not.toBeInTheDocument();
  });

  it("shows the invert-direction toggle only once the demo is enabled", () => {
    render(
      <CornerWristVolumeDemoSection
        enabled={true}
        invertDirection={false}
        onToggleEnabled={() => {}}
        onToggleInvertDirection={() => {}}
      />,
    );
    expect(screen.getByRole("switch", { name: "Corner wrist volume demo enabled" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Corner wrist volume direction not inverted" })).not.toBeChecked();
  });

  it("calls the enable toggle without touching invert direction", () => {
    let enabledCalls = 0;
    render(
      <CornerWristVolumeDemoSection
        enabled={false}
        invertDirection={false}
        onToggleEnabled={() => { enabledCalls += 1; }}
        onToggleInvertDirection={() => { throw new Error("must not be called"); }}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Corner wrist volume demo disabled" }));
    expect(enabledCalls).toBe(1);
  });
});
