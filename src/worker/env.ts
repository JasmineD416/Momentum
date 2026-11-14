import type { Database } from './db';

export interface Env {
  DB: Database;
  /** Serves the built web app (dist/client); absent in tests. */
  ASSETS?: { fetch(req: Request): Promise<Response> };
  ENVIRONMENT: string;
  /** Google sign-in (OAuth client of type "Web application"). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Optional: only accept Google Workspace accounts on this domain, e.g. "jdlawyers.ca". */
  GOOGLE_HOSTED_DOMAIN?: string;
  /** Secret (at least 32 characters): signs session cookies. Changing it signs everyone out. */
  SESSION_SECRET?: string;
  /** How long a sign-in lasts, in hours (default 12). */
  SESSION_HOURS?: string;
  /** Google account that becomes the Owner on first sign-in when no Owner exists yet. */
  OWNER_EMAIL: string;
  /** Development only: who requests are treated as when no x-dev-user header is sent. */
  DEV_USER_EMAIL?: string;

  /* ---------- Email (see GO-LIVE.md, "Email sending") ---------- */
  /** "ses" sends through Amazon SES; "log" records sends without delivering (development and tests only). */
  EMAIL_PROVIDER?: string;
  AWS_REGION?: string;
  /** Secrets: an IAM user allowed only ses:SendRawEmail / ses:SendEmail and ses:GetEmailIdentity. */
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  /** SES configuration set that publishes bounces and complaints to the SNS topic below. */
  SES_CONFIGURATION_SET?: string;
  /** Secret: signs unsubscribe links. */
  EMAIL_SIGNING_SECRET?: string;
  /** Secret: must appear in the SNS subscription URL (/hooks/ses?token=…). */
  SES_WEBHOOK_TOKEN?: string;
  /** Optional: only accept notifications from this SNS topic. */
  SES_TOPIC_ARN?: string;
  /** Public address of this site, used in unsubscribe links, e.g. https://momentum.jdlawyers.ca */
  PUBLIC_BASE_URL?: string;
  /** Messages sent per scheduler run (once a minute). Default 100. */
  SEND_BATCH_SIZE?: string;
}

export interface Member {
  id: string;
  email: string;
  name: string;
  title: string;
  role: 'Owner' | 'Administrator' | 'Member';
  divisions: string[];
  active: boolean;
}

export type AppEnv = { Bindings: Env; Variables: { member: Member } };
