import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@campingmeow/ui/lib/utils"

const alertVariants = cva("rounded-lg border p-3 text-sm", {
  variants: {
    variant: {
      default: "border-border bg-card text-card-foreground",
      // Something is degraded but the page still works — stale data, a
      // campground we've never scanned, a missing provider.
      warning: "border-amber-500/40 bg-amber-500/5 text-foreground",
      // Something failed or is blocked.
      destructive: "border-destructive/40 bg-destructive/5 text-foreground",
    },
  },
  defaultVariants: { variant: "default" },
})

function Alert({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      data-variant={variant}
      role={variant === "destructive" ? "alert" : "status"}
      className={cn(alertVariants({ variant, className }))}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("mb-1 font-medium", className)} {...props} />
}

export { Alert, AlertTitle, alertVariants }
