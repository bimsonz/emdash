import { beforeEach, describe, expect, it } from "vitest";

import {
	_clearImageSigningKeyCacheForTesting,
	hasValidTransformSignature,
	IMAGE_SIGNATURE_PARAM,
	importImageSigningKeys,
	signTransformUrl,
} from "../../../src/media/image-signature.js";

const ORIGIN = "https://site.example";
const HREF = "https://site.example/_emdash/api/media/file/abc.jpg";
const BASE = `href=${encodeURIComponent(HREF)}&w=640&h=360&f=webp`;

function endpoint(query: string): URL {
	return new URL(`${ORIGIN}/_image?${query}`);
}

async function sign(query: string, key: CryptoKey, asset?: URLSearchParams): Promise<URL> {
	return new URL(await signTransformUrl(endpoint(query), key, asset), ORIGIN);
}

describe("image transform signatures", () => {
	let a: CryptoKey;
	let b: CryptoKey;

	beforeEach(async () => {
		_clearImageSigningKeyCacheForTesting();
		[a, b] = await importImageSigningKeys(["secret-a", "secret-b"]);
	});

	it("signs the canonical query, so a reordered or re-encoded query verifies", async () => {
		const query = `href=${HREF.replaceAll("/", "%2F")}&w=640&h=360&f=webp`;
		const signed = await sign(query, a);
		const sig = signed.searchParams.get(IMAGE_SIGNATURE_PARAM)!;

		const reordered = endpoint(
			`f=webp&h=360&${IMAGE_SIGNATURE_PARAM}=${sig}&w=640&href=${encodeURIComponent(HREF)}`,
		);
		expect(await hasValidTransformSignature(reordered, [a])).toBe(true);

		// "," written as %2C and " " as "+" decode to the same parameters.
		const spaced = "https://site.example/_emdash/api/media/file/a b,c.jpg";
		const s1 = await sign(`href=${encodeURIComponent(spaced)}&w=1`, a);
		const sig1 = s1.searchParams.get(IMAGE_SIGNATURE_PARAM)!;
		const rewritten = endpoint(
			`href=${spaced.replaceAll(" ", "+")}&w=1&${IMAGE_SIGNATURE_PARAM}=${sig1}`,
		);
		expect(await hasValidTransformSignature(rewritten, [a])).toBe(true);
		const rewritten2 = endpoint(
			`href=${encodeURIComponent(spaced).replaceAll("%20", "+").replaceAll(",", "%2C")}&w=1&${IMAGE_SIGNATURE_PARAM}=${sig1}`,
		);
		expect(await hasValidTransformSignature(rewritten2, [a])).toBe(true);
	});

	it("refuses any changed parameter", async () => {
		const full = `${BASE}&q=80&fit=cover&position=top`;
		const signed = await sign(full, a);
		expect(await hasValidTransformSignature(signed, [a])).toBe(true);

		const changes: Record<string, string> = {
			w: "641",
			h: "361",
			q: "81",
			f: "png",
			fit: "contain",
			position: "bottom",
			href: "https://evil.example/_emdash/api/media/file/abc.jpg",
		};
		for (const [name, value] of Object.entries(changes)) {
			const tampered = new URL(signed);
			tampered.searchParams.set(name, value);
			expect(await hasValidTransformSignature(tampered, [a]), name).toBe(false);
		}
	});

	it("excludes assetQueryParams", async () => {
		const asset = new URLSearchParams({ dpl: "abc" });
		const signed = await sign(BASE, a);
		const withAsset = new URL(signed);
		withAsset.searchParams.set("dpl", "abc");
		expect(await hasValidTransformSignature(withAsset, [a], asset)).toBe(true);
		withAsset.searchParams.set("dpl", "other");
		expect(await hasValidTransformSignature(withAsset, [a], asset)).toBe(true);
	});

	it("signature is 22 base64url characters after the canonical and asset params", async () => {
		const asset = new URLSearchParams({ dpl: "abc" });
		const out = await signTransformUrl(endpoint(BASE), a, asset);
		expect(out).toMatch(
			new RegExp(
				`^/_image\\?${BASE.replace(/[?]/g, "\\?")}&dpl=abc&${IMAGE_SIGNATURE_PARAM}=[A-Za-z0-9_-]{22}$`,
			),
		);
		const plain = await signTransformUrl(endpoint(BASE), a);
		expect(plain).toMatch(new RegExp(`&${IMAGE_SIGNATURE_PARAM}=[A-Za-z0-9_-]{22}$`));
		expect(plain.startsWith("/_image?href=")).toBe(true);
	});

	it("rotation", async () => {
		const signed = await sign(BASE, a);
		expect(await hasValidTransformSignature(signed, [b, a])).toBe(true);
		expect(await hasValidTransformSignature(signed, [b])).toBe(false);
	});

	it("caches imported keys per secret", async () => {
		const [again] = await importImageSigningKeys(["secret-a"]);
		expect(again).toBe(a);
	});

	it("refuses a missing, empty, truncated or duplicated _emdash_sig", async () => {
		const signed = await sign(BASE, a);
		const sig = signed.searchParams.get(IMAGE_SIGNATURE_PARAM)!;

		expect(await hasValidTransformSignature(endpoint(BASE), [a])).toBe(false);
		expect(
			await hasValidTransformSignature(endpoint(`${BASE}&${IMAGE_SIGNATURE_PARAM}=`), [a]),
		).toBe(false);
		expect(
			await hasValidTransformSignature(
				endpoint(`${BASE}&${IMAGE_SIGNATURE_PARAM}=${sig.slice(0, 21)}`),
				[a],
			),
		).toBe(false);
		expect(
			await hasValidTransformSignature(
				endpoint(`${BASE}&${IMAGE_SIGNATURE_PARAM}=${sig}&${IMAGE_SIGNATURE_PARAM}=${sig}`),
				[a],
			),
		).toBe(false);
		expect(await hasValidTransformSignature(signed, [])).toBe(false);
	});
});
