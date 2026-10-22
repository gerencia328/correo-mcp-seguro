import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const built = await build({
  stdin: { resolveDir: process.cwd(), contents: `
    import { MailService } from "./src/mail-service";
    export default { async fetch() {
      let unsupportedRejected = false;
      try { new Request("https://oauth2.googleapis.com/token", { redirect: "error" }); }
      catch (e) { unsupportedRejected = e instanceof TypeError; }
      let requests = 0;
      const service = new MailService({ GOOGLE_IMAP_REFRESH_TOKEN: "synthetic", GOOGLE_IMAP_CLIENT_ID: "synthetic", GOOGLE_IMAP_CLIENT_SECRET: "synthetic" },
        () => { throw new Error("IMAP must not be reached"); },
        async (url, init) => { requests++; new Request(url, init); return new Response(null, { status: 302, headers: { Location: "https://example.invalid/" } }); });
      try { await service.listFolders({ accountId: "jegatech-gerencia", offset: 0, limit: 1 }); }
      catch (e) { return Response.json({ unsupportedRejected, requests, code: e.code }); }
      return new Response("unexpected success", { status: 500 });
    } };
  ` },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:sockets"],
});
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-03-10", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"] }));
try {
  const result = await (await mf.dispatchFetch("https://worker.test/")).json();
  assert.deepEqual(result, { unsupportedRejected: true, requests: 1, code: "GOOGLE_OAUTH_REDIRECT_REJECTED" });
  console.log("PASS workerd: unsupported redirect reproduced; manual redirect accepted and rejected safely without network access.");
} finally { await mf.dispose(); }
