import { Link, redirect } from "react-router";

import { addDays, fmt } from "@campingmeow/scanner";
import type { Route } from "./+types/watches.new";
import { readWatchForm, WatchForm } from "~/components/watch-form";
import { ValidationError } from "~/lib/errors";
import { HORIZON_DAYS } from "~/lib/limits";
import { withAuth } from "~/lib/with-auth";
import type { AuthUser } from "~/services/auth.service.server";
import { catalogService } from "~/services/catalog.service.server";
import { watchService } from "~/services/watch.service.server";

export const loader = withAuth(async ({ request }: Route.LoaderArgs & { user: AuthUser }) => {
  const url = new URL(request.url);
  const facilitiesParam = url.searchParams.get("facilities");
  const preselectedFacilityId = url.searchParams.get("facilityId");
  const today = fmt(new Date());
  const window = { today, horizon: addDays(today, HORIZON_DAYS) };

  // Coming from the home-page selection: show exactly those campgrounds,
  // all pre-checked (unchecking here removes them from the watch).
  if (facilitiesParam) {
    const facilityIds = facilitiesParam.split(",").filter(Boolean);
    const facilities = await catalogService.listFacilityPicker({ facilityIds });
    if (facilities.length === 0) throw new Response("Not Found", { status: 404 });
    return { facilities, preselectedIds: facilities.map((f) => f.id), ...window };
  }

  // Coming from a park detail page: full picker with that campground checked.
  if (preselectedFacilityId) {
    const facility = await catalogService.getFacilityDetail(preselectedFacilityId);
    if (!facility) throw new Response("Not Found", { status: 404 });
  }
  const facilities = await catalogService.listFacilityPicker();
  return { facilities, preselectedIds: preselectedFacilityId ? [preselectedFacilityId] : [], ...window };
});

export const action = withAuth(async ({ request, user }: Route.ActionArgs & { user: AuthUser }) => {
  try {
    await watchService.createWatch(user.id, readWatchForm(await request.formData()));
  } catch (err) {
    if (err instanceof ValidationError) {
      return { fields: err.fields };
    }
    throw err;
  }
  return redirect("/watches");
});

export default function NewWatch({ loaderData, actionData }: Route.ComponentProps) {
  const { facilities, preselectedIds, today, horizon } = loaderData;
  const fields = actionData && "fields" in actionData ? actionData.fields : undefined;

  return (
    <div className="max-w-2xl">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← Parks
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">New watch</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Pick campgrounds and the stay you care about. We&apos;ll email you when a matching site opens.
      </p>
      <WatchForm
        facilities={facilities}
        preselectedIds={preselectedIds}
        defaults={{ mode: "pattern", checkinDays: [5, 6], checkinDates: [], nights: 1 }}
        fields={fields}
        today={today}
        horizon={horizon}
        submitLabel="Create watch"
      />
    </div>
  );
}

export { PageErrorBoundary as ErrorBoundary } from "~/components/page-error-boundary";
