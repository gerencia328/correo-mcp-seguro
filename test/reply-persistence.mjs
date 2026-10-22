import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

await build({ entryPoints: ["test/reply-runtime-worker.ts"], outfile: ".wrangler/reply-runtime-worker.mjs", bundle: true, format: "esm", platform: "neutral", external: ["cloudflare:workers"] });
const workerName = "reply-runtime-" + crypto.randomUUID();
const options = convertV4MiniflareOptions({ name: workerName, modules: true, scriptPath: ".wrangler/reply-runtime-worker.mjs", compatibilityDate: "2026-03-10", durableObjects: { REPLY_TEST: { className: "ReplyTestDO", useSQLite: true } } });
const mf = new Miniflare(options);
const restartObject = (name = "same-user") => mf.unsafeEvictDurableObject(workerName, "ReplyTestDO", { name });
async function call(route, body) {
  const r = await mf.dispatchFetch("https://test.invalid" + route, { method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
  const text = await r.text();
  assert.match(r.headers.get("Content-Type") ?? "", /json/, `Test route ${route}: HTTP ${r.status}: ${text}`);
  return { status: r.status, body: JSON.parse(text) };
}
try {
  const preparation = await call("/prepare"); assert.equal(preparation.status, 200, JSON.stringify(preparation.body));
  const prepared = preparation.body;
  assert.equal((await call(`/status?draftId=${prepared.draftId}&object=other-user`)).status, 409);
  await restartObject();
  const restored = await call(`/status?draftId=${prepared.draftId}`);
  assert.equal(restored.status, 200, JSON.stringify(restored.body)); assert.equal(restored.body.state, "prepared");
  const args = { draftId: prepared.draftId, previewHash: prepared.previewHash, confirmation: "ENVIAR" };
  const results = await Promise.all([call("/send", args), call("/send", args)]);
  assert.ok(results.some(r => r.status === 200));
  let status = (await call(`/status?draftId=${prepared.draftId}`)).body;
  assert.equal(status.submissions, 1); assert.equal(status.state, "sent");
  await restartObject();
  const again = await call("/send", args); assert.equal(again.body.alreadySubmitted, true);
  assert.equal((await call(`/status?draftId=${prepared.draftId}`)).body.submissions, 1);
  const uncertain = (await call("/prepare?object=uncertain-user")).body;
  const uncertainArgs = { draftId: uncertain.draftId, previewHash: uncertain.previewHash, confirmation: "ENVIAR" };
  assert.equal((await call("/send?object=uncertain-user&ambiguous=1", uncertainArgs)).body.error, "SMTP_OUTCOME_UNKNOWN_DO_NOT_RETRY");
  await restartObject("uncertain-user");
  assert.equal((await call("/send?object=uncertain-user", uncertainArgs)).body.error, "REPLY_ALREADY_ATTEMPTED_DO_NOT_RESEND");
  status = (await call(`/status?object=uncertain-user&draftId=${uncertain.draftId}`)).body;
  assert.equal(status.submissions, 1); assert.equal(status.state, "unknown");
  console.log("PASS workerd SQLite DO: drafts/receipts persist after object restart, objects isolated, concurrent/retried submission once, ambiguous outcome not resent. Synthetic SMTP only.");
} finally { await mf.dispose(); }
