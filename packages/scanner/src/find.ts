// CLI helper to discover PlaceId / FacilityId for any park.
//
//   npm run find -- "Crystal Cove"
//   npm run find -- "San Onofre"

import { searchParks, getFacilities } from "./api.js";
import { fmt } from "./dates.js";

async function main(): Promise<void> {
  const keyword = process.argv.slice(2).join(" ").trim();
  if (!keyword) {
    console.error('Usage: npm run find -- "park name"');
    process.exit(1);
  }

  const parks = await searchParks(keyword);
  if (parks.length === 0) {
    console.log(`No parks match "${keyword}".`);
    return;
  }

  const start = fmt(new Date());
  for (const park of parks) {
    console.log(`\n${park.Name}  (PlaceId ${park.PlaceId})`);
    const facilities = await getFacilities(park.PlaceId, start);
    if (facilities.length === 0) {
      console.log("  (no bookable facilities)");
      continue;
    }
    for (const f of facilities) {
      console.log(`  facilityId ${f.FacilityId}  ->  ${f.Name}`);
    }
  }
  console.log("\nPut the facilityId you want into src/config.ts.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
