import * as React from "react"
import { DayPicker } from "react-day-picker"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"

import { cn } from "@campingmeow/ui/lib/utils"

/**
 * Month grid, built on react-day-picker.
 *
 * Two uses. Without a `mode` it is read-only: no selection state, and days are
 * plain cells rather than buttons — the availability calendars. With a `mode`
 * (the watch form picks check-in dates with `mode="multiple"`) it renders
 * react-day-picker's own day buttons, which carry the keyboard handling, focus
 * management and `aria-selected` state that a hand-rolled button would lose.
 *
 * Either way it earns its place for the parts that are tedious and easy to get
 * subtly wrong: week starts, leading/trailing days from adjacent months,
 * DST-safe date maths, and the grid's ARIA.
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
        // Only reached in selection mode; read-only days have no button.
        day_button:
          "flex size-full items-center justify-center rounded-md tabular-nums transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected: "[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary",
        disabled: "text-muted-foreground/30 [&>button]:pointer-events-none",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, ...rest }) =>
          orientation === "left" ? (
            <ChevronLeftIcon className="size-4" {...rest} />
          ) : (
            <ChevronRightIcon className="size-4" {...rest} />
          ),
        // Read-only cells, only when nothing can be selected. In a selection
        // mode the library's own Day and DayButton are kept, or there would be
        // nothing to click.
        ...(props.mode === undefined && {
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
        }),
        ...components,
      }}
      {...props}
    />
  )
}

export { Calendar }
