/**
 * The public origin, used anywhere we mint a link that leaves the app —
 * sitemap entries and the unsubscribe URL in notification email.
 *
 * It has to be absolute and it has to be right: an unsubscribe link pointing
 * at the wrong host is a compliance problem, not a broken link.
 */
export const SITE_URL = (process.env.SITE_URL ?? "https://campingmeow.com").replace(/\/$/, "");
