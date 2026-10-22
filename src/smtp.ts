import { MailError } from "./mail-policy";
import type { Dial, ImapSocket } from "./imap";

export interface OutgoingMessage { from: string; to: string; raw: string }
const encoder = new TextEncoder();
export const smtpHosts = {
  "mascorona-contacto": "sucumbios.ecuahosting.net",
  "mascorona-gerencia": "sucumbios.ecuahosting.net",
  "nostraterra-contacto": "mail.nostraterraec.com",
  "nostraterra-gerencia": "mail.nostraterraec.com",
} as const;
export type ReplyAccountId = keyof typeof smtpHosts;

export function base64Utf8(value: string) {
  return btoa(Array.from(encoder.encode(value), b => String.fromCharCode(b)).join(""));
}

/** SMTP submission over implicit TLS only. No plaintext fallback, port 25 or Node SMTP client. */
export class SmtpSession {
  private socket?: ImapSocket;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = new Uint8Array(0);
  private received = 0;
  private expired = false;
  private dataStarted = false;
  private dataRejected = false;

  constructor(private dial: Dial, private timeoutMs = 20000) {}

  async run(hostname: string, email: string, password: string, message?: OutgoingMessage) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.expired = true;
        reject(new MailError(this.dataStarted ? "SMTP_OUTCOME_UNKNOWN_DO_NOT_RETRY" : "SMTP_TIMEOUT"));
        void this.socket?.close().catch(() => {});
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.execute(hostname, email, password, message), deadline]);
    } catch (e) {
      if (this.dataStarted && !this.dataRejected) throw new MailError("SMTP_OUTCOME_UNKNOWN_DO_NOT_RETRY");
      if (e instanceof MailError) throw e;
      throw new MailError(this.expired ? "SMTP_TIMEOUT" : "SMTP_CONNECTION_FAILED");
    } finally {
      if (timer) clearTimeout(timer);
      try { await this.socket?.close(); } catch { /* already closed */ }
      try { this.reader?.releaseLock(); } catch { /* pending */ }
      try { this.writer?.releaseLock(); } catch { /* pending */ }
    }
  }

  private async execute(hostname: string, email: string, password: string, message?: OutgoingMessage) {
    if (!Object.values(smtpHosts).includes(hostname as typeof smtpHosts[ReplyAccountId])) throw new MailError("SMTP_HOST_NOT_ALLOWED");
    if (!password || password.length > 4096 || /[\r\n\0]/.test(password)) throw new MailError("SMTP_CREDENTIAL_INVALID");
    this.socket = this.dial({ hostname, port: 465 }, { secureTransport: "on", allowHalfOpen: false });
    void this.socket.closed.catch(() => {}); void this.socket.opened.catch(() => {});
    this.reader = this.socket.readable.getReader(); this.writer = this.socket.writable.getWriter();
    await this.socket.opened;
    this.expect(await this.reply(), [220]);
    const ehlo = await this.command(`EHLO ${email.split("@")[1]}`, [250]);
    const auth = ehlo.lines.find(line => /^AUTH\s/i.test(line));
    if (!auth) throw new MailError("SMTP_AUTH_UNAVAILABLE");
    if (/\bPLAIN\b/i.test(auth)) {
      const credential = base64Utf8(`\0${email}\0${password}`);
      const first = await this.command(`AUTH PLAIN ${credential}`, [235, 334], "SMTP_AUTH_FAILED");
      if (first.code === 334) await this.command(credential, [235], "SMTP_AUTH_FAILED");
    } else if (/\bLOGIN\b/i.test(auth)) {
      await this.command("AUTH LOGIN", [334], "SMTP_AUTH_FAILED");
      await this.command(base64Utf8(email), [334], "SMTP_AUTH_FAILED");
      await this.command(base64Utf8(password), [235], "SMTP_AUTH_FAILED");
    } else throw new MailError("SMTP_AUTH_UNAVAILABLE");
    if (!message) {
      await this.command("NOOP", [250]);
      await this.command("QUIT", [221]);
      return { authenticated: true, submitted: false };
    }
    if (message.from !== email) throw new MailError("SMTP_SENDER_MISMATCH");
    await this.command(`MAIL FROM:<${message.from}>`, [250], "SMTP_SENDER_REJECTED");
    await this.command(`RCPT TO:<${message.to}>`, [250, 251], "SMTP_RECIPIENT_REJECTED");
    await this.command("DATA", [354], "SMTP_DATA_REJECTED");
    // From this point, a connection failure may mean the server accepted the message.
    // Never retry automatically after an ambiguous outcome.
    this.dataStarted = true;
    const raw = message.raw.replace(/(^|\r\n)\./g, "$1..");
    await this.write(raw + (raw.endsWith("\r\n") ? "" : "\r\n") + ".\r\n");
    const result = await this.reply();
    if (result.code !== 250) {
      this.dataRejected = true;
      throw new MailError("SMTP_MESSAGE_REJECTED");
    }
    // Do not let a failed QUIT mask a successful final 250 acceptance.
    this.dataStarted = false;
    return { authenticated: true, submitted: true };
  }

  private expect(reply: { code: number; lines: string[] }, expected: number[], failure = "SMTP_COMMAND_REJECTED") {
    if (!expected.includes(reply.code)) throw new MailError(failure);
    return reply;
  }
  private async command(command: string, expected: number[], failure?: string) {
    if (/[\r\n\0]/.test(command)) throw new MailError("SMTP_COMMAND_INVALID");
    await this.write(command + "\r\n");
    return this.expect(await this.reply(), expected, failure);
  }
  private async write(value: string) {
    if (this.expired) throw new MailError("SMTP_TIMEOUT");
    await this.writer!.write(encoder.encode(value));
  }
  private async line() {
    for (;;) {
      let end = -1;
      for (let i = 0; i + 1 < this.buffer.length; i++) if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) { end = i; break; }
      if (end >= 0) {
        if (end > 2048) throw new MailError("SMTP_LINE_LIMIT");
        const line = new TextDecoder().decode(this.buffer.subarray(0, end)); this.buffer = this.buffer.slice(end + 2); return line;
      }
      if (this.buffer.length > 2048) throw new MailError("SMTP_LINE_LIMIT");
      if (this.expired) throw new MailError("SMTP_TIMEOUT");
      const result = await this.reader!.read();
      if (result.done) throw new MailError("SMTP_CONNECTION_CLOSED");
      this.received += result.value.length;
      if (this.received > 65536) throw new MailError("SMTP_RESPONSE_LIMIT");
      const merged = new Uint8Array(this.buffer.length + result.value.length); merged.set(this.buffer); merged.set(result.value, this.buffer.length); this.buffer = merged;
    }
  }
  private async reply() {
    let code: number | undefined; const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      const line = await this.line(); const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!match || (code !== undefined && code !== Number(match[1]))) throw new MailError("SMTP_PROTOCOL_ERROR");
      code = Number(match[1]); lines.push(match[3]);
      if (match[2] === " ") return { code, lines };
    }
    throw new MailError("SMTP_RESPONSE_LIMIT");
  }
}
