import * as React from "react"
import { DayPicker } from "react-day-picker"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"

import { cn } from "@campingmeow/ui/lib/utils"

/**
 * Month grid, built on react-day-picker.
 *
 * We use it read-only — `mode` is left off, so there is no selection state and
 * days are not buttons. It earns its place for the parts that are tedious and
 * easy to get subtly wrong: week starts, leading/trailing days from adjacent
 * months, DST-safe date maths, and the grid's ARIA.
 *
 * Day content is wrapped in a div rather than left as bare text in the cell.
 * Without it, a `modifiers` background paints the cell's padding too, so a run
 * of marked days merges into one solid bar instead of reading as separate
 * days. Callers style the wrapper with `[&>div]:` in `modifiersClassNames`.
 */
function Calendar({
  className,
  classNames,
  components,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      data-slot="calendar"
      showOutsideDays
      className={cn("w-fit", className)}
      classNames={{
        // `relative` anchors the nav, which react-day-picker renders as a
        // sibling *above* the caption rather than beside it.
        months: "relative flex flex-col gap-4",
        month: "flex flex-col gap-3",
        nav: "absolute inset-x-0 top-0 flex items-center justify-between",
        button_previous:
          "inline-flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30",
        button_next:
          "inline-flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30",
        month_caption: "flex h-8 items-center justify-center",
        caption_label: "font-display text-base font-semibold",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "w-10 text-xs font-normal text-muted-foreground",
        week: "flex w-full",
        day: "size-10 p-0.5 text-center text-sm",
        outside: "text-muted-foreground/40",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, ...rest }) =>
          orientation === "left" ? (
            <ChevronLeftIcon className="size-4" {...rest} />
          ) : (
            <ChevronRightIcon className="size-4" {...rest} />
          ),
        DayButton: undefined,
        Day: ({ day, modifiers, className: dayClassName, ...rest }) => (
          <td className={dayClassName} {...rest}>
            <div
              className={cn(
                "flex size-full items-center justify-center rounded-md tabular-nums",
                modifiers.today && "font-semibold underline underline-offset-4",
              )}
            >
              {day.date.getDate()}
            </div>
          </td>
        ),
        ...components,
      }}
      {...props}
    />
  )
}

export { Calendar }
