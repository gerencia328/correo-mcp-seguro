import test from "node:test";
import assert from "node:assert/strict";
import { SmtpSession, mailbox, makePreview, renderReply, previewDigest, ReplyService, replyAccountSchema, registerReplyTools, MailService } from "../.wrangler/test-modules.mjs";
import { fakeSmtp } from "./smtp-fixture.mjs";
import { fakeReplyImap } from "./imap-reply-fixture.mjs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
const original = { from: '"Sender" <sender@example.com>', subject: "=?UTF-8?B?UmV0ZW5jacOzbg==?=", "message-id": "<original@example.com>" };
const input = { accountId: "mascorona-gerencia", folder: "INBOX", uid: 1, uidValidity: 7, body: "Hola, confirmamos la recepción.\nSaludos." };
function storage() {
  const data = new Map(); let serial = Promise.resolve();
  const store = {
    async get(k) { return structuredClone(data.get(k)); },
    async put(k, v) { data.set(k, structuredClone(v)); },
    async delete(k) { if (Array.isArray(k)) return k.reduce((n, key) => n + Number(data.delete(key)), 0); return data.delete(k); },
    async list({ prefix, limit }) { return new Map([...data].filter(([k]) => k.startsWith(prefix)).sort().slice(0, limit).map(([k,v]) => [k,structuredClone(v)])); },
    transaction(fn) {
      const task = serial.then(async () => { const snapshot = structuredClone(data); try { return await fn(store); } catch (e) { data.clear(); for (const [k,v] of snapshot) data.set(k,v); throw e; } });
      serial = task.catch(() => {}); return task;
    }, data,
  }; return store;
}
function service(options = {}, saved = storage()) {
  const transport = fakeSmtp(options);
  const env = { MAIL_ALLOWED_EMAILS: "owner@example.com", IMAP_MASCORONA_GERENCIA_PASSWORD: "synthetic-only" };
  const s = new ReplyService(env, transport.dial, saved, "owner@example.com", { async replyHeaders() { return original; }, async saveSent(_, raw) { if (options.archiveFail) throw Error("synthetic"); assert.ok(raw.includes("In-Reply-To: <original@example.com>")); } });
  return { s, transport, saved, env };
}
test("reply recipient parsing rejects header injection, groups and multiple recipients", () => {
  assert.equal(mailbox('Sender <sender@example.com>'), "sender@example.com");
  for (const bad of ["a@example.com\r\nBcc: evil@example.com", "a@example.com,b@example.com", "Group: a@example.com;", "a@example.com> MAIL FROM:<evil@example.com"]) assert.throws(() => mailbox(bad));
  assert.throws(() => makePreview(input.accountId, original, "Hello", "other@example.com"));
  assert.throws(() => replyAccountSchema.parse("mascorona-subgerencia"));
  assert.throws(() => replyAccountSchema.parse("jegatech-gerencia"));
});
test("Reply-To difference is visible; thread headers safe; subject/body use safe MIME", async () => {
  const p = makePreview(input.accountId, { ...original, "reply-to": "reply@example.com" }, input.body);
  assert.equal(p.to, "reply@example.com"); assert.equal(p.replyToDiffers, true); assert.equal(p.subject, "Re: Retención");
  const raw = renderReply(p);
  assert.match(raw, /Content-Transfer-Encoding: base64/); assert.ok(!raw.includes(input.body));
  assert.match(raw, /In-Reply-To: <original@example.com>/); assert.ok(raw.split("\r\n").every(l => l.length < 998));
  assert.notEqual(await previewDigest(p), await previewDigest({ ...p, body: "changed" }));
  assert.throws(() => makePreview(input.accountId, { ...original, subject: "Hello\r\nBcc: evil@example.com" }, "test"));
  assert.throws(() => makePreview(input.accountId, { ...original, "message-id": "<bad>\r\nInjected" }, "test"));
});
test("SMTP authentication probe never issues MAIL, RCPT or DATA", async () => {
  const f = fakeSmtp(); const r = await new SmtpSession(f.dial).run("sucumbios.ecuahosting.net", "gerencia@mascorona.com", "synthetic");
  assert.equal(r.submitted, false); assert.equal(f.state.submitted, 0); assert.ok(f.state.closed);
  assert.ok(f.state.commands.every(c => !/^(MAIL|RCPT|DATA)/.test(c)));
});
test("SMTP transmits one base64 message over TLS, SMTP dot-stuffing and accepted outcome", async () => {
  const f = fakeSmtp(), p = makePreview(input.accountId, original, "Hello\n.\nQUIT\n.");
  const r = await new SmtpSession(f.dial).run("sucumbios.ecuahosting.net", p.from, "synthetic", { from: p.from, to: p.to, raw: renderReply(p) });
  assert.equal(r.submitted, true); assert.equal(f.state.submitted, 1); assert.ok(f.state.closed);
});
test("SMTP LOGIN fallback is supported only over TLS", async () => {
  const f = fakeSmtp({ loginOnly: true }); await new SmtpSession(f.dial).run("mail.nostraterraec.com", "gerencia@nostraterraec.com", "synthetic");
  assert.ok(f.state.commands.includes("AUTH LOGIN\r\n")); assert.equal(f.state.submitted, 0);
});
test("SMTP dot-stuffs body lines so embedded dot/commands cannot terminate DATA", async () => {
  const f = fakeSmtp();
  await new SmtpSession(f.dial).run("sucumbios.ecuahosting.net", "gerencia@mascorona.com", "synthetic", { from: "gerencia@mascorona.com", to: "sender@example.com", raw: "From: gerencia@mascorona.com\r\n\r\n.\r\nQUIT\r\n." });
  assert.ok(f.state.commands.at(-1).endsWith("\r\n..\r\nQUIT\r\n..\r\n.\r\n")); assert.equal(f.state.submitted, 1);
});
test("reply headers are selected via EXAMINE/PEEK and incomplete headers are rejected", async () => {
  for (const complete of [true,false]) {
    const raw = 'From: Sender <sender@example.com>\r\nReply-To: reply@example.com\r\nSubject: Test\r\nMessage-ID: <test@example.com>\r\n' + (complete ? '\r\n' : 'truncated');
    const f = fakeReplyImap(raw), s = new MailService({ IMAP_NOSTRATERRA_GERENCIA_PASSWORD: "synthetic" }, f.dial);
    const task = s.replyHeaders({ accountId: "nostraterra-gerencia", folder: "INBOX", uid: 1, uidValidity: 7 });
    if (complete) { const h = await task; assert.equal(h["reply-to"], "reply@example.com"); assert.equal(h["message-id"], "<test@example.com>"); }
    else await assert.rejects(task, /REPLY_HEADERS_INCOMPLETE/);
    assert.ok(f.state.commands.some(c => c.includes("BODY.PEEK[HEADER.FIELDS"))); assert.ok(f.state.closed);
  }
});
test("Sent copy uses literal byte count and only INBOX.Sent; explicit failure surfaced", async () => {
  const raw = renderReply(makePreview(input.accountId, original, input.body));
  for (const failure of [false,true]) {
    const f = fakeReplyImap("", failure), s = new MailService({ IMAP_NOSTRATERRA_GERENCIA_PASSWORD: "synthetic" }, f.dial);
    if (failure) await assert.rejects(s.saveSent("nostraterra-gerencia",raw), /SENT_COPY_FAILED/);
    else await s.saveSent("nostraterra-gerencia",raw);
    assert.equal(f.state.archived, raw); assert.equal(f.state.expected, new TextEncoder().encode(raw).length);
    assert.ok(f.state.commands.some(c => c.includes('APPEND "INBOX.Sent" (\\Seen)'))); assert.ok(f.state.closed);
  }
});
for (const [name, options, expected] of [["TLS failure", { tlsFailure: true }, "SMTP_CONNECTION_FAILED"], ["auth failure", { badAuth: true }, "SMTP_AUTH_FAILED"], ["malformed response", { malformed: true }, "SMTP_PROTOCOL_ERROR"], ["bad greeting", { badGreeting: true }, "SMTP_COMMAND_REJECTED"]]) {
  test(`SMTP ${name} redacts upstream text and closes`, async () => {
    const f = fakeSmtp(options);
    await assert.rejects(new SmtpSession(f.dial).run("sucumbios.ecuahosting.net", "gerencia@mascorona.com", "synthetic"), e => e.code === expected && !e.message.includes("SECRET")); assert.ok(f.state.closed); assert.equal(f.state.submitted, 0);
  });
}
for (const opts of [{ hang: true }, { hangWrite: true }]) test("SMTP timeout covers hung greeting and write", async () => {
  const f = fakeSmtp(opts); await assert.rejects(new SmtpSession(f.dial, 15).run("sucumbios.ecuahosting.net", "gerencia@mascorona.com", "synthetic"), /SMTP_TIMEOUT/); assert.ok(f.state.closed);
});
test("prepare never dials SMTP; missing approval or changed preview cannot send", async () => {
  const { s, transport } = service(); const draft = await s.prepare(input);
  assert.equal(transport.state.dials, 0);
  await assert.rejects(s.send({ draftId: draft.draftId, previewHash: draft.previewHash, confirmation: "no" }), /CONFIRMATION/);
  await assert.rejects(s.send({ draftId: draft.draftId, previewHash: "0".repeat(64), confirmation: "ENVIAR" }), /PREVIEW_MISMATCH/);
  assert.equal(transport.state.dials, 0);
});
test("concurrent/repeated sends submit once; receipt survives service restart; body removed", async () => {
  const { s, transport, saved } = service(); const draft = await s.prepare(input);
  const args = { draftId: draft.draftId, previewHash: draft.previewHash, confirmation: "ENVIAR" };
  const results = await Promise.allSettled([s.send(args), s.send(args)]);
  assert.ok(results.some(r => r.status === "fulfilled")); assert.equal(transport.state.submitted, 1);
  const restarted = service({}, saved); const again = await restarted.s.send(args);
  assert.equal(again.alreadySubmitted, true); assert.equal(restarted.transport.state.dials, 0);
  assert.equal(again.sentCopy, "saved"); assert.equal([...saved.data.values()].find(r => r.state === "sent").preview, undefined);
});
test("ambiguous SMTP delivery is persisted, never retried", async () => {
  const { s, transport, saved } = service({ ambiguous: true }); const draft = await s.prepare(input);
  const args = { draftId: draft.draftId, previewHash: draft.previewHash, confirmation: "ENVIAR" };
  await assert.rejects(s.send(args), /OUTCOME_UNKNOWN/); assert.equal(transport.state.submitted, 1);
  assert.equal((await s.status(draft.draftId)).state, "unknown");
  const retry = service({}, saved); await assert.rejects(retry.s.send(args), /ALREADY_ATTEMPTED/); assert.equal(retry.transport.state.submitted, 0);
});
test("SMTP explicit DATA rejection is terminal; Sent-copy failure never resends", async () => {
  for (const options of [{ rejectData: true }, { archiveFail: true }]) {
    const { s, transport } = service(options); const d = await s.prepare(input); const args = { draftId: d.draftId, previewHash: d.previewHash, confirmation: "ENVIAR" };
    if (options.rejectData) { await assert.rejects(s.send(args), /SMTP_MESSAGE_REJECTED/); await assert.rejects(s.send(args), /ALREADY_ATTEMPTED/); }
    else { assert.equal((await s.send(args)).sentCopy, "failed_or_unknown"); assert.equal((await s.send(args)).alreadySubmitted, true); }
    assert.equal(transport.state.submitted, 1);
  }
});
test("draft is owner-bound and expired preview cannot send", async () => {
  const { s, saved, env, transport } = service(); const d = await s.prepare(input);
  const row = saved.data.get("mail-reply:v1:" + d.draftId); row.expiresAt = Date.now() - 1;
  await assert.rejects(s.send({ draftId: d.draftId, previewHash: d.previewHash, confirmation: "ENVIAR" }), /EXPIRED/);
  const other = new ReplyService({ ...env, MAIL_ALLOWED_EMAILS: "other@example.com" }, transport.dial, saved, "other@example.com");
  await assert.rejects(other.status(d.draftId), /NOT_FOUND/); assert.equal(transport.state.submitted, 0);
});
test("MCP exposes explicit write tools and guards unauthorized callers", async () => {
  const server = new McpServer({ name: "test", version: "1" }); registerReplyTools(server, {}, () => undefined, storage());
  const client = new Client({ name: "client", version: "1" }); const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    const { tools } = await client.listTools(); assert.equal(tools.length, 4);
    assert.equal(tools.find(t => t.name === "sendReply").annotations.readOnlyHint, false);
    assert.equal(tools.find(t => t.name === "prepareReply").annotations.readOnlyHint, false);
    const result = await client.callTool({ name: "checkReplyConnection", arguments: { accountId: "mascorona-gerencia" } }); assert.equal(result.isError, true); assert.match(result.content[0].text, /MAIL_ACCESS_DENIED/);
  } finally { await client.close(); await server.close(); }
});
