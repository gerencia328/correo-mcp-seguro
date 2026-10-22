// LOCAL TEST HARNESS ONLY. Not imported by src/index.ts or deployed to Cloudflare.
import { DurableObject } from "cloudflare:workers";
import { ReplyService } from "../src/reply-service";
import { MailError } from "../src/mail-policy";
import { fakeSmtp } from "./smtp-fixture.mjs";

export class ReplyTestDO extends DurableObject {
  async fetch(request: Request) {
    const url = new URL(request.url);
    const transport = fakeSmtp({ ambiguous: url.searchParams.has("ambiguous"), onSubmit: async () => { await this.ctx.storage.put("test-submissions", (await this.ctx.storage.get<number>("test-submissions") ?? 0) + 1); } });
    const service = new ReplyService({ MAIL_ALLOWED_EMAILS: "owner@example.com", IMAP_MASCORONA_GERENCIA_PASSWORD: "synthetic" }, transport.dial, this.ctx.storage, "owner@example.com", {
      async replyHeaders() { return { from: "sender@example.com", subject: "Synthetic original", "message-id": "<synthetic@example.com>" }; },
      async saveSent() { /* synthetic archive, never a mailbox write */ },
    });
    try {
      if (url.pathname === "/prepare") return Response.json(await service.prepare({ accountId: "mascorona-gerencia", folder: "INBOX", uid: 1, uidValidity: 7, body: "Respuesta sintética de prueba" }));
      if (url.pathname === "/send") return Response.json(await service.send(await request.json()));
      if (url.pathname === "/status") return Response.json({ ...(await service.status(url.searchParams.get("draftId")!)), submissions: await this.ctx.storage.get<number>("test-submissions") ?? 0 });
      return new Response("Not found", { status: 404 });
    } catch (e) { return Response.json({ error: e instanceof MailError ? e.code : "TEST_ERROR", testDetail: String(e) }, { status: 409 }); }
  }
}

export default {
  fetch(request: Request, env: { REPLY_TEST: DurableObjectNamespace<ReplyTestDO> }) {
    const name = new URL(request.url).searchParams.get("object") ?? "same-user";
    return env.REPLY_TEST.getByName(name).fetch(request);
  },
};
