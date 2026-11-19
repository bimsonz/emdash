import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { virtualConfig, getDb, resolveSecretsCached, requestContext } = vi.hoisted(() => ({
	virtualConfig: {} as { imageSigning?: boolean; imageStoragePublicUrl?: string },
	getDb: vi.fn(),
	resolveSecretsCached: vi.fn(),
	requestContext: { current: undefined as { db?: unknown } | undefined },
}));

vi.mock("virtual:emdash/config", () => ({ default: virtualConfig }));
vi.mock("../../../src/loader.js", () => ({ getDb }));
vi.mock("../../../src/config/secrets.js", () => ({ resolveSecretsCached }));
vi.mock("../../../src/request-context.js", () => ({
	getRequestContext: () => requestContext.current,
}));

import { checkImageSignature } from "../../../src/media/image-signature-check.js";
import {
	_clearImageSigningKeyCacheForTesting,
	IMAGE_SIGNATURE_PARAM,
	importImageSigningKeys,
	signTransformUrl,
} from "../../../src/media/image-signature.js";

const ORIGIN = "https://site.example";
const HREF = "https://site.example/_emdash/api/media/file/abc.jpg";
const BASE = `href=${encodeURIComponent(HREF)}&w=640&h=360&f=webp`;

function ctx(user?: { role: number }): APIContext {
	return { locals: { user } } as unknown as APIContext;
}

async function signed(origin = ORIGIN, asset?: URLSearchParams): Promise<URL> {
	const [key] = await importImageSigningKeys(["secret-a"]);
	const path = await signTransformUrl(new URL(`${ORIGIN}/_image?${BASE}`), key!, asset);
	return new URL(path, origin);
}

describe("checkImageSignature", () => {
	beforeEach(() => {
		_clearImageSigningKeyCacheForTesting();
		virtualConfig.imageSigning = true;
		delete virtualConfig.imageStoragePublicUrl;
		requestContext.current = undefined;
		getDb.mockResolvedValue({});
		resolveSecretsCached.mockResolvedValue({ imageSigningSecrets: ["secret-a"] });
		vi.spyOn(console, "debug").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	async function refusal(response: Response | null, status: number, code: string): Promise<string> {
		expect(response).not.toBeNull();
		expect(response!.status).toBe(status);
		expect(response!.headers.get("Cache-Control")).toContain("no-store");
		expect(response!.headers.get("Set-Cookie")).toBeNull();
		const text = await response!.text();
		const body = JSON.parse(text) as { success: boolean; error: { code: string } };
		expect(body.success).toBe(false);
		expect(body.error.code).toBe(code);
		return text;
	}

	it("continues for a signed URL", async () => {
		expect(await checkImageSignature(ctx(), await signed())).toBeNull();
	});

	it("refuses an altered signature with IMAGE_SIGNATURE_INVALID", async () => {
		const url = await signed();
		const sig = url.searchParams.get(IMAGE_SIGNATURE_PARAM)!;
		url.searchParams.set(
			IMAGE_SIGNATURE_PARAM,
			`${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`,
		);
		await refusal(await checkImageSignature(ctx(), url), 403, "IMAGE_SIGNATURE_INVALID");
	});

	it("refuses a truncated signature", async () => {
		const url = await signed();
		url.searchParams.set(
			IMAGE_SIGNATURE_PARAM,
			url.searchParams.get(IMAGE_SIGNATURE_PARAM)!.slice(0, 10),
		);
		await refusal(await checkImageSignature(ctx(), url), 403, "IMAGE_SIGNATURE_INVALID");
	});

	it("refuses a missing signature", async () => {
		const url = new URL(`${ORIGIN}/_image?${BASE}`);
		await refusal(await checkImageSignature(ctx(), url), 403, "IMAGE_SIGNATURE_INVALID");
	});

	it("refuses a signature over a different query", async () => {
		const url = await signed();
		url.searchParams.set("w", "9999");
		await refusal(await checkImageSignature(ctx(), url), 403, "IMAGE_SIGNATURE_INVALID");
	});

	it("exempts a Contributor but verifies a Subscriber", async () => {
		const unsigned = new URL(`${ORIGIN}/_image?${BASE}`);
		expect(await checkImageSignature(ctx({ role: Role.CONTRIBUTOR }), unsigned)).toBeNull();
		await refusal(
			await checkImageSignature(ctx({ role: Role.SUBSCRIBER }), unsigned),
			403,
			"IMAGE_SIGNATURE_INVALID",
		);
	});

	it("does not need the database for an exempt requester", async () => {
		getDb.mockRejectedValue(new Error("no db"));
		const unsigned = new URL(`${ORIGIN}/_image?${BASE}`);
		expect(await checkImageSignature(ctx({ role: Role.ADMIN }), unsigned)).toBeNull();
		expect(getDb).not.toHaveBeenCalled();
	});

	it("continues for anything when signing is off", async () => {
		virtualConfig.imageSigning = false;
		expect(await checkImageSignature(ctx(), new URL(`${ORIGIN}/_image?${BASE}`))).toBeNull();
		expect(resolveSecretsCached).not.toHaveBeenCalled();
	});

	it("verifies on another host with the same query", async () => {
		for (const origin of [
			"https://www.site.example",
			"https://site.example",
			"https://x.workers.dev",
		]) {
			expect(await checkImageSignature(ctx(), await signed(origin))).toBeNull();
		}
	});

	it("verifies a signed URL that carries the adapter's asset parameters", async () => {
		const asset = new URLSearchParams({ dpl: "abc" });
		const url = await signed(ORIGIN, asset);
		expect(url.searchParams.get("dpl")).toBe("abc");
		expect(await checkImageSignature(ctx(), url, asset)).toBeNull();
	});

	it("uses the request-scoped database before getDb", async () => {
		requestContext.current = { db: { scoped: true } };
		await checkImageSignature(ctx(), await signed());
		expect(resolveSecretsCached).toHaveBeenCalledWith({ scoped: true });
		expect(getDb).not.toHaveBeenCalled();
	});

	it("fails closed with 503 when there is no database", async () => {
		getDb.mockRejectedValue(new Error("EmDash database not configured"));
		const text = await refusal(
			await checkImageSignature(ctx(), await signed()),
			503,
			"IMAGE_SIGNING_UNAVAILABLE",
		);
		expect(text).not.toContain("not configured");
	});

	it("fails closed with 503 when the secret cannot be resolved", async () => {
		resolveSecretsCached.mockRejectedValue(new Error("boom"));
		await refusal(
			await checkImageSignature(ctx(), await signed()),
			503,
			"IMAGE_SIGNING_UNAVAILABLE",
		);
	});

	it("logs the reason and key at debug without the expected MAC", async () => {
		const url = new URL(`${ORIGIN}/_image?${BASE}`);
		await checkImageSignature(ctx(), url);
		const debug = vi.mocked(console.debug);
		expect(debug).toHaveBeenCalledTimes(1);
		expect(debug.mock.calls[0]).toEqual(["[emdash] image signature missing:", "abc.jpg"]);
	});

	it("logs the storage key, not the supplied href, for publicUrl media", async () => {
		virtualConfig.imageStoragePublicUrl = "https://media.example.com/uploads";
		const href = encodeURIComponent("https://media.example.com/uploads/key.jpg");
		await checkImageSignature(ctx(), new URL(`${ORIGIN}/_image?href=${href}&w=1`));
		expect(vi.mocked(console.debug).mock.calls[0]).toEqual([
			"[emdash] image signature missing:",
			"key.jpg",
		]);
	});
});
