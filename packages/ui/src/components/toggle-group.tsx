import * as React from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";

import { cn } from "@campingmeow/ui/lib/utils";

/**
 * A row of on/off filters. Radix handles roving focus and arrow-key movement,
 * which a row of hand-rolled buttons would lose.
 */
function ToggleGroup({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      {...props}
    />
  );
}

function ToggleGroupItem({ className, children, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-input bg-transparent px-2.5 py-1 text-sm whitespace-nowrap transition-colors outline-none",
        "hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { ToggleGroup, ToggleGroupItem };
