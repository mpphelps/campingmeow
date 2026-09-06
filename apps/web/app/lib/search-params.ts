/**
 * The availability search is addressed entirely by its query string: the page
 * is shareable, bookmarkable and reloadable, and the form is just a way to
 * write the URL. Parsing lives here rather than inline in the loader so the
 * shape of a search stays one thing, described in one place.
 */
export interface SearchCriteria {
  /** 0=Sun .. 6=Sat */
  checkinDays: number[];
  nights: number;
  /** yyyy-MM-dd, null = the full booking window */
  startDate: string | null;
  endDate: string | null;
  bounds: "anytime" | "range";
}

export interface ParsedSearch {
  facilityIds: string[];
  /** False when the user has only opened the form and not searched yet. */
  hasQuery: boolean;
  criteria: SearchCriteria;
}

export function parseSearchParams(request: Request): ParsedSearch {
  const params = new URL(request.url).searchParams;
  const bounded = params.get("bounds") === "range";
  const days = params.getAll("days");

  return {
    facilityIds: (params.get("facilities") ?? "").split(",").filter(Boolean),
    hasQuery: days.length > 0,
    criteria: {
      checkinDays: days.length > 0 ? days.map(Number) : [5, 6],
      nights: Number(params.get("nights") ?? 1),
      startDate: bounded ? params.get("from") || null : null,
      endDate: bounded ? params.get("to") || null : null,
      bounds: bounded ? "range" : "anytime",
    },
  };
}
