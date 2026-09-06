import { useState } from "react";
import { Form, Link, useNavigate, useNavigation, useSearchParams } from "react-router";

import { HouseIcon, BackpackIcon, CaravanIcon, SunIcon, TentIcon, TreesIcon, UsersIcon } from "lucide-react";

import { Alert } from "@campingmeow/ui/components/alert";
import { Button } from "@campingmeow/ui/components/button";
import { Input } from "@campingmeow/ui/components/input";
import { Label } from "@campingmeow/ui/components/label";
import { Select } from "@campingmeow/ui/components/select";
import { ToggleGroup, ToggleGroupItem } from "@campingmeow/ui/components/toggle-group";
import type { Route } from "./+types/available-nearby";
import { AvailabilityGrid } from "~/components/availability-grid";
import { ValidationError } from "~/lib/errors";
import { timeAgo } from "~/lib/time";
import { availabilityService } from "~/services/availability.service.server";

/**
 * "I want to go camping — where can I go?"
 *
 * The page is addressed entirely by its query string: `lat`/`lng` are the
 * location, so a result is shareable, bookmarkable and reloadable, and the
 * search box is only a way to write them. Geocoding happens on the way in, not
 * on every render.
 */

const RADIUS_OPTIONS = [25, 50, 100, 200];
const DEFAULT_RADIUS = 50;

/** Filter chips, in the same order the icons render on a campground. */
const TYPE_FILTERS = [
  { id: 1, label: "Campsites", Icon: TentIcon },
  { id: 1015, label: "RV hookups", Icon: CaravanIcon },
  { id: 1008, label: "Cabins", Icon: HouseIcon },
  { id: 2, label: "Group camp", Icon: UsersIcon },
  { id: 1014, label: "Hike-in", Icon: BackpackIcon },
  { id: 1016, label: "Horse camp", Icon: TreesIcon },
  { id: 7, label: "Day use", Icon: SunIcon },
];

export function meta() {
  return [{ title: "Available campsites near you — CampingMeow" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  const radiusMiles = Number(params.get("radius")) || DEFAULT_RADIUS;
  const siteCategories = (params.get("types") ?? "").split(",").filter(Boolean).map(Number);
  const place = params.get("place") ?? "";

  // No location yet — show the prompt rather than guessing somewhere for them.
  if (!params.get("lat") || !params.get("lng")) {
    return { results: null, radiusMiles, siteCategories, place, error: null };
  }

  try {
    const results = await availabilityService.findNearby({ latitude: lat, longitude: lng, radiusMiles, siteCategories });
    return { results, radiusMiles, siteCategories, place, error: null };
  } catch (err) {
    if (err instanceof ValidationError) {
      return { results: null, radiusMiles, siteCategories, place, error: Object.values(err.fields)[0] ?? null };
    }
    throw err;
  }
}

export default function AvailableNearby({ loaderData }: Route.ComponentProps) {
  const { results, radiusMiles, siteCategories, place, error } = loaderData;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  const loading = navigation.state === "loading";

  function go(changes: Record<string, string>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    navigate(`/available-nearby?${next}`);
  }

  /** Browser geolocation: no address to look up, so nothing external is called. */
  function useMyLocation() {
    if (!navigator.geolocation) {
      setLocateError("This browser can't share your location. Type a city instead.");
      return;
    }
    setLocating(true);
    setLocateError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        go({
          lat: String(position.coords.latitude),
          lng: String(position.coords.longitude),
          place: "your location",
        });
      },
      () => {
        setLocating(false);
        setLocateError("Couldn't get your location. Type a city instead.");
      },
    );
  }

  async function lookUpPlace(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = new FormData(event.currentTarget).get("place")?.toString().trim() ?? "";
    if (query.length < 3) {
      setLocateError("Enter a city, ZIP, or address.");
      return;
    }
    setLocating(true);
    setLocateError(null);
    const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
    setLocating(false);
    if (!response.ok) {
      setLocateError((await response.json().catch(() => ({}))).error ?? "We couldn't find that place.");
      return;
    }
    const found = await response.json();
    go({ lat: String(found.latitude), lng: String(found.longitude), place: found.label });
  }

  function toggleFacility(facilityId: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(facilityId);
      else next.delete(facilityId);
      return next;
    });
  }

  return (
    <div>
      <h1 className="text-4xl font-semibold">Available near you</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Every campground we track within range, and the nights they have a site free over the next nine weeks.
      </p>

      <Form onSubmit={lookUpPlace} className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="sm:w-72">
          <Label htmlFor="place">Where from?</Label>
          <Input
            id="place"
            name="place"
            defaultValue={place}
            placeholder="City, ZIP, or address"
            className="mt-2"
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={locating}>
            {locating ? "Looking…" : "Search"}
          </Button>
          <Button type="button" variant="outline" onClick={useMyLocation} disabled={locating}>
            Use my location
          </Button>
        </div>
        <div className="sm:ml-auto">
          <Label htmlFor="radius">Within</Label>
          <Select
            id="radius"
            className="mt-2"
            value={String(radiusMiles)}
            onChange={(event) => go({ radius: event.target.value })}
          >
            {RADIUS_OPTIONS.map((miles) => (
              <option key={miles} value={miles}>
                {miles} miles
              </option>
            ))}
          </Select>
        </div>
      </Form>

      {(locateError || error) && (
        <Alert variant="destructive" className="mt-4 max-w-2xl">
          {locateError ?? error}
        </Alert>
      )}

      <div className="mt-4">
        <ToggleGroup
          type="multiple"
          value={siteCategories.map(String)}
          onValueChange={(values: string[]) => go({ types: values.join(",") })}
          aria-label="Filter by type of camping"
        >
          {TYPE_FILTERS.map(({ id, label, Icon }) => (
            <ToggleGroupItem key={id} value={String(id)} aria-label={label}>
              <Icon className="size-3.5" aria-hidden="true" />
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {results === null ? (
        <Alert className="mt-8 max-w-2xl p-4">
          <p className="text-sm">
            Tell us where you&apos;re starting from and we&apos;ll show every campground in range with a night free.
          </p>
        </Alert>
      ) : results.campgrounds.length === 0 ? (
        <Alert variant="warning" className="mt-8 max-w-2xl">
          Nothing free within {radiusMiles} miles over the next nine weeks
          {results.fullyBookedCount > 0 ? ` — we checked ${results.fullyBookedCount} campgrounds, all booked` : ""}. Try a
          wider radius, or set a watch and we&apos;ll email you when something opens.
        </Alert>
      ) : (
        <div className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {results.campgrounds.length} campground{results.campgrounds.length === 1 ? "" : "s"} with something free
              {results.fullyBookedCount > 0 ? `, ${results.fullyBookedCount} fully booked and hidden` : ""}.
            </p>
            {results.oldestScannedAt && (
              <p className="text-sm text-muted-foreground">Updated {timeAgo(results.oldestScannedAt)}</p>
            )}
          </div>

          <div className={`mt-3 ${loading ? "opacity-50" : ""}`}>
            <AvailabilityGrid
              dates={results.dates}
              campgrounds={results.campgrounds}
              selected={selected}
              onToggle={toggleFacility}
            />
          </div>

          {/* Said plainly because the grid genuinely cannot answer it: adjacent
              nights may be different sites, so a run of colour is not a stay. */}
          <p className="mt-3 text-xs text-muted-foreground">
            Each square is one night with at least one site free — darker means more sites. Two nights side by side may be
            different sites, so a run doesn&apos;t guarantee a multi-night stay. Open a campground to see the detail.
          </p>

          {selected.size > 0 && (
            <div className="sticky bottom-4 mt-4 flex items-center gap-3 rounded-lg border bg-card p-3 shadow-sm">
              <span className="text-sm">
                {selected.size} campground{selected.size === 1 ? "" : "s"} selected
              </span>
              <Button asChild className="ml-auto">
                <Link to={`/watches/new?facilities=${[...selected].join(",")}`}>Watch these</Link>
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { PageErrorBoundary as ErrorBoundary } from "~/components/page-error-boundary";
