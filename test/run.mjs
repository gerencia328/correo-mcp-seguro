import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
await mkdir(".wrangler", { recursive: true });
await build({ stdin: { contents: 'export * from "./src/imap"; export * from "./src/mail-policy"; export * from "./src/mail-service"; export * from "./src/mail-tools"; export * from "./src/oauth-claims";', resolveDir: process.cwd() }, bundle: true, format: "esm", platform: "node", outfile: ".wrangler/test-modules.mjs", external: ["@modelcontextprotocol/sdk/*"], alias: { "cloudflare:sockets": "./test/sockets-stub.mjs" } });
const result = spawnSync(process.execPath, ["--test", "test/security.test.mjs"], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
