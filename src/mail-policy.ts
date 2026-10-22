import { z } from "zod";

export const accounts = [
  { id: "mascorona-subgerencia", email: "subgerencia@mascorona.com", hostname: "sucumbios.ecuahosting.net", port: 143, tls: "starttls", secret: "IMAP_MASCORONA_SUBGERENCIA_PASSWORD" },
  { id: "mascorona-contacto", email: "contacto@mascorona.com", hostname: "sucumbios.ecuahosting.net", port: 143, tls: "starttls", secret: "IMAP_MASCORONA_CONTACTO_PASSWORD" },
  { id: "mascorona-gerencia", email: "gerencia@mascorona.com", hostname: "sucumbios.ecuahosting.net", port: 143, tls: "starttls", secret: "IMAP_MASCORONA_GERENCIA_PASSWORD" },
  { id: "nostraterra-gerencia", email: "gerencia@nostraterraec.com", hostname: "mail.nostraterraec.com", port: 993, tls: "on", secret: "IMAP_NOSTRATERRA_GERENCIA_PASSWORD" },
  { id: "nostraterra-contacto", email: "contacto@nostraterraec.com", hostname: "mail.nostraterraec.com", port: 993, tls: "on", secret: "IMAP_NOSTRATERRA_CONTACTO_PASSWORD" },
  { id: "jegatech-gerencia", email: "gerencia@jegatechgroup.com", hostname: "imap.gmail.com", port: 993, tls: "on", secret: "GOOGLE_IMAP_REFRESH_TOKEN" },
] as const;

export type Account = (typeof accounts)[number];
export type MailSecrets = Partial<Record<Account["secret"] | "MAIL_ALLOWED_EMAILS" | "GOOGLE_IMAP_CLIENT_ID" | "GOOGLE_IMAP_CLIENT_SECRET", string>>;
export class MailError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export function authorizeMail(email: string | undefined, env: MailSecrets) {
  const allowed = (env.MAIL_ALLOWED_EMAILS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!email || !allowed.includes(email.toLowerCase())) throw new MailError("MAIL_ACCESS_DENIED");
}

export const accountSchema = z.enum(accounts.map(a => a.id));
export const folderSchema = z.string().min(1).max(256).regex(/^[\x20-\x7e]+$/).default("INBOX");
export const uidSchema = z.number().int().min(1).max(4294967295);
export const pageSchema = z.number().int().min(1).max(25).default(10);
export const searchSchema = {
  accountId: accountSchema,
  folder: folderSchema,
  limit: pageSchema,
  beforeUid: uidSchema.optional(),
  uidValidity: uidSchema.optional(),
  from: z.string().min(1).max(200).regex(/^[\x20-\x7e]+$/).optional(),
  subject: z.string().min(1).max(200).regex(/^[\x20-\x7e]+$/).optional(),
  unreadOnly: z.boolean().default(false),
};
export type SearchInput = z.infer<z.ZodObject<typeof searchSchema>>;

export function quote(value: string): string {
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new MailError("INVALID_IMAP_STRING");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function accountById(id: string): Account {
  const account = accounts.find(a => a.id === id);
  if (!account) throw new MailError("UNKNOWN_ACCOUNT");
  return account;
}

export function isConfigured(account: Account, env: MailSecrets) {
  return Boolean(env[account.secret] && (account.id !== "jegatech-gerencia" || (env.GOOGLE_IMAP_CLIENT_ID && env.GOOGLE_IMAP_CLIENT_SECRET)));
}
