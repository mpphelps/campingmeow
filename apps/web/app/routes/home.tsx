import { useEffect, useMemo, useState } from "react";
import { Link, useFetcher, useNavigate } from "react-router";

import { MapPinIcon, TreePineIcon } from "lucide-react";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@campingmeow/ui/components/accordion";
import { Button } from "@campingmeow/ui/components/button";
import { Checkbox } from "@campingmeow/ui/components/checkbox";
import { Input } from "@campingmeow/ui/components/input";
import { Label } from "@campingmeow/ui/components/label";
import { Select } from "@campingmeow/ui/components/select";
import { toast } from "@campingmeow/ui/components/toast";
import type { Route } from "./+types/home";
import { ParkBanner } from "~/components/park-banner";
import { MAX_WATCH_FACILITIES } from "~/lib/limits";
import { distanceMiles } from "~/lib/geo";
import { catalogService, type ParkBrowseItem } from "~/services/catalog.service.server";

export async function loader({ request }: Route.LoaderArgs) {
  const parks = await catalogService.listParksWithFacilities();
  // ?q= only seeds the box (e.g. from a shared /parks?q= link); all filtering
  // is client-side so it updates on every keystroke.
  return { parks, initialQuery: new URL(request.url).searchParams.get("q") ?? "" };
}

type Located = ParkBrowseItem & { distance: number | null };

// ReserveCalifornia abbreviates park types ("Crystal Cove SP"). Expanding them
// makes the name resolve to the real place on Google Maps instead of a
// near-miss.
const PARK_TYPES: [RegExp, string][] = [
  [/\bSVRA\b/g, "State Vehicular Recreation Area"],
  [/\bSRA\b/g, "State Recreation Area"],
  [/\bSNR\b/g, "State Natural Reserve"],
  [/\bSHP\b/g, "State Historic Park"],
  [/\bSP\b/g, "State Park"],
  [/\bSB\b/g, "State Beach"],
];

function fullParkName(name: string): string {
  return PARK_TYPES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), name);
}

/**
 * Search Maps by name rather than raw coordinates, so the link opens the
 * park's actual place page (hours, photos, reviews, directions) instead of
 * dropping an unlabelled pin. City disambiguates same-named parks.
 */
function mapsUrl(park: ParkBrowseItem): string {
  const query = [fullParkName(park.name), park.city, "CA"].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// parks.ca.gov park pages use opaque numeric ids (Crystal Cove is
// ?page_id=644) that aren't derivable from the ReserveCalifornia catalog and
// their site has no search parameter, so scope a search to their domain.
function stateParkUrl(park: ParkBrowseItem): string {
  return `https://www.google.com/search?q=${encodeURIComponent(`site:parks.ca.gov ${fullParkName(park.name)}`)}`;
}

function ParkRow({
  park,
  selected,
  onToggleFacility,
  onTogglePark,
}: {
  park: Located;
  selected: Set<string>;
  onToggleFacility: (facilityId: string, checked: boolean) => void;
  onTogglePark: (park: ParkBrowseItem, checked: boolean) => void;
}) {
  const selectedCount = park.facilities.filter((f) => selected.has(f.id)).length;
  const allSelected = park.facilities.length > 0 && selectedCount === park.facilities.length;
  const parkState = allSelected ? true : selectedCount > 0 ? ("indeterminate" as const) : false;

  return (
    <AccordionItem value={park.id}>
      <div className="flex items-center gap-3 px-3">
        <Checkbox
          checked={parkState}
          onCheckedChange={(checked) => onTogglePark(park, checked === true)}
          aria-label={`Select ${park.name}`}
        />
        <AccordionTrigger>
          {/* Text stacks on mobile inside its own column so the chevron stays
              on the right; side by side, the name wrapped to four lines and the
              metadata collided with the icon links. */}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
            <span className="min-w-0 font-medium">{park.name}</span>
            <span className="font-mono text-xs font-normal tracking-tight text-muted-foreground sm:ml-auto sm:shrink-0">
            {/* Distance is extra information, not a replacement — searching by
                location shouldn't cost you the city you were reading. */}
            {park.distance !== null && <span className="text-foreground">{Math.round(park.distance)} mi · </span>}
            {park.city ? `${park.city} · ` : ""}
            {park.facilities.length} campground{park.facilities.length === 1 ? "" : "s"}
              {selectedCount > 0 ? <span className="text-poppy"> · {selectedCount} selected</span> : null}
            </span>
          </span>
        </AccordionTrigger>
        {/* Sits outside the trigger: a link nested in a button is invalid HTML. */}
        <div className="flex shrink-0 items-center gap-0.5">
          <a
            href={mapsUrl(park)}
            target="_blank"
            rel="noreferrer"
            title={`${park.name} on Google Maps`}
            aria-label={`${park.name} on Google Maps`}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <MapPinIcon className="size-4" />
          </a>
          <a
            href={stateParkUrl(park)}
            target="_blank"
            rel="noreferrer"
            title={`${park.name} on parks.ca.gov`}
            aria-label={`${park.name} on parks.ca.gov`}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <TreePineIcon className="size-4" />
          </a>
        </div>
      </div>
      <AccordionContent className="bg-accent/20 pl-12 pr-3">
        {park.facilities.map((facility) => (
          <div key={facility.id} className="flex items-center gap-2 py-1.5">
            <Checkbox
              id={`facility-${facility.id}`}
              checked={selected.has(facility.id)}
              onCheckedChange={(checked) => onToggleFacility(facility.id, checked === true)}
              aria-label={`Select ${facility.name}`}
            />
            <Label htmlFor={`facility-${facility.id}`}>{facility.name}</Label>
          </div>
        ))}
        <Link to={`/parks/${park.id}`} className="mt-2 inline-block text-xs text-muted-foreground hover:text-foreground">
          Park details →
        </Link>
      </AccordionContent>
    </AccordionItem>
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { parks, initialQuery } = loaderData;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState(initialQuery);
  const [origin, setOrigin] = useState<{ latitude: number; longitude: number; label: string } | null>(null);
  const [radius, setRadius] = useState("any");
  const [locating, setLocating] = useState(false);
  const [address, setAddress] = useState("");
  const navigate = useNavigate();

  // Geocoding runs server-side (the browser CSP blocks third-party calls).
  const geocoder = useFetcher<
    { latitude: number; longitude: number; label: string } | { error: string; authRequired?: boolean }
  >();
  useEffect(() => {
    if (!geocoder.data) return;
    if ("error" in geocoder.data) {
      toast({
        title: geocoder.data.authRequired ? "Sign in to search by address" : "Couldn't find that place",
        description: geocoder.data.error,
        variant: "destructive",
      });
      return;
    }
    setOrigin(geocoder.data);
  }, [geocoder.data]);

  // Filtering happens client-side so results update on every keystroke.
  const visible = useMemo<Located[]>(() => {
    const needle = query.trim().toLowerCase();
    // The radius filter is inert without an origin — otherwise every park
    // would have a null distance and get filtered out.
    const maxMiles = !origin || radius === "any" ? null : Number(radius);

    const withDistance: Located[] = parks.map((park) => ({
      ...park,
      distance:
        origin && park.latitude !== null && park.longitude !== null
          ? distanceMiles(origin, { latitude: park.latitude, longitude: park.longitude })
          : null,
    }));

    const filtered = withDistance.filter((park) => {
      if (needle && !park.name.toLowerCase().includes(needle) && !(park.city ?? "").toLowerCase().includes(needle)) {
        return false;
      }
      if (maxMiles !== null) {
        if (park.distance === null) return false;
        if (park.distance > maxMiles) return false;
      }
      return true;
    });

    // Nearest first once we know where the user is.
    if (origin) {
      filtered.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    }
    return filtered;
  }, [parks, query, origin, radius]);

  /**
   * Every selected campground costs ~10 seconds of ReserveCalifornia requests,
   * so selection is capped rather than letting someone tick all 500 and queue
   * over an hour of continuous scanning.
   */
  function capped(next: Set<string>, previous: Set<string>): Set<string> {
    if (next.size <= MAX_WATCH_FACILITIES) return next;
    toast({
      title: `That's the limit — ${MAX_WATCH_FACILITIES} campgrounds`,
      description: "We check each one live against ReserveCalifornia. Search or watch these, then come back for more.",
      variant: "destructive",
    });
    return previous;
  }

  function toggleFacility(facilityId: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(facilityId);
      else next.delete(facilityId);
      return capped(next, prev);
    });
  }

  function togglePark(park: ParkBrowseItem, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const f of park.facilities) {
        if (checked) next.add(f.id);
        else next.delete(f.id);
      }
      return capped(next, prev);
    });
  }

  function clearLocation() {
    setOrigin(null);
    setRadius("any");
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      toast({ title: "Location unavailable", description: "This browser can't share your location.", variant: "destructive" });
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setOrigin({ latitude: position.coords.latitude, longitude: position.coords.longitude, label: "your location" });
        // Fill the box so the same ✕ clears a GPS fix too.
        setAddress("My location");
        setLocating(false);
      },
      (error) => {
        setLocating(false);
        const description =
          error.code === error.PERMISSION_DENIED
            ? "Your browser blocked the request. Allow location for this site, or type an address instead."
            : error.code === error.TIMEOUT
              ? "That took too long. Try again, or type an address instead."
              : "Your device couldn't get a fix. Type an address instead.";
        toast({ title: "Couldn't get your location", description, variant: "destructive" });
      },
      { timeout: 10_000 },
    );
  }

  const selectedIds = [...selected].join(",");

  return (
    <div>
      <div className="-mt-6 mb-8 overflow-hidden rounded-xl border sm:-mt-8">
        <ParkBanner className="block h-36 w-full sm:h-48" />
        {/* Caption block, like the print series: solid field, title in cream. */}
        <div className="bg-[#1E3A2B] px-5 py-5 sm:px-7 sm:py-6">
          <h1 className="text-3xl leading-tight font-semibold text-[#F2E4CC] sm:text-[2.75rem]">
            Find open California campsites
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-[#F2E4CC]/70">
            Pick the parks or campgrounds you want, then search what&apos;s open right now — or set up a watch and we&apos;ll
            email you the moment ReserveCalifornia has a matching opening.
          </p>
        </div>
      </div>

      <div className="mt-6 space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by park name or city…"
            aria-label="Search parks"
            className="sm:max-w-xs"
          />
          {/* The two actions share a row on mobile rather than stacking — they
              are a pair, and full-width buttons would push the list off-screen. */}
          <div className="flex gap-2 sm:ml-auto">
            <Button
              variant="outline"
              className="flex-1 sm:flex-none"
              disabled={selected.size === 0}
              onClick={() => navigate(`/search?facilities=${selectedIds}`)}
            >
              Search availability
            </Button>
            <Button
              className="flex-1 sm:flex-none"
              disabled={selected.size === 0}
              onClick={() => navigate(`/watches/new?facilities=${selectedIds}`)}
            >
              Create watch{selected.size > 0 ? ` (${selected.size})` : ""}
            </Button>
          </div>
        </div>

        {selected.size > 0 && (
          <p className="text-sm text-muted-foreground">{selected.size} of {MAX_WATCH_FACILITIES} campgrounds selected.</p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <geocoder.Form
            method="get"
            action="/api/geocode"
            className="flex flex-1 gap-2"
            onSubmit={() => setRadius((r) => (r === "any" ? "100" : r))}
          >
            <Input
              type="search"
              name="q"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                // The native search field's ✕ clears the whole location filter.
                if (e.target.value === "") clearLocation();
              }}
              placeholder="City, ZIP, or address…"
              aria-label="Location"
              className="min-w-0 flex-1 sm:w-56 sm:flex-none"
            />
            <Button type="submit" variant="outline" className="shrink-0" disabled={geocoder.state !== "idle"}>
              {geocoder.state !== "idle" ? "Finding…" : "Find nearby"}
            </Button>
          </geocoder.Form>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1 sm:flex-none" onClick={useMyLocation} disabled={locating}>
              {locating ? "Locating…" : "Use my location"}
            </Button>
            <Select
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
              aria-label="Distance"
              className="flex-1 sm:w-40 sm:flex-none"
              disabled={!origin}
            >
            <option value="any">Any distance</option>
            <option value="25">Within 25 mi</option>
            <option value="50">Within 50 mi</option>
            <option value="100">Within 100 mi</option>
              <option value="200">Within 200 mi</option>
            </Select>
          </div>
          {origin && <span className="text-xs text-muted-foreground">Distances from {origin.label}</span>}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          {parks.length === 0
            ? "No parks yet — the catalog hasn't been synced."
            : query
              ? `No parks match “${query}”.`
              : "No parks in range. Try a wider distance."}
        </p>
      ) : (
        <>
          <p className="mt-6 text-xs text-muted-foreground">
            {visible.length} park{visible.length === 1 ? "" : "s"} · check a park to select all of it, or expand to pick campgrounds
          </p>
          <Accordion type="multiple" className="mt-2 overflow-hidden rounded-lg border bg-card">
            {visible.map((park) => (
              <ParkRow key={park.id} park={park} selected={selected} onToggleFacility={toggleFacility} onTogglePark={togglePark} />
            ))}
          </Accordion>
        </>
      )}
    </div>
  );
}

export { PageErrorBoundary as ErrorBoundary } from "~/components/page-error-boundary";
