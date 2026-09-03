// Outbound email. Data access only — no business logic, same role Nominatim
// plays for geocoding and packages/scanner plays for ReserveCalifornia.
//
// The provider sits behind an interface for two reasons: tests must never send
// real mail, and the free tiers are close enough (Resend 100/day, Brevo
// 300/day, SES $0.10/1k) that swapping is a plausible afternoon rather than a
// rewrite.

import { logger } from "./logger.server";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  /** Human-readable, shown in the admin panel so a misconfigured prod is visible. */
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/** Logs instead of sending. Used locally and in e2e; captures for assertions. */
class StubSender implements EmailSender {
  readonly name = "stub (not sending)";
  /** Last messages "sent", newest last. Test-only. */
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    logger.info({ action: "email.stub_send", to: message.to, subject: message.subject }, "email not sent (stub sender)");
  }
}

class ResendSender implements EmailSender {
  readonly name = "Resend";

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });

    if (!response.ok) {
      // Surfaced to the caller so the events stay unnotified and go out on the
      // next pass, rather than being marked sent and lost.
      throw new Error(`Resend ${response.status}: ${await response.text().catch(() => response.statusText)}`);
    }
  }
}

export const stubSender = new StubSender();

/**
 * Resend when a key is configured, the stub otherwise.
 *
 * Falling back silently is right for local and test, and dangerous in
 * production — a secret that failed to inject would stop all mail with nobody
 * noticing. Hence the loud warning, and the sender name on the admin panel.
 */
function resolveSender(): EmailSender {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      logger.warn(
        { action: "email.no_provider" },
        "RESEND_API_KEY is not set in production — notification emails will NOT be sent",
      );
    }
    return stubSender;
  }
  return new ResendSender(apiKey, process.env.EMAIL_FROM ?? "CampingMeow <alerts@campingmeow.com>");
}

export const emailSender: EmailSender = resolveSender();
