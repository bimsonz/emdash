import { Role } from "@emdash-cms/auth";
import { describe, it, expect, vi } from "vitest";

import { GET as getContent } from "../../../src/astro/routes/api/content/[collection]/[id].js";
import { GET as listContent } from "../../../src/astro/routes/api/content/[collection]/index.js";

/**
 * Regression tests for draft visibility through an API token.
 *
 * Token creation requires `Role.ADMIN` and records the caller as the owner, so
 * every token is admin-owned. Gating drafts on the owner's role alone therefore
 * lets any token read unpublished content however narrowly it was scoped — a
 * website key scoped `content:read` would still be served draft pages, so
 * unpublishing would not take content off the site.
 *
 * Session requests carry no scopes and must keep working on role alone.
 */
describe("content routes — draft visibility depends on token scope", () => {
	const admin = { id: "user-1", role: Role.ADMIN };

	const draftItem = { id: "abc", status: "draft", data: { title: "Unpublished" } };

	function getLocals(tokenScopes?: string[]) {
		return {
			emdash: {
				handleContentGet: vi.fn().mockResolvedValue({
					success: true,
					data: { item: { ...draftItem } },
				}),
			},
			user: admin,
			...(tokenScopes ? { tokenScopes } : {}),
		};
	}

	async function get(tokenScopes?: string[]) {
		return getContent({
			params: { collection: "pages", id: "abc" },
			url: new URL("http://localhost/_emdash/api/content/pages/abc"),
			locals: getLocals(tokenScopes),
		} as unknown as Parameters<typeof getContent>[0]);
	}

	it("hides a draft from a token scoped content:read", async () => {
		const response = await get(["content:read"]);
		expect(response.status).toBe(404);
	});

	it("serves a draft to a token scoped admin", async () => {
		const response = await get(["admin"]);
		expect(response.status).toBe(200);
	});

	it("serves a draft to a session request, which has no scopes", async () => {
		const response = await get(undefined);
		expect(response.status).toBe(200);
	});

	describe("list", () => {
		async function list(tokenScopes?: string[]) {
			const handleContentList = vi.fn().mockResolvedValue({ success: true, data: { items: [] } });
			await listContent({
				params: { collection: "pages" },
				url: new URL("http://localhost/_emdash/api/content/pages?status=draft"),
				locals: {
					emdash: { handleContentList },
					user: admin,
					...(tokenScopes ? { tokenScopes } : {}),
				},
			} as unknown as Parameters<typeof listContent>[0]);
			return handleContentList.mock.calls[0]?.[1] as { status?: string };
		}

		it("forces status=published for a token scoped content:read", async () => {
			expect((await list(["content:read"])).status).toBe("published");
		});

		it("keeps the requested status for a token scoped admin", async () => {
			expect((await list(["admin"])).status).toBe("draft");
		});

		it("keeps the requested status for a session request", async () => {
			expect((await list(undefined)).status).toBe("draft");
		});
	});
});
