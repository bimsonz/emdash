import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDb } = vi.hoisted(() => ({ getDb: vi.fn() }));

// The configured database, which tests make fail to exercise the 503.
vi.mock("../../../src/loader.js", () => ({ getDb }));

import { checkImageSignature } from "../../../src/astro/image-signing.js";
import {
	_clearSecretsCacheForTesting,
	IMAGE_SECRET_OPTION_KEY,
} from "../../../src/config/secrets.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import {
	_clearImageSigningKeyCacheForTesting,
	IMAGE_SIGNATURE_PARAM,
	importImageSigningKeys,
	signTransformUrl,
} from "../../../src/media/image-signature.js";
import { type EmDashRequestContext, runWithContext } from "../../../src/request-context.js";
import {
	createTestDatabase,
	setupTestDatabase,
	teardownTestDatabase,
} from "../../utils/test-db.js";

const ORIGIN = "https://site.example";
const HREF = "https://site.example/_emdash/api/media/file/abc.jpg";
const BASE = `href=${encodeURIComponent(HREF)}&w=640&h=360&f=webp`;

function ctx(user?: { role: number }): APIContext {
	return { locals: { user } } as unknown as APIContext;
}

async function signed(origin = ORIGIN, asset?: URLSearchParams, secret = "secret-a"): Promise<URL> {
	const [key] = await importImageSigningKeys([secret]);
	const path = await signTransformUrl(new URL(`${ORIGIN}/_image?${BASE}`), key!, asset);
	return new URL(path, origin);
}

function inRequest<T>(fn: () => Promise<T>, context: Partial<EmDashRequestContext>): Promise<T> {
	return runWithContext({ editMode: false, ...context }, fn);
}

describe("checkImageSignature", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		_clearImageSigningKeyCacheForTesting();
		_clearSecretsCacheForTesting();
		vi.stubEnv("EMDASH_IMAGE_SECRET", "");
		db = await setupTestDatabase();
		await new OptionsRepository(db).set(IMAGE_SECRET_OPTION_KEY, "secret-a");
		getDb.mockResolvedValue(db);
		vi.spyOn(console, "debug").mockImplementation(() => undefined);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		vi.clearAllMocks();
		_clearSecretsCacheForTesting();
		await teardownTestDatabase(db);
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
		expect(await checkImageSignature(ctx(), url)).toBeNull();
	});

	it("verifies with the secret stored in the database", async () => {
		await refusal(
			await checkImageSignature(ctx(), await signed(ORIGIN, undefined, "other-secret")),
			403,
			"IMAGE_SIGNATURE_INVALID",
		);
	});

	it("reads the secret through the request's database before getDb", async () => {
		const scoped = await setupTestDatabase();
		try {
			await new OptionsRepository(scoped).set(IMAGE_SECRET_OPTION_KEY, "scoped-secret");
			getDb.mockRejectedValue(new Error("EmDash database not configured"));
			const url = await signed(ORIGIN, undefined, "scoped-secret");
			expect(await inRequest(() => checkImageSignature(ctx(), url), { db: scoped })).toBeNull();
			expect(getDb).not.toHaveBeenCalled();
		} finally {
			await teardownTestDatabase(scoped);
		}
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

	// The Durable Object preview puts its own database in the request context
	// without `dbIsIsolated`. Each test starts on a cold isolate.
	describe("with another site's database in the request context", () => {
		let previewDb: Kysely<Database>;

		beforeEach(async () => {
			previewDb = await setupTestDatabase();
		});

		afterEach(async () => {
			await teardownTestDatabase(previewDb);
		});

		const preview = <T>(fn: () => Promise<T>) => inRequest(fn, { db: previewDb });

		it("keeps the main site's secret when the preview resolves first", async () => {
			await new OptionsRepository(previewDb).set(IMAGE_SECRET_OPTION_KEY, "preview-secret");
			const previewUrl = await signed(ORIGIN, undefined, "preview-secret");
			const mainUrl = await signed(ORIGIN, undefined, "secret-a");

			expect(await preview(() => checkImageSignature(ctx(), previewUrl))).toBeNull();

			expect(await checkImageSignature(ctx(), mainUrl)).toBeNull();
			await refusal(await checkImageSignature(ctx(), previewUrl), 403, "IMAGE_SIGNATURE_INVALID");
			await refusal(
				await preview(() => checkImageSignature(ctx(), mainUrl)),
				403,
				"IMAGE_SIGNATURE_INVALID",
			);
		});

		it("gives the preview its own secret after the main site resolved", async () => {
			const mainUrl = await signed(ORIGIN, undefined, "secret-a");
			expect(await checkImageSignature(ctx(), mainUrl)).toBeNull();

			await refusal(
				await preview(() => checkImageSignature(ctx(), mainUrl)),
				403,
				"IMAGE_SIGNATURE_INVALID",
			);
			const previewSecret = await new OptionsRepository(previewDb).get<string>(
				IMAGE_SECRET_OPTION_KEY,
			);
			expect(previewSecret).toEqual(expect.any(String));
			expect(previewSecret).not.toBe("secret-a");
			const previewUrl = await signed(ORIGIN, undefined, previewSecret!);
			expect(await preview(() => checkImageSignature(ctx(), previewUrl))).toBeNull();
			expect(await checkImageSignature(ctx(), mainUrl)).toBeNull();
		});
	});

	describe("with EMDASH_IMAGE_SECRET set", () => {
		beforeEach(() => {
			vi.stubEnv("EMDASH_IMAGE_SECRET", "secret-a");
			getDb.mockRejectedValue(new Error("EmDash database not configured"));
		});

		it("verifies a signed URL without a database", async () => {
			expect(await checkImageSignature(ctx(), await signed())).toBeNull();
			expect(getDb).not.toHaveBeenCalled();
		});

		it("refuses an unsigned URL with 403, never 503", async () => {
			await refusal(
				await checkImageSignature(ctx(), new URL(`${ORIGIN}/_image?${BASE}`)),
				403,
				"IMAGE_SIGNATURE_INVALID",
			);
			expect(getDb).not.toHaveBeenCalled();
		});

		it("does not read the request's database", async () => {
			const broken = createTestDatabase();
			try {
				const url = await signed();
				expect(await inRequest(() => checkImageSignature(ctx(), url), { db: broken })).toBeNull();
			} finally {
				await broken.destroy();
			}
		});

		it("logs the env source without a hint for an invalid signature", async () => {
			await checkImageSignature(ctx(), await signed(ORIGIN, undefined, "other-secret"));
			const [, , fields] = vi.mocked(console.debug).mock.calls[0] as [string, string, object];
			expect(fields).toEqual({ secretSource: "env" });
		});
	});

	it("fails closed with 503 when the secret cannot be read", async () => {
		// No migrations: the options table is missing.
		const unmigrated = createTestDatabase();
		try {
			getDb.mockResolvedValue(unmigrated);
			await refusal(
				await checkImageSignature(ctx(), await signed()),
				503,
				"IMAGE_SIGNING_UNAVAILABLE",
			);
		} finally {
			await unmigrated.destroy();
		}
	});

	it("logs the reason, the href and the secret source at debug without the expected MAC", async () => {
		const url = new URL(`${ORIGIN}/_image?${BASE}`);
		await checkImageSignature(ctx(), url);
		const debug = vi.mocked(console.debug);
		expect(debug).toHaveBeenCalledTimes(1);
		expect(debug.mock.calls[0]).toEqual([
			"[emdash] image signature missing:",
			JSON.stringify(HREF),
			{ secretSource: "db" },
		]);
	});

	it("hints at EMDASH_IMAGE_SECRET for an invalid signature checked against the database secret", async () => {
		const url = await signed(ORIGIN, undefined, "other-secret");
		await checkImageSignature(ctx(), url);
		const debug = vi.mocked(console.debug);
		expect(debug.mock.calls[0]).toEqual([
			"[emdash] image signature invalid:",
			JSON.stringify(HREF),
			{ secretSource: "db", hint: expect.stringContaining("EMDASH_IMAGE_SECRET") },
		]);
		const logged = JSON.stringify(debug.mock.calls[0]);
		expect(logged).not.toContain(url.searchParams.get(IMAGE_SIGNATURE_PARAM)!);
		const [expected] = await importImageSigningKeys(["secret-a"]);
		const expectedMac = new URL(
			await signTransformUrl(new URL(`${ORIGIN}/_image?${BASE}`), expected!),
			ORIGIN,
		).searchParams.get(IMAGE_SIGNATURE_PARAM)!;
		expect(logged).not.toContain(expectedMac);
	});

	it("refuses an unsigned href that is not stored media", async () => {
		for (const href of ["/_astro/foo.hash.jpg", "https://cdn.example.com/a.jpg"]) {
			const url = new URL(`${ORIGIN}/_image?href=${encodeURIComponent(href)}&w=100`);
			await refusal(await checkImageSignature(ctx(), url), 403, "IMAGE_SIGNATURE_INVALID");
		}
	});

	it("refuses a request with no href and no signature", async () => {
		await refusal(
			await checkImageSignature(ctx(), new URL(`${ORIGIN}/_image?w=100`)),
			403,
			"IMAGE_SIGNATURE_INVALID",
		);
	});

	it("continues for a signed href that is not stored media", async () => {
		const [key] = await importImageSigningKeys(["secret-a"]);
		const path = await signTransformUrl(
			new URL(`${ORIGIN}/_image?href=${encodeURIComponent("/_astro/foo.hash.jpg")}&w=100`),
			key!,
		);
		expect(await checkImageSignature(ctx(), new URL(path, ORIGIN))).toBeNull();
	});

	it("logs the reason and the href truncated to 200 characters", async () => {
		const long = `/${"a".repeat(300)}.jpg`;
		await checkImageSignature(ctx(), new URL(`${ORIGIN}/_image?href=${encodeURIComponent(long)}`));
		const [message, logged] = vi.mocked(console.debug).mock.calls[0] as [string, string];
		expect(message).toBe("[emdash] image signature missing:");
		expect(logged).toBe(JSON.stringify(long.slice(0, 200)));
	});

	it("escapes control characters in the logged href so a request cannot forge log lines", async () => {
		const query = new URLSearchParams({ href: "a\nb" });
		await checkImageSignature(ctx(), new URL(`${ORIGIN}/_image?${query}`));
		const [, logged] = vi.mocked(console.debug).mock.calls[0] as [string, string];
		expect(logged).not.toContain("\n");
		expect(logged).toBe(JSON.stringify("a\nb"));
	});
});
