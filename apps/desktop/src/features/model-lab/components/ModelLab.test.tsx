import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../../app/App";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const DATASET_A = {
  id: "dataset-a",
  originalFilename: "session-1.csv",
  importedAt: "2026-08-31T00:00:00Z",
  label: "pinch_start",
  rowCount: 42,
};

async function openModelLab() {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Model Lab" }));
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("list_model_datasets"));
}

describe("ModelLab", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
  });

  it("opens from the nav tab and shows every workflow section plus the unavailable-runner reason", async () => {
    await openModelLab();

    for (const sectionLabel of ["Dataset", "Label coverage", "Training", "Evaluation", "Export and deploy"]) {
      expect(screen.getByRole("region", { name: sectionLabel })).toBeInTheDocument();
    }

    expect(screen.getAllByText(/managed tauri runner is the next integration slice/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Start training" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export model" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deploy to device" })).toBeDisabled();

    expect(await screen.findByText(/no dataset sessions imported yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no trained model exists yet/i)).toBeInTheDocument();
  });

  it("loads imported sessions on mount and shows label plus row count", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([DATASET_A]);
      return Promise.resolve(undefined);
    });

    await openModelLab();

    expect(await screen.findByText(/session-1\.csv.*pinch start.*42 rows/i)).toBeInTheDocument();
  });

  it("derives label coverage counts from imported sessions", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([DATASET_A]);
      return Promise.resolve(undefined);
    });

    await openModelLab();

    await screen.findByText(/session-1\.csv/i);
    const pinchStartRow = screen.getByText("pinch start").closest(".model-lab-label-row");
    expect(pinchStartRow).not.toBeNull();
    expect(pinchStartRow).toHaveTextContent("1 session");

    const idleRow = screen.getByText("idle").closest(".model-lab-label-row");
    expect(idleRow).not.toBeNull();
    expect(idleRow).toHaveTextContent("0 sessions");
  });

  it("imports a selected CSV file via a hidden file input and refreshes the list", async () => {
    let listCallCount = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") {
        listCallCount += 1;
        return Promise.resolve(listCallCount === 1 ? [] : [DATASET_A]);
      }
      if (command === "import_model_dataset") return Promise.resolve(DATASET_A);
      return Promise.resolve(undefined);
    });

    await openModelLab();

    const file = new File(["# label: pinch_start\ncsv,content"], "session-1.csv", { type: "text/csv" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("import_model_dataset", {
        filename: "session-1.csv",
        csvContent: "# label: pinch_start\ncsv,content",
      }),
    );

    expect(await screen.findByText(/session-1\.csv.*pinch start.*42 rows/i)).toBeInTheDocument();
  });

  it("deletes an imported session and refreshes the list", async () => {
    let listCallCount = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") {
        listCallCount += 1;
        return Promise.resolve(listCallCount === 1 ? [DATASET_A] : []);
      }
      if (command === "delete_model_dataset") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    await openModelLab();

    await screen.findByText(/session-1\.csv/i);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("delete_model_dataset", { id: "dataset-a" }));
    expect(await screen.findByText(/no dataset sessions imported yet/i)).toBeInTheDocument();
  });

  it("shows an operation error when loading sessions fails", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.reject(new Error("disk unavailable"));
      return Promise.resolve(undefined);
    });

    await openModelLab();

    expect(await screen.findByRole("alert")).toHaveTextContent(/disk unavailable/i);
  });

  it("shows an operation error when import fails and does not add a row", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([]);
      if (command === "import_model_dataset") return Promise.reject(new Error("bad header"));
      return Promise.resolve(undefined);
    });

    await openModelLab();

    const file = new File(["bad,csv"], "broken.csv", { type: "text/csv" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByRole("alert")).toHaveTextContent(/bad header/i);
    expect(screen.getByText(/no dataset sessions imported yet/i)).toBeInTheDocument();
  });
});
