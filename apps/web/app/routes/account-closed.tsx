import { Alert, AlertTitle } from "@campingmeow/ui/components/alert";

/**
 * Where a banned account lands after signing in.
 *
 * Needs no session of its own — that is the point. The sign-in succeeds at
 * Auth0 and then fails here, so without this page the person bounces between
 * login and a signed-out home page with nothing telling them why.
 */
export function meta() {
  return [{ title: "Account closed — CampingMeow" }];
}

export default function AccountClosed() {
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-4xl font-semibold">Account closed</h1>
      <Alert variant="warning" className="mt-6">
        <AlertTitle>This account can no longer be used</AlertTitle>
        Your watches have stopped and we are not sending you email. Nothing has been deleted — if you think this is a
        mistake, reply to any email you have had from us and we will take a look.
      </Alert>
      <p className="mt-6 text-sm text-muted-foreground">
        You can still browse parks and check availability without an account.
      </p>
    </div>
  );
}
