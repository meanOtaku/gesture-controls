import { Popover } from "radix-ui";
import { useId, useState, type ComponentProps, type KeyboardEvent } from "react";
import { cn } from "../../lib/utils";
import { Input } from "../ui/input";

type SuggestInputProps = Omit<ComponentProps<typeof Input>, "value" | "onChange" | "list"> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Offered below the field, filtered by what is typed; any other text can still be typed. */
  suggestions: readonly string[];
  /** A plain `<input>` styled only by `className`, for forms with their own field look (the Recipe editor). */
  plain?: boolean;
};

/**
 * A text field with suggestions, drawn in the app's theme. A native `<datalist>` is drawn by the system, which no theme
 * reaches. The menu uses the Select menu's slots, so every theme styles it the same way; focus stays in the field.
 */
export function SuggestInput({ value, onValueChange, suggestions, plain = false, className, onKeyDown, onFocus, onBlur, ...props }: SuggestInputProps) {
  const Field = plain ? "input" : Input;
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = value.trim().toLowerCase();
  const shown = suggestions.filter((item) => item.toLowerCase().includes(typed) && item.toLowerCase() !== typed);
  const visible = open && shown.length > 0;
  const highlighted = visible && active >= 0 && active < shown.length ? active : -1;

  const pick = (item: string) => {
    onValueChange(item);
    setOpen(false);
    setActive(-1);
  };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (shown.length === 0) return;
      event.preventDefault();
      setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((was) => (was < 0 ? (step > 0 ? 0 : shown.length - 1) : (was + step + shown.length) % shown.length));
    } else if (event.key === "Enter" && highlighted >= 0) {
      event.preventDefault();
      pick(shown[highlighted]);
    } else if (event.key === "Escape" && visible) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <Popover.Root open={visible} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <Field
          {...props}
          className={className}
          value={value}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={visible}
          aria-controls={visible ? listId : undefined}
          aria-activedescendant={highlighted >= 0 ? `${listId}-${highlighted}` : undefined}
          autoComplete="off"
          onChange={(event) => {
            onValueChange(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={(event) => {
            onFocus?.(event);
            setOpen(true);
          }}
          onBlur={(event) => {
            onBlur?.(event);
            setOpen(false);
            setActive(-1);
          }}
          onClick={() => setOpen(true)}
          onKeyDown={keyDown}
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          data-slot="select-content"
          data-state={visible ? "open" : "closed"}
          side="bottom"
          align="start"
          sideOffset={4}
          // The field keeps focus and the keyboard; the menu only shows what it may become.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="z-50 max-h-60 min-w-(--radix-popover-trigger-width) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          <ul id={listId} role="listbox" aria-label={props["aria-label"] ? `${props["aria-label"]} suggestions` : "Suggestions"}>
            {shown.map((item, index) => (
              <li
                key={item}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === highlighted}
                data-slot="select-item"
                data-highlighted={index === highlighted ? "" : undefined}
                className={cn(
                  "flex w-full cursor-default items-center rounded-md px-1.5 py-1 text-sm select-none",
                  "hover:bg-accent hover:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground",
                )}
                // Chosen on mouse down, before the field's blur closes the menu.
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(item);
                }}
                onMouseEnter={() => setActive(index)}
              >
                {item}
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
