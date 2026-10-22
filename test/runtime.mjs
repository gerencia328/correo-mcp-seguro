import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// Run the SAME built Worker in workerd, with isolated local KV and SQLite DOs.
// Synthetic OAuth settings only. This never reads production KV or mailbox secrets.
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, scriptPath: ".wrangler/build/index.js", compatibilityDate: "2026-03-10",
  compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  kvNamespaces: ["OAUTH_KV"], durableObjects: { MCP_OBJECT: { className: "MyMCP", useSQLite: true } },
  bindings: { ACCESS_CLIENT_ID: "synthetic", ACCESS_CLIENT_SECRET: "synthetic", ACCESS_TOKEN_URL: "https://test.cloudflareaccess.com/token", ACCESS_AUTHORIZATION_URL: "https://test.cloudflareaccess.com/authorize", ACCESS_JWKS_URL: "https://test.cloudflareaccess.com/certs", COOKIE_ENCRYPTION_KEY: "synthetic-test-only", MAIL_ALLOWED_EMAILS: "gerencia@mascorona.com" },
}));
try {
  for (const authorization of [undefined, "Bearer deliberately-invalid-test-token"]) {
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (authorization) headers.Authorization = authorization;
    const r = await mf.dispatchFetch("https://worker.test/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(r.status, 401); assert.match(r.headers.get("www-authenticate"), /Bearer/i); await r.body?.cancel();
  }
  const discovery = await mf.dispatchFetch("https://worker.test/.well-known/oauth-authorization-server");
  assert.equal(discovery.status, 200);
  const config = await discovery.json();
  assert.equal(config.authorization_endpoint, "https://worker.test/authorize");
  assert.equal(config.token_endpoint, "https://worker.test/token");
  assert.equal(config.registration_endpoint, "https://worker.test/register");
  assert.ok(config.code_challenge_methods_supported.includes("S256"));
  const badCallback = await mf.dispatchFetch("https://worker.test/callback?state=forged&code=synthetic");
  assert.equal(badCallback.status, 400); assert.ok(!(await badCallback.text()).includes("synthetic"));
  console.log("PASS workerd: built Worker loads, unauthenticated/invalid bearer rejected, OAuth endpoints/PKCE preserved, forged callback rejected.");
} finally { await mf.dispose(); }
