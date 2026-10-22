import { z } from "zod";
import { MailError, accountById } from "./mail-policy";
import { base64Utf8, type ReplyAccountId } from "./smtp";

export const replyAccountSchema = z.enum(["mascorona-contacto", "mascorona-gerencia", "nostraterra-contacto", "nostraterra-gerencia"]);
export const replyBodySchema = z.string().min(1).max(12000).refine(s => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s), "Invalid text controls");

export function mailbox(value: string) {
  if (!value || /[\r\n\0]/.test(value)) throw new MailError("REPLY_ADDRESS_INVALID");
  const enclosed = /^[^<>]*<([^<>]+)>$/.exec(value.trim());
  const address = (enclosed ? enclosed[1] : value).trim();
  if (address.length > 254 || !/^[\x21-\x7e]+$/.test(address) || !z.email().safeParse(address).success) throw new MailError("REPLY_SINGLE_ADDRESS_REQUIRED");
  return address;
}

export function decodeSubject(value: string) {
  let decoded: string;
  try {
    decoded = value.replace(/(\?=)\s+(?==\?)/g, "$1").replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset: string, kind: string, data: string) => {
      const binary = kind.toLowerCase() === "b" ? atob(data) : data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      return new TextDecoder(charset).decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
    });
  } catch { throw new MailError("REPLY_SUBJECT_ENCODING_INVALID"); }
  if (!decoded || decoded.length > 512 || /[\x00-\x1f\x7f]/.test(decoded) || decoded.includes("=?")) throw new MailError("REPLY_SUBJECT_INVALID");
  return /^re\s*:/i.test(decoded) ? decoded : `Re: ${decoded}`;
}

export function messageId(value: string) {
  if (!/^<[^<>\s\x00-\x1f\x7f]{1,196}>$/.test(value) || !/^[\x20-\x7e]+$/.test(value)) throw new MailError("REPLY_MESSAGE_ID_INVALID");
  return value;
}

export interface ReplyPreview {
  accountId: ReplyAccountId; from: string; to: string; subject: string; body: string;
  inReplyTo: string; references: string[]; messageId: string; date: string;
  replyToDiffers: boolean; originalFrom: string;
}

export function makePreview(accountId: ReplyAccountId, original: Record<string, string>, body: string, recipient?: string): ReplyPreview {
  replyBodySchema.parse(body);
  const from = accountById(accountId).email;
  const source = mailbox(original.from ?? "");
  const suggested = original["reply-to"] ? mailbox(original["reply-to"]) : source;
  const to = recipient ? mailbox(recipient) : suggested;
  // Only reply to a mailbox explicitly present in the original From/Reply-To.
  // Never derive recipients from instructions, links or addresses in the body.
  if (![source, suggested].some(a => a.toLowerCase() === to.toLowerCase()) || to.toLowerCase() === from.toLowerCase()) throw new MailError("REPLY_RECIPIENT_NOT_ORIGINAL_SENDER");
  const inReplyTo = messageId(original["message-id"] ?? "");
  const references = (original.references?.match(/<[^<>\s]+>/g) ?? []).slice(-8).map(messageId);
  references.push(inReplyTo);
  return { accountId, from, to, subject: decodeSubject(original.subject ?? ""), body: body.replace(/\r\n|\r|\n/g, "\n"), inReplyTo, references: [...new Set(references)].slice(-5), messageId: `<${crypto.randomUUID()}@${from.split("@")[1]}>`, date: new Date().toUTCString(), replyToDiffers: suggested.toLowerCase() !== source.toLowerCase(), originalFrom: source };
}

function encodedSubject(subject: string) {
  // RFC 2047: independently valid UTF-8 encoded words, each below 75 characters.
  const chunks: string[] = []; let chunk = "";
  for (const character of subject) {
    if (new TextEncoder().encode(chunk + character).length > 36) { chunks.push(`=?UTF-8?B?${base64Utf8(chunk)}?=`); chunk = ""; }
    chunk += character;
  }
  if (chunk) chunks.push(`=?UTF-8?B?${base64Utf8(chunk)}?=`);
  return chunks.join("\r\n ");
}

export function renderReply(preview: ReplyPreview) {
  const body = base64Utf8(preview.body.replace(/\n/g, "\r\n")).match(/.{1,76}/g)?.join("\r\n") ?? "";
  return [`From: ${preview.from}`, `To: ${preview.to}`, `Subject: ${encodedSubject(preview.subject)}`, `Date: ${preview.date}`, `Message-ID: ${preview.messageId}`, `In-Reply-To: ${preview.inReplyTo}`, `References: ${preview.references.join("\r\n ")}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", body, ""].join("\r\n");
}

export async function previewDigest(preview: ReplyPreview) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(preview)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
