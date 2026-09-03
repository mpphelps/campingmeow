import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@campingmeow/ui/lib/utils";

const selectVariants = cva(
  "flex w-full rounded-lg border border-border bg-background text-foreground outline-none transition-colors hover:border-primary/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      size: {
        xs: "h-6 px-2 py-0.5 text-xs",
        sm: "h-7 px-2 py-1 text-sm",
        default: "h-8 px-2.5 py-1 text-sm",
        lg: "h-9 px-3 py-1.5 text-sm",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
);

function Select({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & VariantProps<typeof selectVariants>) {
  return (
    <select
      data-slot="select"
      data-size={size}
      className={cn(selectVariants({ size, className }))}
      {...props}
    />
  );
}

export { Select, selectVariants };
