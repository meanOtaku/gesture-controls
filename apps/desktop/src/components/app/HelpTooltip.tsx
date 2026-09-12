import { CircleHelpIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { buttonVariants } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

type HelpTooltipProps = {
  /** Required accessible name for the "?" trigger, e.g. "About export cancellation". */
  label: string;
  children: ReactNode;
};

/**
 * A keyboard-focusable "?" trigger for concise contextual help. Opens on
 * hover and keyboard focus via the official shadcn Tooltip; the open state
 * is also controlled so a tap/click reliably toggles it as a fallback on
 * touch devices that do not reliably emit hover events.
 */
export function HelpTooltip({ label, children }: HelpTooltipProps) {
  const [open, setOpen] = useState(false);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        aria-label={label}
        className={buttonVariants({ variant: "ghost", size: "icon-xs", className: "rounded-full text-muted-foreground" })}
        onClick={() => setOpen((current) => !current)}
      >
        <CircleHelpIcon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
}
