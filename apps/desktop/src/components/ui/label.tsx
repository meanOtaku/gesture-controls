import * as React from "react"
import { cn } from "cn"

function Label({ className, required, ...props }: React.ComponentProps<"label"> & { required?: boolean }) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      // A field the form cannot be saved without gets a "*" drawn by CSS, so it is not part of the label's text; the
      // control itself should also be `required` or `aria-required`.
      data-required={required ? "true" : undefined}
      {...props}
    />
  )
}

export { Label }
