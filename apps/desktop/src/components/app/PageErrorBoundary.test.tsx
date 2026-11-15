import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageErrorBoundary } from "./PageErrorBoundary";

afterEach(cleanup);

let failing = true;
function Page() {
  if (failing) throw new Error("cannot read properties of undefined (reading 'filter')");
  return <p>The page drew.</p>;
}

describe("PageErrorBoundary", () => {
  it("keeps a page's error inside it, says so, and tries the page again", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    failing = true;
    render(<><nav>Sidebar</nav><PageErrorBoundary page="Model Lab"><Page /></PageErrorBoundary></>);
    expect(screen.getByText("Sidebar")).toBeInTheDocument();
    expect(screen.getByText("Model Lab hit an error")).toBeInTheDocument();
    expect(screen.getByText(/reading 'filter'/)).toBeInTheDocument();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("The page drew.")).toBeInTheDocument();
  });

  it("asks for a reload, not a retry, when the page's code can no longer be loaded", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Stale(): never { throw new Error("Failed to fetch dynamically imported module: /src/ModelLab.tsx"); }
    render(<PageErrorBoundary page="Model Lab"><Stale /></PageErrorBoundary>);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reload the window" })).toBeInTheDocument();
  });
});
