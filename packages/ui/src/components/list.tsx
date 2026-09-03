import * as React from "react"

import { cn } from "@campingmeow/ui/lib/utils"

/**
 * A bordered, divided list — the "rows in a box" pattern used for watches,
 * search results and a park's campgrounds. Not a shadcn component, but the
 * markup appeared in four routes with four slightly different sets of classes,
 * which is exactly the drift a primitive exists to prevent.
 */
function List({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul data-slot="list" className={cn("divide-y rounded-lg border", className)} {...props} />
}

function ListItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="list-item" className={cn("p-3 text-sm", className)} {...props} />
}

export { List, ListItem }
