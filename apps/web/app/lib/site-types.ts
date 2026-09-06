/**
 * ReserveCalifornia `UnitCategoryId` → what kind of camping it is.
 *
 * Measured across 60 campgrounds (2026-09-06): seven distinct ids, and 83% of
 * campgrounds use exactly one. Mixed ones are real and usually say so in the
 * name — "Paso Picacho Campground & Cabins" reports both 1 and 1008 — which is
 * why a facility stores a *set* rather than a single type.
 *
 * The raw ids are what we persist. If RC invents a category we haven't seen,
 * it lands here as an unknown id and is dropped from display rather than
 * mislabelled as something else.
 */
export type SiteTypeKey = "campsite" | "rv" | "cabin" | "group" | "primitive" | "horse" | "dayuse";

export interface SiteType {
  key: SiteTypeKey;
  label: string;
}

const CATEGORIES: Record<number, SiteType> = {
  1: { key: "campsite", label: "Campsites" },
  2: { key: "group", label: "Group camp" },
  7: { key: "dayuse", label: "Day use" },
  1008: { key: "cabin", label: "Cabins" },
  1014: { key: "primitive", label: "Hike-in or boat-in" },
  1015: { key: "rv", label: "RV hookups" },
  1016: { key: "horse", label: "Horse camp" },
};

/** Display order, so two campgrounds with the same types render identically. */
const ORDER: SiteTypeKey[] = ["campsite", "rv", "cabin", "group", "primitive", "horse", "dayuse"];

/**
 * Turn stored category ids into display types: known ones only, deduplicated,
 * in a stable order.
 */
export function toSiteTypes(categoryIds: number[]): SiteType[] {
  const seen = new Map<SiteTypeKey, SiteType>();
  for (const id of categoryIds) {
    const type = CATEGORIES[id];
    if (type) seen.set(type.key, type);
  }
  return ORDER.flatMap((key) => {
    const type = seen.get(key);
    return type ? [type] : [];
  });
}
