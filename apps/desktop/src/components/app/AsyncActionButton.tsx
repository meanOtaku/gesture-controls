import { useState, type ReactNode } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "../ui/button";

type AsyncActionButtonProps = {
  pendingLabel: ReactNode;
  children: ReactNode;
  onPress: () => Promise<void>;
  disabled?: boolean;
  className?: string;
  variant?: "default" | "outline";
};

/**
 * A button that runs one async action at a time. Disables itself for the
 * duration of its own request so a slow or repeated click cannot fire the
 * same operation twice; unrelated controls are unaffected.
 */
export function AsyncActionButton({ pendingLabel, children, onPress, disabled, className, variant }: AsyncActionButtonProps) {
  const [pending, setPending] = useState(false);

  const handleClick = () => {
    if (pending) return;
    setPending(true);
    void onPress().finally(() => setPending(false));
  };

  return (
    <Button type="button" variant={variant} className={className} disabled={disabled || pending} aria-busy={pending} onClick={handleClick}>
      {pending && <Loader2Icon className="animate-spin" aria-hidden="true" />}
      {pending ? pendingLabel : children}
    </Button>
  );
}
