import { ForbiddenError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { exchangeCodeForTokens, verifyAccessToken, verifyIdToken } from "../lib/auth0.server";
import { getSessionToken, getTestSessionEmail, getTestSessionPermissions } from "../lib/session.server";
import { userRepository } from "../repositories/user.repository.server";
import { splitName } from "~/lib/name";

export type AuthUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string | null;
  permissions: string[];
};

// Domain service for authentication: token exchange, session → user
// resolution, and permission checks. Routes call this, never Auth0 directly.
export const authService = {
  handleCallback,
  getAuthenticatedUser,
  requirePermission,
};

async function handleCallback(code: string): Promise<{
  accessToken: string;
  user: AuthUser;
  /**
   * Auth0 has no idea we banned anyone, so the sign-in itself succeeds. The
   * callback has to notice and send them somewhere that says so — otherwise
   * they land back looking signed out, try again, and loop forever.
   */
  banned: boolean;
}> {
  const tokens = await exchangeCodeForTokens(code);
  const [identity, authz] = await Promise.all([verifyIdToken(tokens.id_token), verifyAccessToken(tokens.access_token)]);

  const email = identity.email;
  if (!email) {
    throw new Error("No email in ID token");
  }

  const name = identity.name || email;

  const { firstName, lastName } = identity.given_name
    ? { firstName: identity.given_name, lastName: identity.family_name ?? null }
    : splitName(name);

  // Sync user to local DB on first login
  let user = await userRepository.findByEmail(email);
  if (!user) {
    user = await userRepository.create({ email, firstName, lastName });
  }

  return {
    accessToken: tokens.access_token,
    banned: user.bannedAt !== null,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      permissions: authz.permissions ?? [],
    },
  };
}

async function getAuthenticatedUser(request: Request): Promise<AuthUser | null> {
  if (process.env.E2E_AUTH_BYPASS === "1") {
    const email = await getTestSessionEmail(request);
    if (!email) return null;
    const user = await userRepository.findByEmail(email);
    if (!user || user.bannedAt) return null;
    const sessionPermissions = await getTestSessionPermissions(request);
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      permissions: sessionPermissions ?? [],
    };
  }

  const token = await getSessionToken(request);
  if (!token) return null;

  try {
    const payload = await verifyAccessToken(token);
    const email = payload.email;
    if (!email) return null;

    const user = await userRepository.findByEmail(email);
    // A banned account reads as signed out everywhere: every route, loader and
    // service already handles a null user, so one check here covers the app.
    if (!user || user.bannedAt) return null;

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      permissions: payload.permissions ?? [],
    };
  } catch {
    return null;
  }
}

function requirePermission(user: AuthUser, permission: string): void {
  if (!user.permissions.includes(permission)) {
    logger.warn({ userId: user.id, permission, action: "auth.permission_denied" }, "permission denied");
    throw new ForbiddenError(`User does not have permission: ${permission}`);
  }
}
