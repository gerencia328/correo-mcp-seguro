import { ImapSession, examine, type Dial, type Token } from "./imap";
import { accountById, accounts, isConfigured, MailError, quote, type MailSecrets, type SearchInput } from "./mail-policy";

export async function boundedJson(response: Response, max = 16384): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new MailError("OAUTH_RESPONSE_INVALID");
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > max) throw new MailError("OAUTH_RESPONSE_LIMIT"); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(data));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new MailError("OAUTH_RESPONSE_INVALID");
  return parsed as Record<string, unknown>;
}

async function credential(id: string, env: MailSecrets, request: typeof fetch) {
  const account = accountById(id);
  if (!isConfigured(account, env)) throw new MailError("MAIL_SECRET_NOT_CONFIGURED");
  if (account.id !== "jegatech-gerencia") return env[account.secret]!;
  // This OAuth grant is independent of the working ChatGPT/Access OAuth grant.
  try {
    const response = await request("https://oauth2.googleapis.com/token", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: env.GOOGLE_IMAP_CLIENT_ID!, client_secret: env.GOOGLE_IMAP_CLIENT_SECRET!, refresh_token: env.GOOGLE_IMAP_REFRESH_TOKEN! }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new MailError("GOOGLE_OAUTH_REFRESH_FAILED"); }
    const body = await boundedJson(response);
    if (typeof body.access_token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(body.access_token)) throw new MailError("GOOGLE_OAUTH_REFRESH_FAILED");
    return body.access_token;
  } catch { throw new MailError("GOOGLE_OAUTH_REFRESH_FAILED"); }
}

export function headers(raw: string) {
  const result: Record<string, string> = {};
  for (const line of raw.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colon = line.indexOf(":"); if (colon <= 0) continue;
    const key = line.slice(0, colon).toLowerCase();
    if (["from", "reply-to", "references", "to", "cc", "subject", "date", "message-id", "content-type", "content-transfer-encoding"].includes(key)) result[key] = line.slice(colon + 1).trim().slice(0, 2048);
  }
  return result;
}

function attributes(record: Token[]) {
  if (record[0] !== "*" || record[2] !== "FETCH" || !Array.isArray(record[3])) return null;
  const values = record[3]; const out: Record<string, Token> = {};
  for (let i = 0; i + 1 < values.length; i += 2) if (typeof values[i] === "string") out[(values[i] as string).toUpperCase()] = values[i + 1];
  return out;
}

export class MailService {
  constructor(private env: MailSecrets, private dial: Dial, private request: typeof fetch = fetch) {}

  listAccounts() {
    return { accounts: accounts.map(a => ({ accountId: a.id, email: a.email, authentication: a.id === "jegatech-gerencia" ? "OAuth2/XOAUTH2" : "password-over-TLS", configured: isConfigured(a, this.env), authenticationVerified: false })), note: "configured solo indica presencia de secretos; no acredita autenticación IMAP." };
  }

  private async withAccount<T>(id: string, action: (session: ImapSession) => Promise<T>) {
    const token = await credential(id, this.env, this.request);
    return new ImapSession(this.dial).run(accountById(id), token, action);
  }

  async listFolders(input: { accountId: string; limit: number; offset: number }) {
    return this.withAccount(input.accountId, async s => {
      const records = await s.command('LIST "" "*"');
      const folders = records.filter(r => r[1] === "LIST").map(r => {
        if (!Array.isArray(r[2]) || typeof r[4] !== "string") throw new MailError("IMAP_PROTOCOL_ERROR");
        return { name: r[4], delimiter: r[3] === "NIL" ? null : r[3], flags: r[2], encoding: "IMAP modified UTF-7 (usar name sin modificar)" };
      }).sort((a, b) => a.name.localeCompare(b.name));
      return { folders: folders.slice(input.offset, input.offset + input.limit), nextOffset: input.offset + input.limit < folders.length ? input.offset + input.limit : null };
    });
  }

  async searchMessages(input: SearchInput) {
    return this.withAccount(input.accountId, async s => {
      const { uidNext, uidValidity } = await examine(s, input.folder, input.uidValidity);
      const high = Math.min(uidNext - 1, input.beforeUid === undefined ? uidNext - 1 : input.beforeUid - 1);
      if (high < 1) return { messages: [], uidValidity, nextBeforeUid: null, scannedUidRange: null };
      // Bounded UID windows avoid unbounded SEARCH ALL results on large mailboxes.
      const low = Math.max(1, high - 499);
      const criteria = [`UID ${low}:${high}`, input.unreadOnly ? "UNSEEN" : "ALL"];
      if (input.from) criteria.push(`FROM ${quote(input.from)}`);
      if (input.subject) criteria.push(`SUBJECT ${quote(input.subject)}`);
      const records = await s.command(`UID SEARCH ${criteria.join(" ")}`);
      const ids = [...new Set(records.filter(r => r[1] === "SEARCH").flatMap(r => r.slice(2)).map(uid => {
        if (typeof uid !== "string" || !/^\d+$/.test(uid)) throw new MailError("IMAP_PROTOCOL_ERROR");
        const value = Number(uid); if (value < low || value > high || !Number.isSafeInteger(value)) throw new MailError("IMAP_PROTOCOL_ERROR"); return value;
      }))].sort((a, b) => b - a);
      const chosen = ids.slice(0, input.limit);
      const messages: { uid: number; flags: Token; size: number; headers: Record<string, string> }[] = [];
      // Fetch sequentially: at most one socket and bounded response per operation.
      for (const uid of chosen) {
        const fetched = await s.command(`UID FETCH ${uid} (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)]<0.4096>)`);
        const a = fetched.map(attributes).find(a => a?.UID === String(uid));
        if (a) {
          const selectedHeaders = Object.entries(a).find(([key]) => /^BODY\[HEADER\.FIELDS \(/.test(key))?.[1];
          messages.push({ uid, flags: a.FLAGS ?? [], size: Number(a["RFC822.SIZE"]), headers: headers(typeof selectedHeaders === "string" ? selectedHeaders : "") });
        }
      }
      return { messages, uidValidity, scannedUidRange: { low, high }, nextBeforeUid: ids.length > chosen.length ? chosen[chosen.length - 1] : low > 1 ? low : null, note: "Continuar con nextBeforeUid y uidValidity, incluso si esta ventana no tiene coincidencias. UID puede tener huecos." };
    });
  }

  async getMessage(input: { accountId: string; folder: string; uid: number; uidValidity: number; offset: number; maxBytes: number }) {
    return this.withAccount(input.accountId, async s => {
      await examine(s, input.folder, input.uidValidity);
      const records = await s.command(`UID FETCH ${input.uid} (UID RFC822.SIZE BODY.PEEK[]<${input.offset}.${input.maxBytes}>)`);
      const a = records.map(attributes).find(a => a?.UID === String(input.uid));
      if (!a) throw new MailError("MESSAGE_NOT_FOUND");
      const size = Number(a["RFC822.SIZE"]), raw = a[`BODY[]<${input.offset}>`];
      if (!Number.isSafeInteger(size) || size < 0 || typeof raw !== "string") throw new MailError("IMAP_PROTOCOL_ERROR");
      return { uid: input.uid, uidValidity: input.uidValidity, size, offset: input.offset, rawRfc822Utf8: raw, nextOffset: input.offset + input.maxBytes < size ? input.offset + input.maxBytes : null, format: "Fragmento RFC822/MIME sin procesar, decodificado como UTF-8. Puede incluir base64, quoted-printable o HTML; no ejecutar HTML ni seguir enlaces. No es una descarga binaria de adjuntos." };
    });
  }

  async replyHeaders(input: { accountId: string; folder: string; uid: number; uidValidity: number }) {
    return this.withAccount(input.accountId, async s => {
      await examine(s, input.folder, input.uidValidity);
      const records = await s.command(`UID FETCH ${input.uid} (UID BODY.PEEK[HEADER.FIELDS (FROM REPLY-TO TO CC SUBJECT DATE MESSAGE-ID REFERENCES)]<0.8192>)`);
      const a = records.map(attributes).find(a => a?.UID === String(input.uid));
      if (!a) throw new MailError("MESSAGE_NOT_FOUND");
      const raw = Object.entries(a).find(([key]) => /^BODY\[HEADER\.FIELDS \(/.test(key))?.[1];
      if (typeof raw !== "string" || !raw.endsWith("\r\n\r\n")) throw new MailError("REPLY_HEADERS_INCOMPLETE");
      return headers(raw);
    });
  }

  async saveSent(accountId: string, raw: string) {
    return this.withAccount(accountId, s => s.appendSent(raw));
  }
}
