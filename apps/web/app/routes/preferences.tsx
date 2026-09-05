import { Form, Link } from "react-router";

import { Alert } from "@campingmeow/ui/components/alert";
import { Button } from "@campingmeow/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@campingmeow/ui/components/card";
import type { Route } from "./+types/preferences";
import { ValidationError } from "~/lib/errors";
import { authService } from "~/services/auth.service.server";
import { preferenceService } from "~/services/preference.service.server";

/**
 * Settings, reachable two ways: signed in, or with the token from a
 * notification email.
 *
 * Loading this page never changes anything — the toggle is a POST. Corporate
 * mail scanners follow every link in an email before a human sees it, so a
 * link that acted on GET would unsubscribe people who never clicked it.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const user = await authService.getAuthenticatedUser(request);

  if (user) {
    const prefs = await preferenceService.getForUser(user.id);
    return { ...prefs, email: user.email, token: "", signedIn: true, invalidToken: false };
  }

  if (!token) throw new Response("Not Found", { status: 404 });

  try {
    const prefs = await preferenceService.getByToken(token);
    return { ...prefs, token, signedIn: false, invalidToken: false };
  } catch (err) {
    if (err instanceof ValidationError) {
      return { emailNotifications: false, email: "", token, signedIn: false, invalidToken: true };
    }
    throw err;
  }
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const url = new URL(request.url);

  // Two callers with different shapes:
  //  - our own form, which posts `token` and the intended state
  //  - Gmail/Yahoo one-click (RFC 8058), which POSTs to the List-Unsubscribe
  //    URL with the token in the query string and only `List-Unsubscribe` in
  //    the body. Absent `emailNotifications` therefore means "turn it off",
  //    which is exactly what one-click asks for.
  const token = String(form.get("token") || url.searchParams.get("token") || "");
  const enabled = form.get("emailNotifications") === "on";

  const user = await authService.getAuthenticatedUser(request);
  if (user) {
    await preferenceService.setEmailNotificationsForUser(user.id, enabled);
    return { saved: true, invalidToken: false, emailNotifications: enabled };
  }

  try {
    await preferenceService.setEmailNotificationsByToken(token, enabled);
    return { saved: true, invalidToken: false, emailNotifications: enabled };
  } catch (err) {
    if (err instanceof ValidationError) return { saved: false, invalidToken: true, emailNotifications: false };
    throw err;
  }
}

export default function Preferences({ loaderData, actionData }: Route.ComponentProps) {
  const { emailNotifications, email, token, signedIn, invalidToken } = loaderData;
  const badToken = invalidToken || actionData?.invalidToken;

  if (badToken) {
    return (
      <div className="max-w-xl">
        <h1 className="text-4xl font-semibold">Settings</h1>
        <Alert variant="warning" className="mt-4">
          That link is no longer valid.{" "}
          <a href="/auth/login" className="underline underline-offset-2">
            Sign in
          </a>{" "}
          to change your settings.
        </Alert>
      </div>
    );
  }

  // Take the value the action actually wrote. Deriving it as `!emailNotifications`
  // would double-toggle, because React Router revalidates the loader after an
  // action — so `emailNotifications` is already the new value by the time this
  // renders.
  const enabled = actionData?.saved ? actionData.emailNotifications : emailNotifications;

  return (
    <div className="max-w-xl">
      <h1 className="text-4xl font-semibold">Settings</h1>
      {email && <p className="mt-2 font-mono text-sm text-muted-foreground">{email}</p>}

      {actionData?.saved && (
        <Alert className="mt-4">
          Saved. {enabled ? "We'll email you when a site opens." : "We've stopped emailing you."}
        </Alert>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Email notifications</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {enabled
              ? "We email you when a campsite matching your watch opens up. This is the only email we send."
              : "Email is off. Your watches keep running, so nothing is lost — you just won't hear from us."}
          </p>

          <Form method="post" className="mt-4">
            <input type="hidden" name="token" value={token} />
            {/* Off is the absent value in a form post, so the toggle is the
                intent to switch, not the current state. */}
            <input type="hidden" name="emailNotifications" value={enabled ? "off" : "on"} />
            <Button type="submit" variant={enabled ? "outline" : "default"}>
              {enabled ? "Turn off email notifications" : "Turn email notifications back on"}
            </Button>
          </Form>
        </CardContent>
      </Card>

      <p className="mt-6 text-sm text-muted-foreground">
        {signedIn ? (
          <Link to="/watches" className="underline underline-offset-2">
            Manage your watches
          </Link>
        ) : (
          <>
            <a href="/auth/login" className="underline underline-offset-2">
              Sign in
            </a>{" "}
            to manage your watches.
          </>
        )}
      </p>
    </div>
  );
}

export { PageErrorBoundary as ErrorBoundary } from "~/components/page-error-boundary";
