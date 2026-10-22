import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { handleAccessRequest } from "./access-handler";
import type { Props } from "./workers-oauth-utils";
import { registerMailTools } from "./mail-tools";
import type { MailSecrets } from "./mail-policy";
import { registerReplyTools } from "./reply-tools";
import { ReplyService, type ReplyAction, type ReplyResult } from "./reply-service";
import { connect } from "cloudflare:sockets";
import { MailError, authorizeMail } from "./mail-policy";

const ALLOWED_EMAILS = new Set(["<INSERT EMAIL>"]);

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Correo Empresarial MCP",
		version: "1.2.0",
	});

	async init() {
		registerMailTools(this.server, this.env as Env & MailSecrets, () => this.props?.email);
		registerReplyTools(this.server, this.env as Env & MailSecrets, () => this.props?.email, this.ctx.storage, (owner, action) => this.env.MCP_OBJECT.getByName(`reply-ledger:${owner}`).replyOperation(owner, action));
		// Hello, world!
		this.server.tool(
			"add",
			"Add two numbers the way only MCP can",
			{ a: z.number(), b: z.number() },
			async ({ a, b }) => ({
				content: [{ text: String(a + b), type: "text" }],
			}),
		);

		// Dynamically add tools based on the user's login. In this case, I want to limit
		// access to my Image Generation tool to just me
		if (ALLOWED_EMAILS.has(this.props!.email)) {
			this.server.tool(
				"generateImage",
				"Generate an image using the `flux-1-schnell` model. Works best with 8 steps.",
				{
					prompt: z
						.string()
						.describe("A text description of the image you want to generate."),
					steps: z
						.number()
						.min(4)
						.max(8)
						.default(4)
						.describe(
							"The number of diffusion steps; higher values can improve quality but take longer. Must be between 4 and 8, inclusive.",
						),
				},
				async ({ prompt, steps }) => {
					const response = await this.env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
						prompt,
						steps,
					});

					return {
						content: [{ data: response.image!, mimeType: "image/jpeg", type: "image" }],
					};
				},
			);
		}
	}

	// Internal binding RPC only; there is no public HTTP route for this method.
	// A stable object per verified owner survives MCP session replacement.
	async replyOperation(owner: string, action: ReplyAction): Promise<ReplyResult> {
		try {
			authorizeMail(owner, this.env as Env & MailSecrets);
			const service = new ReplyService(this.env as Env & MailSecrets, connect, this.ctx.storage, owner);
			const data = action.kind === "prepare" ? await service.prepare(action.input) : action.kind === "send" ? await service.send(action.input) : action.kind === "status" ? await service.status(action.input) : await service.checkConnection(action.input);
			return { ok: true, data };
		} catch (e) {
			return { ok: false, error: e instanceof MailError ? e.code : "REPLY_OPERATION_FAILED" };
		}
	}
}

export default new OAuthProvider({
	apiHandler: MyMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: { fetch: handleAccessRequest as any },
	tokenEndpoint: "/token",
});
