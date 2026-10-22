import { MailError, quote, type Account } from "./mail-policy";

// Structural interface permits deterministic stream tests without importing Node IMAP clients.
export interface ImapSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  closed: Promise<unknown>;
  close(): Promise<void>;
  startTls(): ImapSocket;
}
export type Dial = (address: { hostname: string; port: number }, options: { secureTransport: "on" | "starttls"; allowHalfOpen: false }) => ImapSocket;
export type Token = string | Token[];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_RESPONSE = 256 * 1024;
const MAX_LINE = 32 * 1024;
const MAX_LITERAL = 64 * 1024;

/** Each literal is consumed by BYTE count; its contents can never become tagged responses. */
export class ImapSession {
  private socket?: ImapSocket;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = new Uint8Array(0);
  private received = 0;
  private tag = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private expired = false;

  constructor(private dial: Dial, private timeoutMs = 20000) {}

  private attach(socket: ImapSocket) {
    this.socket = socket;
    // A failed TLS handshake can reject both promises. Never expose platform exception text.
    void socket.closed.catch(() => {});
    void socket.opened.catch(() => {});
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buffer = new Uint8Array(0);
  }

  async close() {
    if (this.timer) clearTimeout(this.timer);
    try { await this.socket?.close(); } catch { /* already closed */ }
    try { this.reader?.releaseLock(); } catch { /* pending operation */ }
    try { this.writer?.releaseLock(); } catch { /* pending operation */ }
  }

  async run<T>(account: Account, credential: string, operation: (session: ImapSession) => Promise<T>): Promise<T> {
    // Total deadline covers dial, greeting, TLS, authentication, all commands and socket writes.
    const deadline = new Promise<never>((_, reject) => {
      this.timer = setTimeout(() => {
        this.expired = true;
        reject(new MailError("IMAP_TIMEOUT"));
        void this.socket?.close().catch(() => {});
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.execute(account, credential, operation), deadline]);
    } catch (error) {
      if (error instanceof MailError) throw error;
      throw new MailError(this.expired ? "IMAP_TIMEOUT" : "IMAP_CONNECTION_FAILED");
    } finally { await this.close(); }
  }

  private async execute<T>(account: Account, credential: string, operation: (s: ImapSession) => Promise<T>) {
    this.attach(this.dial({ hostname: account.hostname, port: account.port }, { secureTransport: account.tls, allowHalfOpen: false }));
    await this.socket!.opened;
    const greeting = await this.record();
    if (greeting[0] !== "*" || greeting[1]?.toString().toUpperCase() !== "OK") throw new MailError("IMAP_GREETING_REJECTED");
    if (account.tls === "starttls") {
      const capabilities = await this.command("CAPABILITY");
      if (!capabilities.some(r => r[1] === "CAPABILITY" && r.some(t => typeof t === "string" && t.toUpperCase() === "STARTTLS"))) throw new MailError("STARTTLS_REQUIRED");
      await this.command("STARTTLS");
      // No unread plaintext may be carried across the security boundary.
      if (this.buffer.length) throw new MailError("STARTTLS_UNEXPECTED_DATA");
      this.reader!.releaseLock();
      this.writer!.releaseLock();
      this.attach(this.socket!.startTls());
      await this.socket!.opened;
    }
    if (this.expired) throw new MailError("IMAP_TIMEOUT");
    const caps = await this.command("CAPABILITY");
    if (account.id === "jegatech-gerencia") {
      if (!caps.some(r => r.some(t => t === "AUTH=XOAUTH2"))) throw new MailError("XOAUTH2_UNAVAILABLE");
      const raw = `user=${account.email}\x01auth=Bearer ${credential}\x01\x01`;
      const bytes = encoder.encode(raw);
      const encoded = btoa(Array.from(bytes, b => String.fromCharCode(b)).join(""));
      await this.command(`AUTHENTICATE XOAUTH2 ${encoded}`, "IMAP_AUTH_FAILED");
    } else {
      if (caps.some(r => r.some(t => t === "LOGINDISABLED"))) throw new MailError("IMAP_LOGIN_DISABLED");
      await this.command(`LOGIN ${quote(account.email)} ${quote(credential)}`, "IMAP_AUTH_FAILED");
    }
    if (this.expired) throw new MailError("IMAP_TIMEOUT");
    return operation(this);
  }

  private async more() {
    if (this.expired) throw new MailError("IMAP_TIMEOUT");
    const result = await this.reader!.read();
    if (result.done) throw new MailError("IMAP_CONNECTION_CLOSED");
    this.received += result.value.length;
    if (this.received > MAX_RESPONSE) throw new MailError("IMAP_RESPONSE_LIMIT");
    const joined = new Uint8Array(this.buffer.length + result.value.length);
    joined.set(this.buffer); joined.set(result.value, this.buffer.length); this.buffer = joined;
  }

  private async line() {
    for (;;) {
      let end = -1;
      for (let i = 0; i + 1 < this.buffer.length; i++) if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) { end = i; break; }
      if (end >= 0) {
        if (end > MAX_LINE) throw new MailError("IMAP_LINE_LIMIT");
        const value = decoder.decode(this.buffer.subarray(0, end)); this.buffer = this.buffer.slice(end + 2); return value;
      }
      if (this.buffer.length > MAX_LINE) throw new MailError("IMAP_LINE_LIMIT");
      await this.more();
    }
  }

  private async record(): Promise<Token[]> {
    const flat: string[] = [];
    const literalValues = new Map<string, string>();
    let parts = 0;
    for (;;) {
      if (++parts > 128) throw new MailError("IMAP_RECORD_LIMIT");
      const line = await this.line();
      const literal = /\{(\d+)\+?\}$/.exec(line);
      const prefix = literal ? line.slice(0, literal.index) : line;
      // BODY sections may contain a parenthesized HEADER.FIELDS list. It is
      // part of the attribute name, not a nested FETCH value.
      const pieces = prefix.match(/"(?:[^"\\]|\\.)*"|BODY\[[^\]\r\n]*\](?:<\d+>)?|[()]|[^\s()]+/gi) ?? [];
      flat.push(...pieces);
      if (!literal) break;
      const size = Number(literal[1]);
      if (!Number.isSafeInteger(size) || size > MAX_LITERAL) throw new MailError("IMAP_LITERAL_LIMIT");
      while (this.buffer.length < size) await this.more();
      // Random placeholders cannot collide with server atoms and are never parsed as protocol.
      const key = `literal-${crypto.randomUUID()}`;
      literalValues.set(key, decoder.decode(this.buffer.subarray(0, size)));
      this.buffer = this.buffer.slice(size); flat.push(key);
    }
    const root: Token[] = [], stack = [root];
    for (const piece of flat) {
      if (piece === "(") {
        if (stack.length > 16) throw new MailError("IMAP_NESTING_LIMIT");
        const group: Token[] = []; stack[stack.length - 1].push(group); stack.push(group);
      } else if (piece === ")") {
        if (stack.length === 1) throw new MailError("IMAP_PROTOCOL_ERROR"); stack.pop();
      } else stack[stack.length - 1].push(literalValues.get(piece) ?? (piece.startsWith('"') ? piece.slice(1, -1).replace(/\\(.)/g, "$1") : piece));
    }
    if (stack.length !== 1) throw new MailError("IMAP_PROTOCOL_ERROR");
    return root;
  }

  async command(command: string, failure = "IMAP_COMMAND_REJECTED"): Promise<Token[][]> {
    if (this.expired) throw new MailError("IMAP_TIMEOUT");
    if (/[\r\n\0]/.test(command)) throw new MailError("INVALID_IMAP_COMMAND");
    const tag = `A${++this.tag}`;
    await this.writer!.write(encoder.encode(`${tag} ${command}\r\n`));
    const records: Token[][] = [];
    for (let i = 0; i < 2000; i++) {
      const record = await this.record();
      if (record[0] === tag) {
        if (record[1] !== "OK") throw new MailError(failure);
        return records;
      }
      // XOAUTH2 error challenges are cancelled by immediate socket closure in run's finally.
      if (record[0] === "+") throw new MailError(failure);
      if (record[0] !== "*" || record[1] === "BYE") throw new MailError("IMAP_PROTOCOL_ERROR");
      records.push(record);
    }
    throw new MailError("IMAP_RECORD_LIMIT");
  }

  // Deliberately narrow write: only archive an already-submitted reply in Sent.
  // Not exposed as an arbitrary IMAP command or MCP tool.
  async appendSent(raw: string) {
    const bytes = encoder.encode(raw);
    if (bytes.length > 65536 || this.expired) throw new MailError("SENT_COPY_LIMIT");
    const tag = `A${++this.tag}`;
    await this.writer!.write(encoder.encode(`${tag} APPEND "INBOX.Sent" (\\Seen) {${bytes.length}}\r\n`));
    let literalSent = false;
    for (let i = 0; i < 100; i++) {
      const record = await this.record();
      if (record[0] === "+" && !literalSent) {
        literalSent = true;
        await this.writer!.write(bytes);
        await this.writer!.write(encoder.encode("\r\n"));
      } else if (record[0] === tag) {
        if (record[1] !== "OK" || !literalSent) throw new MailError("SENT_COPY_FAILED");
        return;
      } else if (record[0] !== "*" || record[1] === "BYE") throw new MailError("SENT_COPY_FAILED");
    }
    throw new MailError("SENT_COPY_FAILED");
  }
}

export async function examine(session: ImapSession, folder: string, expected?: number) {
  const records = await session.command(`EXAMINE ${quote(folder)}`);
  const find = (name: string) => {
    for (const r of records) {
      const match = r.filter(t => typeof t === "string").join(" ").match(new RegExp(`\\[${name} (\\d+)\\]`));
      if (match) return Number(match[1]);
    }
    throw new MailError("IMAP_MAILBOX_METADATA_MISSING");
  };
  const uidValidity = find("UIDVALIDITY"), uidNext = find("UIDNEXT");
  if (!Number.isSafeInteger(uidValidity) || uidValidity < 1 || uidValidity > 4294967295 || !Number.isSafeInteger(uidNext) || uidNext < 1 || uidNext > 4294967295) throw new MailError("IMAP_PROTOCOL_ERROR");
  if (expected !== undefined && expected !== uidValidity) throw new MailError("UIDVALIDITY_CHANGED");
  return { uidValidity, uidNext };
}
