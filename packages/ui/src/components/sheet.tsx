import * as React from "react"
import { Dialog as SheetPrimitive } from "radix-ui"
import { XIcon } from "lucide-react"

import { cn } from "@campingmeow/ui/lib/utils"

/**
 * Slide-in panel, built on Radix Dialog so it gets focus trapping, scroll
 * locking, Escape handling and the right ARIA for free. Used for the mobile
 * nav, where a row of inline links has nowhere to go.
 */
function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger(props: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose(props: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetContent({
  className,
  children,
  side = "right",
  title,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "left" | "right"
  /** Required by Radix for screen readers; visually hidden unless you render it. */
  title: string
}) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay
        data-slot="sheet-overlay"
        className="fixed inset-0 z-50 bg-foreground/40 data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=open]:animate-in data-[state=open]:fade-in"
      />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-0 z-50 flex w-72 max-w-[85vw] flex-col gap-1 border-border bg-card p-5 shadow-lg transition ease-in-out data-[state=closed]:duration-200 data-[state=open]:duration-300",
          side === "right"
            ? "right-0 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right"
            : "left-0 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left",
          "data-[state=closed]:animate-out data-[state=open]:animate-in",
          className,
        )}
        {...props}
      >
        <SheetPrimitive.Title className="sr-only">{title}</SheetPrimitive.Title>
        <SheetPrimitive.Close
          aria-label="Close menu"
          className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <XIcon className="size-5" />
        </SheetPrimitive.Close>
        {children}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
}

export { Sheet, SheetTrigger, SheetClose, SheetContent }
