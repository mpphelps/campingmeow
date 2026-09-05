import { ValidationError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { userPreferenceRepository } from "../repositories/user-preference.repository.server";

/**
 * User settings, reachable two ways: signed in, or by the token we put in
 * every notification email.
 *
 * The token is a bearer credential — whoever holds the email holds it. That is
 * acceptable only because it grants exactly one power: toggling this user's
 * email notifications. It must never be widened into a login, and nothing here
 * returns anything the token-holder didn't already have (they received the
 * email, so they know the address).
 */

export interface Preferences {
  emailNotifications: boolean;
}

/**
 * What the token path may show. Only the address the email was already sent
 * to — the holder learns nothing they didn't have.
 */
export interface TokenPreferences extends Preferences {
  email: string;
}

export const preferenceService = {
  getForUser,
  getByToken,
  setEmailNotificationsForUser,
  setEmailNotificationsByToken,
  getUnsubscribeToken,
};

async function getForUser(userId: string): Promise<Preferences> {
  const pref = await userPreferenceRepository.findOrCreateByUserId(userId);
  return { emailNotifications: pref.emailNotifications };
}

/** The token a notification email should carry for this user. */
async function getUnsubscribeToken(userId: string): Promise<string> {
  const pref = await userPreferenceRepository.findOrCreateByUserId(userId);
  return pref.unsubscribeToken;
}

async function getByToken(token: string): Promise<TokenPreferences> {
  const pref = await requireToken(token);
  return { emailNotifications: pref.emailNotifications, email: pref.user.email };
}

async function setEmailNotificationsForUser(userId: string, enabled: boolean): Promise<void> {
  await userPreferenceRepository.setEmailNotifications(userId, enabled);
  logger.info({ action: "preference.email_toggled", userId, enabled, via: "session" }, "email preference changed");
}

async function setEmailNotificationsByToken(token: string, enabled: boolean): Promise<TokenPreferences> {
  const pref = await requireToken(token);
  await userPreferenceRepository.setEmailNotifications(pref.userId, enabled);
  logger.info(
    { action: "preference.email_toggled", userId: pref.userId, enabled, via: "token" },
    "email preference changed from an email link",
  );
  return { emailNotifications: enabled, email: pref.user.email };
}

async function requireToken(token: string) {
  const pref = token ? await userPreferenceRepository.findByToken(token) : null;
  // Same error for missing and unknown: a valid-vs-invalid distinction would
  // let someone probe for live tokens.
  if (!pref) throw new ValidationError({ token: "That link is no longer valid. Sign in to change your settings." });
  return pref;
}
