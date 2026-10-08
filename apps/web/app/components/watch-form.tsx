import { useState } from "react";
import { Form } from "react-router";

import { Button } from "@campingmeow/ui/components/button";
import { Calendar } from "@campingmeow/ui/components/calendar";
import { Card } from "@campingmeow/ui/components/card";
import { Checkbox } from "@campingmeow/ui/components/checkbox";
import { Input } from "@campingmeow/ui/components/input";
import { Label } from "@campingmeow/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@campingmeow/ui/components/radio-group";
import { SiteTypeIcons } from "~/components/site-type-icons";
import { checkinLabel, type WatchMode } from "~/lib/watch-schedule";
import type { FacilityPickerItem } from "~/services/catalog.service.server";

/**
 * The watch form, shared by create and edit so the two can never drift apart.
 *
 * A watch is a weekday pattern ("every Friday") or a handful of specific
 * check-in dates ("Oct 16 and Nov 6"). Both carry one `nights` value, so a stay
 * is check-in plus that many nights.
 */

const DAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

/** Mirrors MAX_CHECKIN_DATES in the service; the server enforces it regardless. */
const MAX_DATES = 10;

export interface WatchFormDefaults {
  mode: WatchMode;
  checkinDays: number[];
  checkinDates: string[];
  nights: number;
}

interface Props {
  facilities: FacilityPickerItem[];
  preselectedIds: string[];
  defaults: WatchFormDefaults;
  fields?: Record<string, string>;
  /** yyyy-MM-dd */
  today: string;
  /** yyyy-MM-dd — the last night we scan. */
  horizon: string;
  submitLabel: string;
}

// The picker works in local dates; we store yyyy-MM-dd. Converted by parts, not
// through toISOString, which would shift the day for anyone west of UTC.
function toLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

function toIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function FacilityPicker({
  facilities,
  preselectedIds,
  error,
}: {
  facilities: FacilityPickerItem[];
  preselectedIds: string[];
  error?: string;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? facilities.filter((f) => f.name.toLowerCase().includes(needle) || f.parkName.toLowerCase().includes(needle))
    : facilities;

  return (
    <fieldset>
      <legend className="text-sm font-medium">Campgrounds</legend>
      <p className="mt-1 text-xs text-muted-foreground">Pick one or more. We watch all of them for the same stay.</p>
      <Input
        type="search"
        placeholder="Filter by park or campground…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="mt-2 max-w-sm"
        aria-label="Filter campgrounds"
      />
      <Card className="mt-2 max-h-64 space-y-1 overflow-y-auto p-3">
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No campgrounds match.</p>
        ) : (
          visible.map((facility) => (
            <div key={facility.id} className="flex items-start gap-2">
              <Checkbox
                id={`pick-${facility.id}`}
                name="facilityIds"
                value={facility.id}
                defaultChecked={facility.watchable && preselectedIds.includes(facility.id)}
                disabled={!facility.watchable}
                aria-label={`${facility.parkName} · ${facility.name}`}
                className="mt-0.5"
              />
              <Label htmlFor={`pick-${facility.id}`} className={facility.watchable ? undefined : "opacity-60"}>
                <span className="text-muted-foreground">{facility.parkName} · </span>
                {facility.name}
                <SiteTypeIcons types={facility.siteTypes} className="ml-1.5 align-text-bottom" />
                {/* Shown rather than hidden: "first-come, first-served" is
                    genuinely useful to know about a place you might otherwise
                    drive to expecting a reservation. */}
                {!facility.watchable && (
                  <span className="block text-xs font-normal text-muted-foreground">{facility.unwatchableReason}</span>
                )}
              </Label>
            </div>
          ))
        )}
      </Card>
      {error && <p className="mt-1 text-sm text-destructive">{error}</p>}
    </fieldset>
  );
}

export function WatchForm({ facilities, preselectedIds, defaults, fields, today, horizon, submitLabel }: Props) {
  const [mode, setMode] = useState<WatchMode>(defaults.mode);
  const [nights, setNights] = useState(defaults.nights);
  // Dates already in the past (an expired watch being edited) are dropped, so
  // the form starts from something that could actually be saved.
  const [dates, setDates] = useState<Date[]>(defaults.checkinDates.filter((d) => d >= today).map(toLocalDate));

  // Every night of the stay has to fall inside the scanned window, so the
  // latest check-in moves earlier as the stay gets longer.
  const lastCheckin = toLocalDate(horizon);
  lastCheckin.setDate(lastCheckin.getDate() - Math.max(0, (Number.isFinite(nights) ? nights : 1) - 1));
  const selectedIso = dates.map(toIso).sort();

  return (
    <Form method="post" className="mt-8 space-y-6">
      <FacilityPicker facilities={facilities} preselectedIds={preselectedIds} error={fields?.facilityIds} />

      <fieldset>
        <legend className="text-sm font-medium">When</legend>
        <RadioGroup name="mode" value={mode} onValueChange={(v) => setMode(v as WatchMode)} className="mt-2">
          <div className="flex items-center gap-2">
            <RadioGroupItem value="pattern" id="mode-pattern" />
            <Label htmlFor="mode-pattern">Every week, on certain days</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="dates" id="mode-dates" />
            <Label htmlFor="mode-dates">Specific check-in dates</Label>
          </div>
        </RadioGroup>
      </fieldset>

      {mode === "pattern" ? (
        <fieldset>
          <legend className="text-sm font-medium">Check-in days</legend>
          <div className="mt-2 flex flex-wrap gap-4">
            {DAYS.map((day) => (
              <div key={day.value} className="flex items-center gap-1.5">
                <Checkbox
                  id={`day-${day.value}`}
                  name="checkinDays"
                  value={String(day.value)}
                  defaultChecked={defaults.checkinDays.includes(day.value)}
                  aria-label={day.label}
                />
                <Label htmlFor={`day-${day.value}`}>{day.label}</Label>
              </div>
            ))}
          </div>
          {fields?.checkinDays && <p className="mt-1 text-sm text-destructive">{fields.checkinDays}</p>}
        </fieldset>
      ) : (
        <fieldset>
          <legend className="text-sm font-medium">Check-in dates</legend>
          <p className="mt-1 text-xs text-muted-foreground">
            Pick up to {MAX_DATES}, within the next nine weeks. The watch ends once they have all passed — edit it to pick new
            ones.
          </p>
          <Calendar
            mode="multiple"
            selected={dates}
            onSelect={(next) => setDates(next ?? [])}
            max={MAX_DATES}
            disabled={[{ before: toLocalDate(today) }, { after: lastCheckin }]}
            defaultMonth={dates[0] ?? toLocalDate(today)}
            className="mt-2"
          />
          {/* The picker is client state; these are what the form posts. */}
          {selectedIso.map((iso) => (
            <input key={iso} type="hidden" name="checkinDates" value={iso} />
          ))}
          <p className="mt-2 text-sm" aria-live="polite">
            {selectedIso.length === 0 ? (
              <span className="text-muted-foreground">No dates picked yet.</span>
            ) : (
              selectedIso.map(checkinLabel).join(" · ")
            )}
          </p>
          {fields?.checkinDates && <p className="mt-1 text-sm text-destructive">{fields.checkinDates}</p>}
        </fieldset>
      )}

      <div>
        <Label htmlFor="nights">Nights</Label>
        <Input
          id="nights"
          name="nights"
          type="number"
          min={1}
          max={7}
          value={Number.isFinite(nights) ? nights : ""}
          onChange={(e) => setNights(e.target.valueAsNumber)}
          className="mt-2 w-24"
        />
        {fields?.nights && <p className="mt-1 text-sm text-destructive">{fields.nights}</p>}
      </div>

      <p className="text-sm text-muted-foreground">
        {mode === "pattern"
          ? "A weekly watch covers the next nine weeks and rolls forward each day, so there's nothing to renew."
          : "A dated watch ends on its own once every check-in has passed. It stays in your list so you can pick new dates."}{" "}
        For dates further out, browse ReserveCalifornia directly.
      </p>

      <Button type="submit">{submitLabel}</Button>
    </Form>
  );
}

/** What both the create and edit actions hand to the service. */
export function readWatchForm(formData: FormData) {
  return {
    facilityIds: formData.getAll("facilityIds").map(String),
    mode: (formData.get("mode") === "dates" ? "dates" : "pattern") as WatchMode,
    checkinDays: formData.getAll("checkinDays").map(Number),
    checkinDates: formData.getAll("checkinDates").map(String),
    nights: Number(formData.get("nights")),
  };
}
