import { BackpackIcon, CaravanIcon, HouseIcon, SunIcon, TentIcon, TreesIcon, UsersIcon } from "lucide-react";

import type { SiteType, SiteTypeKey } from "~/lib/site-types";

/**
 * What kind of camping a campground offers, as a small row of icons.
 *
 * Most campgrounds are one type, so this is usually a single icon; mixed ones
 * ("Campground & Cabins") show one per type. Each carries its own label —
 * an unlabelled icon row is invisible to a screen reader and ambiguous to
 * everyone else, and these shapes are not self-evident.
 */
const ICONS: Record<SiteTypeKey, typeof TentIcon> = {
  campsite: TentIcon,
  rv: CaravanIcon,
  cabin: HouseIcon,
  group: UsersIcon,
  primitive: BackpackIcon,
  horse: TreesIcon,
  dayuse: SunIcon,
};

export function SiteTypeIcons({ types, className = "" }: { types: SiteType[]; className?: string }) {
  // Nothing to show before a campground's first scan, and never for the ones
  // we don't scan at all. Render nothing rather than an empty placeholder.
  if (types.length === 0) return null;

  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-muted-foreground ${className}`}>
      {types.map((type) => {
        const Icon = ICONS[type.key];
        return (
          <span key={type.key} title={type.label}>
            <Icon className="size-3.5" aria-hidden="true" />
            <span className="sr-only">{type.label}</span>
          </span>
        );
      })}
    </span>
  );
}
