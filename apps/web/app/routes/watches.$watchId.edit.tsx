import { Link, redirect } from "react-router";

import { addDays, fmt } from "@campingmeow/scanner";
import type { Route } from "./+types/watches.$watchId.edit";
import { readWatchForm, WatchForm } from "~/components/watch-form";
import { ForbiddenError, ValidationError } from "~/lib/errors";
import { HORIZON_DAYS } from "~/lib/limits";
import { withAuth } from "~/lib/with-auth";
import type { AuthUser } from "~/services/auth.service.server";
import { catalogService } from "~/services/catalog.service.server";
import { watchService } from "~/services/watch.service.server";

// Someone else's watch answers 404, not 403: whether a watch id exists is none
// of their business.
function notFound(): never {
  throw new Response("Not Found", { status: 404 });
}

export const loader = withAuth(async ({ params, user }: Route.LoaderArgs & { user: AuthUser }) => {
  let watch;
  try {
    watch = await watchService.getWatchForEdit(user.id, params.watchId);
  } catch (err) {
    if (err instanceof ForbiddenError) notFound();
    throw err;
  }
  if (!watch) notFound();

  const facilities = await catalogService.listFacilityPicker();
  const today = fmt(new Date());
  return { watch, facilities, today, horizon: addDays(today, HORIZON_DAYS) };
});

export const action = withAuth(async ({ request, params, user }: Route.ActionArgs & { user: AuthUser }) => {
  try {
    const updated = await watchService.updateWatch(user.id, params.watchId, readWatchForm(await request.formData()));
    if (!updated) notFound();
  } catch (err) {
    if (err instanceof ValidationError) return { fields: err.fields };
    if (err instanceof ForbiddenError) notFound();
    throw err;
  }
  return redirect("/watches");
});

export default function EditWatch({ loaderData, actionData }: Route.ComponentProps) {
  const { watch, facilities, today, horizon } = loaderData;
  const fields = actionData && "fields" in actionData ? actionData.fields : undefined;

  return (
    <div className="max-w-2xl">
      <Link to="/watches" className="text-sm text-muted-foreground hover:text-foreground">
        ← Watches
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Edit watch</h1>
      {watch.expired && (
        <p className="mt-2 text-sm text-muted-foreground">
          Every check-in date on this watch has passed. Pick new ones to start it again.
        </p>
      )}
      <WatchForm
        facilities={facilities}
        preselectedIds={watch.facilityIds}
        defaults={watch}
        fields={fields}
        today={today}
        horizon={horizon}
        submitLabel="Save changes"
      />
    </div>
  );
}

export { PageErrorBoundary as ErrorBoundary } from "~/components/page-error-boundary";
