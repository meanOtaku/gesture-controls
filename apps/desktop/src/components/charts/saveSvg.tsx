import { DownloadIcon } from "lucide-react";
import { type RefObject } from "react";
import { OperationFeedback } from "../app/OperationFeedback";
import { exportFile } from "../../shared/tauri/exportCsv";
import { Button } from "../ui/button";

/** The picture as a standalone SVG file: the colours it was drawn with, on white, readable outside the app. */
export function serialiseSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("style", "color:#1a1a1a;font-family:system-ui,sans-serif;background:#fff");
  const box = (svg.getAttribute("viewBox") ?? "0 0 100 100").split(/\s+/).map(Number);
  const backdrop = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  backdrop.setAttribute("width", String(box[2]));
  backdrop.setAttribute("height", String(box[3]));
  backdrop.setAttribute("fill", "#ffffff");
  clone.insertBefore(backdrop, clone.firstChild);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`;
}

/** A small button that saves the picture in `target` as an SVG file. */
export function SaveSvgButton({ target, name }: { target: RefObject<SVGSVGElement | null>; name: string }) {
  const save = async () => {
    const svg = target.current;
    if (!svg) return;
    const result = await exportFile({ content: serialiseSvg(svg), suggestedName: `${name}.svg`, title: "Save the picture", kind: "svg" });
    if (result.status === "saved") OperationFeedback.success("Save picture", `Saved ${result.path.split(/[/\\]/).pop()}`);
    else if (result.status === "error") OperationFeedback.error("Save picture", result.message);
  };
  return (
    <Button type="button" variant="ghost" size="sm" aria-label={`Save ${name} as an image`} onClick={() => void save()}>
      <DownloadIcon aria-hidden="true" />SVG
    </Button>
  );
}
