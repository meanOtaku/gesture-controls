import { useState, type ReactNode } from "react";

type AsyncActionButtonProps = {
  pendingLabel: ReactNode;
  children: ReactNode;
  onPress: () => Promise<void>;
  disabled?: boolean;
  className?: string;
};

/**
 * A button that runs one async action at a time. Disables itself for the
 * duration of its own request so a slow or repeated click cannot fire the
 * same operation twice; unrelated controls are unaffected.
 */
export function AsyncActionButton({ pendingLabel, children, onPress, disabled, className }: AsyncActionButtonProps) {
  const [pending, setPending] = useState(false);

  const handleClick = () => {
    if (pending) return;
    setPending(true);
    void onPress().finally(() => setPending(false));
  };

  return (
    <button type="button" className={className} disabled={disabled || pending} aria-busy={pending} onClick={handleClick}>
      {pending ? pendingLabel : children}
    </button>
  );
}
