import type { ReactNode } from "react";
import { HelpTooltip } from "./HelpTooltip";

type SectionHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Optional slot for a status pill/badge rendered beside the title. */
  status?: ReactNode;
  /** Optional "?" help tooltip explaining this section's operational context. */
  help?: { label: string; content: ReactNode };
  className?: string;
};

/** Consistent section title/description/status layout used across feature cards. */
export function SectionHeader({ title, description, status, help, className }: SectionHeaderProps) {
  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <h2 className="m-0">{title}</h2>
        {help && <HelpTooltip label={help.label}>{help.content}</HelpTooltip>}
        {status && <div className="ml-auto">{status}</div>}
      </div>
      {description && <p className="subtitle">{description}</p>}
    </div>
  );
}
